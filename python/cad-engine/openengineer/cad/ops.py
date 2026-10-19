"""Operation handlers for the cad_* tool suite."""
import os
from pathlib import Path
from uuid import uuid4

from build123d import export_gltf, export_step, export_stl
from pydantic import TypeAdapter

from ..errors import EngineError
from . import store
from .features import build_part, inspect_shape, summarize
from .materials import get_material, list_materials
from .models import (
    CommitRequest, ExportRequest, Feature, MaterialRequest, Part, PartCreate, PartRef,
    ProjectCreate,
)

FEATURE_ADAPTER = TypeAdapter(Feature)
EXPORTERS = {"step": export_step, "stl": export_stl, "gltf": export_gltf}


def _no_args(args: dict) -> None:
    if args:
        raise EngineError("VALIDATION", f"Unexpected fields: {', '.join(sorted(args))}")


def project_create(root: Path, args: dict) -> dict:
    request = ProjectCreate.model_validate(args)
    return store.create_project(root, request.name, request.units)


def project_status(root: Path, args: dict) -> dict:
    _no_args(args)
    return store.status(root)


def project_commit(root: Path, args: dict) -> dict:
    request = CommitRequest.model_validate(args)
    return store.commit(root, request.message)


def project_history(root: Path, args: dict) -> dict:
    _no_args(args)
    return store.history(root)


def material_list(root: Path, args: dict) -> dict:
    _no_args(args)
    return {"materials": list_materials()}


def part_create(root: Path, args: dict) -> dict:
    request = PartCreate.model_validate(args)
    get_material(request.material)
    with store.project_lock(root):
        store.load_project(root)
        part_id = store.next_part_id(root)
        spec = Part(id=part_id, name=request.name, material=request.material,
                    features=[], created=store.now())
        store.write_part(root, spec)
        return {"part": part_id, "name": spec.name, "material": spec.material, "features": []}


def part_list(root: Path, args: dict) -> dict:
    _no_args(args)
    return {"parts": store.list_parts(root)}


def part_get(root: Path, args: dict) -> dict:
    request = PartRef.model_validate(args)
    store.load_project(root)
    return summarize(store.read_part(root, request.part))


def part_rebuild(root: Path, args: dict) -> dict:
    request = PartRef.model_validate(args)
    store.load_project(root)
    return summarize(store.read_part(root, request.part))


def part_set_material(root: Path, args: dict) -> dict:
    request = MaterialRequest.model_validate(args)
    get_material(request.material)
    with store.project_lock(root):
        store.load_project(root)
        spec = store.read_part(root, request.part)
        candidate = spec.model_copy(update={"material": request.material})
        shape = build_part(candidate)
        measured = inspect_shape(shape, candidate.material)
        store.write_part(root, candidate)
        return {"part": candidate.id, "name": candidate.name, "material": candidate.material,
                "features": [feature.model_dump(mode="json", by_alias=True) for feature in candidate.features],
                **measured}


def _feature(root: Path, args: dict, feature_type: str) -> dict:
    part_id = args.get("part")
    if not isinstance(part_id, str):
        raise EngineError("VALIDATION", "part is required")
    payload = {key: value for key, value in args.items() if key != "part"}
    with store.project_lock(root):
        store.load_project(root)
        spec = store.read_part(root, part_id)
        feature = FEATURE_ADAPTER.validate_python({**payload, "type": feature_type,
                                                   "id": store.next_feature_id(spec)})
        candidate = spec.model_copy(update={"features": [*spec.features, feature]})
        shape = build_part(candidate)
        measured = inspect_shape(shape, candidate.material)
        store.write_part(root, candidate)
        return {"part": part_id, "feature": feature.model_dump(mode="json", by_alias=True), **measured}


def feature_extrude(root: Path, args: dict) -> dict:
    return _feature(root, args, "extrude")


def feature_hole(root: Path, args: dict) -> dict:
    return _feature(root, args, "hole")


def feature_fillet(root: Path, args: dict) -> dict:
    return _feature(root, args, "fillet")


def feature_chamfer(root: Path, args: dict) -> dict:
    return _feature(root, args, "chamfer")


def feature_tube(root: Path, args: dict) -> dict:
    return _feature(root, args, "tube")


def part_export(root: Path, args: dict) -> dict:
    request = ExportRequest.model_validate(args)
    store.load_project(root)
    spec = store.read_part(root, request.part)
    shape = build_part(spec)
    measured = inspect_shape(shape, spec.material)
    digest = store.part_hash(spec)[:12]
    directory = store.artifacts_dir(root) / spec.id / digest
    target = directory / f"part.{request.format}"
    if not target.exists() or target.stat().st_size == 0:
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / f".{uuid4().hex}.{request.format}"
        try:
            exported = EXPORTERS[request.format](shape, temporary)
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise EngineError("EXPORT", f"{request.format.upper()} export failed: {exc}") from None
        if not exported or not temporary.exists() or temporary.stat().st_size == 0:
            temporary.unlink(missing_ok=True)
            raise EngineError("EXPORT", f"{request.format.upper()} export produced no file")
        os.replace(temporary, target)
    return {"part": spec.id, "format": request.format, "path": str(target.resolve()),
            "relative_path": target.relative_to(root).as_posix(),
            "bytes": target.stat().st_size, "checks": measured["checks"]}


HANDLERS = {
    "project_create": project_create,
    "project_status": project_status,
    "project_commit": project_commit,
    "project_history": project_history,
    "part_create": part_create,
    "part_list": part_list,
    "part_get": part_get,
    "part_rebuild": part_rebuild,
    "part_set_material": part_set_material,
    "feature_extrude": feature_extrude,
    "feature_hole": feature_hole,
    "feature_fillet": feature_fillet,
    "feature_chamfer": feature_chamfer,
    "feature_tube": feature_tube,
    "part_export": part_export,
    "material_list": material_list,
}


def dispatch(root: Path, operation: str, args: dict) -> dict:
    handler = HANDLERS.get(operation)
    if handler is None:
        raise EngineError("VALIDATION", f"Unknown operation: {operation}")
    return handler(root, args)
