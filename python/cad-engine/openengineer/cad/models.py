"""Pydantic contracts for projects, parts and ordered features."""
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, populate_by_name=True)


class Project(StrictModel):
    version: int = Field(default=1, alias="schema")
    name: str = Field(min_length=1, max_length=120)
    units: Literal["mm"] = "mm"
    created: str


class RectangleProfile(StrictModel):
    shape: Literal["rectangle"]
    width: float = Field(gt=0, le=10000)
    height: float = Field(gt=0, le=10000)
    center: tuple[float, float] = (0.0, 0.0)


class CircleProfile(StrictModel):
    shape: Literal["circle"]
    radius: float = Field(gt=0, le=5000)
    center: tuple[float, float] = (0.0, 0.0)


class PolygonProfile(StrictModel):
    shape: Literal["polygon"]
    points: list[tuple[float, float]] = Field(min_length=3, max_length=200)


Profile = Annotated[
    Union[RectangleProfile, CircleProfile, PolygonProfile],
    Field(discriminator="shape"),
]


class ExtrudeFeature(StrictModel):
    id: str | None = None
    type: Literal["extrude"] = "extrude"
    profile: Profile
    plane: Literal["XY", "XZ", "YZ"] = "XY"
    offset: float = Field(default=0.0, ge=-10000, le=10000)
    distance: float = Field(gt=0, le=10000)
    direction: Literal["normal", "reverse", "both"] = "normal"
    operation: Literal["add", "cut", "intersect"] = "add"


class HoleFeature(StrictModel):
    id: str | None = None
    type: Literal["hole"] = "hole"
    x: float = Field(ge=-10000, le=10000)
    y: float = Field(ge=-10000, le=10000)
    diameter: float = Field(gt=0, le=1000)
    through: bool = True
    depth: float | None = Field(default=None, gt=0, le=10000)
    axis: Literal["x", "y", "z"] = "z"
    at: tuple[float, float, float] | None = None

    @model_validator(mode="after")
    def depth_required_for_blind_hole(self):
        if not self.through and self.depth is None:
            raise ValueError("depth is required when through is false")
        if self.axis != "z" and self.at is None:
            raise ValueError("at is required when axis is x or y")
        return self


class EdgeSelector(StrictModel):
    kind: Literal["all", "parallel", "box", "circular", "holes"]
    axis: Literal["x", "y", "z"] | None = None
    min: tuple[float, float, float] | None = None
    max: tuple[float, float, float] | None = None
    diameter: float | None = Field(default=None, gt=0, le=1000)
    center: tuple[float, float] | None = None
    z: Literal["top", "bottom", "both"] | None = None

    @model_validator(mode="after")
    def selector_fields(self):
        if self.kind == "parallel" and self.axis is None:
            raise ValueError("axis is required when kind is parallel")
        if self.kind == "box":
            if self.min is None or self.max is None:
                raise ValueError("min and max are required when kind is box")
            if any(lo >= hi for lo, hi in zip(self.min, self.max)):
                raise ValueError("selector min must be smaller than max on every axis")
        if self.kind == "circular" and self.diameter is None and self.center is None and self.z is None:
            raise ValueError("circular selector requires at least one of diameter, center or z")
        return self


class FilletFeature(StrictModel):
    id: str | None = None
    type: Literal["fillet"] = "fillet"
    radius: float = Field(gt=0, le=1000)
    selector: EdgeSelector = Field(default_factory=lambda: EdgeSelector(kind="all"))


class FilletOperation(StrictModel):
    radius: float = Field(gt=0, le=1000)
    selector: EdgeSelector


class FilletGroupFeature(StrictModel):
    id: str | None = None
    type: Literal["fillet_group"] = "fillet_group"
    operations: list[FilletOperation] = Field(min_length=1, max_length=50)


class ChamferFeature(StrictModel):
    id: str | None = None
    type: Literal["chamfer"] = "chamfer"
    distance: float = Field(gt=0, le=1000)
    distance2: float | None = Field(default=None, gt=0, le=1000)
    selector: EdgeSelector = Field(default_factory=lambda: EdgeSelector(kind="all"))


