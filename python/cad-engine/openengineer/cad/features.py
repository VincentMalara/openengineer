"""Deterministic feature interpreter built on build123d/OpenCascade."""
import math

from build123d import (
    Align, Axis, CenterOf, Circle, Cylinder, Plane, Polygon, Pos, Rectangle,
    extrude, fillet,
)

from ..errors import EngineError
from .materials import get_material
from .models import (
    CircleProfile, EdgeSelector, ExtrudeFeature, FilletFeature, HoleFeature,
    Part, PolygonProfile, RectangleProfile,
)

PLANES = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
AXES = {"x": Axis.X, "y": Axis.Y, "z": Axis.Z}


def _sketch(profile):
    if isinstance(profile, RectangleProfile):
        return Pos(profile.center[0], profile.center[1], 0) * Rectangle(profile.width, profile.height)
    if isinstance(profile, CircleProfile):
        return Pos(profile.center[0], profile.center[1], 0) * Circle(profile.radius)
    if isinstance(profile, PolygonProfile):
        return Polygon(*profile.points, align=None)
    raise EngineError("VALIDATION", f"Unsupported profile: {profile}")


def _combine(current, solid, operation: str):
    if current is None:
        if operation != "add":
            raise EngineError("VALIDATION", "The first extrude must use operation 'add'")
        return solid
    if operation == "add":
        return current + solid
    if operation == "cut":
        return current - solid
    if operation == "intersect":
        return current & solid
    raise EngineError("VALIDATION", f"Unsupported operation: {operation}")


def _apply_extrude(current, feature: ExtrudeFeature):
    plane = PLANES[feature.plane]
    if feature.offset:
        plane = plane.offset(feature.offset)
    solid = extrude(plane * _sketch(feature.profile), amount=feature.distance)
    return _combine(current, solid, feature.operation)


def _apply_hole(current, feature: HoleFeature):
    if current is None:
        raise EngineError("VALIDATION", "A hole cannot be the first feature")
    bounds = current.bounding_box()
    top, bottom = bounds.max.Z, bounds.min.Z
    height = (top - bottom) + 1.0 if feature.through else float(feature.depth)
    start = top + 0.5
    cutter = Pos(feature.x, feature.y, start) * Cylinder(
        feature.diameter / 2, height, align=(Align.CENTER, Align.CENTER, Align.MAX))
    before = current.volume
    result = current - cutter
    if abs(result.volume - before) < 1e-9:
        raise EngineError(
            "VALIDATION",
            f"Hole at ({feature.x}, {feature.y}) removes no material; check its position and depth",
        )
    return result


def _select_edges(current, selector: EdgeSelector):
    edges = list(current.edges())
    if selector.kind == "all":
        return edges
    if selector.kind == "parallel":
        return list(current.edges().filter_by(AXES[selector.axis]))
    if selector.kind == "box":
        selected = []
        for edge in edges:
            center = edge.center()
            if all(lo <= value <= hi for value, lo, hi in zip((center.X, center.Y, center.Z), selector.min, selector.max)):
                selected.append(edge)
        return selected
    raise EngineError("VALIDATION", f"Unsupported selector: {selector.kind}")


def _apply_fillet(current, feature: FilletFeature):
    if current is None:
        raise EngineError("VALIDATION", "A fillet cannot be the first feature")
    edges = _select_edges(current, feature.selector)
    if not edges:
        raise EngineError("VALIDATION", "The edge selector matched no edges")
    try:
        return fillet(edges, feature.radius)
    except Exception as exc:  # OpenCascade failures are geometric, not protocol failures.
        raise EngineError("GEOMETRY", f"Fillet failed: {exc}") from None


def build_part(spec: Part):
    """Rebuild the part from its ordered feature list."""
    current = None
    for feature in spec.features:
        if isinstance(feature, ExtrudeFeature):
            current = _apply_extrude(current, feature)
        elif isinstance(feature, HoleFeature):
            current = _apply_hole(current, feature)
        elif isinstance(feature, FilletFeature):
            current = _apply_fillet(current, feature)
        else:
            raise EngineError("VALIDATION", f"Unsupported feature: {feature}")
    if current is None:
        raise EngineError("VALIDATION", "Part has no features; add an extrude first")
    return current


def inspect_shape(shape, material_id: str) -> dict:
    """Measure the built shape and reject invalid or non-manifold results."""
    material = get_material(material_id)
    bounds = shape.bounding_box()
    volume = float(shape.volume)
    checks = {
        "valid": bool(shape.is_valid),
        "single_solid": len(shape.solids()) == 1,
        "positive_volume": volume > 1e-9,
        "finite_bounds": all(math.isfinite(value) for value in (
            bounds.min.X, bounds.min.Y, bounds.min.Z,
            bounds.max.X, bounds.max.Y, bounds.max.Z,
        )),
    }
    if not all(checks.values()):
        raise EngineError("GEOMETRY", f"Geometry validation failed: {checks}")
    mass_g = volume * material["density_kg_m3"] / 1e6
    center = shape.center(CenterOf.MASS)
    return {
        "checks": checks,
        "bounds_mm": {
            "min": [bounds.min.X, bounds.min.Y, bounds.min.Z],
            "max": [bounds.max.X, bounds.max.Y, bounds.max.Z],
        },
        "volume_mm3": volume,
        "mass_g": mass_g,
        "center_of_mass_mm": [center.X, center.Y, center.Z],
        "material_properties": material,
    }


def summarize(spec: Part) -> dict:
    shape = build_part(spec)
    measured = inspect_shape(shape, spec.material)
    return {
        "part": spec.id,
        "name": spec.name,
        "material": spec.material,
        "features": [feature.model_dump(mode="json", by_alias=True) for feature in spec.features],
        **measured,
    }
