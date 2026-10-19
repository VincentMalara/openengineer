import argparse
import json
from pathlib import Path
import sys

from pydantic import ValidationError

from .errors import EngineError


def _message(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        details = []
        for error in exc.errors():
            location = ".".join(str(part) for part in error["loc"]) or "input"
            details.append(f"{location}: {error['msg']}")
        return "; ".join(details)
    return str(exc)


def _code(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "VALIDATION"
    if isinstance(exc, EngineError):
        return exc.code
    if isinstance(exc, OSError):
        return "IO"
    return "ENGINE"


def _request_from_stdin() -> dict:
    raw = sys.stdin.read(1_000_001)
    if len(raw) > 1_000_000:
        raise EngineError("VALIDATION", "JSON request exceeds 1 MB")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EngineError("VALIDATION", f"Invalid JSON request: {exc}") from None
    if not isinstance(request, dict):
        raise EngineError("VALIDATION", "JSON request must be an object")
    unknown = set(request) - {"input", "output", "reason", "overrides"}
    if unknown:
        raise EngineError("VALIDATION", f"Unknown request fields: {', '.join(sorted(unknown))}")
    missing = {"input", "output", "reason"} - set(request)
    if missing:
        raise EngineError("VALIDATION", f"Missing request fields: {', '.join(sorted(missing))}")
    overrides = request.get("overrides")
    if overrides is not None and not isinstance(overrides, dict):
        raise EngineError("VALIDATION", "overrides must be an object")
    return request


def main():
    parser = argparse.ArgumentParser(description="Build and verify a parametric mounting bracket")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--reason")
    parser.add_argument("--set", action="append", default=[], metavar="PARAMETER=VALUE")
    parser.add_argument("--json", action="store_true", help="Read one JSON request on stdin")
    args = parser.parse_args()
    try:
        from .pipeline import run
        if args.json:
            request = _request_from_stdin()
            result = run(Path(request["input"]), Path(request["output"]), request["reason"], request.get("overrides"))
        else:
            if not args.input or not args.output or not args.reason:
                parser.error("--input, --output and --reason are required")
            overrides = {}
            for item in args.set:
                if "=" not in item:
                    raise EngineError("VALIDATION", f"Invalid --set value: {item}; expected PARAMETER=VALUE")
                key, value = item.split("=", 1)
                overrides[key] = value
            result = run(args.input, args.output, args.reason, overrides)
        print(json.dumps({"ok": True, "result": result}))
    except Exception as exc:
        print(json.dumps({"ok": False, "code": _code(exc), "error": _message(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
