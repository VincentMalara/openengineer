import argparse
import json
from pathlib import Path
import sys


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
            request = json.loads(sys.stdin.read(1_000_001))
            if set(request) - {"input", "output", "reason", "overrides"}:
                raise ValueError("Unknown request fields")
            result = run(Path(request["input"]), Path(request["output"]), request["reason"], request.get("overrides"))
        else:
            if not args.input or not args.output or not args.reason:
                parser.error("--input, --output and --reason are required")
            overrides = dict(item.split("=", 1) for item in args.set)
            result = run(args.input, args.output, args.reason, overrides)
        print(json.dumps({"ok": True, "result": result}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
