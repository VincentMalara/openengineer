"""Deterministic feature interpreter built on build123d/OpenCascade."""
import math

from build123d import (
    Align, Axis, CenterOf, Circle, Cylinder, GeomType, Plane, Polygon, Pos, Rectangle,
    Rotation, chamfer, extrude, fillet,
)

from ..errors import EngineError
from .materials import get_material
from .models import (
    ChamferFeature, CircleProfile, EdgeSelector, ExtrudeFeature, FilletFeature, HoleFeature,
    Part, PolygonProfile, RectangleProfile, TubeFeature,
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


def _edge_center(edge):
    # `Edge.center()` is the curve's centroid; circular selectors need the arc centre.
    return edge.arc_center if edge.geom_type == GeomType.CIRCLE else edge.center()


def _select_edges(current, selector: EdgeSelector, holes=()):
    edges = list(current.edges())
    if selector.kind == "all":
        return edges
    if selector.kind == "parallel":
        return list(current.edges().filter_by(AXES[selector.axis]))
    if selector.kind == "box":
        selected = []
        for edge in edges:
            center = _edge_center(edge)
            if all(lo <= value <= hi for value, lo, hi in zip((center.X, center.Y, center.Z), selector.min, selector.max)):
                selected.append(edge)
        return selected
    if selector.kind in ("circular", "holes"):
        bounds = current.bounding_box()
        selected = []
        for edge in edges:
            if edge.geom_type != GeomType.CIRCLE:
                continue
            center = edge.arc_center
            if selector.kind == "holes":
                if not any(
                        math.isclose(center.X, hole.x, abs_tol=1e-6)
                        and math.isclose(center.Y, hole.y, abs_tol=1e-6)
                        and math.isclose(edge.radius * 2, hole.diameter, abs_tol=1e-6)
                        for hole in holes):
                    continue
            else:
                if selector.diameter is not None and not math.isclose(
                        edge.radius * 2, selector.diameter, abs_tol=1e-6):
                    continue
                if selector.center is not None and not (
                        math.isclose(center.X, selector.center[0], abs_tol=1e-6)
                        and math.isclose(center.Y, selector.center[1], abs_tol=1e-6)):
                    continue
            at_top = math.isclose(center.Z, bounds.max.Z, abs_tol=1e-6)
            at_bottom = math.isclose(center.Z, bounds.min.Z, abs_tol=1e-6)
            if selector.z == "top" and not at_top:
                continue
            if selector.z == "bottom" and not at_bottom:
                continue
            if selector.z == "both" and not (at_top or at_bottom):
                continue
            selected.append(edge)
        return selected
    raise EngineError("VALIDATION", f"Unsupported selector: {selector.kind}")


def _apply_fillet(current, feature: FilletFeature, holes=()):
    if current is None:
        raise EngineError("VALIDATION", "A fillet cannot be the first feature")
    edges = _select_edges(current, feature.selector, holes)
    if not edges:
        raise EngineError("VALIDATION", "The edge selector matched no edges")
    try:
        return fillet(edges, feature.radius)
    except Exception as exc:  # OpenCascade failures are geometric, not protocol failures.
        raise EngineError("GEOMETRY", f"Fillet failed: {exc}") from None


def _apply_chamfer(current, feature: ChamferFeature, holes=()):
    if current is None:
        raise EngineError("VALIDATION", "A chamfer cannot be the first feature")
    edges = _select_edges(current, feature.selector, holes)
    if not edges:
        raise EngineError("VALIDATION", "The edge selector matched no edges")
    try:
        if feature.distance2 is not None:
            return chamfer(edges, feature.distance, feature.distance2)
        return chamfer(edges, feature.distance)
    except Exception as exc:
        raise EngineError("GEOMETRY", f"Chamfer failed: {exc}") from None


def _apply_tube(current, feature: TubeFeature):
    outer_radius = feature.outer_diameter / 2
    inner_radius = feature.resolved_inner_diameter / 2
    outer = Cylinder(outer_radius, feature.length, align=(Align.CENTER, Align.CENTER, Align.MIN))
    bore = Pos(0, 0, -1) * Cylinder(
        inner_radius, feature.length + 2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    tube = outer - bore
    if feature.axis == "x":
        tube = Rotation(0, 90, 0) * tube
    elif feature.axis == "y":
        tube = Rotation(-90, 0, 0) * tube
    return _combine(current, tube, feature.operation)


def build_part(spec: Part):
    """Rebuild the part from its ordered feature list."""
    current = None
    holes = []
    for feature in spec.features:
        if isinstance(feature, ExtrudeFeature):
            current = _apply_extrude(current, feature)
        elif isinstance(feature, HoleFeature):
            current = _apply_hole(current, feature)
            holes.append(feature)
        elif isinstance(feature, FilletFeature):
            current = _apply_fillet(current, feature, holes)
        elif isinstance(feature, ChamferFeature):
            current = _apply_chamfer(current, feature, holes)
        elif isinstance(feature, TubeFeature):
            current = _apply_tube(current, feature)
        else:
            raise EngineError("VALIDATION", f"Unsupported feature: {feature}")
    if current is None:
        raise EngineError("VALIDATION", "Part has no features; add an extrude or tube first")
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
