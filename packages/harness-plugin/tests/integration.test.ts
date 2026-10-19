import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { mkdtemp, copyFile, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import * as plugin from '../src/index.js';
import { buildBracket, EngineError, type BuildResult, type EngineConfig } from '../../engineering-core/src/index.js';

const roots: string[] = [];
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup(): Promise<EngineConfig> {
  const root = await mkdtemp(join(tmpdir(), 'openengineer-test-')); roots.push(root);
  await copyFile(resolve('examples/mounting-bracket/dimensions.yaml'), join(root, 'dimensions.yaml'));
  return { root, python: resolve('.venv/bin/python'), timeoutMs: 120000 };
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error('Expected the operation to fail');
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
      if (result.isError) throw new Error(`Unexpected tool error: ${result.error.message}`);
      const block = result.content[0];
      expect(block.type).toBe('text');
      const text = block.type === 'text' ? block.text : '';
      return { value: result.value as unknown as BuildResult, text };
    };
    const first = await call({ input: 'dimensions.yaml', reason: 'Initial measured bracket' });
    expect(first.value.bounds_mm).toEqual([80, 40, 30]);
    expect(first.value.parent).toBeNull();
    expect(first.value.checks).toEqual({ valid_solid: true, bounds: true, volume: true, hole_boundaries: true });
    expect(first.value.hole_boundaries).toHaveLength(4);
    expect(first.text).toContain(`Revision ${first.value.revision}`);
    expect(first.text).toContain('Checks:');
    const second = await call({ input: `artifacts/${first.value.revision}/parameters.yaml`, reason: 'Increase clearance', height: 45 });
    expect(second.value.bounds_mm).toEqual([80, 40, 45]);
    expect(second.value.parent).toBe(first.value.revision);
    const heightChange = second.value.changes.height as { after: { value: number } };
    expect(heightChange.after.value).toBe(45);
    const record = JSON.parse(await readFile(join(second.value.directory, 'record.json'), 'utf8'));
    expect(record.parent).toBe(first.value.revision);
    expect(record.changes.height.after.value).toBe(45);
  }, 180000);

  it('rejects traversal and symlink escapes with the PATH code', async () => {
    const config = await setup();
    const absolute = await rejection(buildBracket(config, { input: resolve('pyproject.toml'), reason: 'escape' }));
    expect(absolute.code).toBe('PATH');
    await symlink(resolve('examples/mounting-bracket/dimensions.yaml'), join(config.root, 'escape.yaml'));
    const linked = await rejection(buildBracket(config, { input: 'escape.yaml', reason: 'escape' }));
    expect(linked.code).toBe('PATH');
  });

  it('surfaces invalid dimensions as a typed VALIDATION tool failure without a revision', async () => {
    const config = await setup();
    const ctx = new Context(); contexts.push(ctx);
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(plugin, config);
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('cad-test'), name: 'openengineer_build_bracket',
      arguments: { input: 'dimensions.yaml', reason: 'invalid', height: -3 } });
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error('Expected a tool failure');
    expect(result.error.info?.code).toBe('VALIDATION');
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const error = await rejection(buildBracket(config, { input: 'dimensions.yaml', reason: 'invalid', height: -3 }));
    expect(error.code).toBe('VALIDATION');
  }, 120000);

  it('maps a hung engine to TIMEOUT and terminates it', async () => {
    const config = await setup();
    const script = join(config.root, 'slow.sh');
    await writeFile(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const error = await rejection(buildBracket(
      { ...config, python: script, timeoutMs: 500 },
      { input: 'dimensions.yaml', reason: 'timeout' },
    ));
    expect(error.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('maps cancellation to ABORTED', async () => {
    const config = await setup();
    const script = join(config.root, 'slow.sh');
    await writeFile(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const controller = new AbortController();
    const pending = buildBracket(
      { ...config, python: script, timeoutMs: 60000 },
      { input: 'dimensions.yaml', reason: 'abort' },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    const error = await rejection(pending);
    expect(error.code).toBe('ABORTED');
  });
});
