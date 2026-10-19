import fcntl
import json
import math
from pathlib import Path
import subprocess
import sys

import pytest
from pydantic import ValidationError

from openengineer.cad import ops
from openengineer.errors import EngineError


def call(root: Path, operation: str, **args):
    return ops.dispatch(root, operation, args)


def test_cad_project_part_features_export_and_revision(tmp_path):
    call(tmp_path, "project_create", name="demo", units="mm")
    part = call(tmp_path, "part_create", name="plate", material="alu-6061")
    assert part["part"] == "part-000001"

    extruded = call(
        tmp_path, "feature_extrude", part=part["part"],
        profile={"shape": "rectangle", "width": 80, "height": 40, "center": [40, 20]},
        distance=6,
    )
    assert extruded["feature"]["id"] == "feature-001"
    assert extruded["bounds_mm"]["max"] == [80, 40, 6]
    assert extruded["mass_g"] > 0
    assert all(extruded["checks"].values())

    call(tmp_path, "feature_hole", part=part["part"], x=20, y=20, diameter=6)
    call(tmp_path, "feature_hole", part=part["part"], x=60, y=20, diameter=6)
    filleted = call(tmp_path, "feature_fillet", part=part["part"], radius=3,
                    selector={"kind": "parallel", "axis": "z"})
    assert filleted["feature"]["id"] == "feature-004"
    assert filleted["volume_mm3"] < extruded["volume_mm3"]

    chamfered = call(tmp_path, "feature_chamfer", part=part["part"], distance=0.5,
                     selector={"kind": "holes", "z": "top"})
    assert chamfered["feature"]["id"] == "feature-005"
    assert chamfered["feature"]["type"] == "chamfer"
    assert chamfered["volume_mm3"] < filleted["volume_mm3"]
    assert filleted["volume_mm3"] - chamfered["volume_mm3"] == pytest.approx(5.0, abs=1.0)

    summary = call(tmp_path, "part_get", part=part["part"])
    assert len(summary["features"]) == 5
    assert summary["material_properties"]["id"] == "alu-6061"

    exported = call(tmp_path, "part_export", part=part["part"], format="step")
    assert Path(exported["path"]).exists()
    assert exported["bytes"] > 1000
    assert exported["relative_path"].startswith("artifacts/part-000001/")

    committed = call(tmp_path, "project_commit", message="plate with holes")
    assert committed["revision"].startswith("revision-000001-")
    status = call(tmp_path, "project_status")
    assert status["dirty"] is False
    assert status["last_revision"] == committed["revision"]
    history = call(tmp_path, "project_history")
    assert [item["revision"] for item in history["revisions"]] == [committed["revision"]]

    with pytest.raises(EngineError) as caught:
        call(tmp_path, "project_commit", message="no change")
    assert caught.value.code == "CONFLICT"


def test_cad_circle_polygon_and_plane_extrudes(tmp_path):
    call(tmp_path, "project_create", name="demo")
    first = call(tmp_path, "part_create", name="cylinder")
    call(tmp_path, "feature_extrude", part=first["part"],
         profile={"shape": "circle", "radius": 10}, distance=20)
    cylinder = call(tmp_path, "part_get", part=first["part"])
    assert cylinder["volume_mm3"] == pytest.approx(3.141592653589793 * 100 * 20, rel=1e-4)

    second = call(tmp_path, "part_create", name="wedge")
    call(tmp_path, "feature_extrude", part=second["part"],
         profile={"shape": "polygon", "points": [[0, 0], [30, 0], [0, 20]]}, distance=5)
    wedge = call(tmp_path, "part_get", part=second["part"])
    assert wedge["volume_mm3"] == pytest.approx(0.5 * 30 * 20 * 5)

    third = call(tmp_path, "part_create", name="upright")
    call(tmp_path, "feature_extrude", part=third["part"],
         profile={"shape": "rectangle", "width": 20, "height": 30}, plane="XZ", distance=4)
    upright = call(tmp_path, "part_get", part=third["part"])
    assert upright["bounds_mm"]["max"][1] == pytest.approx(0)
    assert upright["bounds_mm"]["min"][1] == pytest.approx(-4)


