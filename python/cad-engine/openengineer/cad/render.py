"""Headless PNG previews for CAD parts (matplotlib imported lazily)."""
import os
import tempfile
from pathlib import Path

VIEWS = {
    "iso": (25, -55),
    "front": (0, -90),
    "top": (90, -90),
    "right": (0, 0),
}


def render_part(shape, path, view: str = "iso", size: int = 1200) -> None:
    cache = Path(tempfile.gettempdir()) / "openengineer-matplotlib"
    cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(cache))

    import matplotlib

    matplotlib.use("Agg")

    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    import numpy as np

    vertices, triangles = shape.tessellate(0.2)
    points = np.array([[vertex.X, vertex.Y, vertex.Z] for vertex in vertices])
    faces = points[np.array(triangles)]

    figure = plt.figure(figsize=(size / 100, size * 0.75 / 100), dpi=100)
    axes = figure.add_subplot(111, projection="3d")
    collection = Poly3DCollection(
        faces, facecolor="#8fa3bf", edgecolor="#2f3a46", linewidths=0.15,
    )
    axes.add_collection3d(collection)

    bounds = shape.bounding_box()
    center = [(bounds.min.X + bounds.max.X) / 2,
              (bounds.min.Y + bounds.max.Y) / 2,
              (bounds.min.Z + bounds.max.Z) / 2]
    half = max(bounds.max.X - bounds.min.X,
               bounds.max.Y - bounds.min.Y,
               bounds.max.Z - bounds.min.Z) / 2 or 1
    axes.set_xlim(center[0] - half, center[0] + half)
    axes.set_ylim(center[1] - half, center[1] + half)
    axes.set_zlim(center[2] - half, center[2] + half)
    axes.set_box_aspect((1, 1, 1))
    axes.set_proj_type("ortho")
    elevation, azimuth = VIEWS.get(view, VIEWS["iso"])
    axes.view_init(elev=elevation, azim=azimuth)
    axes.set_axis_off()
    figure.subplots_adjust(left=0, right=1, bottom=0, top=1)
    figure.savefig(path, dpi=100, transparent=False, facecolor="white")
    plt.close(figure)
