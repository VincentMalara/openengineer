import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as plugin from '../src/index.js';
import type { EngineConfig } from '../../engineering-core/src/index.js';
import type {
  CadBatchResult, CadCommit, CadDeleteResult, CadEdgeReport, CadExport, CadFeatureResult,
  CadHistory, CadPartBasic, CadPartList, CadPartSummary, CadProject, CadProjectStatus, CadRender,
} from '../../engineering-core/src/cad.js';

const roots: string[] = [];
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup(): Promise<EngineConfig> {
  const root = await mkdtemp(join(tmpdir(), 'cad-suite-')); roots.push(root);
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
    callId: ToolCallId('cad-suite-test'), name, arguments: args });
  if (result.isError) throw new Error(`Unexpected ${name} failure: ${result.error.info?.code} ${result.error.message}`);
  return { value: result.value as unknown, text: result.content[0]?.type === 'text' ? result.content[0].text : '' };
}

async function failure(ctx: Context, name: string, args: Record<string, unknown>): Promise<string | undefined> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal,
    callId: ToolCallId('cad-suite-test'), name, arguments: args });
  expect(result.isError).toBe(true);
  return result.isError ? result.error.info?.code : undefined;
}

describe('CAD suite: project, part, features, export and revisions', () => {
  it('creates a parametric part, exports STEP and commits an immutable revision', async () => {
    const config = await setup();
    const ctx = await harness(config);
    expect(ctx.tools.schemas().some(t => t.name === 'cad_feature_extrude')).toBe(true);

    const project = (await invoke(ctx, 'cad_project_create', { name: 'demo', units: 'mm' })).value as CadProject;
    expect(project.units).toBe('mm');

    const part = (await invoke(ctx, 'cad_part_create', { name: 'plate', material: 'alu-6061' })).value as CadPartBasic;
    expect(part.part).toBe('part-000001');
    expect(part.material).toBe('alu-6061');

    const extrude = (await invoke(ctx, 'cad_feature_extrude', {
      part: part.part,
      profile: { shape: 'rectangle', width: 80, height: 40, center: [40, 20] },
      distance: 6,
      operation: 'add',
    })).value as CadFeatureResult;
    expect(extrude.feature).toMatchObject({ id: 'feature-001', type: 'extrude' });
    expect(extrude.checks).toEqual({ valid: true, single_solid: true, positive_volume: true, finite_bounds: true });
    expect(extrude.bounds_mm.max).toEqual([80, 40, 6]);
    expect(extrude.mass_g).toBeGreaterThan(0);

    const plateVolume = extrude.volume_mm3;
    await invoke(ctx, 'cad_feature_hole', { part: part.part, x: 20, y: 20, diameter: 6, through: true });
    await invoke(ctx, 'cad_feature_hole', { part: part.part, x: 60, y: 20, diameter: 6, through: true });
    const fillet = (await invoke(ctx, 'cad_feature_fillet', {
      part: part.part, radius: 3, selector: { kind: 'parallel', axis: 'z' },
    })).value as CadFeatureResult;
    expect(fillet.feature).toMatchObject({ id: 'feature-004', type: 'fillet' });
    expect(fillet.volume_mm3).toBeLessThan(plateVolume);

    const chamfer = (await invoke(ctx, 'cad_feature_chamfer', {
      part: part.part, distance: 0.5, selector: { kind: 'holes', z: 'top' },
    })).value as CadFeatureResult;
    expect(chamfer.feature).toMatchObject({ id: 'feature-005', type: 'chamfer' });
    expect(chamfer.volume_mm3).toBeLessThan(fillet.volume_mm3);

    const summary = (await invoke(ctx, 'cad_part_get', { part: part.part })).value as CadPartSummary;
    expect(summary.name).toBe('plate');
    expect(summary.features).toHaveLength(5);
    expect(summary.checks.single_solid).toBe(true);
    expect(summary.mass_g).toBeGreaterThan(0);

    const exported = (await invoke(ctx, 'cad_part_export', { part: part.part, format: 'step' })).value as CadExport;
    expect(exported.format).toBe('step');
    expect(exported.bytes).toBeGreaterThan(1000);
    expect((await stat(exported.path)).size).toBe(exported.bytes);

    const commit = (await invoke(ctx, 'cad_project_commit', { message: 'Plate with two holes' })).value as CadCommit;
    expect(commit.revision).toMatch(/^revision-\d{6}-[0-9a-f]{8}$/);
    expect(commit.parts).toBe(1);

    const status = (await invoke(ctx, 'cad_project_status', {})).value as CadProjectStatus;
    expect(status).toMatchObject({ project: 'demo', parts: 1, last_revision: commit.revision, dirty: false });

    const history = (await invoke(ctx, 'cad_project_history', {})).value as CadHistory;
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0].revision).toBe(commit.revision);

    const parts = (await invoke(ctx, 'cad_part_list', {})).value as CadPartList;
    expect(parts.parts).toEqual([{ part: part.part, name: 'plate', material: 'alu-6061', features: 5 }]);
  }, 180000);

  it('builds a tube directly from outer diameter, length and wall thickness', async () => {
    const config = await setup();
    const ctx = await harness(config);
    await invoke(ctx, 'cad_project_create', { name: 'demo' });
    const part = (await invoke(ctx, 'cad_part_create', { name: 'tube', material: 'alu-6061' })).value as CadPartBasic;
    const tube = (await invoke(ctx, 'cad_feature_tube', {
      part: part.part, outer_diameter: 100, wall_thickness: 2, length: 80,
    })).value as CadFeatureResult;
    expect(tube.feature).toMatchObject({ type: 'tube', outer_diameter: 100, wall_thickness: 2, length: 80 });
    expect(tube.bounds_mm.min).toEqual([-50, -50, 0]);
    expect(tube.bounds_mm.max).toEqual([50, 50, 80]);
    const expected = Math.PI * (50 ** 2 - 48 ** 2) * 80;
    expect(Math.abs(tube.volume_mm3 - expected) / expected).toBeLessThan(0.001);
    expect(tube.mass_g).toBeGreaterThan(100);
    const exported = (await invoke(ctx, 'cad_part_export', { part: part.part, format: 'step' })).value as CadExport;
    expect(exported.bytes).toBeGreaterThan(1000);
  }, 180000);

  it('marks the draft dirty after a commit and rejects an empty commit', async () => {
    const config = await setup();
    const ctx = await harness(config);
    await invoke(ctx, 'cad_project_create', { name: 'demo' });
    const part = (await invoke(ctx, 'cad_part_create', { name: 'block' })).value as CadPartBasic;
    await invoke(ctx, 'cad_feature_extrude', {
      part: part.part, profile: { shape: 'circle', radius: 10 }, distance: 5,
    });
    await invoke(ctx, 'cad_project_commit', { message: 'first' });
    expect((await invoke(ctx, 'cad_project_status', {})).value).toMatchObject({ dirty: false });
    expect(await failure(ctx, 'cad_project_commit', { message: 'no change' })).toBe('CONFLICT');
    await invoke(ctx, 'cad_feature_hole', { part: part.part, x: 0, y: 0, diameter: 4 });
    expect((await invoke(ctx, 'cad_project_status', {})).value).toMatchObject({ dirty: true });
  }, 180000);

  it('inspects edges, batch-applies, groups, updates, deletes and renders', async () => {
    const config = await setup();
    const ctx = await harness(config);
    await invoke(ctx, 'cad_project_create', { name: 'demo' });
    const part = (await invoke(ctx, 'cad_part_create', { name: 'block', material: 'alu-6061' })).value as CadPartBasic;
    await invoke(ctx, 'cad_feature_extrude', {
      part: part.part,
      profile: { shape: 'rectangle', width: 40, height: 40, center: [20, 20] },
      distance: 5,
    });

    const edges = (await invoke(ctx, 'cad_part_edges', { part: part.part, kind: 'line', axis: 'z' })).value as CadEdgeReport;
    expect(edges.returned).toBeGreaterThanOrEqual(4);

    const dry = (await invoke(ctx, 'cad_features_apply', {
      part: part.part, features: [{ type: 'hole', x: 10, y: 10, diameter: 4 }], dry_run: true,
    })).value as CadBatchResult;
    expect(dry.dry_run).toBe(true);
    expect(dry.applied).toBe(1);
    expect(((await invoke(ctx, 'cad_part_get', { part: part.part })).value as CadPartSummary).features).toHaveLength(1);

    await invoke(ctx, 'cad_features_apply', {
      part: part.part, features: [{ type: 'hole', x: 10, y: 10, diameter: 4 }],
    });
    const group = (await invoke(ctx, 'cad_feature_fillet_group', {
      part: part.part,
      operations: [
        { radius: 1, selector: { kind: 'parallel', axis: 'z' } },
        { radius: 0.5, selector: { kind: 'holes', z: 'top' } },
      ],
    })).value as CadFeatureResult;
    expect(group.feature).toMatchObject({ type: 'fillet_group' });
    const featureId = (group.feature as { id: string }).id;

    const updated = (await invoke(ctx, 'cad_feature_update', {
      part: part.part, feature_id: featureId,
      parameters: { operations: [{ radius: 0.75, selector: { kind: 'holes', z: 'top' } }] },
    })).value as CadFeatureResult;
    expect((updated.feature as { operations: Array<{ radius: number }> }).operations[0].radius).toBe(0.75);

    const deleted = (await invoke(ctx, 'cad_feature_delete', {
      part: part.part, feature_id: featureId,
    })).value as CadDeleteResult;
    expect(deleted.features).toBe(2);

    const rendered = (await invoke(ctx, 'cad_render', { part: part.part, view: 'iso', size: 500 })).value as CadRender;
    expect(rendered.bytes).toBeGreaterThan(1000);
    expect((await stat(rendered.path)).size).toBe(rendered.bytes);
  }, 180000);

  it('returns typed failures for missing projects, duplicates and invalid features', async () => {
    const config = await setup();
    const ctx = await harness(config);
    expect(await failure(ctx, 'cad_part_list', {})).toBe('NOT_FOUND');
    await invoke(ctx, 'cad_project_create', { name: 'demo' });
    expect(await failure(ctx, 'cad_project_create', { name: 'demo' })).toBe('CONFLICT');
    const part = (await invoke(ctx, 'cad_part_create', { name: 'block' })).value as CadPartBasic;
    expect(await failure(ctx, 'cad_feature_hole', { part: part.part, x: 0, y: 0, diameter: 4 })).toBe('VALIDATION');
    await invoke(ctx, 'cad_feature_extrude', {
      part: part.part, profile: { shape: 'rectangle', width: 20, height: 20, center: [10, 10] }, distance: 5,
    });
    expect(await failure(ctx, 'cad_feature_hole', { part: part.part, x: 100, y: 100, diameter: 4 })).toBe('VALIDATION');
    expect(await failure(ctx, 'cad_part_get', { part: '../escape' })).toBe('VALIDATION');
    expect(await failure(ctx, 'cad_part_get', { part: 'part-000099' })).toBe('NOT_FOUND');
  }, 180000);
});
