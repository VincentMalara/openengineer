import { execFile, type ExecFileException } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import {
  EngineError, normalizeEngineCode,
  type EngineConfig, type Json,
} from './index.js';

export interface CadBounds { min: number[]; max: number[] }

export interface CadChecks {
  valid: boolean;
  single_solid: boolean;
  positive_volume: boolean;
  finite_bounds: boolean;
}

export interface CadMaterialProperties {
  id: string;
  name: string;
  density_kg_m3: number;
  youngs_modulus_mpa: number;
  poisson: number;
  yield_mpa: number;
}

export interface CadPartSummary {
  part: string;
  name: string;
  material: string;
  features: Json[];
  checks: CadChecks;
  bounds_mm: CadBounds;
  volume_mm3: number;
  mass_g: number;
  center_of_mass_mm: number[];
  material_properties: CadMaterialProperties;
}

export interface CadFeatureResult {
  part: string;
  feature: Json;
  checks: CadChecks;
  bounds_mm: CadBounds;
  volume_mm3: number;
  mass_g: number;
  center_of_mass_mm: number[];
  material_properties: CadMaterialProperties;
}

export interface CadProject {
  project: string;
  name: string;
  units: string;
  directory: string;
  created: string;
}

export interface CadProjectStatus {
  project: string;
  name: string;
  units: string;
  parts: number;
  last_revision: string | null;
  dirty: boolean;
}

export interface CadCommit {
  revision: string;
  directory: string;
  message: string;
  timestamp: string;
  parts: number;
  files: number;
}

export interface CadRevision {
  revision: string;
  message: string;
  timestamp: string;
  parts: number;
}

export interface CadHistory { revisions: CadRevision[] }

export interface CadPartBasic {
  part: string;
  name: string;
  material: string;
  features: Json[];
}

export interface CadPartEntry {
  part: string;
  name: string;
  material: string;
  features: number;
}

export interface CadPartList { parts: CadPartEntry[] }

export interface CadExport {
  part: string;
  format: string;
  path: string;
  relative_path: string;
  bytes: number;
  checks: CadChecks;
}

export interface CadMaterial {
  id: string;
  name: string;
  density_kg_m3: number;
  youngs_modulus_mpa: number;
  poisson: number;
  yield_mpa: number;
}

export interface CadMaterialList { materials: CadMaterial[] }

interface CadResponse {
  ok: boolean;
  result?: unknown;
  code?: string;
  error?: string;
}

function cadFailure(
  error: ExecFileException,
  stdout: string,
  stderr: string,
  config: EngineConfig,
  signal: AbortSignal | undefined,
): EngineError {
  if (signal?.aborted === true || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return new EngineError('ABORTED', 'CAD operation aborted', { cause: error });
  }
  let response: CadResponse | undefined;
  try {
    response = JSON.parse(stdout) as CadResponse;
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

/** Run one deterministic operation in the Python CAD suite. */
export async function runCadOperation<T>(
  config: EngineConfig,
  operation: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let root: string;
  try {
    root = await realpath(config.root);
  } catch (error) {
    throw new EngineError('IO', `Project root not found: ${config.root}`, { cause: error });
  }
  const payload = JSON.stringify({ ...args, root, op: operation });
  return new Promise<T>((resolveResult, reject) => {
    const child = execFile(config.python, ['-I', '-m', 'openengineer.cad.cli', '--json'], {
      cwd: root, timeout: config.timeoutMs, maxBuffer: 4 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(cadFailure(error, stdout, stderr, config, signal));
        return;
      }
      let response: CadResponse;
      try {
        response = JSON.parse(stdout) as CadResponse;
      } catch (err) {
        reject(new EngineError('ENGINE', 'Invalid CAD engine response', { cause: err }));
        return;
      }
      if (response.ok !== true || response.result === undefined) {
        reject(new EngineError('ENGINE', 'CAD engine reported success without a result'));
        return;
      }
      resolveResult(response.result as T);
    });
    child.stdin?.on('error', () => { /* execFile callback reports process failures */ });
    child.stdin?.end(payload);
  });
}