class ChamferOperation(StrictModel):
    distance: float = Field(gt=0, le=1000)
    distance2: float | None = Field(default=None, gt=0, le=1000)
    selector: EdgeSelector


class ChamferGroupFeature(StrictModel):
    id: str | None = None
    type: Literal["chamfer_group"] = "chamfer_group"
    operations: list[ChamferOperation] = Field(min_length=1, max_length=50)


class TubeFeature(StrictModel):
    id: str | None = None
    type: Literal["tube"] = "tube"
    outer_diameter: float = Field(gt=0, le=10000)
    inner_diameter: float | None = Field(default=None, gt=0, le=10000)
    wall_thickness: float | None = Field(default=None, gt=0, le=10000)
    length: float = Field(gt=0, le=10000)
    axis: Literal["x", "y", "z"] = "z"
    operation: Literal["add", "cut", "intersect"] = "add"

    @model_validator(mode="after")
    def tube_dimensions(self):
        if (self.inner_diameter is None) == (self.wall_thickness is None):
            raise ValueError("provide exactly one of inner_diameter or wall_thickness")
        inner = self.inner_diameter
        if inner is None:
            inner = self.outer_diameter - 2 * self.wall_thickness
        if inner <= 0:
            raise ValueError("wall_thickness is too large for outer_diameter")
        if inner >= self.outer_diameter:
            raise ValueError("inner_diameter must be smaller than outer_diameter")
        return self

    @property
    def resolved_inner_diameter(self) -> float:
        if self.inner_diameter is not None:
            return self.inner_diameter
        return self.outer_diameter - 2 * self.wall_thickness


Feature = Annotated[
    Union[
        ExtrudeFeature, HoleFeature, FilletFeature, FilletGroupFeature,
        ChamferFeature, ChamferGroupFeature, TubeFeature,
    ],
    Field(discriminator="type"),
]


class Part(StrictModel):
    version: int = Field(default=1, alias="schema")
    id: str = Field(pattern=r"^part-\d{6}$")
    name: str = Field(min_length=1, max_length=200)
    material: str = Field(min_length=1, max_length=80)
    features: list[Feature] = Field(default_factory=list)
    created: str


class ProjectCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    units: Literal["mm"] = "mm"


class PartCreate(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    material: str = Field(default="steel-1018", min_length=1, max_length=80)


class PartRef(StrictModel):
    part: str


class CommitRequest(StrictModel):
    message: str = Field(min_length=1, max_length=2000)


class MaterialRequest(StrictModel):
    part: str
    material: str = Field(min_length=1, max_length=80)


class ExportRequest(StrictModel):
    part: str
    format: Literal["step", "stl", "gltf"]


class EdgeBox(StrictModel):
    min: tuple[float, float, float]
    max: tuple[float, float, float]

    @model_validator(mode="after")
    def min_max(self):
        if any(lo >= hi for lo, hi in zip(self.min, self.max)):
            raise ValueError("box min must be smaller than max on every axis")
        return self


class EdgeQuery(StrictModel):
    part: str
    kind: Literal["all", "line", "circle", "bspline", "other"] = "all"
    axis: Literal["x", "y", "z"] | None = None
    min_length: float | None = Field(default=None, ge=0)
    box: EdgeBox | None = None
    limit: int = Field(default=200, ge=1, le=1000)


class FeaturesApply(StrictModel):
    part: str
    features: list[dict] = Field(min_length=1, max_length=50)
    dry_run: bool = False


class FeatureRef(StrictModel):
    part: str
    feature_id: str = Field(pattern=r"^feature-\d{3,6}$")


class PartImport(StrictModel):
    part: str
    spec: dict


class FeatureUpdate(StrictModel):
    part: str
    feature_id: str = Field(pattern=r"^feature-\d{3,6}$")
    parameters: dict

    @model_validator(mode="after")
    def protected_parameters(self):
        if "id" in self.parameters or "type" in self.parameters:
            raise ValueError("id and type cannot be changed by feature_update")
        return self


class RenderRequest(StrictModel):
    part: str
    view: Literal["iso", "front", "top", "right"] = "iso"
    size: int = Field(default=1200, ge=400, le=2400)
