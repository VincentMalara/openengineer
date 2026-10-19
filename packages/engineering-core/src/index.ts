import { execFile, type ExecFileException } from 'node:child_process';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface EngineConfig { root: string; python: string; timeoutMs: number; artifactsDir?: string }
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
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ENGINE';

const ENGINE_ERROR_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'VALIDATION', 'PATH', 'TIMEOUT', 'ABORTED', 'LOCK', 'EXPORT', 'GEOMETRY', 'IO', 'NOT_FOUND', 'CONFLICT', 'ENGINE',
]);

const REVISION_ID = /^revision-\d{6}-[0-9a-f]{8}$/;

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

export interface RevisionSummary {
  revision: string;
  parent: string | null;
  timestamp: string;
  reason: string;
  bounds_mm: number[];
  volume_mm3: number;
  checks_passed: boolean;
  directory: string;
}

export interface RevisionList {
  artifacts_directory: string;
  revisions: RevisionSummary[];
}

export interface RevisionDetail {
  revision: string;
  parent: string | null;
  timestamp: string;
  reason: string;
  directory: string;
  parameters: Json;
  changes: Json;
  bounds_mm: number[];
  volume_mm3: number;
  checks: BracketChecks;
  sources: { source_sha256: string; step_sha256: string };
  report: string;
  artifacts: BuildArtifacts;
}

interface StoredRecord {
  id?: unknown;
  parent?: unknown;
  timestamp?: unknown;
  reason?: unknown;
  parameters?: Json;
  changes?: Json;
  source_sha256?: unknown;
  step_sha256?: unknown;
  validation?: { step_roundtrip?: BracketValidation };
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

async function resolveRoot(config: EngineConfig): Promise<string> {
  try {
    return await realpath(config.root);
  } catch (error) {
    throw new EngineError('IO', `Project root not found: ${config.root}`, { cause: error });
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

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Resolve the artifacts directory under the project root. The lexical check
 * rejects `..` escapes, and `realpath` rejects symlinks pointing outside.
 * Returns null when the directory does not exist and `create` is false.
 */
async function resolveArtifactsDir(root: string, config: EngineConfig, create: boolean): Promise<string | null> {
  const candidate = resolve(root, config.artifactsDir ?? 'artifacts');
  contained(root, candidate);
  if (create) {
    try {
      await mkdir(candidate, { recursive: true });
    } catch (error) {
      throw new EngineError('IO', `Cannot create output directory: ${candidate}`, { cause: error });
    }
  }
  try {
    const resolved = await realpath(candidate);
    contained(root, resolved);
    return resolved;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new EngineError('IO', `Cannot resolve output directory: ${candidate}`, { cause: error });
  }
}

async function readRecord(directory: string, revision: string): Promise<StoredRecord> {
  const path = join(directory, 'record.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new EngineError('IO', `Cannot read revision record: ${path}`, { cause: error });
  }
  let record: StoredRecord;
  try {
    record = JSON.parse(raw) as StoredRecord;
  } catch (error) {
    throw new EngineError('ENGINE', `Invalid JSON in revision record: ${path}`, { cause: error });
  }
  if (record.id !== revision) {
    throw new EngineError('ENGINE', `Revision record does not match its directory: ${path}`);
  }
  return record;
}

function validated(record: StoredRecord): BracketValidation {
  const validation = record.validation?.step_roundtrip;
  if (
    validation === undefined
    || !Array.isArray(validation.bounding_mm)
    || typeof validation.volume_mm3 !== 'number'
    || validation.checks === null
    || typeof validation.checks !== 'object'
  ) {
    throw new EngineError('ENGINE', `Revision ${String(record.id)} has no validation record`);
  }
  return validation;
}

function summary(record: StoredRecord, directory: string): RevisionSummary {
  const validation = validated(record);
  if (typeof record.timestamp !== 'string' || typeof record.reason !== 'string') {
    throw new EngineError('ENGINE', `Revision ${String(record.id)} has an incomplete record`);
  }
  return {
    revision: String(record.id),
    parent: typeof record.parent === 'string' ? record.parent : null,
    timestamp: record.timestamp,
    reason: record.reason,
    bounds_mm: validation.bounding_mm,
    volume_mm3: validation.volume_mm3,
    checks_passed: Object.values(validation.checks).every(Boolean),
    directory,
  };
}

export function normalizeEngineCode(code: string | undefined): EngineErrorCode {
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
    return new EngineError(normalizeEngineCode(response.code), response.error ?? 'CAD operation failed');
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
  const root = await resolveRoot(config);
  const input = await resolveInside(root, resolve(root, request.input), 'Input');
  const output = await resolveArtifactsDir(root, config, true);
  if (output === null) throw new EngineError('IO', 'Output directory could not be created');
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

export async function listRevisions(config: EngineConfig): Promise<RevisionList> {
  const root = await resolveRoot(config);
  const output = await resolveArtifactsDir(root, config, false);
  if (output === null) {
    return { artifacts_directory: resolve(root, config.artifactsDir ?? 'artifacts'), revisions: [] };
  }
  let entries;
  try {
    entries = await readdir(output, { withFileTypes: true });
  } catch (error) {
    throw new EngineError('IO', `Cannot list output directory: ${output}`, { cause: error });
  }
  const revisions: RevisionSummary[] = [];
  for (const entry of entries.filter(item => item.isDirectory() && REVISION_ID.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(output, entry.name);
    const record = await readRecord(directory, entry.name);
    revisions.push(summary(record, directory));
  }
  return { artifacts_directory: output, revisions };
}

export async function inspectRevision(config: EngineConfig, revision: string): Promise<RevisionDetail> {
  if (!REVISION_ID.test(revision)) {
    throw new EngineError('VALIDATION', `Invalid revision id: ${revision}`);
  }
  const root = await resolveRoot(config);
  const output = await resolveArtifactsDir(root, config, false);
  if (output === null) {
    throw new EngineError('NOT_FOUND', `No revisions exist in ${resolve(root, config.artifactsDir ?? 'artifacts')}`);
  }
  const directory = join(output, revision);
  let resolved: string;
  try {
    resolved = await realpath(directory);
  } catch (error) {
    throw new EngineError('NOT_FOUND', `Revision not found: ${revision}`, { cause: error });
  }
  contained(output, resolved);
  const record = await readRecord(resolved, revision);
  const validation = validated(record);
  let report: string;
  try {
    report = await readFile(join(resolved, 'report.md'), 'utf8');
  } catch (error) {
    throw new EngineError('IO', `Cannot read revision report: ${join(resolved, 'report.md')}`, { cause: error });
  }
  return {
    revision,
    parent: typeof record.parent === 'string' ? record.parent : null,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    reason: typeof record.reason === 'string' ? record.reason : '',
    directory: resolved,
    parameters: record.parameters ?? {},
    changes: record.changes ?? {},
    bounds_mm: validation.bounding_mm,
    volume_mm3: validation.volume_mm3,
    checks: validation.checks,
    sources: {
      source_sha256: typeof record.source_sha256 === 'string' ? record.source_sha256 : '',
      step_sha256: typeof record.step_sha256 === 'string' ? record.step_sha256 : '',
    },
    report,
    artifacts: {
      step: join(resolved, 'part.step'),
      parameters: join(resolved, 'parameters.yaml'),
      record: join(resolved, 'record.json'),
      report: join(resolved, 'report.md'),
    },
  };
}