def test_cad_tube_primitive(tmp_path):
    call(tmp_path, "project_create", name="demo")
    part = call(tmp_path, "part_create", name="tube", material="alu-6061")
    tube = call(tmp_path, "feature_tube", part=part["part"],
                outer_diameter=100, wall_thickness=2, length=80)
    expected = math.pi * (50 ** 2 - 48 ** 2) * 80
    assert tube["volume_mm3"] == pytest.approx(expected, rel=1e-3)
    assert tube["mass_g"] == pytest.approx(expected * 2700 / 1e6, rel=1e-3)
    assert tube["bounds_mm"]["min"] == pytest.approx([-50, -50, 0])
    assert tube["bounds_mm"]["max"] == pytest.approx([50, 50, 80])

    along_x = call(tmp_path, "part_create", name="tube-x")
    call(tmp_path, "feature_tube", part=along_x["part"],
         outer_diameter=100, inner_diameter=96, length=80, axis="x")
    tube_x = call(tmp_path, "part_get", part=along_x["part"])
    assert tube_x["bounds_mm"]["min"] == pytest.approx([0, -50, -50])
    assert tube_x["bounds_mm"]["max"] == pytest.approx([80, 50, 50])

    with pytest.raises(ValidationError):
        call(tmp_path, "feature_tube", part=part["part"],
             outer_diameter=100, inner_diameter=96, wall_thickness=2, length=80)
    with pytest.raises(ValidationError):
        call(tmp_path, "feature_tube", part=part["part"],
             outer_diameter=100, inner_diameter=120, length=80)


def test_cad_rejects_invalid_operations(tmp_path):
    with pytest.raises(EngineError) as missing:
        call(tmp_path, "part_list")
    assert missing.value.code == "NOT_FOUND"

    call(tmp_path, "project_create", name="demo")
    with pytest.raises(EngineError) as duplicate:
        call(tmp_path, "project_create", name="demo")
    assert duplicate.value.code == "CONFLICT"

    part = call(tmp_path, "part_create", name="block")
    with pytest.raises(EngineError) as first_hole:
        call(tmp_path, "feature_hole", part=part["part"], x=0, y=0, diameter=4)
    assert first_hole.value.code == "VALIDATION"

    call(tmp_path, "feature_extrude", part=part["part"],
         profile={"shape": "rectangle", "width": 20, "height": 20}, distance=5)
    with pytest.raises(EngineError) as outside:
        call(tmp_path, "feature_hole", part=part["part"], x=100, y=100, diameter=4)
    assert outside.value.code == "VALIDATION"

    with pytest.raises(EngineError) as traversal:
        call(tmp_path, "part_get", part="../escape")
    assert traversal.value.code == "VALIDATION"

    with pytest.raises(EngineError) as unknown_material:
        call(tmp_path, "part_set_material", part=part["part"], material="unobtainium")
    assert unknown_material.value.code == "NOT_FOUND"

    with pytest.raises(ValidationError):
        call(tmp_path, "feature_hole", part=part["part"], x=10, y=10, diameter=4,
             through=False)


