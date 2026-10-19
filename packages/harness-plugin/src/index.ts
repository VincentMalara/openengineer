import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import {
  buildBracket, inspectRevision, listRevisions, EngineError,
  type BuildResult, type EngineConfig, type Json, type RevisionDetail, type RevisionList,
} from '../../engineering-core/src/index.js';
import { registerCadTools } from './cad-tools.js';

export const name = 'openengineer';
export const inject = ['tools'];

/** Harness-visible error that preserves the engineering code in `info.code`. */
class OpenEngineerError extends HarnessError {}

const parentSchema = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
  required: true,
} as const;

const artifactsSchema = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    step: { type: 'string', required: true },
    parameters: { type: 'string', required: true },
    record: { type: 'string', required: true },
    report: { type: 'string', required: true },
  },
} as const;

const checksSchema = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    valid_solid: { type: 'boolean', required: true },
    bounds: { type: 'boolean', required: true },
    volume: { type: 'boolean', required: true },
    hole_boundaries: { type: 'boolean', required: true },
  },
} as const;

const buildOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'string', required: true },
    parent: parentSchema,
    directory: { type: 'string', required: true },
    artifacts: artifactsSchema,
    bounds_mm: { type: 'array', items: { type: 'number' }, required: true },
    volume_mm3: { type: 'number', required: true },
    checks: checksSchema,
    hole_boundaries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          z: { type: 'number', required: true },
          radius_mm: { type: 'number', required: true },
        },
      },
    },
    changes: { type: 'object', additionalProperties: true, required: true },
  },
} as const;

const listOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifacts_directory: { type: 'string', required: true },
    revisions: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revision: { type: 'string', required: true },
          parent: parentSchema,
          timestamp: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          bounds_mm: { type: 'array', items: { type: 'number' }, required: true },
          volume_mm3: { type: 'number', required: true },
          checks_passed: { type: 'boolean', required: true },
          directory: { type: 'string', required: true },
        },
      },
    },
  },
} as const;

const inspectOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'string', required: true },
    parent: parentSchema,
    timestamp: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    directory: { type: 'string', required: true },
    parameters: { type: 'json', required: true },
    changes: { type: 'json', required: true },
    bounds_mm: { type: 'array', items: { type: 'number' }, required: true },
    volume_mm3: { type: 'number', required: true },
    checks: checksSchema,
    sources: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        source_sha256: { type: 'string', required: true },
        step_sha256: { type: 'string', required: true },
      },
    },
    report: { type: 'string', required: true },
    artifacts: artifactsSchema,
  },
} as const;

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatDimension(value: Json | undefined): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const dimension = (value as { [key: string]: Json }).value;
    if (typeof dimension === 'number') return formatNumber(dimension);
  }
  return JSON.stringify(value) ?? 'null';
}

function formatChanges(changes: Json): string | null {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;
  return entries.map(([key, change]) => {
    const fields = change !== null && typeof change === 'object' && !Array.isArray(change)
      ? change as { [key: string]: Json }
      : {};
    return `${key} ${formatDimension(fields.before)} -> ${formatDimension(fields.after)}`;
  }).join('; ');
}

function formatChecks(checks: BuildResult['checks']): string {
  return Object.entries(checks)
    .map(([check, passed]) => `${check}=${passed ? 'pass' : 'FAIL'}`)
    .join(', ');
}

function formatBuild(value: BuildResult): string {
  const holes = value.hole_boundaries
    .map(hole => `(${formatNumber(hole.x)}, ${formatNumber(hole.y)}, ${formatNumber(hole.z)}, r=${formatNumber(hole.radius_mm)})`)
    .join(', ');
  const lines = [
    `Revision ${value.revision}${value.parent === null ? ' (initial revision)' : ` (parent ${value.parent})`}`,
    `Bounds: ${value.bounds_mm.map(formatNumber).join(' x ')} mm | volume: ${value.volume_mm3.toFixed(1)} mm3`,
    `Checks: ${formatChecks(value.checks)}`,
    `Hole boundaries (x, y, z, radius) in mm: ${holes || 'none'}`,
  ];
  const changes = formatChanges(value.changes);
  if (changes !== null) lines.push(`Changes: ${changes}`);
  lines.push(
    `Directory: ${value.directory}`,
    `STEP: ${value.artifacts.step}`,
    `Parameters: ${value.artifacts.parameters}`,
    `Record: ${value.artifacts.record}`,
    `Report: ${value.artifacts.report}`,
  );
  return lines.join('\n');
}

