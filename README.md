# OpenEngineer

A first working engineering tool for DeepSeek Harness: build, modify and verify a parametric L mounting bracket from measured YAML. No custom GUI, photograph interpretation or arbitrary generated Python execution.

## Quick start

macOS or Linux, Python 3.12, uv, Node 22.19+ (or 24+), pnpm 10.6.5:

```sh
uv sync --locked
pnpm install --frozen-lockfile
pnpm build
uv run openengineer --input examples/mounting-bracket/dimensions.yaml --output artifacts --reason 'Initial reconstruction'
uv run openengineer --input examples/mounting-bracket/dimensions.yaml --output artifacts --reason 'Increase overall height for clearance' --set height=45
uv run pytest -q
pnpm test
```

Each successful build creates `artifacts/revision-NNNNNN-ID/` containing:

- `part.step`: real OpenCascade solid exported to STEP, then reimported and checked.
- `parameters.yaml`: complete editable parameters and measurement provenance.
- `record.json`: previous revision, actual parameter differences, decision, hashes and measured validation results.
- `report.md`: human-readable dimensions, assumptions, changes and verification limits.

To continue a modified design, use its **revision's parameters.yaml** as the next input. Reusing the example deliberately resets parameters to that example before applying overrides. One output directory represents one part's sequential history. Source inputs remain unchanged.

## Harness integration

The external plugin uses the real Cordis registry and `defineTool` API. Tested packages: Harness `0.2.1-rc.2`, Cordis `4.0.5`, Schemastery `3.18.5`. See [architecture and compatibility](docs/architecture.md).

```sh
pnpm build
node scripts/harness-config.mjs
npx @deepseek-ai/dsh@0.2.1-rc.2 web --patch "$PWD/harness.local.yaml"
```

The patch points to this checkout's compiled plugin, installed Python interpreter and project root. Keep this checkout and its `node_modules` present. Regenerate the patch after moving it. This is a local external plugin, not a published npm bundle.

Configure the LLM provider in Harness, then ask:

> Use openengineer_build_bracket with input examples/mounting-bracket/dimensions.yaml and reason Initial reconstruction. Report the verified artifact directory and assumptions.

Then:

> Use the parameters.yaml from the returned revision, change height to 45 mm, and record the reason Increase clearance. Report the new measured dimensions and history.

The plugin uses the provider configured in Harness; OpenEngineer does not implement provider adapters or require its own API key. The automated integration test invokes the real Harness registry without an LLM or Web UI. Live provider selection and natural-language behavior are **not yet acceptance-tested**.

The bundled dimensions are **synthetic test data**, not measurements taken from a physical part. Their provenance labels exercise the schema; replace them with your own observations before reverse engineering a real component.

## Geometry contract

All dimensions are millimeters. The origin is the minimum XYZ corner. The foot occupies X=[0,length], Y=[0,width], Z=[0,thickness]. The upright occupies Y=[0,thickness], Z=[0,height]. Height is overall height. Holes pass vertically through the foot and must clear both the upright and outer edges, and must not overlap.

Every dimension requires `value`, `source` (`measured`, `estimated`, `assumed`) and a descriptive `note`. Missing data raises validation errors; it is never silently inferred. Tool overrides are explicitly recorded as assumed, with the change reason. For measured updates, edit the YAML with the actual provenance.

Checks inspect both the native BREP and the reimported STEP: validity, one solid, origin, bounding dimensions, analytic volume, and circular boundaries at each hole's specified entry/exit center and radius (absolute tolerance 1e-5 mm; relative 1e-8). STEP carries geometry; the YAML and construction recipe retain parametric editability. STEP is not a feature-history file.

## Scope and operational limits

Only this deterministic bracket recipe is executable. The Python subprocess is **not an OS security sandbox**. Do not add arbitrary code execution without a separately reviewed isolation mechanism. The tool constrains input/output paths to a trusted configured project; concurrent adversarial filesystem changes are outside that boundary. Timeout and cancellation terminate the Python child.

Revision directories become visible only after all checks pass. An advisory OS lock serializes builds and releases on process death. An interrupted build can leave a hidden `.building-*` directory, which is not a committed revision. Delete abandoned staging directories only when no build is running. The persistent `.lock` file is normal; never delete it during a build. This implementation uses POSIX `flock`; Windows needs a lock adapter before support can be claimed.

No strength, materials, tolerances, bend radii or manufacturing suitability are certified. Free-text requirements are retained for review, not automatically verified. Human engineering review remains necessary before physical use.

The first repository keeps the working Python geometry and validation together. No separate validation package or unused CAD backend interface is introduced yet. [Implementation plan and audit](docs/architecture.md) records the next increments; [the roadmap](docs/roadmap.md) tracks the remaining work by priority.

## License

MIT — see [LICENSE](LICENSE).
