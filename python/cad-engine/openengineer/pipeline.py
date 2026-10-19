import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime, timezone
from uuid import uuid4

import yaml
from build123d import export_step, import_step
from .models import Bracket
from .geometry import build, validate


def run(input_path: Path, output: Path, reason: str, overrides: dict | None = None):
    if not reason.strip():
        raise ValueError("A design decision / reason is required")
    if input_path.stat().st_size > 1_000_000:
        raise ValueError("Input YAML exceeds 1 MB")
    source_bytes = input_path.read_bytes()
    data = yaml.safe_load(source_bytes)
    spec = Bracket.model_validate(data)
    before = spec.model_dump()
    data = spec.model_dump()
    for key, value in (overrides or {}).items():
        if key not in ("length", "width", "height", "thickness"):
            raise ValueError(f"Unsupported parameter: {key}; edit YAML to change holes")
        data[key] = {"value": value, "source": "assumed", "note": reason}
    spec = Bracket.model_validate(data)
    output.mkdir(parents=True, exist_ok=True)
    # An exclusive workspace lock prevents history races; committed revisions are immutable.
    lock = output / ".lock"
    fd = os.open(lock, os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise ValueError("Another build holds the project lock") from None
    stage = None
    try:
        revisions = sorted(p for p in output.glob("revision-*") if p.is_dir())
        previous = json.loads((revisions[-1] / "record.json").read_text()) if revisions else None
        if previous and previous["parameters"]["name"] != spec.name:
            raise ValueError("Use a separate output directory for a different part")
        parent = previous["id"] if previous else None
        baseline = previous["parameters"] if previous else before
        revision = f"revision-{len(revisions)+1:06d}-{uuid4().hex[:8]}"
        stage = Path(tempfile.mkdtemp(prefix=".building-", dir=output))
        part = build(spec)
        native = validate(part, spec)
        step = stage / "part.step"
        if not export_step(part, step):
            raise ValueError("STEP export failed")
        roundtrip = validate(import_step(step), spec)
        parameters = spec.model_dump()
        record = {"id": revision, "parent": parent, "timestamp": datetime.now(timezone.utc).isoformat(),
                  "reason": reason, "parameters": parameters,
                  "changes": {k: {"before": baseline.get(k), "after": v} for k,v in parameters.items() if baseline.get(k) != v},
                  "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
                  "step_sha256": hashlib.sha256(step.read_bytes()).hexdigest(),
                  "validation": {"native": native, "step_roundtrip": roundtrip}}
        (stage / "parameters.yaml").write_text(yaml.safe_dump(parameters, sort_keys=False))
        (stage / "record.json").write_text(json.dumps(record, indent=2) + "\n")
        report = [f"# {spec.name} — {revision}", "", f"Decision: {reason}",
                  f"Parent: {parent or 'initial revision'}", "", "Units: mm. Origin: minimum XYZ; upright at y=0.",
                  "", "## Dimensions and provenance"]
        for key in ("length", "width", "height", "thickness"):
            d = getattr(spec,key)
            report.append(f"- {key}: {d.value} mm ({d.source}) — {d.note}")
        for i, hole in enumerate(spec.holes):
            report.append(f"- Hole {i+1}: " + "; ".join(f"{k}={v['value']} mm ({v['source']}: {v['note']})" for k,v in hole.model_dump().items()))
        report += ["", "## Requirements", *[f"- {s}" for s in spec.requirements], "", "## Assumptions", *[f"- {s}" for s in spec.assumptions],
                   "", "## Validation", "Native BREP and reimported STEP: one valid solid, bounding dimensions, volume, hole centers/radii and entry/exit planes passed.",
                   "Only the geometric checks listed above are automated. Free-text requirements are not automatically certified.",
                   "No strength, tolerance, material or manufacturing certification. Photographs are not interpreted.",
                   "", "## Changes", "```json", json.dumps(record["changes"], indent=2), "```"]
        (stage / "report.md").write_text("\n".join(report)+"\n")
        stage.rename(output / revision)
        stage = None
        return {"revision": revision, "directory": str((output/revision).resolve()), "validation": roundtrip}
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        os.close(fd)
        # Keep the lock inode; OS releases the advisory lock even after process termination.