function formatList(value: RevisionList): string {
  if (value.revisions.length === 0) {
    return `No committed revisions in ${value.artifacts_directory}.`;
  }
  const lines = [`${value.revisions.length} committed revision(s) in ${value.artifacts_directory}:`];
  for (const revision of value.revisions) {
    const parent = revision.parent === null ? 'initial' : `parent ${revision.parent}`;
    lines.push(`- ${revision.revision} (${parent}) | ${revision.timestamp} | ${revision.bounds_mm.map(formatNumber).join(' x ')} mm | checks ${revision.checks_passed ? 'pass' : 'FAIL'} | ${revision.reason}`);
  }
  return lines.join('\n');
}

function formatDetail(value: RevisionDetail): string {
  const lines = [
    `Revision ${value.revision}${value.parent === null ? ' (initial revision)' : ` (parent ${value.parent})`}`,
    `Created: ${value.timestamp}`,
    `Reason: ${value.reason}`,
    `Bounds: ${value.bounds_mm.map(formatNumber).join(' x ')} mm | volume: ${value.volume_mm3.toFixed(1)} mm3`,
    `Checks: ${formatChecks(value.checks)}`,
  ];
  const changes = formatChanges(value.changes);
  if (changes !== null) lines.push(`Changes: ${changes}`);
  lines.push(
    `Directory: ${value.directory}`,
    `STEP: ${value.artifacts.step}`,
    `Parameters: ${value.artifacts.parameters}`,
    `Record: ${value.artifacts.record}`,
    `Report: ${value.artifacts.report}`,
    '',
    'Report:',
    value.report.trimEnd(),
  );
  return lines.join('\n');
}

async function runTool<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EngineError) {
      throw new OpenEngineerError(error.message, error.code, { cause: error });
    }
    throw error;
  }
}

export const Config: Schema<EngineConfig> = Schema.object({
  root: Schema.string().required(),
  python: Schema.string().required(),
  timeoutMs: Schema.number().min(1000).max(300000).default(120000),
  artifactsDir: Schema.string().default('artifacts'),
});

export function apply(ctx: Context, config: EngineConfig) {
  registerCadTools(ctx, config);
  ctx.tools.register(defineTool({
    name: 'openengineer_build_bracket',
    description: 'Build or modify an L mounting bracket from project YAML in mm, validate its solid and STEP roundtrip, and save an immutable design revision. Missing dimensions must be measured or explicitly labeled assumed. Returns the revision, measured bounds, volume, per-check results, hole boundary circles and artifact paths. Failures carry a stable code (VALIDATION, PATH, TIMEOUT, ABORTED, LOCK, EXPORT, GEOMETRY, IO, NOT_FOUND, ENGINE). Does not certify strength or manufacturing.',
    parameters: {
      input: { type: 'string', required: true, description: 'YAML path relative to configured project root. Use a previous revision parameters.yaml to continue from that design.' },
      reason: { type: 'string', required: true, description: 'Design decision explaining this revision' },
      length: { type: 'number', description: 'Optional new overall X length in mm (recorded as assumed)' },
      width: { type: 'number', description: 'Optional new overall Y width in mm (recorded as assumed)' },
      height: { type: 'number', description: 'Optional new overall Z height in mm (recorded as assumed)' },
      thickness: { type: 'number', description: 'Optional new uniform thickness in mm (recorded as assumed)' },
    },
    output: {
      schema: buildOutputSchema,
      render: (_args, value) => [{ type: 'text', text: formatBuild(value) }],
    },
    async execute(args, execution) {
      return runTool(() => buildBracket(config, args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'openengineer_list_revisions',
    description: 'List committed OpenEngineer revisions in the configured project, oldest first, with parent, timestamp, reason, measured bounds, volume, check result and directory. Read-only; does not rebuild or modify anything.',
    parameters: {},
    output: {
      schema: listOutputSchema,
      render: (_args, value) => [{ type: 'text', text: formatList(value) }],
    },
    async execute() {
      return runTool(() => listRevisions(config));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'openengineer_inspect_revision',
    description: 'Read one committed revision without rebuilding: parameters, recorded changes, measured bounds and volume, validation checks, source/STEP hashes, artifact paths and the full markdown report. Read-only.',
    parameters: {
      revision: { type: 'string', required: true, description: 'Revision id such as revision-000001-3d242bfd, as returned by build or list.' },
    },
    output: {
      schema: inspectOutputSchema,
      render: (_args, value) => [{ type: 'text', text: formatDetail(value) }],
    },
    async execute(args) {
      return runTool(() => inspectRevision(config, args.revision));
    },
  }));
}
