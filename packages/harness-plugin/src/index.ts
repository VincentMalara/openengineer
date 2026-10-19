import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import {
  buildBracket, EngineError,
  type BuildResult, type EngineConfig, type Json,
} from '../../engineering-core/src/index.js';

export const name = 'openengineer';
export const inject = ['tools'];

/** Harness-visible error that preserves the engineering code in `info.code`. */
class OpenEngineerError extends HarnessError {}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revision: { type: 'string', required: true },
    parent: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    directory: { type: 'string', required: true },
    artifacts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        step: { type: 'string', required: true },
        parameters: { type: 'string', required: true },
        record: { type: 'string', required: true },
        report: { type: 'string', required: true },
      },
    },
    bounds_mm: { type: 'array', items: { type: 'number' }, required: true },
    volume_mm3: { type: 'number', required: true },
    checks: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        valid_solid: { type: 'boolean', required: true },
        bounds: { type: 'boolean', required: true },
        volume: { type: 'boolean', required: true },
        hole_boundaries: { type: 'boolean', required: true },
      },
    },
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

function formatResult(value: BuildResult): string {
  const checks = Object.entries(value.checks)
    .map(([check, passed]) => `${check}=${passed ? 'pass' : 'FAIL'}`)
    .join(', ');
  const holes = value.hole_boundaries
    .map(hole => `(${formatNumber(hole.x)}, ${formatNumber(hole.y)}, ${formatNumber(hole.z)}, r=${formatNumber(hole.radius_mm)})`)
    .join(', ');
  const lines = [
    `Revision ${value.revision}${value.parent === null ? ' (initial revision)' : ` (parent ${value.parent})`}`,
    `Bounds: ${value.bounds_mm.map(formatNumber).join(' x ')} mm | volume: ${value.volume_mm3.toFixed(1)} mm3`,
    `Checks: ${checks}`,
    `Hole boundaries (x, y, z, radius) in mm: ${holes || 'none'}`,
  ];
  const changes = Object.entries(value.changes);
  if (changes.length > 0) {
    const summary = changes.map(([key, change]) => {
      const { before, after } = change as { before?: Json; after?: Json };
      return `${key} ${formatDimension(before)} -> ${formatDimension(after)}`;
    });
    lines.push(`Changes: ${summary.join('; ')}`);
  }
  lines.push(
    `Directory: ${value.directory}`,
    `STEP: ${value.artifacts.step}`,
    `Parameters: ${value.artifacts.parameters}`,
    `Record: ${value.artifacts.record}`,
    `Report: ${value.artifacts.report}`,
  );
  return lines.join('\n');
}

export const Config: Schema<EngineConfig> = Schema.object({
  root: Schema.string().required(),
  python: Schema.string().required(),
  timeoutMs: Schema.number().min(1000).max(300000).default(120000),
});

export function apply(ctx: Context, config: EngineConfig) {
  ctx.tools.register(defineTool({
    name: 'openengineer_build_bracket',
    description: 'Build or modify an L mounting bracket from project YAML in mm, validate its solid and STEP roundtrip, and save an immutable design revision. Missing dimensions must be measured or explicitly labeled assumed. Returns the revision, measured bounds, volume, per-check results, hole boundary circles and artifact paths. Failures carry a stable code (VALIDATION, PATH, TIMEOUT, ABORTED, LOCK, EXPORT, GEOMETRY, IO, ENGINE). Does not certify strength or manufacturing.',
    parameters: {
      input: { type: 'string', required: true, description: 'YAML path relative to configured project root. Use a previous revision parameters.yaml to continue from that design.' },
      reason: { type: 'string', required: true, description: 'Design decision explaining this revision' },
      length: { type: 'number', description: 'Optional new overall X length in mm (recorded as assumed)' },
      width: { type: 'number', description: 'Optional new overall Y width in mm (recorded as assumed)' },
      height: { type: 'number', description: 'Optional new overall Z height in mm (recorded as assumed)' },
      thickness: { type: 'number', description: 'Optional new uniform thickness in mm (recorded as assumed)' },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
    },
    async execute(args, execution) {
      try {
        return await buildBracket(config, args, execution.signal);
      } catch (error) {
        if (error instanceof EngineError) {
          throw new OpenEngineerError(error.message, error.code, { cause: error });
        }
        throw error;
      }
    },
  }));
}
