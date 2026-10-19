import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { EngineError, type EngineConfig } from '../../engineering-core/src/index.js';
import {
  runCadOperation,
  type CadCommit, type CadExport, type CadFeatureResult, type CadHistory,
  type CadBatchResult, type CadDeleteResult, type CadEdgeReport, type CadMaterialList, type CadPartBasic,
  type CadPartList, type CadPartSummary, type CadProject, type CadProjectStatus, type CadRender,
} from '../../engineering-core/src/cad.js';

class OpenEngineerError extends HarnessError {}

const boundsValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    min: { type: 'array', items: { type: 'number' }, required: true },
    max: { type: 'array', items: { type: 'number' }, required: true },
  },
} as const;

const boundsSchema = { ...boundsValueSchema, required: true } as const;
const nullableBoundsSchema = {
  oneOf: [boundsValueSchema, { type: 'null' }],
  required: true,
} as const;

const checksSchema = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    valid: { type: 'boolean', required: true },
    single_solid: { type: 'boolean', required: true },
    positive_volume: { type: 'boolean', required: true },
    finite_bounds: { type: 'boolean', required: true },
  },
} as const;

const materialPropertiesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    density_kg_m3: { type: 'number', required: true },
    youngs_modulus_mpa: { type: 'number', required: true },
    poisson: { type: 'number', required: true },
    yield_mpa: { type: 'number', required: true },
  },
} as const;

const featureArraySchema = { type: 'array', items: { type: 'json' }, required: true } as const;
const numberArraySchema = { type: 'array', items: { type: 'number' }, required: true } as const;

const partSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    part: { type: 'string', required: true },
    name: { type: 'string', required: true },
    material: { type: 'string', required: true },
    features: featureArraySchema,
    checks: checksSchema,
    bounds_mm: boundsSchema,
    bounds_tight_mm: nullableBoundsSchema,
    volume_mm3: { type: 'number', required: true },
    mass_g: { type: 'number', required: true },
    center_of_mass_mm: numberArraySchema,
    material_properties: { ...materialPropertiesSchema, required: true },
  },
} as const;

const featureResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    part: { type: 'string', required: true },
    feature: { type: 'json', required: true },
    checks: checksSchema,
    bounds_mm: boundsSchema,
    bounds_tight_mm: nullableBoundsSchema,
    volume_mm3: { type: 'number', required: true },
    mass_g: { type: 'number', required: true },
    center_of_mass_mm: numberArraySchema,
    material_properties: { ...materialPropertiesSchema, required: true },
  },
} as const;

const edgeSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    length_mm: { type: 'number', required: true },
    center_mm: { type: 'array', items: { type: 'number' }, required: true },
    closed: { type: 'boolean', required: true },
    radius_mm: { type: 'number' },
    diameter_mm: { type: 'number' },
    axis: { type: 'string' },
  },
} as const;

const batchResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    part: { type: 'string', required: true },
    applied: { type: 'number', required: true },
    dry_run: { type: 'boolean', required: true },
    feature_ids: { type: 'array', items: { type: 'string' }, required: true },
    checks: checksSchema,
    bounds_mm: boundsSchema,
    bounds_tight_mm: nullableBoundsSchema,
    volume_mm3: { type: 'number', required: true },
    mass_g: { type: 'number', required: true },
    center_of_mass_mm: numberArraySchema,
    material_properties: { ...materialPropertiesSchema, required: true },
  },
} as const;

const deleteResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    part: { type: 'string', required: true },
    deleted: { type: 'string', required: true },
    features: { type: 'number', required: true },
    checks: checksSchema,
    bounds_mm: boundsSchema,
    bounds_tight_mm: nullableBoundsSchema,
    volume_mm3: { type: 'number', required: true },
    mass_g: { type: 'number', required: true },
    center_of_mass_mm: numberArraySchema,
    material_properties: { ...materialPropertiesSchema, required: true },
  },
} as const;

const renderResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    part: { type: 'string', required: true },
    view: { type: 'string', required: true },
    path: { type: 'string', required: true },
    relative_path: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    checks: checksSchema,
  },
} as const;

const profileSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        shape: { type: 'string', const: 'rectangle', required: true },
        width: { type: 'number', required: true, description: 'X size in mm' },
        height: { type: 'number', required: true, description: 'Y size in mm' },
        center: { type: 'array', items: { type: 'number' }, description: '2D center on the sketch plane; defaults to [0, 0]' },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        shape: { type: 'string', const: 'circle', required: true },
        radius: { type: 'number', required: true, description: 'Radius in mm' },
        center: { type: 'array', items: { type: 'number' }, description: '2D center on the sketch plane; defaults to [0, 0]' },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        shape: { type: 'string', const: 'polygon', required: true },
        points: {
          type: 'array', required: true,
          items: { type: 'array', items: { type: 'number' } },
          description: 'Closed polygon points in mm, at least 3, in sketch-plane coordinates',
        },
      },
    },
  ],
} as const;

const selectorSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: { kind: { type: 'string', const: 'all', required: true } },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'parallel', required: true },
        axis: { type: 'string', enum: ['x', 'y', 'z'], required: true },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'box', required: true },
        min: { type: 'array', items: { type: 'number' }, required: true },
        max: { type: 'array', items: { type: 'number' }, required: true },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'circular', required: true },
        diameter: { type: 'number', description: 'Circle diameter in mm' },
        center: { type: 'array', items: { type: 'number' }, description: 'Circle centre [x, y] in mm' },
        z: { type: 'string', enum: ['top', 'bottom', 'both'], description: 'Restrict to the part top, bottom or both' },
      },
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'holes', required: true },
        z: { type: 'string', enum: ['top', 'bottom', 'both'], description: 'Restrict to the part top, bottom or both' },
      },
    },
  ],
} as const;

function formatNumber(value: number): string {
  if (Math.abs(value) < 1e-9) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatChecks(checks: CadPartSummary['checks']): string {
  return Object.entries(checks).map(([name, passed]) => `${name}=${passed ? 'pass' : 'FAIL'}`).join(', ');
}

function formatSize(value: { min: number[]; max: number[] } | null): string {
  if (value === null) return 'unknown';
  const size = value.max.map((max, index) => max - (value.min[index] ?? 0));
  return `${size.map(formatNumber).join(' x ')} mm`;
}

function featureLabel(feature: unknown): string {
  if (feature !== null && typeof feature === 'object') {
    const fields = feature as { id?: unknown; type?: unknown };
    return `${String(fields.id ?? 'feature')} (${String(fields.type ?? 'unknown')})`;
  }
  return 'feature';
}

function formatPartSummary(value: CadPartSummary): string {
  return [
    `Part ${value.part} "${value.name}" - material ${value.material}`,
    `Size: ${formatSize(value.bounds_tight_mm ?? value.bounds_mm)} | volume: ${value.volume_mm3.toFixed(1)} mm3 | mass: ${value.mass_g.toFixed(2)} g`,
    `Checks: ${formatChecks(value.checks)}`,
    `Features: ${value.features.length}`,
  ].join('\n');
}

function formatFeatureResult(value: CadFeatureResult): string {
  return [
    `Added ${featureLabel(value.feature)} to ${value.part}`,
    `Size: ${formatSize(value.bounds_tight_mm ?? value.bounds_mm)} | volume: ${value.volume_mm3.toFixed(1)} mm3 | mass: ${value.mass_g.toFixed(2)} g`,
    `Checks: ${formatChecks(value.checks)}`,
  ].join('\n');
}

function formatProject(value: CadProject): string {
  return `Project "${value.name}" (${value.units}) at ${value.directory}`;
}

function formatStatus(value: CadProjectStatus): string {
  return `Project "${value.name}": ${value.parts} part(s), last revision ${value.last_revision ?? 'none'}, draft ${value.dirty ? 'dirty' : 'clean'}.`;
}

function formatCommit(value: CadCommit): string {
  return `Committed ${value.revision}: ${value.message} (${value.parts} part(s), ${value.files} file(s)).`;
}

function formatHistory(value: CadHistory): string {
  if (value.revisions.length === 0) return 'No revisions yet.';
  return value.revisions
    .map(revision => `- ${revision.revision} | ${revision.timestamp} | ${revision.parts} part(s) | ${revision.message}`)
    .join('\n');
}

function formatPartBasic(value: CadPartBasic): string {
  return `Created part ${value.part} "${value.name}" with material ${value.material}.`;
}

function formatPartList(value: CadPartList): string {
  if (value.parts.length === 0) return 'No parts yet.';
  return value.parts
    .map(part => `- ${part.part} "${part.name}" | ${part.material} | ${part.features} feature(s)`)
    .join('\n');
}

function formatExport(value: CadExport): string {
  return `Exported ${value.format.toUpperCase()} to ${value.path} (${value.bytes} bytes).`;
}

function formatMaterials(value: CadMaterialList): string {
  return value.materials
    .map(material => `- ${material.id} (${material.name}): ${material.density_kg_m3} kg/m3, yield ${material.yield_mpa} MPa`)
    .join('\n');
}

function formatEdges(value: CadEdgeReport): string {
  const counts = new Map<string, number>();
  for (const edge of value.edges) counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([kind, count]) => `${kind}=${count}`).join(', ');
  const lines = [`${value.part}: ${value.returned}/${value.total} edge(s) returned (${summary}).`];
  for (const edge of value.edges.slice(0, 12)) {
    const radius = edge.radius_mm === undefined ? '' : ` r=${formatNumber(edge.radius_mm)}`;
    const axis = edge.axis === undefined ? '' : ` axis=${edge.axis}`;
    lines.push(`- ${edge.id} ${edge.kind} length=${formatNumber(edge.length_mm)} mm center=[${edge.center_mm.map(formatNumber).join(', ')}]${radius}${axis}`);
  }
  return lines.join('\n');
}

