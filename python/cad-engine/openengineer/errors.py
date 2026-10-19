"""Typed engine failures shared by the pipeline and the CLI protocol."""
from typing import Literal

EngineErrorCode = Literal["VALIDATION", "GEOMETRY", "EXPORT", "LOCK", "IO", "ENGINE"]


class EngineError(Exception):
    """A failure whose code is stable across protocol versions."""

    def __init__(self, code: EngineErrorCode, message: str):
        super().__init__(message)
        self.code = code
