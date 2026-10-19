import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const patch = [{insert: [{id: 'openengineer', name: resolve(root, 'dist/harness-plugin/src/index.js'), config: {
  root, python: resolve(root, '.venv/bin/python'), timeoutMs: 120000,
}}]}];
// JSON is valid YAML. The generated absolute paths are local, not portable source config.
await writeFile(resolve(root, 'harness.local.yaml'), JSON.stringify(patch, null, 2) + '\n');
console.log(resolve(root, 'harness.local.yaml'));
