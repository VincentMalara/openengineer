"""Operation handlers for the cad_* tool suite."""
import os
from pathlib import Path
from uuid import uuid4

from build123d import export_gltf, export_step, export_stl
from pydantic import TypeAdapter

from ..errors import EngineError
from . import store
from .features import build_part, edge_infos, inspect_shape, summarize
from .materials import get_material, list_materials
from .models import (
    CommitRequest, EdgeQuery, ExportRequest, Feature, FeatureRef, FeatureUpdate, FeaturesApply,
    MaterialRequest, Part, PartCreate, PartImport, PartRef, ProjectCreate, RenderRequest,
)
from .render import render_part

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


def feature_fillet_group(root: Path, args: dict) -> dict:
    return _feature(root, args, "fillet_group")


def feature_chamfer_group(root: Path, args: dict) -> dict:
    return _feature(root, args, "chamfer_group")


def _next_numbers(spec: Part, offset: int = 0) -> int:
    numbers = [int(feature.id.split("-")[1]) for feature in spec.features
               if feature.id and feature.id.startswith("feature-")]
    return max(numbers, default=0) + offset + 1


def features_apply(root: Path, args: dict) -> dict:
    request = FeaturesApply.model_validate(args)
    with store.project_lock(root):
        store.load_project(root)
        spec = store.read_part(root, request.part)
        features = []
        for index, payload in enumerate(request.features, 1):
            features.append(FEATURE_ADAPTER.validate_python({
                **payload, "id": f"feature-{_next_numbers(spec, index - 1):03d}",
            }))
        candidate = spec.model_copy(update={"features": [*spec.features, *features]})
        shape = build_part(candidate)
        measured = inspect_shape(shape, candidate.material)
        if not request.dry_run:
            store.write_part(root, candidate)
        return {"part": candidate.id, "applied": len(features), "dry_run": request.dry_run,
                "feature_ids": [feature.id for feature in features], **measured}


def feature_update(root: Path, args: dict) -> dict:
    request = FeatureUpdate.model_validate(args)
    with store.project_lock(root):
        store.load_project(root)
        spec = store.read_part(root, request.part)
        index = next((i for i, feature in enumerate(spec.features)
                      if feature.id == request.feature_id), None)
        if index is None:
            raise EngineError("NOT_FOUND", f"Unknown feature: {request.feature_id}")
        current = spec.features[index]
        merged = current.model_dump(mode="json", by_alias=True)
        merged.update(request.parameters)
        merged["id"] = current.id
        merged["type"] = current.type
        feature = FEATURE_ADAPTER.validate_python(merged)
        features = list(spec.features)
        features[index] = feature
        candidate = spec.model_copy(update={"features": features})
        shape = build_part(candidate)
        measured = inspect_shape(shape, candidate.material)
        store.write_part(root, candidate)
        return {"part": candidate.id, "feature": feature.model_dump(mode="json", by_alias=True),
                **measured}


def feature_delete(root: Path, args: dict) -> dict:
    request = FeatureRef.model_validate(args)
    with store.project_lock(root):
        store.load_project(root)
        spec = store.read_part(root, request.part)
        features = [feature for feature in spec.features if feature.id != request.feature_id]
        if len(features) == len(spec.features):
            raise EngineError("NOT_FOUND", f"Unknown feature: {request.feature_id}")
        if not features:
            raise EngineError("VALIDATION", "Cannot delete the last feature")
        candidate = spec.model_copy(update={"features": features})
        shape = build_part(candidate)
        measured = inspect_shape(shape, candidate.material)
        store.write_part(root, candidate)
        return {"part": candidate.id, "deleted": request.feature_id, "features": len(features),
                **measured}


def part_edges(root: Path, args: dict) -> dict:
    request = EdgeQuery.model_validate(args)
    store.load_project(root)
    spec = store.read_part(root, request.part)
    shape = build_part(spec)
    infos = edge_infos(shape)
    selected = []
    for edge in infos:
        if request.kind != "all" and edge["kind"] != request.kind:
            continue
        if request.axis is not None and edge.get("axis") != request.axis:
            continue
        if request.min_length is not None and edge["length_mm"] < request.min_length:
            continue
        if request.box is not None:
            center = edge["center_mm"]
            if not all(lo <= value <= hi for value, lo, hi in zip(center, request.box.min, request.box.max)):
                continue
        selected.append(edge)
    return {"part": spec.id, "total": len(infos), "returned": min(len(selected), request.limit),
            "edges": selected[:request.limit]}


def part_import(root: Path, args: dict) -> dict:
    request = PartImport.model_validate(args)
    with store.project_lock(root):
        store.load_project(root)
        current = store.read_part(root, request.part, check=False)
        merged = current.model_dump(mode="json", by_alias=True)
        merged.update(request.spec)
        merged["id"] = current.id
        merged["created"] = current.created
        merged["schema"] = 1
        spec = Part.model_validate(merged)
        shape = build_part(spec)
        measured = inspect_shape(shape, spec.material)
        store.write_part(root, spec)
        return {"part": spec.id, "name": spec.name, "material": spec.material,
                "features": [feature.model_dump(mode="json", by_alias=True) for feature in spec.features],
                **measured}


def part_render(root: Path, args: dict) -> dict:
    request = RenderRequest.model_validate(args)
    store.load_project(root)
    spec = store.read_part(root, request.part)
    shape = build_part(spec)
    measured = inspect_shape(shape, spec.material)
    digest = store.part_hash(spec)[:12]
    directory = store.artifacts_dir(root) / spec.id / digest
    target = directory / f"preview-{request.view}-{request.size}.png"
    if not target.exists() or target.stat().st_size == 0:
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / f".{uuid4().hex}.png"
        try:
            render_part(shape, temporary, request.view, request.size)
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise EngineError("EXPORT", f"Render failed: {exc}") from None
        os.replace(temporary, target)
    return {"part": spec.id, "view": request.view, "path": str(target.resolve()),
            "relative_path": target.relative_to(root).as_posix(),
            "bytes": target.stat().st_size, "checks": measured["checks"]}


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
    "feature_fillet_group": feature_fillet_group,
    "feature_chamfer_group": feature_chamfer_group,
    "feature_tube": feature_tube,
    "features_apply": features_apply,
    "feature_update": feature_update,
    "feature_delete": feature_delete,
    "part_edges": part_edges,
    "part_import": part_import,
    "part_render": part_render,
    "part_export": part_export,
    "material_list": material_list,
}


def dispatch(root: Path, operation: str, args: dict) -> dict:
    handler = HANDLERS.get(operation)
    if handler is None:
        raise EngineError("VALIDATION", f"Unknown operation: {operation}")
    return handler(root, args)
