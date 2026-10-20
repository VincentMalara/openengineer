# OpenEngineer

[![CI](https://github.com/VincentMalara/openengineer/actions/workflows/test.yml/badge.svg)](https://github.com/VincentMalara/openengineer/actions/workflows/test.yml)

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

The patch points to this checkout's compiled plugin, installed Python interpreter and project root. Keep this checkout and its `node_modules` present. Regenerate the patch after moving it. This is a local external plugin, not a published npm bundle. The plugin config accepts `root`, `python`, `timeoutMs` and `artifactsDir` (default `artifacts`, resolved inside the project root).

Configure the LLM provider in Harness, then ask:

> Use openengineer_build_bracket with input examples/mounting-bracket/dimensions.yaml and reason Initial reconstruction. Report the verified artifact directory and assumptions.

Then:

> Use the parameters.yaml from the returned revision, change height to 45 mm, and record the reason Increase clearance. Report the new measured dimensions and history.

Two read-only tools support follow-up questions without rebuilding: `openengineer_list_revisions` returns every committed revision with parent, reason, bounds and check status, and `openengineer_inspect_revision` returns one revision's parameters, changes, hashes, artifact paths and full report. Ask:

> List the committed revisions, then inspect the latest one and summarise its dimensions and assumptions.

A successful call returns a structured result: revision, parent, measured bounds and volume, per-check booleans, hole boundary circles and artifact paths. The model sees a readable summary rather than raw JSON. Failures carry a stable code — `VALIDATION`, `PATH`, `TIMEOUT`, `ABORTED`, `LOCK`, `EXPORT`, `GEOMETRY`, `IO`, `NOT_FOUND`, `CONFLICT` or `ENGINE` — alongside a human-readable message.

The plugin uses the provider configured in Harness; OpenEngineer does not implement provider adapters or require its own API key. The automated integration test invokes the real Harness registry without an LLM or Web UI. Live provider selection and natural-language behavior are **not yet acceptance-tested**.

## CAD tool suite

The plugin also registers a generic, deterministic `cad_*` suite. A project lives in the configured root:

```
project.json        # name, units, creation time
parts/*.json        # ordered feature lists
artifacts/          # STEP, STL, glTF, content-addressed by part spec
revisions/          # immutable snapshots with a manifest of hashes
.lock               # advisory lock for mutations
```

Slice 1 covers single parts:

- `cad_project_create/status/commit/history` — draft and immutable revisions.
- `cad_part_create/list/get/rebuild/set_material`, `cad_material_list`.
- `cad_feature_extrude` — rectangle, circle or polygon on XY, XZ or YZ; `direction` normal/reverse/both. Profile coordinates are centred on the plane origin unless `center` is given; the first extrude must be `add`.
- `cad_feature_hole` — through or blind hole along X, Y or Z; `at` gives a 3D centre for X/Y holes.
- `cad_feature_fillet` — all edges, edges parallel to an axis, edges inside a box, circular edges, or hole edges.
- `cad_feature_chamfer` — same selectors as fillet; `{ "kind": "holes", "z": "top" }` chamfers hole entry edges.
- `cad_feature_tube` — a hollow cylinder in one call: outer diameter, length, and either inner diameter or wall thickness. Use it directly for tubes, pipes and bushings instead of composing two extrusions.
- `cad_part_export` — STEP, STL or glTF; `cad_render` — shaded PNG preview.
- `cad_part_edges` — inspect B-rep edges (kind, length, centre, radius, axis) before choosing a selector.
- `cad_features_apply` — append several features in one atomic rebuild; `dry_run` validates without writing.
- `cad_part_import` — explicit, validated import of a hand-edited spec; direct JSON edits are otherwise rejected with `CONFLICT`.
- `cad_feature_update` / `cad_feature_delete` — edit the chain without touching JSON.
- `cad_feature_fillet_group` / `cad_feature_chamfer_group` — several radii/selectors in one atomic feature.

Every mutation rebuilds the part, validates one watertight solid, and measures volume, mass and centre of mass before it is kept. `bounds_tight_mm` uses a mesh-based bound because OCC's analytic box is conservative around B-splines. Parts are hash-guarded: a file edited outside the tools must go through `cad_part_import`. Feature order is the source of truth; there is no hidden state and no generated Python.

> Create a project named demo, create an 80 × 40 × 6 mm aluminium plate with profile center [40, 20] so its corner is at the origin, drill two 6 mm through holes at (20, 20) and (60, 20), fillet the vertical edges with radius 3, chamfer the hole entries by 0.5 mm, then add a tube with outer diameter 100 mm, wall 2 mm and length 80 mm. Export both STEP files and commit.

The generalisation rule: the model composes **primitives and ordered features**, it does not run per-part code. A tube is one `cad_feature_tube`; a bracket is an extrude plus holes and fillets. New part families are added by adding primitives or feature types, never by hardcoding a recipe for one client.

To connect an open Autodesk Fusion session through MCP (`mcp__fusion__*` tools), see [docs/fusion-mcp.md](docs/fusion-mcp.md).

Assembly, BOM, simulation and topology optimization are **not implemented yet**; the intended contract is in [docs/tool-suite.md](docs/tool-suite.md).

### Starting a new project

One plugin instance owns **one project root**: `project.json`, `parts/`, `artifacts/` and `revisions/` live directly in that directory. Calling `cad_project_create` in a root that already has a project returns `CONFLICT`.

To start a separate project, use a new empty directory and a separate server/port:

```sh
mkdir -p ~/Developer/cad-projects/my-project
cd /Users/melissamalara/Developer/cursor_for_cad
CAD_ROOT="$HOME/Developer/cad-projects/my-project" \
HARNESS_PATCH="$PWD/harness.my-project.yaml" \
node scripts/harness-config.mjs
npx @deepseek-ai/dsh@0.2.1-rc.2 web \
  --patch "$PWD/harness.my-project.yaml" \
  --port 61119
```

Open the printed URL, start a new conversation, then ask it to create the project (`cad_project_create`). The plugin code and Python interpreter stay in this checkout; only the project data moves to the new root. The demo server on port 61118 keeps using `harness.local.yaml`.

### Try it

```sh
.venv/bin/python scripts/cad-demo.py
```

The script creates a temporary project, builds an 80 × 40 × 6 mm plate with holes, fillets and chamfers, plus a 100 mm tube, prints its measurements and exports STEP/STL. To test the same path through the plugin, run `pnpm build`, regenerate the Harness patch with `node scripts/harness-config.mjs`, restart the Harness web server with that patch, then ask the prompt above. The compiled plugin exposes the `cad_*` tools alongside the older `openengineer_*` ones.

Tests: `.venv/bin/python -m pytest -q` (26 tests) and `pnpm test` (12 tests, including a real Cordis registry run). `uv run pytest` may fail if the sandbox cannot write `~/.cache/uv`; the project virtualenv is the fallback.

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
