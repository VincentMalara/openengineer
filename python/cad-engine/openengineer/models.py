from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Dimension(StrictModel):
    value: float = Field(gt=0, le=10000)
    source: Literal["measured", "estimated", "assumed"]
    note: str = Field(min_length=1, max_length=2000)


class Hole(StrictModel):
    x: Dimension
    y: Dimension
    diameter: Dimension


class Bracket(StrictModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
    units: Literal["mm"]
    length: Dimension
    width: Dimension
    height: Dimension
    thickness: Dimension
    holes: list[Hole] = Field(min_length=1, max_length=100)
    requirements: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def geometry_constraints(self):
        l, w, h, t = (getattr(self, k).value for k in ("length", "width", "height", "thickness"))
        if t >= min(l, w, h):
            raise ValueError("thickness must be smaller than length, width and height")
        for i, hole in enumerate(self.holes):
            x, y, r = hole.x.value, hole.y.value, hole.diameter.value / 2
            if not (r + 1e-5 < x < l-r-1e-5 and t+r+1e-5 < y < w-r-1e-5):
                raise ValueError(f"hole {i} intersects an edge or the upright")
            for other in self.holes[:i]:
                if (x-other.x.value)**2 + (y-other.y.value)**2 <= (r+other.diameter.value/2+1e-5)**2:
                    raise ValueError("holes must not overlap or touch")
        return self