function formatBatch(value: CadBatchResult): string {
  return [
    `${value.dry_run ? 'Validated' : 'Applied'} ${value.applied} feature(s) to ${value.part}${value.dry_run ? ' (dry run, not saved)' : ''}.`,
    `Size: ${formatSize(value.bounds_tight_mm ?? value.bounds_mm)} | volume: ${value.volume_mm3.toFixed(1)} mm3 | mass: ${value.mass_g.toFixed(2)} g`,
    `Checks: ${formatChecks(value.checks)}`,
    `Feature ids: ${value.feature_ids.join(', ')}`,
  ].join('\n');
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

export function registerCadTools(ctx: Context, config: EngineConfig): void {
  ctx.tools.register(defineTool({
    name: 'cad_project_create',
    description: 'Create a CAD project in the configured root with a name and millimetre units. Fails with CONFLICT if a project already exists.',
    parameters: {
      name: { type: 'string', required: true, description: 'Project name' },
      units: { type: 'string', enum: ['mm'], description: 'Units; only mm is supported' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          name: { type: 'string', required: true },
          units: { type: 'string', required: true },
          directory: { type: 'string', required: true },
          created: { type: 'string', required: true },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatProject(value as CadProject) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadProject>(config, 'project_create', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_project_status',
    description: 'Show the current project name, part count, last revision and whether the draft has uncommitted changes. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          name: { type: 'string', required: true },
          units: { type: 'string', required: true },
          parts: { type: 'number', required: true },
          last_revision: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          dirty: { type: 'boolean', required: true },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatStatus(value as CadProjectStatus) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return runTool(() => runCadOperation<CadProjectStatus>(config, 'project_status', {}));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_project_commit',
    description: 'Freeze the current draft into an immutable revision. Fails with CONFLICT when nothing changed since the last revision. Returns the revision id and directory.',
    parameters: {
      message: { type: 'string', required: true, description: 'Decision or change summary for this revision' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          revision: { type: 'string', required: true },
          directory: { type: 'string', required: true },
          message: { type: 'string', required: true },
          timestamp: { type: 'string', required: true },
          parts: { type: 'number', required: true },
          files: { type: 'number', required: true },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatCommit(value as CadCommit) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadCommit>(config, 'project_commit', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_project_history',
    description: 'List committed CAD revisions, oldest first. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          revisions: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                revision: { type: 'string', required: true },
                message: { type: 'string', required: true },
                timestamp: { type: 'string', required: true },
                parts: { type: 'number', required: true },
              },
            },
          },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatHistory(value as CadHistory) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return runTool(() => runCadOperation<CadHistory>(config, 'project_history', {}));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_create',
    description: 'Create a new empty part in the project. Add an extrude feature next. Material defaults to steel-1018; use cad_material_list to see options.',
    parameters: {
      name: { type: 'string', required: true, description: 'Part name' },
      material: { type: 'string', description: 'Material id from cad_material_list; default steel-1018' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          part: { type: 'string', required: true },
          name: { type: 'string', required: true },
          material: { type: 'string', required: true },
          features: featureArraySchema,
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatPartBasic(value as CadPartBasic) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadPartBasic>(config, 'part_create', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_list',
    description: 'List parts in the project with name, material and feature count. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          parts: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                part: { type: 'string', required: true },
                name: { type: 'string', required: true },
                material: { type: 'string', required: true },
                features: { type: 'number', required: true },
              },
            },
          },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatPartList(value as CadPartList) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return runTool(() => runCadOperation<CadPartList>(config, 'part_list', {}));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_get',
    description: 'Rebuild one part and return its feature list, measured size, volume, mass, centre of mass and validation checks. Read-only.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id such as part-000001' },
    },
    output: {
      schema: partSummarySchema,
      render: (_args, value) => [{ type: 'text', text: formatPartSummary(value as CadPartSummary) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadPartSummary>(config, 'part_get', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_rebuild',
    description: 'Force a rebuild of one part from its ordered features and return fresh measurements and checks. Refuses a part file modified outside the CAD tools; use cad_part_import for an explicit hand-edited spec. Read-only.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id such as part-000001' },
    },
    output: {
      schema: partSummarySchema,
      render: (_args, value) => [{ type: 'text', text: formatPartSummary(value as CadPartSummary) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadPartSummary>(config, 'part_rebuild', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_set_material',
    description: 'Assign a material to a part and recompute its mass. Use cad_material_list for valid ids.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      material: { type: 'string', required: true, description: 'Material id' },
    },
    output: {
      schema: partSummarySchema,
      render: (_args, value) => [{ type: 'text', text: formatPartSummary(value as CadPartSummary) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadPartSummary>(config, 'part_set_material', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_extrude',
    description: 'Append an extrude feature: a rectangle, circle or polygon profile on the XY, XZ or YZ plane, extruded along the plane normal. Profile coordinates are centred on the plane origin unless center is given. direction=reverse extrudes against the normal, both extrudes symmetrically. The first extrude must use operation add. The part is rebuilt and validated before the feature is kept.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      profile: { oneOf: profileSchema.oneOf, required: true, description: '2D profile in mm' },
      plane: { type: 'string', enum: ['XY', 'XZ', 'YZ'], description: 'Sketch plane; default XY' },
      offset: { type: 'number', description: 'Plane offset in mm along its normal; default 0' },
      distance: { type: 'number', required: true, description: 'Extrusion distance in mm, positive' },
      direction: { type: 'string', enum: ['normal', 'reverse', 'both'], description: 'Extrusion direction; default normal' },
      operation: { type: 'string', enum: ['add', 'cut', 'intersect'], description: 'Boolean operation; default add' },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_extrude', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_hole',
    description: 'Append a hole along the X, Y or Z axis. Axis z drills from the top and uses x/y; axes x and y require at=[x,y,z]. through=true drills the full range; through=false requires depth. The hole must remove material. Rebuilt and validated before it is kept.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      x: { type: 'number', required: true, description: 'Hole centre X in mm (Z-axis holes; ignored when at is given)' },
      y: { type: 'number', required: true, description: 'Hole centre Y in mm (Z-axis holes; ignored when at is given)' },
      diameter: { type: 'number', required: true, description: 'Hole diameter in mm' },
      through: { type: 'boolean', description: 'Through hole; default true' },
      depth: { type: 'number', description: 'Blind depth in mm; required when through is false' },
      axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Drill axis; default z' },
      at: { type: 'array', items: { type: 'number' }, description: '3D hole centre [x,y,z]; required for x and y axes' },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_hole', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_fillet',
    description: 'Append an edge fillet. Select edges by all, parallelism to an axis, a bounding box, circular geometry (diameter/centre/height) or all hole edges. The part is rebuilt and validated before the feature is kept.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      radius: { type: 'number', required: true, description: 'Fillet radius in mm' },
      selector: { oneOf: selectorSchema.oneOf, required: true, description: 'Edge selector' },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_fillet', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_chamfer',
    description: 'Append an edge chamfer. distance is the chamfer leg in mm; distance2 optionally makes it asymmetric. Use selector {kind:"holes", z:"top"} to chamfer hole entry edges, or all/parallel/box/circular selectors. The part is rebuilt and validated before the feature is kept.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      distance: { type: 'number', required: true, description: 'Chamfer distance in mm' },
      distance2: { type: 'number', description: 'Optional second chamfer distance in mm for an asymmetric chamfer' },
      selector: { oneOf: selectorSchema.oneOf, required: true, description: 'Edge selector' },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_chamfer', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_tube',
    description: 'Add a hollow cylinder in one call: outer diameter, length, and either inner diameter or wall thickness. Axis X, Y or Z; the tube starts at the origin and extends along the positive axis. Use this directly for tubes, pipes and bushings instead of composing two extrusions.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      outer_diameter: { type: 'number', required: true, description: 'Outer diameter in mm' },
      inner_diameter: { type: 'number', description: 'Inner diameter in mm; provide this or wall_thickness' },
      wall_thickness: { type: 'number', description: 'Wall thickness in mm; provide this or inner_diameter' },
      length: { type: 'number', required: true, description: 'Tube length in mm' },
      axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Extrusion axis; default z' },
      operation: { type: 'string', enum: ['add', 'cut', 'intersect'], description: 'Boolean operation; default add' },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_tube', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_edges',
    description: 'List B-rep edges with deterministic ids, kind, length, centre, circle radius/diameter and axis. Filter by kind, axis, minimum length or a bounding box. Read-only; use it before choosing fillet or chamfer selectors.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      kind: { type: 'string', enum: ['all', 'line', 'circle', 'bspline', 'other'], description: 'Edge kind; default all' },
      axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Keep line edges parallel to this axis' },
      min_length: { type: 'number', description: 'Minimum edge length in mm' },
      box: {
        type: 'object', additionalProperties: false,
        properties: {
          min: { type: 'array', items: { type: 'number' }, required: true },
          max: { type: 'array', items: { type: 'number' }, required: true },
        },
      },
      limit: { type: 'number', description: 'Maximum edges returned; default 200' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          part: { type: 'string', required: true },
          total: { type: 'number', required: true },
          returned: { type: 'number', required: true },
          edges: { type: 'array', items: edgeSchema, required: true },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatEdges(value as CadEdgeReport) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadEdgeReport>(config, 'part_edges', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_features_apply',
    description: 'Append several features in one atomic rebuild. With dry_run=true nothing is written; use it to test a fillet/chamfer chain or a candidate design. Returns the failing feature index on error.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      features: { type: 'array', items: { type: 'json' }, required: true, description: 'Ordered feature payloads, same shape as the individual cad_feature_* tools' },
      dry_run: { type: 'boolean', description: 'Validate without writing; default false' },
    },
    output: {
      schema: batchResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatBatch(value as CadBatchResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadBatchResult>(config, 'features_apply', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_update',
    description: 'Update one existing feature by id without editing part JSON. id and type are immutable; parameters are merged into the feature. The part is rebuilt and validated before saving.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      feature_id: { type: 'string', required: true, description: 'Feature id such as feature-003' },
      parameters: { type: 'object', additionalProperties: true, required: true, description: 'Fields to merge, for example { "radius": 2.5 }' },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_update', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_delete',
    description: 'Delete one feature by id and rebuild the remaining chain. Refuses to delete the last feature. Use cad_part_edges after deletion to inspect the result.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      feature_id: { type: 'string', required: true, description: 'Feature id such as feature-003' },
    },
    output: {
      schema: deleteResultSchema,
      render: (_args, value) => {
        const result = value as unknown as { deleted: string; features: number; volume_mm3: number; mass_g: number };
        return [{ type: 'text', text: `Deleted ${result.deleted}; ${result.features} feature(s) remain. Volume ${result.volume_mm3.toFixed(1)} mm3, mass ${result.mass_g.toFixed(2)} g.` }];
      },
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadDeleteResult>(config, 'feature_delete', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_fillet_group',
    description: 'Apply an ordered group of fillets in one atomic feature. Each operation has a radius and a selector. If one operation fails, the whole group is rejected and nothing is written.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      operations: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            radius: { type: 'number', required: true, description: 'Fillet radius in mm' },
            selector: { oneOf: selectorSchema.oneOf, required: true, description: 'Edge selector' },
          },
        },
      },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_fillet_group', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_feature_chamfer_group',
    description: 'Apply an ordered group of chamfers in one atomic feature. Each operation has distance, optional distance2 and a selector. If one operation fails, the whole group is rejected.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      operations: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            distance: { type: 'number', required: true, description: 'Chamfer distance in mm' },
            distance2: { type: 'number', description: 'Optional asymmetric second distance' },
            selector: { oneOf: selectorSchema.oneOf, required: true, description: 'Edge selector' },
          },
        },
      },
    },
    output: {
      schema: featureResultSchema,
      render: (_args, value) => [{ type: 'text', text: formatFeatureResult(value as CadFeatureResult) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadFeatureResult>(config, 'feature_chamfer_group', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_import',
    description: 'Explicit escape hatch for a hand-edited part spec. Merges the provided spec fields (name, material, features) over the current part, validates and rebuilds under the project lock, then records the new hash. id and created are preserved. Prefer cad_feature_* and cad_feature_update for normal edits.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      spec: { type: 'object', additionalProperties: true, required: true, description: 'Partial or complete part spec: name, material, features' },
    },
    output: {
      schema: partSummarySchema,
      render: (_args, value) => [{ type: 'text', text: formatPartSummary(value as CadPartSummary) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadPartSummary>(config, 'part_import', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_render',
    description: 'Render a shaded PNG preview of one part (iso, front, top or right) into the artifacts directory. Returns the path and byte size; the image is for human inspection.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      view: { type: 'string', enum: ['iso', 'front', 'top', 'right'], description: 'Camera view; default iso' },
      size: { type: 'number', description: 'Image width in pixels; default 1200' },
    },
    output: {
      schema: renderResultSchema,
      render: (_args, value) => {
        const result = value as unknown as CadRender;
        return [{ type: 'text', text: `Rendered ${result.view} view to ${result.path} (${result.bytes} bytes).` }];
      },
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadRender>(config, 'part_render', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_part_export',
    description: 'Export one part as STEP, STL or glTF into the project artifacts directory. Returns the absolute and relative paths, byte size and validation checks.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      format: { type: 'string', enum: ['step', 'stl', 'gltf'], required: true, description: 'Export format' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          part: { type: 'string', required: true },
          format: { type: 'string', required: true },
          path: { type: 'string', required: true },
          relative_path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          checks: checksSchema,
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatExport(value as CadExport) }],
    },
    async execute(args, execution) {
      return runTool(() => runCadOperation<CadExport>(config, 'part_export', args, execution.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cad_material_list',
    description: 'List built-in materials with density, elastic modulus, Poisson ratio and yield strength. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          materials: { type: 'array', required: true, items: materialPropertiesSchema },
        },
      } as const,
      render: (_args, value) => [{ type: 'text', text: formatMaterials(value as CadMaterialList) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return runTool(() => runCadOperation<CadMaterialList>(config, 'material_list', {}));
    },
  }));
}
