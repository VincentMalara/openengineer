#!/usr/bin/env python3
"""Build a small demo part with the CAD suite in a throwaway project.

Usage:
    .venv/bin/python scripts/cad-demo.py

The script prints the project directory, the measured part and the exported
STEP/STL paths. Open the STEP in any CAD viewer to inspect the result.
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

    call("project_create", name="demo", units="mm")
    part = call("part_create", name="plate", material="alu-6061")
    part_id = part["part"]

    call(
        "feature_extrude", part=part_id,
        profile={"shape": "rectangle", "width": 80, "height": 40, "center": [40, 20]},
        distance=6,
    )
    call("feature_hole", part=part_id, x=20, y=20, diameter=6)
    call("feature_hole", part=part_id, x=60, y=20, diameter=6)
    call("feature_fillet", part=part_id, radius=3, selector={"kind": "parallel", "axis": "z"})

    summary = call("part_get", part=part_id)
    print(f"\nPart {summary['part']} - {summary['name']} ({summary['material']})")
    print(f"  size: {summary['bounds_mm']['max']} mm")
    print(f"  volume: {summary['volume_mm3']:.1f} mm3")
    print(f"  mass: {summary['mass_g']:.2f} g")
    print(f"  checks: {summary['checks']}")
    print(f"  features: {len(summary['features'])}")

    step = call("part_export", part=part_id, format="step")
    stl = call("part_export", part=part_id, format="stl")
    print(f"\nSTEP: {step['path']}")
    print(f"STL:  {stl['path']}")

    commit = call("project_commit", message="Demo plate with two holes and fillets")
    print(f"\nRevision: {commit['revision']}")
    print(f"Files:    {root / 'project.json'}, {root / 'parts' / (part_id + '.json')}")
    print(f"History:  {root / 'revisions' / commit['revision']}")


if __name__ == "__main__":
    main()
