import argparse
import json
from pathlib import Path
import sys

from ..errors import EngineError, error_details
from . import ops


def _request() -> dict:
    raw = sys.stdin.read(1_000_001)
    if len(raw) > 1_000_000:
        raise EngineError("VALIDATION", "JSON request exceeds 1 MB")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EngineError("VALIDATION", f"Invalid JSON request: {exc}") from None
    if not isinstance(request, dict):
        raise EngineError("VALIDATION", "JSON request must be an object")
    return request


def main():
    parser = argparse.ArgumentParser(description="Deterministic CAD suite operations")
    parser.add_argument("--json", action="store_true", help="Read one JSON request on stdin")
    parser.parse_args()
    try:
        request = _request()
        root = request.pop("root", None)
        operation = request.pop("op", None)
        if not isinstance(root, str) or not isinstance(operation, str):
            raise EngineError("VALIDATION", "root and op are required")
        result = ops.dispatch(Path(root).resolve(), operation, request)
        print(json.dumps({"ok": True, "result": result}))
    except Exception as exc:
        code, message = error_details(exc)
        print(json.dumps({"ok": False, "code": code, "error": message}))
        sys.exit(1)


if __name__ == "__main__":
    main()