def test_cad_lock_serializes_mutations(tmp_path):
    call(tmp_path, "project_create", name="demo")
    with (tmp_path / ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(EngineError) as caught:
            call(tmp_path, "part_create", name="blocked")
        assert caught.value.code == "LOCK"
    assert call(tmp_path, "part_create", name="released")["part"] == "part-000001"


def test_cad_cli_protocol(tmp_path):
    proc = subprocess.run([sys.executable, "-m", "openengineer.cad.cli", "--json"], input=json.dumps({
        "root": str(tmp_path), "op": "project_create", "name": "cli",
    }), text=True, capture_output=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert payload["result"]["name"] == "cli"

    proc = subprocess.run([sys.executable, "-m", "openengineer.cad.cli", "--json"], input=json.dumps({
        "root": str(tmp_path), "op": "unknown_operation",
    }), text=True, capture_output=True)
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["ok"] is False
    assert payload["code"] == "VALIDATION"


def test_cad_edges_batch_groups_update_delete_and_render(tmp_path):
    call(tmp_path, "project_create", name="demo")
    part = call(tmp_path, "part_create", name="block", material="alu-6061")["part"]
    ext = call(tmp_path, "feature_extrude", part=part,
               profile={"shape": "rectangle", "width": 40, "height": 40, "center": [20, 20]},
               distance=5)
    assert ext["bounds_tight_mm"] is not None
    assert ext["bounds_tight_mm"]["max"] == pytest.approx([40, 40, 5], abs=0.1)

    edges = call(tmp_path, "part_edges", part=part, kind="line", axis="z")
    assert edges["returned"] >= 4
    assert all(edge["axis"] == "z" for edge in edges["edges"])
    boxed = call(tmp_path, "part_edges", part=part,
                 box={"min": [0, 0, 0], "max": [40, 40, 10]})
    assert boxed["returned"] > 0

    dry = call(tmp_path, "features_apply", part=part,
               features=[{"type": "hole", "x": 10, "y": 10, "diameter": 4}], dry_run=True)
    assert dry["dry_run"] is True and dry["applied"] == 1
    assert len(call(tmp_path, "part_get", part=part)["features"]) == 1

    call(tmp_path, "features_apply", part=part,
         features=[{"type": "hole", "x": 10, "y": 10, "diameter": 4}])
    group = call(tmp_path, "feature_fillet_group", part=part, operations=[
        {"radius": 1.0, "selector": {"kind": "all"}},
    ])
    assert group["feature"]["type"] == "fillet_group"
    feature_id = group["feature"]["id"]

    updated = call(tmp_path, "feature_update", part=part, feature_id=feature_id,
                   parameters={"operations": [{"radius": 0.5, "selector": {"kind": "all"}}]})
    assert updated["feature"]["operations"][0]["radius"] == 0.5

    with pytest.raises(EngineError):
        call(tmp_path, "feature_fillet_group", part=part, operations=[
            {"radius": 1000.0, "selector": {"kind": "all"}},
        ])
    assert len(call(tmp_path, "part_get", part=part)["features"]) == 3

    deleted = call(tmp_path, "feature_delete", part=part, feature_id=feature_id)
    assert deleted["deleted"] == feature_id
    assert deleted["features"] == 2

    rendered = call(tmp_path, "part_render", part=part, view="iso", size=500)
    assert Path(rendered["path"]).exists()
    assert rendered["bytes"] > 1000


def test_cad_extrude_direction_and_hole_axis(tmp_path):
    call(tmp_path, "project_create", name="demo")
    part = call(tmp_path, "part_create", name="block")["part"]
    reversed_extrude = call(tmp_path, "feature_extrude", part=part,
                            profile={"shape": "rectangle", "width": 40, "height": 40, "center": [20, 20]},
                            distance=10, direction="reverse")
    assert reversed_extrude["bounds_mm"]["min"][2] == pytest.approx(-10)
    assert reversed_extrude["bounds_mm"]["max"][2] == pytest.approx(0)

    through = call(tmp_path, "feature_hole", part=part, x=0, y=0, diameter=4,
                   axis="x", at=[20, 20, -5])
    assert through["volume_mm3"] < reversed_extrude["volume_mm3"]
    around_y = call(tmp_path, "feature_hole", part=part, x=0, y=0, diameter=3,
                    axis="y", at=[20, 20, -5])
    assert around_y["volume_mm3"] < through["volume_mm3"]

    with pytest.raises(ValidationError):
        call(tmp_path, "feature_hole", part=part, x=0, y=0, diameter=4, axis="x")


def test_cad_hash_guard_and_part_import(tmp_path):
    call(tmp_path, "project_create", name="demo")
    part = call(tmp_path, "part_create", name="guarded")["part"]
    call(tmp_path, "feature_extrude", part=part,
         profile={"shape": "rectangle", "width": 20, "height": 20}, distance=5)
    path = tmp_path / "parts" / f"{part}.json"
    data = json.loads(path.read_text())
    data["name"] = "hand edited"
    path.write_text(json.dumps(data))

    with pytest.raises(EngineError) as caught:
        call(tmp_path, "part_get", part=part)
    assert caught.value.code == "CONFLICT"

    imported = call(tmp_path, "part_import", part=part,
                    spec={"name": "imported", "features": data["features"]})
    assert imported["name"] == "imported"
    assert call(tmp_path, "part_get", part=part)["name"] == "imported"
