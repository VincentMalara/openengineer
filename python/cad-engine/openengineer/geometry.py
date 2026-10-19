"""The first backend: an L bracket in mm, origin at its minimum XYZ corner."""
from math import isclose, pi
from build123d import Align, Box, Cylinder, GeomType, Pos
from .models import Bracket


def build(spec: Bracket):
    l, w, h, t = (getattr(spec, k).value for k in ("length", "width", "height", "thickness"))
    part = Box(l, w, t, align=(Align.MIN,)*3) + Box(l, t, h, align=(Align.MIN,)*3)
    for hole in spec.holes:
        part -= Pos(hole.x.value, hole.y.value, -1) * Cylinder(
            hole.diameter.value / 2, t+2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part


def validate(part, spec: Bracket):
    """Measure the BREP itself; never report input positions as measured results."""
    l, w, h, t = (getattr(spec, k).value for k in ("length", "width", "height", "thickness"))
    bounds = part.bounding_box()
    size = list(bounds.size)
    close = lambda a, b: isclose(a, b, abs_tol=1e-5, rel_tol=1e-8)
    expected_volume = l*w*t + l*t*(h-t) - sum(pi*(v.diameter.value/2)**2*t for v in spec.holes)
    # Circular boundary edges provide independent hole centers, radii and entry/exit planes.
    circles = []
    for edge in part.edges():
        if edge.geom_type == GeomType.CIRCLE:
            circles.append((*edge.arc_center, edge.radius))
    expected = [(v.x.value, v.y.value, z, v.diameter.value/2) for v in spec.holes for z in (0, t)]
    unmatched = circles.copy()
    for target in expected:
        match = next((i for i, c in enumerate(unmatched) if all(close(a,b) for a,b in zip(c, target))), None)
        if match is None:
            raise ValueError(f"Missing hole boundary in BREP: {target}")
        unmatched.pop(match)
    checks = {
        "valid_solid": bool(part.is_valid and len(part.solids()) == 1),
        "bounds": all(close(a,b) for a,b in zip(size, (l,w,h))) and all(close(v,0) for v in bounds.min),
        "volume": close(part.volume, expected_volume),
        "hole_boundaries": not unmatched,
    }
    if not all(checks.values()):
        raise ValueError(f"Geometry validation failed: {checks}")
    return {"checks": checks, "bounding_mm": size, "volume_mm3": part.volume,
            "hole_boundary_circles_mm": circles}
