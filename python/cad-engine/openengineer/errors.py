"""Typed engine failures shared by the pipeline and the CLI protocol."""
from typing import Literal

from pydantic import ValidationError

EngineErrorCode = Literal[
    "VALIDATION", "GEOMETRY", "EXPORT", "LOCK", "IO", "NOT_FOUND", "CONFLICT", "ENGINE",
]


class EngineError(Exception):
    """A failure whose code is stable across protocol versions."""

    def __init__(self, code: EngineErrorCode, message: str):
        super().__init__(message)
        self.code = code


def error_details(exc: Exception) -> tuple[str, str]:
    """Return the stable code and a compact, model-readable message."""
    if isinstance(exc, ValidationError):
        details = []
        for error in exc.errors():
            location = ".".join(str(part) for part in error["loc"]) or "input"
            details.append(f"{location}: {error['msg']}")
        return "VALIDATION", "; ".join(details)
    if isinstance(exc, EngineError):
        return exc.code, str(exc)
    if isinstance(exc, OSError):
        return "IO", str(exc)
    return "ENGINE", str(exc)
