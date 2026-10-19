"""Atomic project storage, locking and immutable revisions."""
import fcntl
import hashlib
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4

from ..errors import EngineError
from .models import Part, Project

PART_ID = re.compile(r"^part-\d{6}$")
REVISION_ID = re.compile(r"^revision-\d{6}-[0-9a-f]{8}$")
FEATURE_ID = re.compile(r"^feature-\d{3,6}$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def project_file(root: Path) -> Path:
    return root / "project.json"


def parts_dir(root: Path) -> Path:
    return root / "parts"


def revisions_dir(root: Path) -> Path:
    return root / "revisions"


def artifacts_dir(root: Path) -> Path:
    return root / "artifacts"


def ensure_layout(root: Path) -> None:
    parts_dir(root).mkdir(parents=True, exist_ok=True)
    revisions_dir(root).mkdir(parents=True, exist_ok=True)
    artifacts_dir(root).mkdir(parents=True, exist_ok=True)


@contextmanager
def project_lock(root: Path):
    """Serialize mutations; the OS releases the advisory lock if the process dies."""
    try:
        fd = os.open(root / ".lock", os.O_CREAT | os.O_WRONLY, 0o600)
    except OSError as exc:
        raise EngineError("IO", f"Cannot open project lock: {exc}") from None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise EngineError("LOCK", "Another CAD operation holds the project lock") from None
        yield
    finally:
        os.close(fd)


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise EngineError("NOT_FOUND", f"Missing file: {path}") from None
    except OSError as exc:
        raise EngineError("IO", f"Cannot read {path}: {exc}") from None
    except json.JSONDecodeError as exc:
        raise EngineError("ENGINE", f"Invalid JSON in {path}: {exc}") from None


def atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temp.write_text(json.dumps(data, indent=2) + "\n")
        os.replace(temp, path)
    except OSError as exc:
        temp.unlink(missing_ok=True)
        raise EngineError("IO", f"Cannot write {path}: {exc}") from None


def load_project(root: Path) -> Project:
    if not project_file(root).exists():
        raise EngineError("NOT_FOUND", "No project found; call cad_project_create first")
    return Project.model_validate(read_json(project_file(root)))


def create_project(root: Path, name: str, units: str = "mm") -> dict:
    root.mkdir(parents=True, exist_ok=True)
    with project_lock(root):
        if project_file(root).exists():
            raise EngineError("CONFLICT", "A project already exists in this directory")
        ensure_layout(root)
        project = Project(name=name, units=units, created=now())
        atomic_write_json(project_file(root), project.model_dump(mode="json", by_alias=True))
        return {"project": project.name, "name": project.name, "units": project.units,
                "directory": str(root), "created": project.created}


def part_path(root: Path, part_id: str) -> Path:
    if not PART_ID.match(part_id):
        raise EngineError("VALIDATION", f"Invalid part id: {part_id}")
    return parts_dir(root) / f"{part_id}.json"


def state_file(root: Path) -> Path:
    return parts_dir(root) / ".state.json"


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_state(root: Path) -> dict:
    path = state_file(root)
    return read_json(path) if path.exists() else {}


def read_part(root: Path, part_id: str, check: bool = True) -> Part:
    path = part_path(root, part_id)
    if not path.exists():
        raise EngineError("NOT_FOUND", f"Unknown part: {part_id}")
    if check:
        entry = read_state(root).get(part_id)
        if entry is not None and entry.get("hash") != file_digest(path):
            raise EngineError(
                "CONFLICT",
                f"Part {part_id} was modified outside the CAD tools; use cad_part_import to load an explicit spec",
            )
    return Part.model_validate(read_json(path))


def write_part(root: Path, spec: Part) -> None:
    path = part_path(root, spec.id)
    atomic_write_json(path, spec.model_dump(mode="json", by_alias=True))
    state = read_state(root)
    state[spec.id] = {"hash": file_digest(path), "updated": now()}
    atomic_write_json(state_file(root), state)


def next_part_id(root: Path) -> str:
    numbers = [int(path.stem.split("-")[1]) for path in parts_dir(root).glob("part-*.json")
               if PART_ID.match(path.stem)]
    return f"part-{max(numbers, default=0) + 1:06d}"


def next_feature_id(spec: Part) -> str:
    numbers = [int(feature.id.split("-")[1]) for feature in spec.features
               if feature.id and FEATURE_ID.match(feature.id)]
    return f"feature-{max(numbers, default=0) + 1:03d}"


def list_parts(root: Path) -> list[dict]:
    load_project(root)
    parts = []
    for path in sorted(parts_dir(root).glob("part-*.json")):
        spec = Part.model_validate(read_json(path))
        parts.append({"part": spec.id, "name": spec.name, "material": spec.material,
                      "features": len(spec.features)})
    return parts


def part_hash(spec: Part) -> str:
    canonical = json.dumps(spec.model_dump(mode="json", by_alias=True), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def file_hashes(root: Path) -> dict[str, str]:
    hashes = {}
    for path in [project_file(root), *sorted(parts_dir(root).glob("part-*.json"))]:
        if path.exists():
            hashes[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def revision_dirs(root: Path) -> list[Path]:
    return sorted(path for path in revisions_dir(root).glob("revision-*") if path.is_dir())


def last_manifest(root: Path) -> dict | None:
    revisions = revision_dirs(root)
    if not revisions:
        return None
    return read_json(revisions[-1] / "manifest.json")


def commit(root: Path, message: str) -> dict:
    if not message.strip():
        raise EngineError("VALIDATION", "A commit message is required")
    with project_lock(root):
        load_project(root)
        files = file_hashes(root)
        previous = last_manifest(root)
        if previous is not None and previous["files"] == files:
            raise EngineError("CONFLICT", "No changes to commit since the last revision")
        number = len(revision_dirs(root)) + 1
        seed = json.dumps({"message": message, "files": files}, sort_keys=True)
        revision = f"revision-{number:06d}-{hashlib.sha256(seed.encode()).hexdigest()[:8]}"
        timestamp = now()
        stage = revisions_dir(root) / f".staging-{uuid4().hex}"
        try:
            for relative in files:
                source = root / relative
                destination = stage / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
            manifest = {"schema": 1, "id": revision, "timestamp": timestamp, "message": message,
                        "parts": len(list(parts_dir(root).glob("part-*.json"))), "files": files}
            atomic_write_json(stage / "manifest.json", manifest)
            os.replace(stage, revisions_dir(root) / revision)
        except OSError as exc:
            shutil.rmtree(stage, ignore_errors=True)
            raise EngineError("IO", f"Cannot publish revision: {exc}") from None
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        return {"revision": revision, "directory": str((revisions_dir(root) / revision).resolve()),
                "message": message, "timestamp": timestamp, "parts": manifest["parts"],
                "files": len(files)}


def history(root: Path) -> dict:
    load_project(root)
    revisions = []
    for directory in revision_dirs(root):
        manifest = read_json(directory / "manifest.json")
        revisions.append({"revision": manifest["id"], "message": manifest["message"],
                          "timestamp": manifest["timestamp"], "parts": manifest["parts"]})
    return {"revisions": revisions}


def status(root: Path) -> dict:
    project = load_project(root)
    previous = last_manifest(root)
    parts = list(parts_dir(root).glob("part-*.json"))
    files = file_hashes(root)
    dirty = bool(parts) if previous is None else previous["files"] != files
    return {"project": project.name, "name": project.name, "units": project.units,
            "parts": len(parts), "last_revision": previous["id"] if previous else None,
            "dirty": dirty}
