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
    operation: Literal["add", "cut", "intersect"] = "add"


class HoleFeature(StrictModel):
    id: str | None = None
    type: Literal["hole"] = "hole"
    x: float = Field(ge=-10000, le=10000)
    y: float = Field(ge=-10000, le=10000)
    diameter: float = Field(gt=0, le=1000)
    through: bool = True
    depth: float | None = Field(default=None, gt=0, le=10000)

    @model_validator(mode="after")
    def depth_required_for_blind_hole(self):
        if not self.through and self.depth is None:
            raise ValueError("depth is required when through is false")
        return self


class EdgeSelector(StrictModel):
    kind: Literal["all", "parallel", "box"]
    axis: Literal["x", "y", "z"] | None = None
    min: tuple[float, float, float] | None = None
    max: tuple[float, float, float] | None = None

    @model_validator(mode="after")
    def selector_fields(self):
        if self.kind == "parallel" and self.axis is None:
            raise ValueError("axis is required when kind is parallel")
        if self.kind == "box":
            if self.min is None or self.max is None:
                raise ValueError("min and max are required when kind is box")
            if any(lo >= hi for lo, hi in zip(self.min, self.max)):
                raise ValueError("selector min must be smaller than max on every axis")
        return self


class FilletFeature(StrictModel):
    id: str | None = None
    type: Literal["fillet"] = "fillet"
    radius: float = Field(gt=0, le=1000)
    selector: EdgeSelector = Field(default_factory=lambda: EdgeSelector(kind="all"))


Feature = Annotated[
    Union[ExtrudeFeature, HoleFeature, FilletFeature],
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
