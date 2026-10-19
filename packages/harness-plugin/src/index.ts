import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildBracket, type EngineConfig } from '../../engineering-core/src/index.js';

export const name = 'openengineer';
export const inject = ['tools'];
export const Config: Schema<EngineConfig> = Schema.object({
  root: Schema.string().required(),
  python: Schema.string().required(),
  timeoutMs: Schema.number().min(1000).max(300000).default(120000),
});

export function apply(ctx: Context, config: EngineConfig) {
  ctx.tools.register(defineTool({
    name: 'openengineer_build_bracket',
    description: 'Build or modify an L mounting bracket from project YAML in mm, validate its solid and STEP roundtrip, and save an immutable design revision. Missing dimensions must be measured or explicitly labeled assumed. Returns artifact paths and measured geometry. Does not certify strength or manufacturing.',
    parameters: {
      input: { type: 'string', required: true, description: 'YAML path relative to configured project root. Use a previous revision parameters.yaml to continue from that design.' },
      reason: { type: 'string', required: true, description: 'Design decision explaining this revision' },
      length: { type: 'number', description: 'Optional new overall X length in mm (recorded as assumed)' },
      width: { type: 'number', description: 'Optional new overall Y width in mm (recorded as assumed)' },
      height: { type: 'number', description: 'Optional new overall Z height in mm (recorded as assumed)' },
      thickness: { type: 'number', description: 'Optional new uniform thickness in mm (recorded as assumed)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) { return buildBracket(config, args, execution.signal); },
  }));
}
