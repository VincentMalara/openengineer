import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { mkdtemp, copyFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import * as plugin from '../src/index.js';
import { buildBracket } from '../../engineering-core/src/index.js';

const roots: string[] = [];
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'openengineer-test-')); roots.push(root);
  await copyFile(resolve('examples/mounting-bracket/dimensions.yaml'), join(root, 'dimensions.yaml'));
  return { root, python: resolve('.venv/bin/python'), timeoutMs: 120000 };
}

describe('real Harness → Python → OpenCascade → STEP', () => {
  it('registers through Cordis, builds, modifies and records parent history', async () => {
    const config = await setup();
    const ctx = new Context(); contexts.push(ctx);
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(plugin, config);
    expect(ctx.tools.schemas().some(t => t.name === 'openengineer_build_bracket')).toBe(true);
    const call = async (args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('cad-test'), name: 'openengineer_build_bracket', arguments: args });
      const block = result.content[0];
      expect(block.type).toBe('text');
      if (block.type !== 'text') throw new Error('Expected text');
      return JSON.parse(block.text);
    };
    const first = await call({ input: 'dimensions.yaml', reason: 'Initial measured bracket' });
    expect(first.validation.bounding_mm).toEqual([80, 40, 30]);
    const second = await call({ input: `artifacts/${first.revision}/parameters.yaml`, reason: 'Increase clearance', height: 45 });
    expect(second.validation.bounding_mm).toEqual([80, 40, 45]);
    const record = JSON.parse(await readFile(join(second.directory, 'record.json'), 'utf8'));
    expect(record.parent).toBe(first.revision);
    expect(record.changes.height.after.value).toBe(45);
  }, 180000);

  it('rejects traversal and symlink escapes', async () => {
    const config = await setup();
    await expect(buildBracket(config, { input: resolve('pyproject.toml'), reason: 'escape' })).rejects.toThrow('inside');
    await symlink(resolve('examples/mounting-bracket/dimensions.yaml'), join(config.root, 'escape.yaml'));
    await expect(buildBracket(config, { input: 'escape.yaml', reason: 'escape' })).rejects.toThrow('inside');
  });

  it('propagates invalid dimensions from Python without a revision', async () => {
    const config = await setup();
    await expect(buildBracket(config, { input: 'dimensions.yaml', reason: 'invalid', height: -3 })).rejects.toThrow('CAD operation failed');
  }, 120000);
});
