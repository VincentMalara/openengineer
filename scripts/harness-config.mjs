import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const entries = [{id: 'openengineer', name: resolve(root, 'dist/harness-plugin/src/index.js'), config: {
  root, python: resolve(root, '.venv/bin/python'), timeoutMs: 120000,
}}];
if (process.env.FUSION_MCP === '1') {
  entries.push({id: 'mcp-fusion', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'fusion',
    transport: 'streamable-http',
    url: process.env.FUSION_MCP_URL ?? 'http://127.0.0.1:8765/mcp',
    toolCallTimeoutMs: 120000,
    failOnStartupError: false,
  }});
}
const patch = [{insert: entries}];
// JSON is valid YAML. The generated absolute paths are local, not portable source config.
await writeFile(resolve(root, 'harness.local.yaml'), JSON.stringify(patch, null, 2) + '\n');
console.log(resolve(root, 'harness.local.yaml'));
