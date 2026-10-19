import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { EngineError, type EngineConfig } from '../../engineering-core/src/index.js';
import {
  runCadOperation,
  type CadCommit, type CadExport, type CadFeatureResult, type CadHistory,
  type CadMaterialList, type CadPartBasic, type CadPartList, type CadPartSummary,
  type CadProject, type CadProjectStatus,
} from '../../engineering-core/src/cad.js';

class OpenEngineerError extends HarnessError {}

const boundsSchema = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    min: { type: 'array', items: { type: 'number' }, required: true },
    max: { type: 'array', items: { type: 'number' }, required: true },
  },
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
    volume_mm3: { type: 'number', required: true },
    mass_g: { type: 'number', required: true },
    center_of_mass_mm: numberArraySchema,
    material_properties: { ...materialPropertiesSchema, required: true },
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

function formatSize(value: { min: number[]; max: number[] }): string {
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
    `Size: ${formatSize(value.bounds_mm)} | volume: ${value.volume_mm3.toFixed(1)} mm3 | mass: ${value.mass_g.toFixed(2)} g`,
    `Checks: ${formatChecks(value.checks)}`,
    `Features: ${value.features.length}`,
  ].join('\n');
}

function formatFeatureResult(value: CadFeatureResult): string {
  return [
    `Added ${featureLabel(value.feature)} to ${value.part}`,
    `Size: ${formatSize(value.bounds_mm)} | volume: ${value.volume_mm3.toFixed(1)} mm3 | mass: ${value.mass_g.toFixed(2)} g`,
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
    description: 'Force a rebuild of one part from its ordered features and return fresh measurements and checks. Read-only.',
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
    description: 'Append an extrude feature: a rectangle, circle or polygon profile on the XY, XZ or YZ plane, extruded along the plane normal. Profile coordinates are centred on the plane origin unless center is given. The first extrude must use operation add. The part is rebuilt and validated before the feature is kept.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      profile: { oneOf: profileSchema.oneOf, required: true, description: '2D profile in mm' },
      plane: { type: 'string', enum: ['XY', 'XZ', 'YZ'], description: 'Sketch plane; default XY' },
      offset: { type: 'number', description: 'Plane offset in mm along its normal; default 0' },
      distance: { type: 'number', required: true, description: 'Extrusion distance in mm, positive' },
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
    description: 'Append a hole drilled along -Z from the top of the part. through=true drills through the whole Z range; through=false requires depth. The hole must remove material. Rebuilt and validated before it is kept.',
    parameters: {
      part: { type: 'string', required: true, description: 'Part id' },
      x: { type: 'number', required: true, description: 'Hole centre X in mm' },
      y: { type: 'number', required: true, description: 'Hole centre Y in mm' },
      diameter: { type: 'number', required: true, description: 'Hole diameter in mm' },
      through: { type: 'boolean', description: 'Through hole; default true' },
      depth: { type: 'number', description: 'Blind depth in mm; required when through is false' },
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
