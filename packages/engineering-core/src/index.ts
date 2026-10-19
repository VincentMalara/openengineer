import { execFile } from 'node:child_process';
import { realpath, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface EngineConfig { root: string; python: string; timeoutMs: number }
export interface BuildRequest { input: string; reason: string; length?: number; width?: number; height?: number; thickness?: number }

function contained(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path must stay inside the configured project root');
}

export async function buildBracket(config: EngineConfig, request: BuildRequest, signal?: AbortSignal): Promise<string> {
  const root = await realpath(config.root);
  const input = await realpath(resolve(root, request.input));
  contained(root, input);
  const outputPath = resolve(root, 'artifacts');
  await mkdir(outputPath, { recursive: true });
  const output = await realpath(outputPath);
  contained(root, output);
  const overrides = Object.fromEntries(['length', 'width', 'height', 'thickness']
    .filter(key => request[key as keyof BuildRequest] !== undefined)
    .map(key => [key, request[key as keyof BuildRequest]]));
  return new Promise((resolveResult, reject) => {
    const child = execFile(config.python, ['-I', '-m', 'openengineer.cli', '--json'], {
      cwd: root, timeout: config.timeoutMs, maxBuffer: 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`CAD operation failed: ${stdout || stderr || error.message}`)); return; }
      try {
        const response = JSON.parse(stdout);
        if (response.ok !== true || !response.result?.revision) throw new Error('Invalid engine response');
        resolveResult(JSON.stringify(response.result));
      } catch (err) { reject(err); }
    });
    child.stdin?.on('error', () => { /* execFile callback reports process failures */ });
    child.stdin?.end(JSON.stringify({ input, output, reason: request.reason, overrides }));
  });
}
