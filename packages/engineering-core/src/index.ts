import { execFile, type ExecFileException } from 'node:child_process';
import { realpath, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface EngineConfig { root: string; python: string; timeoutMs: number }
export interface BuildRequest { input: string; reason: string; length?: number; width?: number; height?: number; thickness?: number }

export type EngineErrorCode =
  | 'VALIDATION'
  | 'PATH'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'LOCK'
  | 'EXPORT'
  | 'GEOMETRY'
  | 'IO'
  | 'ENGINE';

const ENGINE_ERROR_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'VALIDATION', 'PATH', 'TIMEOUT', 'ABORTED', 'LOCK', 'EXPORT', 'GEOMETRY', 'IO', 'ENGINE',
]);

/** Stable, machine-routable failure raised by the engineering core. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
  }
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface BracketChecks {
  valid_solid: boolean;
  bounds: boolean;
  volume: boolean;
  hole_boundaries: boolean;
}

export interface BracketValidation {
  checks: BracketChecks;
  bounding_mm: number[];
  volume_mm3: number;
  hole_boundary_circles_mm: Array<[number, number, number, number]>;
}

export interface BuildArtifacts {
  step: string;
  parameters: string;
  record: string;
  report: string;
}

export interface BuildResult {
  revision: string;
  parent: string | null;
  directory: string;
  artifacts: BuildArtifacts;
  bounds_mm: number[];
  volume_mm3: number;
  checks: BracketChecks;
  hole_boundaries: Array<{ x: number; y: number; z: number; radius_mm: number }>;
  changes: Record<string, Json>;
}

interface EngineResult {
  revision: string;
  parent?: string | null;
  directory: string;
  artifacts?: BuildArtifacts;
  changes?: Record<string, Json>;
  validation: BracketValidation;
}

interface EngineResponse {
  ok: boolean;
  result?: EngineResult;
  code?: string;
  error?: string;
}

function contained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new EngineError('PATH', 'Path must stay inside the configured project root');
  }
}

async function resolveInside(root: string, target: string, label: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch (error) {
    throw new EngineError('IO', `${label} not found: ${target}`, { cause: error });
  }
  contained(root, resolved);
  return resolved;
}

function normalizeCode(code: string | undefined): EngineErrorCode {
  return code !== undefined && ENGINE_ERROR_CODES.has(code) ? code as EngineErrorCode : 'ENGINE';
}

function engineFailure(
  error: ExecFileException,
  stdout: string,
  stderr: string,
  config: EngineConfig,
  signal: AbortSignal | undefined,
): EngineError {
  if (signal?.aborted === true || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return new EngineError('ABORTED', 'CAD operation aborted', { cause: error });
  }
  let response: EngineResponse | undefined;
  try {
    response = JSON.parse(stdout) as EngineResponse;
  } catch {
    response = undefined;
  }
  if (response?.ok === false) {
    return new EngineError(normalizeCode(response.code), response.error ?? 'CAD operation failed');
  }
  if (error.killed === true || error.signal === 'SIGTERM') {
    return new EngineError('TIMEOUT', `CAD operation timed out after ${config.timeoutMs} ms`, { cause: error });
  }
  if (error.code === 'ENOENT') {
    return new EngineError('ENGINE', `Python interpreter not found: ${config.python}`, { cause: error });
  }
  const detail = (stderr || stdout || error.message).trim();
  return new EngineError('ENGINE', `CAD operation failed: ${detail}`, { cause: error });
}

function normalizeResult(response: EngineResponse): BuildResult {
  if (response.ok !== true || response.result === undefined) {
    throw new EngineError('ENGINE', 'Engine reported success without a result');
  }
  const result = response.result;
  const validation = result.validation;
  if (
    typeof result.revision !== 'string'
    || typeof result.directory !== 'string'
    || validation === undefined
    || !Array.isArray(validation.bounding_mm)
    || typeof validation.volume_mm3 !== 'number'
    || typeof validation.checks !== 'object'
    || !Array.isArray(validation.hole_boundary_circles_mm)
  ) {
    throw new EngineError('ENGINE', 'Invalid engine response');
  }
  return {
    revision: result.revision,
    parent: result.parent ?? null,
    directory: result.directory,
    artifacts: result.artifacts ?? {
      step: join(result.directory, 'part.step'),
      parameters: join(result.directory, 'parameters.yaml'),
      record: join(result.directory, 'record.json'),
      report: join(result.directory, 'report.md'),
    },
    bounds_mm: validation.bounding_mm,
    volume_mm3: validation.volume_mm3,
    checks: validation.checks,
    hole_boundaries: validation.hole_boundary_circles_mm.map(([x, y, z, radius_mm]) => ({ x, y, z, radius_mm })),
    changes: result.changes ?? {},
  };
}

export async function buildBracket(
  config: EngineConfig,
  request: BuildRequest,
  signal?: AbortSignal,
): Promise<BuildResult> {
  let root: string;
  try {
    root = await realpath(config.root);
  } catch (error) {
    throw new EngineError('IO', `Project root not found: ${config.root}`, { cause: error });
  }
  const input = await resolveInside(root, resolve(root, request.input), 'Input');
  const outputPath = resolve(root, 'artifacts');
  try {
    await mkdir(outputPath, { recursive: true });
  } catch (error) {
    throw new EngineError('IO', `Cannot create output directory: ${outputPath}`, { cause: error });
  }
  const output = await resolveInside(root, outputPath, 'Output directory');
  const overrides = Object.fromEntries(['length', 'width', 'height', 'thickness']
    .filter(key => request[key as keyof BuildRequest] !== undefined)
    .map(key => [key, request[key as keyof BuildRequest]]));
  return new Promise<BuildResult>((resolveResult, reject) => {
    const child = execFile(config.python, ['-I', '-m', 'openengineer.cli', '--json'], {
      cwd: root, timeout: config.timeoutMs, maxBuffer: 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(engineFailure(error, stdout, stderr, config, signal));
        return;
      }
      try {
        resolveResult(normalizeResult(JSON.parse(stdout) as EngineResponse));
      } catch (err) {
        reject(err instanceof EngineError
          ? err
          : new EngineError('ENGINE', 'Invalid engine response', { cause: err }));
      }
    });
    child.stdin?.on('error', () => { /* execFile callback reports process failures */ });
    child.stdin?.end(JSON.stringify({ input, output, reason: request.reason, overrides }));
  });
}
