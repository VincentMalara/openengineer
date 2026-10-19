# Architecture, implementation milestones and audit

## Verified upstream contract

Inspected official Harness source at commit `687f282e8625c6b8d11ff58211a90524be2e4317` on 2026-10-19. The repository reports `0.2.1-rc.2`. Its `packages/core/tools/src/index.ts`, `schema.ts`, tool execution tests and plugin tutorials informed this implementation. Runtime dependencies are pinned to published packages, with full resolution in `pnpm-lock.yaml`.

References:

- [Official plugin tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/index.md)
- [Tool definition API](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/tool.md)
- [Official STEP import/export reference](https://build123d.readthedocs.io/en/latest/import_export.html)

The latest build123d documentation targets a development version. The implementation instead pins and tests build123d 0.10.0 with OpenCascade 7.8.1.1.post1. Its broad transitive constraint selected ocp-gordon 0.3.1, which imports OCP.collections from OCP 8 and broke import. Explicitly pinning ocp-gordon 0.1.17 resolves that observed incompatibility. uv.lock pins the complete tested dependency graph.

## Minimal design

Harness provider → Cordis plugin tool → TypeScript process bridge → Python/Pydantic → build123d/OpenCascade → STEP roundtrip validation → immutable revision.

- `packages/harness-plugin`: registration, configuration, structured result schemas, readable rendering, read-only revision tools and Harness-specific error mapping.
- `packages/engineering-core`: JSON subprocess transport, structured result normalization, typed errors, timeout, cancellation, project path restrictions and read-only revision inspection. No Harness imports.
- `python/cad-engine/openengineer/models.py`: dimensions, provenance and input constraints.
- `geometry.py`: deterministic construction and geometric measurement. This module is the initial backend replacement boundary.
- `pipeline.py`: staged publication, immutable history, report and artifact management.
- `errors.py`: typed engine failures shared by the pipeline and the CLI protocol.
- `cli.py`: standalone CLI and JSON protocol, including machine-readable error codes.
- `tests` and `packages/harness-plugin/tests`: geometry, failure, timeout/cancellation and real-registry integration tests.
- `examples/mounting-bracket`: reproducible measured input.

No network service or new agent framework. A future CAD backend should preserve the structured specification and validation result contract; a generic backend interface is deferred until a second implementation makes its actual requirements clear. NumPy/SciPy are available through CAD dependencies but no speculative analysis subsystem is introduced.

## Small verifiable milestones

1. Parse and validate measured YAML; reject absent, nonfinite, inconsistent and unknown values.
2. Construct the L bracket and per-hole booleans; export/reimport STEP; independently verify dimensions and hole boundary positions.
3. Modify a dimension; preserve input and prior STEP; record parent, actual differences and decision.
4. Register the tool using official Harness packages; test calls through the real registry into Python, including a modified second revision.
5. Run a live provider/UI acceptance session using the documented overlay. This remains separate from the deterministic integration tests and requires the user's configured provider.
6. Add photograph interpretation and missing-measurement dialogue only after the preceding pipeline is accepted. Generated code requires explicit isolation design first.

## Audit observations and fixes

- Transitive OCP incompatibility reproduced and fixed by pinning ocp-gordon.
- Positions are measured from BREP circular edges, rather than echoing input; a deliberately shifted hole with unchanged volume is rejected in a negative test.
- Both in-memory and imported STEP geometries are checked; export failure does not commit a revision.
- Baselines come from the previous committed revision; snapshots preserve source/provenance, requirements, assumptions and the modification reason.
- Read source bytes once so the recorded source hash matches the parsed input.
- Staged directory rename prevents partial revisions; advisory locking avoids a permanently stale exclusive-create lock after timeout/process death.
- Tool results are structured and rendered as a readable summary; failures carry stable codes across the Python/TypeScript boundary, re-raised as `HarnessError` so `info.code` survives policy and replay.
- `openengineer_list_revisions` and `openengineer_inspect_revision` read the same artifacts directory with the same path containment as the build tool; they never spawn Python or mutate files.
- No shell command interpolation, no generated Python, bounded subprocess output and duration, and canonical input/output path containment at the TypeScript boundary.
- Source imports and Python exceptions are returned as structured CLI errors when possible.

Limitations: local trusted workspace, no tamper-proof history, no distributed writers, no automatic Git commits, no manufacturing or structural validation. Snapshot directory naming is a sequential history, not a branch/merge implementation. The process boundary is not a sandbox. Future code generation must not inherit the current trust assumption.

No approval was needed for this local reversible implementation. The project is released under the MIT license (see [LICENSE](../LICENSE)). Remaining decisions: select a configured LLM for live acceptance; define the intended manufacturing process and measured bend radius; select isolation requirements before allowing generated code.

## Local verification result

On macOS arm64 / Python 3.12 / Node 25.6.1: TypeScript compilation succeeded; 17 pytest tests and 7 Vitest tests passed. Four build123d deprecation warnings remain upstream. Two demonstration STEP files were exported and reimported: 80 × 40 × 30 mm and 80 × 40 × 45 mm, each with two 6 mm through holes. Example values are synthetic fixtures, not observations of a real physical component. The GitHub Actions workflow passes on GitHub-hosted Ubuntu (Python 3.12, Node 22.19). The full Web UI and an external LLM provider have not been exercised.
