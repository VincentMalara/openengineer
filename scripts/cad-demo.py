#!/usr/bin/env python3
"""Build a demo plate and tube with the CAD suite in a throwaway project.

Usage:
    .venv/bin/python scripts/cad-demo.py

The script prints the project directory, the measured parts and the exported
STEP/STL paths. Open the STEP files in any CAD viewer to inspect the result.
"""
import tempfile
from pathlib import Path

from openengineer.cad import ops


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="openengineer-cad-"))
    print(f"Project: {root}\n")

    def call(operation: str, **args):
        result = ops.dispatch(root, operation, args)
        print(f"- {operation}: ok")
        return result

    def size(summary):
        bounds = summary["bounds_mm"]
        return [high - low for low, high in zip(bounds["min"], bounds["max"])]

    call("project_create", name="demo", units="mm")

    plate = call("part_create", name="plate", material="alu-6061")["part"]
    call(
        "feature_extrude", part=plate,
        profile={"shape": "rectangle", "width": 80, "height": 40, "center": [40, 20]},
        distance=6,
    )
    call("feature_hole", part=plate, x=20, y=20, diameter=6)
    call("feature_hole", part=plate, x=60, y=20, diameter=6)
    call("feature_fillet", part=plate, radius=3, selector={"kind": "parallel", "axis": "z"})
    call("feature_chamfer", part=plate, distance=0.5, selector={"kind": "holes", "z": "top"})
    plate_summary = call("part_get", part=plate)
    print(f"\nPart {plate} - {plate_summary['name']} ({plate_summary['material']})")
    print(f"  size: {size(plate_summary)} mm")
    print(f"  volume: {plate_summary['volume_mm3']:.1f} mm3")
    print(f"  mass: {plate_summary['mass_g']:.2f} g")
    print(f"  checks: {plate_summary['checks']}")
    print(f"  features: {len(plate_summary['features'])}")
    plate_step = call("part_export", part=plate, format="step")
    call("part_export", part=plate, format="stl")

    tube = call("part_create", name="tube", material="alu-6061")["part"]
    tube_result = call(
        "feature_tube", part=tube,
        outer_diameter=100, wall_thickness=2, length=80,
    )
    print(f"\nPart {tube} - tube (alu-6061)")
    print(f"  size: {size(tube_result)} mm")
    print(f"  volume: {tube_result['volume_mm3']:.1f} mm3")
    print(f"  mass: {tube_result['mass_g']:.2f} g")
    tube_step = call("part_export", part=tube, format="step")

    print(f"\nPlate STEP: {plate_step['path']}")
    print(f"Tube STEP:  {tube_step['path']}")

    commit = call("project_commit", message="Demo plate with holes/chamfers and a 100 mm tube")
    print(f"\nRevision: {commit['revision']}")
    print(f"Files:    {root / 'project.json'}, {root / 'parts'}")
    print(f"History:  {root / 'revisions' / commit['revision']}")


if __name__ == "__main__":
    main()
