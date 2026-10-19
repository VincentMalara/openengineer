import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { mkdtemp, copyFile, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import * as plugin from '../src/index.js';
import {
  buildBracket, EngineError,
  type BuildResult, type EngineConfig, type RevisionDetail, type RevisionList,
} from '../../engineering-core/src/index.js';

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

async function harness(config: EngineConfig): Promise<Context> {
  const ctx = new Context(); contexts.push(ctx);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(plugin, config);
  return ctx;
}

async function invoke(ctx: Context, name: string, args: Record<string, unknown>) {
  const result = await ctx.tools.execute({ signal: new AbortController().signal,
    callId: ToolCallId('cad-test'), name, arguments: args });
  if (result.isError) throw new Error(`Unexpected tool error: ${result.error.message}`);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return { value: result.value as unknown, text: block.type === 'text' ? block.text : '' };
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
    const ctx = await harness(config);
    expect(ctx.tools.schemas().some(t => t.name === 'openengineer_build_bracket')).toBe(true);
    expect(ctx.tools.schemas().some(t => t.name === 'openengineer_list_revisions')).toBe(true);
    expect(ctx.tools.schemas().some(t => t.name === 'openengineer_inspect_revision')).toBe(true);
    const call = async (args: Record<string, unknown>) => {
      const result = await invoke(ctx, 'openengineer_build_bracket', args);
      return { value: result.value as BuildResult, text: result.text };
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
    const output = await rejection(buildBracket({ ...config, artifactsDir: '../outside' }, { input: 'dimensions.yaml', reason: 'escape' }));
    expect(output.code).toBe('PATH');
  });

  it('surfaces invalid dimensions as a typed VALIDATION tool failure without a revision', async () => {
    const config = await setup();
    const ctx = await harness(config);
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

  it('supports a custom artifacts directory and read-only revision tools', async () => {
    const config = { ...(await setup()), artifactsDir: 'builds' };
    const ctx = await harness(config);
    const first = await invoke(ctx, 'openengineer_build_bracket', { input: 'dimensions.yaml', reason: 'Initial build' });
    const initial = first.value as BuildResult;
    expect(initial.directory).toContain(`${sep}builds${sep}`);
    const second = await invoke(ctx, 'openengineer_build_bracket', {
      input: `builds/${initial.revision}/parameters.yaml`, reason: 'Raise height', height: 45,
    });
    const modified = second.value as BuildResult;
    const listed = await invoke(ctx, 'openengineer_list_revisions', {});
    const list = listed.value as RevisionList;
    expect(list.artifacts_directory).toContain(`${sep}builds`);
    expect(list.revisions.map(revision => revision.revision)).toEqual([initial.revision, modified.revision]);
    expect(list.revisions[1].parent).toBe(initial.revision);
    expect(listed.text).toContain(modified.revision);
    const inspected = await invoke(ctx, 'openengineer_inspect_revision', { revision: modified.revision });
    const detail = inspected.value as RevisionDetail;
    expect(detail.revision).toBe(modified.revision);
    expect(detail.parent).toBe(initial.revision);
    expect(detail.bounds_mm).toEqual([80, 40, 45]);
    expect(detail.parameters).toMatchObject({ name: 'mounting-bracket' });
    expect(detail.changes).toMatchObject({ height: { after: { value: 45 } } });
    expect(detail.report).toContain('## Validation');
    expect(inspected.text).toContain('Report:');
  }, 180000);

  it('reports empty projects, unknown revisions and malformed ids', async () => {
    const config = await setup();
    const ctx = await harness(config);
    const listed = await invoke(ctx, 'openengineer_list_revisions', {});
    expect((listed.value as RevisionList).revisions).toEqual([]);
    expect(listed.text).toContain('No committed revisions');
    const missing = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('cad-test'), name: 'openengineer_inspect_revision',
      arguments: { revision: 'revision-000001-deadbeef' } });
    expect(missing.isError).toBe(true);
    if (missing.isError) expect(missing.error.info?.code).toBe('NOT_FOUND');
    const malformed = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('cad-test'), name: 'openengineer_inspect_revision',
      arguments: { revision: '../escape' } });
    expect(malformed.isError).toBe(true);
    if (malformed.isError) expect(malformed.error.info?.code).toBe('VALIDATION');
  });

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
