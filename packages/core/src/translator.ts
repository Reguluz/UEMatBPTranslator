import { parseClipboard } from './parser';
import { buildGraph, flag, identifier, num, rec, referenceName, str } from './graph';
import type { Connection, GraphNode, MaterialGraph } from './graph';
import type { LoweringContext } from './lowering';
import { lowerMath } from './lowering-math';
import { lowerTexture } from './lowering-texture';
import { lowerFunction } from './lowering-functions';
import type { Diagnostic, ModuleInfo, OutputCandidate, ShaderInput, SourceMapping, SourceRange, TranslationOptions, TranslationResult, Value, ValueType } from './types';

interface Ref { code: string; type: ValueType; deps: string[] }
interface Instruction extends Ref {
  id: string; nodeId: string; name: string; range: SourceRange; comment?: string;
  branches?: { label: string; value: Ref }[];
  staticBranch?: { macro: string; whenTrue: Ref; whenFalse: Ref };
}
const width = (t: ValueType): number => t === 'float' ? 1 : /^float[234]$/.test(t) ? Number(t.at(-1)) : 0;
const floatType = (n: number): ValueType => n === 1 ? 'float' : n >= 2 && n <= 4 ? `float${n}` as ValueType : 'unknown';
const literal = (n: number): string => Number.isFinite(n) ? Number.isInteger(n) ? `${n}.0` : String(n) : 'INVALID_NONFINITE_VALUE';
const safeComment = (s: string): string => s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\x00-\x1f]/g, ' ');
const numericTypes = new Set<ValueType>(['float', 'float2', 'float3', 'float4']);
// UE imports a serialized output tuple over the class constructor's existing
// FExpressionOutput. Omitted mask fields keep their defaults (often RGB/R/G/B/A).
function mergedOutputMask(output: Record<string, Value>, defaultMask: string): string | undefined {
  const enabled = Object.hasOwn(output, 'Mask') ? flag(output.Mask) : !!defaultMask;
  if (!enabled) return undefined;
  return ['R', 'G', 'B', 'A'].filter((channel, index) => Object.hasOwn(output, `Mask${channel}`)
    ? flag(output[`Mask${channel}`]) : defaultMask.includes('xyzw'[index])).map((channel) => ({ R: 'x', G: 'y', B: 'z', A: 'w' })[channel]).join('');
}
export const SUPPORTED_NODES = [
  'Constant', 'Constant2Vector', 'Constant3Vector', 'Constant4Vector', 'ScalarParameter', 'VectorParameter',
  'TextureCoordinate', 'Time', 'Add', 'Subtract', 'Multiply', 'Divide', 'Min', 'Max', 'LinearInterpolate',
  'Clamp', 'Saturate', 'Abs', 'Floor', 'Ceil', 'Frac', 'Fmod', 'OneMinus', 'Sine', 'Cosine',
  'DotProduct', 'CrossProduct', 'Normalize', 'Distance', 'AppendVector', 'ComponentMask',
  'Reroute', 'NamedRerouteDeclaration', 'NamedRerouteUsage', 'FunctionInput', 'FunctionOutput',
  'TextureObject', 'TextureObjectParameter', 'TextureSample', 'TextureSampleParameter2D', 'TextureSampleParameterVolume',
  'VertexColor', 'WorldPosition', 'VertexNormalWS', 'PixelNormalWS', 'CameraPositionWS',
  'CameraVectorWS', 'ObjectPositionWS', 'ObjectRadius', 'TwoSidedSign', 'StaticBool',
  'ShadingPathSwitch',
  'If', 'Power', 'Rotator', 'TruncateLWC', 'Length', 'StaticSwitchParameter',
  'TextureProperty', 'CloudSampleAttribute', 'VolumetricAdvancedMaterialInput', 'VolumetricAdvancedMaterialOutput', 'MaterialFunctionCall',
] as const;

export function translate(text: string, options: TranslationOptions = {}): TranslationResult {
  const engineVersion = options.engineVersion ?? '5.7';
  const diagnostics: Diagnostic[] = [];
  if (engineVersion !== '5.5' && engineVersion !== '5.7') diagnostics.push({ severity: 'error', code: 'ENGINE_VERSION', message: '仅支持 UE 5.5 和 5.7 版本档案。' });
  if (options.shadingPath && !['preserve', 'deferred', 'forward', 'mobile'].includes(options.shadingPath)) diagnostics.push({ severity: 'error', code: 'SHADING_PATH', message: 'shadingPath 必须为 preserve、deferred、forward 或 mobile。' });
  if (text.length > 20 * 1024 * 1024) return emptyResult(engineVersion, [{ severity: 'error', code: 'INPUT_LIMIT', message: '输入超过 20 MiB，请缩小复制范围。' }]);
  const parsed = parseClipboard(text);
  diagnostics.push(...parsed.diagnostics);
  const graph = buildGraph(parsed.objects);
  diagnostics.push(...graph.diagnostics);
  if (!graph.nodes.size) diagnostics.push({ severity: 'error', code: 'NO_MATERIAL_NODES', message: '没有找到材质表达式节点。请输入 UE 材质编辑器复制的节点文本。' });
  const compiler = new Compiler(graph, options, diagnostics);
  return compiler.run(engineVersion);
}
function emptyResult(engineVersion: '5.5' | '5.7', diagnostics: Diagnostic[]): TranslationResult {
  return { hlsl: '#error UE_MATERIAL_TRANSLATION_FAILED\n', status: 'unsupported', engineVersion, diagnostics, inputs: [], outputs: [], candidates: [], modules: [], sourceMap: [], stats: { nodes: 0, reachableNodes: 0, expressions: 0 } };
}

class Compiler {
  private instructions = new Map<string, Instruction>();
  private cache = new Map<string, Ref[]>();
  private visiting = new Set<string>();
  private visited = new Set<string>();
  private names = new Set<string>(['MaterialResult', 'result', 'EvaluateMaterial', 'UE_SafeDivide', 'UE_SafeNormalize', 'UE_MATERIAL_SHADING_PATH',
    'UE_PositiveClampedPow', 'UE_TextureSize2D', 'UE_TextureSize3D', 'UE_DecodeGrayscale']);
  private inputs = new Map<string, ShaderInput>();
  private helpers = new Set<string>();
  private helperSources = new Map<string, string>();
  private staticDefinitions = new Map<string, { macro: string; defaultValue: boolean }>();
  private materialSettings: Record<string, Value> = {};
  private dependencies = false;
  private diagKeys = new Set<string>();
  constructor(private graph: MaterialGraph, private options: TranslationOptions, private diagnostics: Diagnostic[]) {}

  private context(): LoweringContext {
    return { graph: this.graph, options: this.options,
      input: this.input.bind(this), connected: this.connected.bind(this), emit: this.emit.bind(this),
      parameter: this.inputParameter.bind(this), common: this.common.bind(this), as: this.as.bind(this),
      diag: this.diag.bind(this), link: this.link.bind(this), unknown: this.unknown.bind(this), channels: this.channels.bind(this),
      helper: (name, source) => { this.helperSources.set(name, source); },
      requireExternal: () => { this.dependencies = true; },
    };
  }

  private diag(node: GraphNode | undefined, code: string, message: string, severity: Diagnostic['severity'] = 'error'): void {
    const key = `${node?.id}:${code}:${message}`;
    if (this.diagKeys.has(key)) return;
    this.diagKeys.add(key);
    this.diagnostics.push({ severity, code, message, range: node?.range, nodeId: node?.id });
  }
  private unique(label: string, fallback = 'value'): string {
    const base = identifier(label, fallback); let name = base; let suffix = 2;
    while (this.names.has(name)) name = `${base}_${suffix++}`;
    this.names.add(name); return name;
  }
  private inputParameter(key: string, label: string, type: ValueType, kind: ShaderInput['kind'], source?: string, defaultValue?: Value): Ref {
    const existing = this.inputs.get(key);
    if (existing) {
      if (existing.type !== type) this.diag(undefined, 'PARAMETER_TYPE_CONFLICT', `输入 ${label} 同时被要求为 ${existing.type} 和 ${type}。`);
      if (defaultValue !== undefined && existing.defaultValue !== undefined && JSON.stringify(existing.defaultValue) !== JSON.stringify(defaultValue))
        this.diag(undefined, 'PARAMETER_DEFAULT_CONFLICT', `同名参数 ${label} 的默认值不一致。`, 'warning');
      return { code: existing.name, type: existing.type, deps: [] };
    }
    const parameter: ShaderInput = { name: this.unique(label, 'input'), type, kind, source, defaultValue };
    this.inputs.set(key, parameter);
    return { code: parameter.name, type, deps: [] };
  }
  private emit(node: GraphNode, expression: string, type: ValueType, refs: Ref[] = [], suffix = '', label?: string): Ref {
    const id = `${node.id}:${suffix || 'value'}`;
    const existing = this.instructions.get(id);
    if (existing) return { code: existing.name, type: existing.type, deps: [id] };
    const name = this.unique(label ?? `${node.type.replace('MaterialExpression', '')}_${node.id.match(/\d+$/)?.[0] ?? this.instructions.size}${suffix ? `_${suffix}` : ''}`);
    const instruction: Instruction = { id, nodeId: node.id, name, code: expression, type,
      deps: [...new Set(refs.flatMap(r => r.deps))], range: node.range, comment: str(node.props.Desc) };
    this.instructions.set(id, instruction);
    return { code: name, type, deps: [id] };
  }
  private unknown(node: GraphNode, reason: string): Ref[] {
    this.diag(node, 'UNSUPPORTED_NODE', reason);
    // Unsupported expressions are analysis boundaries, not traversal boundaries.
    // Keep every recoverable upstream algorithm and its input parameters visible.
    const upstream = this.graph.dependencies(node).map(connection => this.link(node, connection));
    return [this.emit(node, `UNRESOLVED_${identifier(node.id)}(${upstream.map(value => value.code).join(', ')})`, 'unknown', upstream)];
  }
  private connected(node: GraphNode, key: string): boolean { return !!this.graph.connection(node, key); }
  private input(node: GraphNode, key: string, fallback?: number | Ref, expected?: ValueType): Ref {
    const link = this.graph.connection(node, key);
    if (link) return this.link(node, link, expected);
    if (typeof fallback === 'number') return { code: literal(fallback), type: 'float', deps: [] };
    if (fallback) return fallback;
    this.diag(node, 'REQUIRED_INPUT', `${node.type.replace('MaterialExpression', '')}.${key} 缺少必需输入。`);
    return { code: `UNCONNECTED_${identifier(node.id)}_${identifier(key)}`, type: 'unknown', deps: [] };
  }
  private link(node: GraphNode, link: Connection, expected?: ValueType): Ref {
    let value: Ref;
    const source = this.graph.nodes.get(link.source);
    if (!source) {
      const key = `${link.source}:${link.outputIndex}`;
      const given = this.options.externalInputs?.[key] ?? this.options.externalInputs?.[link.source];
      const type = given ?? (link.mask ? undefined : expected) ?? 'unknown';
      value = this.inputParameter(`external:${key}`, `External_${link.source}_${link.outputIndex}`, type, 'external', key);
      this.dependencies = true;
      this.diag(node, 'EXTERNAL_INPUT', `未复制上游 ${key}，已提取为外部输入。`, 'warning');
      if (type === 'unknown') this.diag(node, 'UNKNOWN_EXTERNAL_TYPE', `无法确定 ${key} 的类型；通过 externalInputs 或 --input-type 指定类型。`);
    } else value = this.get(source, link.outputIndex);
    if (link.mask !== undefined) {
      if (!link.mask.length) { this.diag(node, 'EMPTY_MASK', '连接启用了通道掩码但没有选择通道。'); return { ...value, type: 'unknown' }; }
      if (width(value.type) === 1) return { code: link.mask.length === 1 ? value.code : `(${floatType(link.mask.length)})(${value.code})`, type: floatType(link.mask.length), deps: value.deps };
      if ([...link.mask].some(c => 'xyzw'.indexOf(c) >= width(value.type))) this.diag(node, 'MASK_CHANNEL', `通道掩码 .${link.mask} 超出 ${value.type} 的范围。`);
      value = { code: `(${value.code}).${link.mask}`, type: floatType(link.mask.length), deps: value.deps };
    }
    if (expected && value.type !== expected) {
      if (numericTypes.has(expected) && numericTypes.has(value.type) && width(value.type) === 1)
        return { ...value, code: `(${expected})(${value.code})`, type: expected };
      if (numericTypes.has(expected) && width(value.type) > width(expected))
        return { ...value, code: `(${value.code}).${'xyzw'.slice(0, width(expected))}`, type: expected };
      this.diag(node, 'INPUT_TYPE', `输入需要 ${expected}，实际为 ${value.type}。`);
    }
    return value;
  }
  private get(node: GraphNode, index = 0): Ref {
    if (node.type === 'MaterialExpressionVolumetricAdvancedMaterialOutput') return this.volumeOutput(node, index);
    if (node.type === 'MaterialGraphNode_Root') {
      const slot = this.rootSlots(node)[index];
      if (!slot) { this.diag(node, 'OUTPUT_INDEX', `材质根节点不存在输出 ${index}。`); return { code: 'INVALID_ROOT_OUTPUT', type: 'unknown', deps: [] }; }
      this.visited.add(node.id);
      const value = this.input(node, slot.key, undefined, slot.type === 'unknown' ? undefined : slot.type);
      return this.emit(node, value.code, value.type, [value], `root_${index}`, slot.name);
    }
    const values = this.compile(node);
    if (!Number.isInteger(index) || index < 0 || index >= values.length) {
      if (values[0]?.type === 'unknown') return { code: `UNRESOLVED_OUTPUT_${identifier(node.id)}_${identifier(String(index))}(${values[0].code})`, type: 'unknown', deps: values[0].deps };
      this.diag(node, 'OUTPUT_INDEX', `${node.id} 不存在输出端口 ${index}。`);
      return { code: `INVALID_OUTPUT_${identifier(node.id)}_${index}`, type: 'unknown', deps: [] };
    }
    return values[index];
  }
  private common(node: GraphNode, values: Ref[]): ValueType {
    const widths = values.map(v => width(v.type));
    if (widths.some(w => w === 0)) { this.diag(node, 'NUMERIC_TYPE', '该运算需要已知的标量或向量类型。'); return 'unknown'; }
    const nonscalar = new Set(widths.filter(w => w !== 1));
    if (nonscalar.size > 1) { this.diag(node, 'VECTOR_WIDTH', `不兼容的向量维数：${values.map(v => v.type).join(', ')}。`); return 'unknown'; }
    return floatType(Math.max(...widths));
  }
  private as(value: Ref, type: ValueType): string { return value.type === 'float' && width(type) > 1 ? `(${type})(${value.code})` : value.code; }
  private compile(node: GraphNode): Ref[] {
    const cached = this.cache.get(node.id); if (cached) return cached;
    if (this.visiting.has(node.id)) {
      this.diag(node, 'GRAPH_CYCLE', '材质表达式存在循环依赖。');
      return [{ code: `CYCLE_${identifier(node.id)}`, type: 'unknown', deps: [] }];
    }
    if (this.visiting.size > 512) { this.diag(node, 'DEPTH_LIMIT', '依赖链超过 512 层，请缩小复制范围。'); return [{ code: 'DEPTH_LIMIT', type: 'unknown', deps: [] }]; }
    this.visiting.add(node.id); this.visited.add(node.id);
    let result: Ref[];
    try { result = this.lower(node); }
    catch (error) { result = this.unknown(node, `无法解析该节点：${error instanceof Error ? error.message : String(error)}`); }
    this.visiting.delete(node.id); this.cache.set(node.id, result); return result;
  }
  private vectorConstant(node: GraphNode, count: number, field: string): Ref {
    const p = rec(node.props[field]);
    const components = count === 2 ? [num(node.props.R), num(node.props.G)] : ['R', 'G', 'B', 'A'].slice(0, count).map(k => num(p[k], k === 'A' ? 1 : 0));
    return this.emit(node, `${floatType(count)}(${components.map(literal).join(', ')})`, floatType(count));
  }
  private channels(node: GraphNode, value: Ref): Ref[] {
    const defaults = [this.emit(node, `${value.code}.rgb`, 'float3', [value], 'rgb'),
      ...['r', 'g', 'b', 'a'].map(c => this.emit(node, `${value.code}.${c}`, 'float', [value], c)), value];
    return this.serializedOutputs(node, value, defaults, ['xyz', 'x', 'y', 'z', 'w', 'xyzw']);
  }
  private serializedOutputs(node: GraphNode, base: Ref, defaults: Ref[], defaultMasks: string[] = []): Ref[] {
    const result = defaults.slice();
    for (const key of Object.keys(node.props).filter(k => /^Outputs\(\d+\)$/.test(k))) {
      const index = Number(/\d+/.exec(key)![0]);
      if (index > 63) { this.diag(node, 'OUTPUT_LIMIT', '节点输出端口索引超过支持范围 0–63。'); continue; }
      const output = rec(node.props[key]);
      if (!['Mask', 'MaskR', 'MaskG', 'MaskB', 'MaskA'].some(key => Object.hasOwn(output, key)) && result[index]) continue;
      const mask = mergedOutputMask(output, defaultMasks[index] ?? '');
      if (mask === undefined) { result[index] = base; continue; }
      if (!mask.length || (width(base.type) !== 1 && [...mask].some(c => 'xyzw'.indexOf(c) >= width(base.type)))) {
        this.diag(node, 'OUTPUT_MASK', `序列化端口 ${index} 的通道掩码与 ${base.type} 不兼容。`);
        result[index] = { code: 'INVALID_OUTPUT_MASK', type: 'unknown', deps: [] }; continue;
      }
      result[index] = this.emit(node, width(base.type) === 1 ? mask.length === 1 ? base.code : `(${floatType(mask.length)})(${base.code})` : `${base.code}.${mask}`, floatType(mask.length), [base], `port${index}`);
    }
    // Sparse declared ports must not turn into an undefined value at selection time.
    for (let i = 0; i < result.length; i++) if (!result[i]) result[i] = { code: `UNDECLARED_PORT_${i}`, type: 'unknown', deps: [] };
    for (const entry of Array.isArray(node.props.__ArrayOperations) ? node.props.__ArrayOperations : []) {
      const operation = rec(entry);
      if (operation.property === 'Outputs' && operation.operation === 'RemoveIndex') {
        const index = num(operation.index, -1);
        if (index < 0 || index >= result.length) this.diag(node, 'OUTPUT_ARRAY_OPERATION', `Outputs.RemoveIndex(${index}) 超出端口数组范围。`);
        else result.splice(index, 1);
      }
    }
    return result;
  }
  private lower(node: GraphNode): Ref[] {
    const p = node.props; const type = node.type.replace('MaterialExpression', '');
    this.validateProperties(node, type);
    const context = this.context();
    const extended = lowerMath(node, context) ?? lowerTexture(node, context) ?? lowerFunction(node, context);
    if (extended) return extended;
    const done = (expression: string, resultType: ValueType, refs: Ref[] = []) => [this.emit(node, expression, resultType, refs)];
    if (type === 'Constant') return done(literal(num(p.R)), 'float');
    if (/^Constant[234]Vector$/.test(type)) { const value = this.vectorConstant(node, Number(type[8]), 'Constant'); return this.serializedOutputs(node, value, [value]); }
    if (type === 'ScalarParameter') {
      const name = str(p.ParameterName, node.id);
      return [this.emit(node, this.inputParameter(`scalar:${name}`, name, 'float', 'parameter', node.id, p.DefaultValue ?? 0).code, 'float', [], '', name + '_value')];
    }
    if (type === 'VectorParameter') {
      const name = str(p.ParameterName, node.id);
      return this.channels(node, this.inputParameter(`vector:${name}`, name, 'float4', 'parameter', node.id, p.DefaultValue));
    }
    if (type === 'StaticBool') return done(flag(p.Value) ? 'true' : 'false', 'bool');
    if (type === 'StaticSwitchParameter') return this.staticSwitch(node);
    if (type === 'ShadingPathSwitch') return this.shadingPathSwitch(node);
    if (type === 'TextureCoordinate') {
      if (flag(p.UnMirrorU) || flag(p.UnMirrorV)) return this.unknown(node, 'TextureCoordinate 的 UnMirror 需要网格坐标导数语义，首版不支持。');
      const uv = this.inputParameter(`uv:${num(p.CoordinateIndex)}`, `UV${num(p.CoordinateIndex)}`, 'float2', 'context', node.id);
      return done(`${uv.code} * float2(${literal(num(p.UTiling, 1))}, ${literal(num(p.VTiling, 1))})`, 'float2');
    }
    if (type === 'Time') {
      const ignoresPause = flag(p.bIgnorePause);
      const time = this.inputParameter(ignoresPause ? 'real-time' : 'game-time', ignoresPause ? 'RealTime' : 'GameTime', 'float', 'context', ignoresPause ? 'Unpaused elapsed seconds' : 'Elapsed game seconds respecting pause');
      if (!flag(p.bOverride_Period)) return done(time.code, 'float');
      const period = num(p.Period, 1);
      return done(period > 0 ? `frac(${time.code} / ${literal(period)}) * ${literal(period)}` : '0.0', 'float');
    }
    if (['Add', 'Subtract', 'Multiply', 'Divide', 'Min', 'Max', 'Fmod'].includes(type)) {
      const defaults: Record<string, [number | undefined, number | undefined]> = { Add: [0, 1], Subtract: [1, 1], Multiply: [0, 1], Divide: [1, 2], Min: [0, 1], Max: [0, 1], Fmod: [undefined, undefined] };
      const [da, db] = defaults[type];
      const a = this.input(node, 'A', typeof p.ConstA === 'number' ? p.ConstA : da);
      const b = this.input(node, 'B', typeof p.ConstB === 'number' ? p.ConstB : db);
      const resultType = this.common(node, [a, b]);
      const operators: Record<string, string> = { Add: '+', Subtract: '-', Multiply: '*' };
      if (operators[type]) return done(`${a.code} ${operators[type]} ${b.code}`, resultType, [a, b]);
      if (type === 'Divide') { this.helpers.add(`divide:${resultType}`); return done(`UE_SafeDivide(${this.as(a, resultType)}, ${this.as(b, resultType)})`, resultType, [a, b]); }
      return done(`${type.toLowerCase()}(${this.as(a, resultType)}, ${this.as(b, resultType)})`, resultType, [a, b]);
    }
    if (type === 'LinearInterpolate') {
      const a = this.input(node, 'A', num(p.ConstA)); const b = this.input(node, 'B', num(p.ConstB, 1));
      const alpha = this.input(node, 'Alpha', num(p.ConstAlpha, 0.5)); const resultType = this.common(node, [a, b, alpha]);
      return done(`lerp(${this.as(a, resultType)}, ${this.as(b, resultType)}, ${alpha.code})`, resultType, [a, b, alpha]);
    }
    if (type === 'Clamp') {
      const mode = str(p.ClampMode, 'CMODE_Clamp');
      if (!['CMODE_Clamp', 'CMODE_ClampMin', 'CMODE_ClampMax'].includes(mode)) return this.unknown(node, `未知 ClampMode：${mode}`);
      const value = this.input(node, 'Input');
      const args = [value];
      if (mode !== 'CMODE_ClampMax') args.push(this.input(node, 'Min', num(p.MinDefault)));
      if (mode !== 'CMODE_ClampMin') args.push(this.input(node, 'Max', num(p.MaxDefault, 1)));
      const resultType = this.common(node, args);
      return done(`${mode === 'CMODE_ClampMin' ? 'max' : mode === 'CMODE_ClampMax' ? 'min' : 'clamp'}(${args.map(a => this.as(a, resultType)).join(', ')})`, resultType, args);
    }
    if (['Abs', 'Floor', 'Ceil', 'Frac', 'Saturate', 'OneMinus', 'Sine', 'Cosine', 'Normalize'].includes(type)) {
      const value = this.input(node, 'Input'); this.common(node, [value]);
      if (type === 'OneMinus') return done(`1.0 - ${value.code}`, value.type, [value]);
      // Explicit mathematical form also avoids a DXC constant-folding discrepancy
      // observed for frac of a negative local constant in the verification compiler.
      if (type === 'Frac') return done(`${value.code} - floor(${value.code})`, value.type, [value]);
      if (type === 'Sine' || type === 'Cosine') {
        const period = num(p.Period, 1);
        if (period <= 0) return this.unknown(node, '非正三角函数周期尚未完成 UE 版本语义验证，请使用正周期。');
        const argument = `${value.code} * ${literal(2 * Math.PI / period)}`;
        return done(`${type === 'Sine' ? 'sin' : 'cos'}(${argument})`, value.type, [value]);
      }
      if (type === 'Normalize') { this.helpers.add(`normalize:${value.type}`); return done(`UE_SafeNormalize(${value.code})`, value.type, [value]); }
      return done(`${type.toLowerCase()}(${value.code})`, value.type, [value]);
    }
    if (['DotProduct', 'CrossProduct', 'Distance'].includes(type)) {
      const expected = type === 'CrossProduct' ? 'float3' : undefined;
      const a = this.input(node, 'A', undefined, expected); const b = this.input(node, 'B', undefined, expected);
      const common = this.common(node, [a, b]);
      return done(`${type === 'DotProduct' ? 'dot' : type === 'CrossProduct' ? 'cross' : 'distance'}(${this.as(a, common)}, ${this.as(b, common)})`, type === 'CrossProduct' ? 'float3' : 'float', [a, b]);
    }
    if (type === 'AppendVector') {
      const a = this.input(node, 'A'); const b = this.input(node, 'B'); const total = width(a.type) + width(b.type);
      if (!width(a.type) || !width(b.type) || total > 4) this.diag(node, 'APPEND_WIDTH', 'AppendVector 需要总维数不超过 4 的已知数值类型。');
      return done(`${floatType(total)}(${a.code}, ${b.code})`, floatType(total), [a, b]);
    }
    if (type === 'ComponentMask') {
      const value = this.input(node, 'Input'); const channels = ['R', 'G', 'B', 'A'].filter(c => flag(p[c])).map(c => ({ R: 'x', G: 'y', B: 'z', A: 'w' })[c]).join('');
      if (!channels.length) { this.diag(node, 'EMPTY_MASK', 'ComponentMask 未选择任何通道。'); return done('INVALID_EMPTY_MASK', 'unknown'); }
      if (width(value.type) === 1) return done(channels.length === 1 ? value.code : `(${floatType(channels.length)})(${value.code})`, floatType(channels.length), [value]);
      if ([...channels].some(c => 'xyzw'.indexOf(c) >= width(value.type))) this.diag(node, 'MASK_CHANNEL', `ComponentMask .${channels} 超出 ${value.type}。`);
      return done(`${value.code}.${channels}`, floatType(channels.length), [value]);
    }
    if (['Reroute', 'NamedRerouteDeclaration', 'NamedRerouteUsage'].includes(type)) {
      let value: Ref;
      if (type === 'NamedRerouteUsage') {
        const link = this.graph.dependencies(node)[0];
        if (!link) return this.unknown(node, 'Named Reroute 找不到对应声明。');
        value = this.link(node, link);
      } else value = this.input(node, 'Input');
      if ((type === 'Reroute' || type === 'NamedRerouteUsage') && !str(p.Desc)) return [value];
      return [this.emit(node, value.code, value.type, [value], '', str(p.Name, type === 'NamedRerouteUsage' ? `${node.id}_value` : undefined))];
    }
    if (type === 'FunctionInput') {
      const types: Record<string, ValueType> = { FunctionInput_Scalar: 'float', FunctionInput_Vector2: 'float2', FunctionInput_Vector3: 'float3', FunctionInput_Vector4: 'float4', FunctionInput_Texture2D: 'Texture2D', FunctionInput_Texture3D: 'Texture3D', FunctionInput_StaticBool: 'bool' };
      const inputType = types[str(p.InputType, 'FunctionInput_Vector3')];
      if (!inputType) return this.unknown(node, `不支持的 FunctionInput 类型：${str(p.InputType)}`);
      const defaultValue = flag(p.bUsePreviewValueAsDefault) && !this.connected(node, 'Preview') ? p.PreviewValue : undefined;
      if (flag(p.bUsePreviewValueAsDefault) && this.connected(node, 'Preview')) this.diag(node, 'PREVIEW_EXPRESSION_DEFAULT', '预览表达式作为默认值保留在原文中；独立函数需要显式传入此参数。', 'info');
      return [this.inputParameter(`function-input:${node.id}`, str(p.InputName, node.id), inputType, 'parameter', node.id, defaultValue)];
    }
    if (type === 'FunctionOutput') { const value = this.input(node, 'A'); return [this.emit(node, value.code, value.type, [value], '', str(p.OutputName, node.id))]; }
    const contexts: Record<string, [ValueType, string]> = {
      VertexColor: ['float4', 'VertexColor'], WorldPosition: ['float3', 'WorldPositionWS'], VertexNormalWS: ['float3', 'VertexNormalWS'],
      PixelNormalWS: ['float3', 'PixelNormalWS'], CameraPositionWS: ['float3', 'CameraPositionWS'], CameraVectorWS: ['float3', 'CameraVectorWS'],
      ObjectPositionWS: ['float3', 'ObjectPositionWS'], ObjectRadius: ['float', 'ObjectRadius'], TwoSidedSign: ['float', 'TwoSidedSign'],
    };
    if (contexts[type]) {
      const [valueType, label] = contexts[type];
      const mode = type === 'WorldPosition' ? str(p.WorldPositionShaderOffset, 'WPT_Default') : '';
      const context = this.inputParameter(`context:${type}:${mode}`, mode && mode !== 'WPT_Default' ? `${label}_${mode}` : label, valueType, 'context', `${type}${mode ? ` (${mode})` : ''}`);
      if (type === 'WorldPosition') return this.serializedOutputs(node, context, [context,
        this.emit(node, `${context.code}.xy`, 'float2', [context], 'xy'), this.emit(node, `${context.code}.z`, 'float', [context], 'z')], ['xyz', 'xy', 'z']);
      return type === 'VertexColor' ? this.channels(node, context) : [context];
    }
    if (type === 'MaterialFunctionCall') {
      this.dependencies = true;
      return this.unknown(node, `材质函数 ${str(p.MaterialFunction, node.id)} 的正文不在复制文本中；请补充函数内部节点。`);
    }
    if (type === 'Custom') return this.unknown(node, 'Custom 节点包含独立 HLSL 和可能的 include/helper 依赖；首版保留原文与诊断，不猜测其上下文。');
    return this.unknown(node, `首版尚未实现节点 ${node.type}。`);
  }

  private shadingPathSwitch(node: GraphNode): Ref[] {
    const labels = ['Deferred', 'Forward', 'Mobile'];
    const resolveBranch = (index: number): Ref => {
      const indexed = `Inputs(${index})`;
      // Text properties are authoritative. Visual pin labels are a fallback only
      // when the indexed property is absent, just as for other material inputs.
      const key = Object.hasOwn(node.props, indexed) || this.connected(node, indexed) ? indexed : labels[index];
      return this.connected(node, key) ? this.input(node, key) : this.input(node, 'Default');
    };
    const selection = this.options.shadingPath ?? 'preserve';
    if (selection !== 'preserve') {
      const index = ['deferred', 'forward', 'mobile'].indexOf(selection);
      if (index < 0) return this.unknown(node, `未知着色路径 ${selection}。`);
      const value = resolveBranch(index);
      this.diag(node, 'SHADING_PATH_SELECTED', `使用 ${labels[index]} 路径；对应输入未连接时使用 Default。`, 'info');
      return [this.emit(node, value.code, value.type, [value])];
    }
    const branches = labels.map((label, index) => ({ label, value: resolveBranch(index) }));
    const type = this.common(node, branches.map(branch => branch.value));
    const output = this.emit(node, `UE_ShadingPathSwitch(${branches.map(branch => branch.value.code).join(', ')})`, type, branches.map(branch => branch.value));
    this.instructions.get(output.deps[0])!.branches = branches;
    this.helpers.add('shading-path');
    this.dependencies = true;
    this.diag(node, 'SHADING_PATH_VARIANTS', '保留 Deferred / Forward / Mobile 编译期分支。阅读单一路径可设置 shadingPath；编译保留版须定义 UE_MATERIAL_SHADING_PATH=0/1/2。', 'warning');
    return [output];
  }

  private staticSwitch(node: GraphNode): Ref[] {
    const name = str(node.props.ParameterName, node.id);
    if (flag(node.props.DynamicBranch)) {
      if (!this.connected(node, 'A')) return [this.input(node, 'B')];
      if (!this.connected(node, 'B')) return [this.input(node, 'A')];
      const whenTrue = this.input(node, 'A'); const whenFalse = this.input(node, 'B');
      const type = whenTrue.type === whenFalse.type ? whenTrue.type : numericTypes.has(whenTrue.type) && numericTypes.has(whenFalse.type)
        ? floatType(Math.max(width(whenTrue.type), width(whenFalse.type))) : this.common(node, [whenTrue, whenFalse]);
      const cast = (value: Ref): string => width(value.type) > 1 && width(value.type) < width(type)
        ? `${type}(${value.code}, ${Array(width(type) - width(value.type)).fill('0.0').join(', ')})` : this.as(value, type);
      const condition = this.inputParameter(`dynamic-bool:${name}`, name, 'bool', 'parameter', node.id, flag(node.props.DefaultValue));
      return [this.emit(node, `${condition.code} ? ${cast(whenTrue)} : ${cast(whenFalse)}`, type, [condition, whenTrue, whenFalse])];
    }
    // UE static switches require both structural inputs, even with an override.
    if (!this.connected(node, 'A') || !this.connected(node, 'B')) return this.unknown(node, 'StaticSwitchParameter 的 A 和 B 必须都有连接。');
    if (Object.hasOwn(this.options.staticParameters ?? {}, name)) {
      const selected = this.options.staticParameters![name];
      if (typeof selected !== 'boolean') return this.unknown(node, `静态参数 ${name} 的覆盖值必须是布尔值。`);
      const value = this.input(node, selected ? 'A' : 'B');
      this.materialSettings[`StaticParameter_${name}`] = selected;
      return [this.emit(node, value.code, value.type, [value])];
    }
    const whenTrue = this.input(node, 'A'); const whenFalse = this.input(node, 'B');
    const type = whenTrue.type === whenFalse.type ? whenTrue.type : this.common(node, [whenTrue, whenFalse]);
    let definition = this.staticDefinitions.get(name);
    if (!definition) {
      definition = { macro: this.unique(`UE_STATIC_${name}`), defaultValue: flag(node.props.DefaultValue) };
      this.staticDefinitions.set(name, definition);
    } else if (definition.defaultValue !== flag(node.props.DefaultValue)) this.diag(node, 'STATIC_DEFAULT_CONFLICT', `同名静态参数 ${name} 的默认值不一致，使用首次定义。`, 'warning');
    const value = this.emit(node, `${definition.macro} ? ${whenTrue.code} : ${whenFalse.code}`, type, [whenTrue, whenFalse]);
    this.instructions.get(value.deps[0])!.staticBranch = { macro: definition.macro, whenTrue, whenFalse };
    this.materialSettings[`StaticParameter_${name}`] = definition.defaultValue;
    return [value];
  }

  private volumeSlots(): { key: string; type: ValueType; fallback: number }[] {
    return [
      { key: 'PhaseG', type: 'float', fallback: 0 }, { key: 'PhaseG2', type: 'float', fallback: 0 },
      { key: 'PhaseBlend', type: 'float', fallback: 0 }, { key: 'MultiScatteringContribution', type: 'float', fallback: 0.5 },
      { key: 'MultiScatteringOcclusion', type: 'float', fallback: 0.5 }, { key: 'MultiScatteringEccentricity', type: 'float', fallback: 0.5 },
      { key: 'ConservativeDensity', type: 'float4', fallback: 1 },
    ];
  }
  private volumeOutput(node: GraphNode, index: number): Ref {
    const slot = this.volumeSlots()[index];
    if (!slot) { this.diag(node, 'OUTPUT_INDEX', '体积材质输出索引无效。'); return { code: 'INVALID_VOLUME_OUTPUT', type: 'unknown', deps: [] }; }
    this.visited.add(node.id);
    const settings: Record<string, Value> = {};
    for (const [key, defaultValue] of Object.entries({ PerSamplePhaseEvaluation: false, MultiScatteringApproximationOctaveCount: 0,
      bGroundContribution: false, bGrayScaleMaterial: false, bRayMarchVolumeShadow: true, bClampMultiScatteringContribution: true }))
      settings[key] = node.props[key] ?? defaultValue;
    this.materialSettings.VolumetricAdvancedMaterialOutput = settings;
    let value: Ref;
    if (!this.connected(node, slot.key)) {
      value = slot.key === 'ConservativeDensity' ? { code: 'float4(1.0, 1.0, 1.0, 0.0)', type: 'float4', deps: [] } :
        { code: literal(num(node.props[`Const${slot.key}`], slot.fallback)), type: 'float', deps: [] };
    } else {
      value = this.input(node, slot.key);
      if (slot.key === 'ConservativeDensity' && width(value.type) > 1 && width(value.type) < 4)
        value = { ...value, code: `float4(${value.code}, ${Array(4 - width(value.type)).fill('0.0').join(', ')})`, type: 'float4' };
      else if (width(value.type) === 1 && slot.type === 'float4') value = { ...value, code: `(float4)(${value.code})`, type: 'float4' };
      // VolumetricCloud.usf consumes the first six custom outputs as scalar floats.
      else if (width(value.type) > 1 && slot.type === 'float') value = { ...value, code: `${value.code}.x`, type: 'float' };
      else if (value.type !== slot.type && value.type !== 'unknown') this.diag(node, 'VOLUME_OUTPUT_TYPE', `${slot.key} 需要 ${slot.type}，实际为 ${value.type}。`);
    }
    return this.emit(node, value.code, value.type, [value], `volume_${index}`, `Volume_${slot.key}`);
  }

  private metadata(node: GraphNode): OutputCandidate[] {
    if (node.type === 'MaterialGraphNode_Root') return this.rootSlots(node).map((slot, i) => ({ id: `${node.id}:${i}`, nodeId: node.id, outputIndex: i, name: slot.name, type: slot.type }));
    if (node.type === 'MaterialExpressionVolumetricAdvancedMaterialOutput') return this.volumeSlots().map((slot, i) => ({ id: `${node.id}:${i}`, nodeId: node.id, outputIndex: i, name: `Volume_${slot.key}`, type: slot.type }));
    const type = node.type.replace('MaterialExpression', '');
    const knownTypes: Record<string, ValueType> = { Constant: 'float', Constant2Vector: 'float2', Constant3Vector: 'float3', Constant4Vector: 'float4', ScalarParameter: 'float', TextureCoordinate: 'float2', Time: 'float', DotProduct: 'float', Distance: 'float', CrossProduct: 'float3', StaticBool: 'bool', ObjectRadius: 'float', TwoSidedSign: 'float', TextureObject: 'Texture2D', TextureObjectParameter: 'Texture2D' };
    const multi = ['VectorParameter', 'TextureSample', 'TextureSampleParameter2D', 'TextureSampleParameterVolume', 'VertexColor'].includes(type);
    const label = str(node.props.OutputName) || str(node.props.Name) || str(node.props.ParameterName) || type + '_' + (node.id.match(/\d+$/)?.[0] ?? 'value');
    let items: { name: string; type: ValueType }[] = multi ? [ { name: 'RGB', type: 'float3' }, ...['R', 'G', 'B', 'A'].map(name => ({ name, type: 'float' as ValueType })), { name: 'RGBA', type: 'float4' } ] : [{ name: '', type: knownTypes[type] ?? 'unknown' }];
    if (type === 'CloudSampleAttribute') items = ['Altitude', 'AltitudeInLayer', 'NormAltitudeInLayer', 'ShadowSampleDistance'].map(name => ({ name, type: 'float' }));
    if (type === 'VolumetricAdvancedMaterialInput') items = [{ name: 'ConservativeDensity3', type: 'float3' }, { name: 'ConservativeDensity4', type: 'float4' }];
    if (type === 'WorldPosition') items = [{ name: 'XYZ', type: 'float3' }, { name: 'XY', type: 'float2' }, { name: 'Z', type: 'float' }];
    if (['TextureObject', 'TextureObjectParameter'].includes(type) && /(?:^|[./])VolumeTexture'/.test(str(node.props.Texture))) items[0].type = 'Texture3D';
    if (type === 'MaterialFunctionCall') {
      const ports = Object.keys(node.props).filter(key => /^FunctionOutputs\(\d+\)$/.test(key)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
      for (const key of ports) {
        const index = Number(/\d+/.exec(key)![0]); if (index > 63) continue;
        while (items.length <= index) items.push({ name: `Output${items.length}`, type: 'unknown' });
        items[index] = { name: str(rec(rec(node.props[key]).Output).OutputName, `Output${index}`), type: 'unknown' };
      }
    }
    const defaultMasks = multi ? ['xyz', 'x', 'y', 'z', 'w', 'xyzw'] : type === 'WorldPosition' ? ['xyz', 'xy', 'z'] : [];
    const declared = Object.keys(node.props).filter(k => /^Outputs\(\d+\)$/.test(k)).sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
    for (const key of declared) {
      const index = Number(/\d+/.exec(key)![0]); if (index > 63) continue;
      while (items.length <= index) items.push({ name: `Output${items.length}`, type: 'unknown' });
      const output = rec(node.props[key]);
      const mask = mergedOutputMask(output, defaultMasks[index] ?? '');
      items[index] = { name: str(output.OutputName) || items[index].name,
        type: mask !== undefined ? floatType(mask.length) : multi ? 'float4' : items[index].type };
    }
    for (const entry of Array.isArray(node.props.__ArrayOperations) ? node.props.__ArrayOperations : []) {
      const operation = rec(entry);
      if (operation.property === 'Outputs' && operation.operation === 'RemoveIndex') {
        const index = num(operation.index, -1); if (index >= 0 && index < items.length) items.splice(index, 1);
      }
    }
    return items.map((item, i) => ({ id: `${node.id}:${i}`, nodeId: node.id, name: label + (item.name ? `_${item.name}` : ''), type: item.type, outputIndex: i }));
  }

  run(engineVersion: '5.5' | '5.7'): TranslationResult {
    const expressionNodes = [...this.graph.nodes.values()].filter(n => n.type !== 'MaterialExpressionComment' && n.type !== 'MaterialGraphNode_Root');
    const roots = [...this.graph.nodes.values()].filter(n => n.type === 'MaterialGraphNode_Root' && this.rootSlots(n).length);
    const consumed = new Set([...expressionNodes, ...roots].flatMap(n => this.graph.dependencies(n).map(d => d.source)));
    const customOutputs = expressionNodes.filter(n => n.type === 'MaterialExpressionVolumetricAdvancedMaterialOutput');
    const explicit = [...(roots.length ? roots : expressionNodes.filter(n => n.type === 'MaterialExpressionFunctionOutput')), ...customOutputs];
    const terminals = explicit.length ? explicit : expressionNodes.filter(n => !consumed.has(n.id));
    // Every expression can be explicitly selected; candidate defaults are the graph sinks.
    const allCandidates = [...expressionNodes, ...roots].flatMap(n => this.metadata(n));
    let selected: OutputCandidate[];
    if (this.options.outputs?.length) {
      selected = [];
      for (const id of [...new Set(this.options.outputs)]) {
        const match = allCandidates.find(c => c.id === id || c.nodeId === id && c.outputIndex === 0);
        if (match) selected.push({ ...match }); else this.diag(undefined, 'OUTPUT_SELECTION', `找不到输出 ${id}。`);
      }
    } else selected = terminals.flatMap(n => n.type === 'MaterialGraphNode_Root' || n.type === 'MaterialExpressionVolumetricAdvancedMaterialOutput' ? this.metadata(n) : this.metadata(n).slice(0, 1)).filter(c => c.type !== 'Texture2D' && c.type !== 'Texture3D');
    if (!selected.length && expressionNodes.length) this.diag(undefined, 'NO_OUTPUTS', '找不到候选输出。图可能只有资源、存在循环或未选择有效端口。');
    if (!explicit.length && selected.length) this.diag(undefined, 'INFERRED_OUTPUTS', '没有 FunctionOutput；以局部图的末端作为候选输出，可显式选择输出端口。', 'info');
    const values = selected.map(output => {
      const node = this.graph.nodes.get(output.nodeId)!; const value = this.get(node, output.outputIndex); output.type = value.type;
      if (value.type === 'unknown') this.diag(node, 'OUTPUT_TYPE', `无法确定所选输出 ${output.id} 的数值类型。`);
      if (value.type === 'Texture2D' || value.type === 'Texture3D' || value.type === 'SamplerState') this.diag(node, 'RESOURCE_OUTPUT', '算法输出必须是数值；纹理和采样器应作为输入资源使用。');
      return value;
    });
    const usedIds = new Set<string>();
    const visit = (id: string) => { if (usedIds.has(id)) return; usedIds.add(id); this.instructions.get(id)?.deps.forEach(visit); };
    values.flatMap(v => v.deps).forEach(visit);
    const instructions = [...this.instructions.values()].filter(i => usedIds.has(i.id));
    const candidates = allCandidates.map(c => {
      const cached = this.cache.get(c.nodeId)?.[c.outputIndex]; return { ...c, type: cached?.type ?? c.type };
    });
    for (const diagnostic of this.graph.diagnostics) if (!this.diagnostics.includes(diagnostic)) this.diagnostics.push(diagnostic);
    const { hlsl, sourceMap, modules } = this.generate(instructions, selected, values, engineVersion);
    const status = this.diagnostics.some(d => d.severity === 'error') ? 'unsupported' : this.dependencies ? 'external-dependencies' : 'complete';
    return { hlsl, status, engineVersion, diagnostics: this.diagnostics, inputs: [...this.inputs.values()], outputs: selected, candidates, modules, sourceMap,
      stats: { nodes: expressionNodes.length + roots.length, reachableNodes: this.visited.size, expressions: instructions.length },
      ...(Object.keys(this.materialSettings).length ? { materialSettings: this.materialSettings } : {}) };
  }

  private generate(instructions: Instruction[], outputs: OutputCandidate[], outputValues: Ref[], engineVersion: string): { hlsl: string; sourceMap: SourceMapping[]; modules: ModuleInfo[] } {
    const lines: string[] = [`// UE Material Translator | UE ${engineVersion}`, '// Inputs are explicit; no Unreal Engine headers are required.'];
    const sourceMap: SourceMapping[] = [];
    const hasErrors = this.diagnostics.some(d => d.severity === 'error');
    if (hasErrors) {
      lines.push('#error UE_MATERIAL_TRANSLATION_INCOMPLETE', '// Partial analysis follows. Supported upstream algorithms are retained.');
      const errors = this.diagnostics.filter(d => d.severity === 'error');
      for (const error of errors.slice(0, 12)) lines.push(`// [${error.code}]${error.nodeId ? ` ${safeComment(error.nodeId)}` : ''}${error.range ? ` (source line ${error.range.startLine})` : ''}: ${safeComment(error.message)}`);
      if (errors.length > 12) lines.push(`// ${errors.length - 12} more errors: see the diagnostics report.`);
    }
    if (this.options.shadingPath && this.options.shadingPath !== 'preserve') lines.push(`// Selected material shading path: ${this.options.shadingPath}`);
    if (this.helpers.has('shading-path')) lines.push('// UE_MATERIAL_SHADING_PATH: 0 = Deferred, 1 = Forward, 2 = Mobile.', '#ifndef UE_MATERIAL_SHADING_PATH', '#error Define_UE_MATERIAL_SHADING_PATH_or_select_a_path_in_translator_settings', '#elif UE_MATERIAL_SHADING_PATH < 0 || UE_MATERIAL_SHADING_PATH > 2', '#error Invalid_UE_MATERIAL_SHADING_PATH', '#endif');
    for (const [name, definition] of this.staticDefinitions) lines.push(`// Static parameter: ${safeComment(name)}`, `#ifndef ${definition.macro}`, `#define ${definition.macro} ${definition.defaultValue ? 1 : 0}`, '#endif');
    if (Object.keys(this.materialSettings).length) lines.push(`// Renderer configuration: ${safeComment(JSON.stringify(this.materialSettings))}`);
    for (const input of this.inputs.values()) {
      if (input.defaultValue !== undefined) lines.push(`// Default ${input.name}: ${safeComment(JSON.stringify(input.defaultValue))}`);
      if (input.kind === 'context' || input.kind === 'external' || input.kind === 'resource') lines.push(`// ${input.kind} ${input.name}: ${safeComment(input.source ?? input.type)}`);
    }
    lines.push('');
    for (const source of this.helperSources.values()) lines.push(source, '');
    if ([...this.helpers].some(h => h.startsWith('divide:'))) {
      lines.push('// UE Divide clamps the divisor magnitude to 0.00001.');
      for (let n = 1; n <= 4; n++) {
        const type = floatType(n); const components = 'xyzw'.slice(0, n).split('');
        if (!this.helpers.has(`divide:${type}`)) continue;
        lines.push(`${type} UE_SafeDivide(${type} a, ${type} b)`, '{');
        const expr = (c: string) => { const b = n === 1 ? 'b' : `b.${c}`; return `((${b} < 0.0) ? min(${b}, -0.00001) : max(${b}, 0.00001))`; };
        lines.push(`    return a / ${n === 1 ? expr('x') : `${type}(${components.map(expr).join(', ')})`};`, '}', '');
      }
    }
    if ([...this.helpers].some(h => h.startsWith('normalize:'))) {
      for (let n = 1; n <= 4; n++) { const type = floatType(n); if (!this.helpers.has(`normalize:${type}`)) continue; lines.push(`${type} UE_SafeNormalize(${type} value)`, '{', '    float magnitudeSquared = dot(value, value);', `    return magnitudeSquared > 0.0 ? value * rsqrt(magnitudeSquared) : (${type})0.0;`, '}', ''); }
    }
    const modules = this.groupModules(instructions);
    const owner = new Map<string, ModuleInfo>();
    for (const module of modules) for (const id of module.nodeIds) owner.set(id, module);
    const instrById = new Map(instructions.map(i => [i.id, i]));
    const indices = new Map(instructions.map((i, idx) => [i.id, idx]));
    // A group can be extracted only if all of its external dependencies are available before
    // its first instruction. Otherwise a scope/section preserves the original topological order.
    const groups = new Map<string, Instruction[]>();
    for (const module of modules) groups.set(module.id, instructions.filter(i => owner.get(i.nodeId)?.id === module.id));
    const emittedFunctions = new Set<string>();
    for (const module of modules) {
      const group = groups.get(module.id)!; if (!group.length) continue;
      const own = new Set(group.map(i => i.id));
      const first = indices.get(group[0].id)!;
      const dependencies = [...new Set(group.flatMap(i => i.deps).filter(id => !own.has(id)))];
      const contiguous = group.every((i, idx) => indices.get(i.id) === first + idx);
      const legal = dependencies.every(id => (indices.get(id) ?? -1) < first) && group.every(i => numericTypes.has(i.type) || i.type === 'bool');
      if (this.options.moduleStyle !== 'scopes' && legal) module.mode = 'function';
      else if (contiguous) { module.mode = 'scope'; module.reason = !legal ? '跨组交错依赖或资源输出，保留原计算顺序。' : '用户选择作用域。'; }
      else { module.mode = 'sections'; module.reason = '分组节点交错，使用命名代码段保留原计算顺序。'; }
      if (this.options.moduleStyle === 'functions' && module.mode !== 'function') this.diag(this.graph.nodes.get(group[0].nodeId), 'MODULE_FUNCTION_FALLBACK', `模块 ${module.name} 无法安全提取函数，已使用${module.mode === 'scope' ? '作用域' : '代码段'}。`, 'info');
    }
    const seenFields = new Set<string>();
    const fieldNames = outputs.map(o => {
      const base = identifier(o.name, 'output'); let name = base; let suffix = 2;
      while (seenFields.has(name)) name = `${base}_${suffix++}`;
      seenFields.add(name); return name;
    });
    lines.push('struct MaterialResult', '{');
    outputs.forEach((o, i) => lines.push(`    ${o.type === 'unknown' ? 'float /* unresolved type */' : o.type} ${fieldNames[i]};`));
    if (!outputs.length) lines.push('    // No valid output was selected.');
    lines.push('};', '');
    const moduleFunctions = new Map<string, { name: string; args: Instruction[]; globals: ShaderInput[]; exports: Instruction[] }>();
    for (const module of modules.filter(m => m.mode === 'function')) {
      const group = groups.get(module.id)!; const own = new Set(group.map(i => i.id));
      const args = [...new Set(group.flatMap(i => i.deps).filter(id => !own.has(id)))].map(id => instrById.get(id)!).filter(Boolean);
      // Passing all explicit inputs also covers resource/context references without synthetic graph edges.
      const globals = [...this.inputs.values()].filter(input => group.some(i => new RegExp(`\\b${input.name}\\b`).test(i.code)));
      const frontier = new Set([...instructions.filter(i => !own.has(i.id)).flatMap(i => i.deps), ...outputValues.flatMap(v => v.deps)]);
      const exports = group.filter(i => frontier.has(i.id));
      const exported = new Set(exports.map(i => i.id));
      const functionName = this.unique(`Module_${module.name}`, `Module_${module.id}`);
      moduleFunctions.set(module.id, { name: functionName, args, globals, exports });
      lines.push(`// Module: ${safeComment(module.name)}`, `void ${functionName}(${[...globals.map(i => `${i.type === 'unknown' ? 'float' : i.type} ${i.name}`), ...args.map(i => `${i.type} ${i.name}`), ...exports.map(i => `out ${i.type} ${i.name}`)].join(', ')})`, '{');
      for (const i of group) this.instructionLine(lines, sourceMap, i, `    ${exported.has(i.id) ? '' : i.type + ' '}${i.name} = ${i.code};`, module.id);
      lines.push('}', '');
    }
    const name = identifier(this.options.functionName ?? 'EvaluateMaterial', 'EvaluateMaterial');
    if (name !== 'EvaluateMaterial' && this.names.has(name)) this.diag(undefined, 'FUNCTION_NAME_CONFLICT', `函数名称 ${name} 与生成符号冲突。`);
    lines.push(`MaterialResult ${name}(${[...this.inputs.values()].map(i => `${i.type === 'unknown' ? 'float /* unresolved type */' : i.type} ${i.name}`).join(', ')})`, '{');
    let currentSection = '';
    for (let idx = 0; idx < instructions.length;) {
      const i = instructions[idx]; const module = owner.get(i.nodeId);
      if (module?.mode === 'function') {
        if (!emittedFunctions.has(module.id)) {
          const group = groups.get(module.id)!; const fn = moduleFunctions.get(module.id)!;
          lines.push(`    // Module: ${safeComment(module.name)}`);
          fn.exports.forEach(item => lines.push(`    ${item.type} ${item.name};`));
          const startLine = lines.length + 1;
          lines.push(`    ${fn.name}(${[...fn.globals.map(v => v.name), ...fn.args.map(v => v.name), ...fn.exports.map(v => v.name)].join(', ')});`);
          for (const item of group) sourceMap.push({ generated: { startLine, endLine: startLine }, source: item.range, nodeId: item.nodeId, moduleId: module.id });
          emittedFunctions.add(module.id);
        }
        idx++; continue;
      }
      if (module?.mode === 'scope') {
        const group = groups.get(module.id)!;
        group.forEach(item => lines.push(`    ${item.type === 'unknown' ? 'float /* unresolved type */' : item.type} ${item.name};`));
        lines.push(`    { // Module: ${safeComment(module.name)}`);
        for (const item of group) this.instructionLine(lines, sourceMap, item, `        ${item.name} = ${item.code};`, module.id);
        lines.push('    }'); idx += group.length; currentSection = ''; continue;
      }
      if (module?.id !== currentSection && module) lines.push(`    // Module: ${safeComment(module.name)} (section)`);
      currentSection = module?.id ?? '';
      this.instructionLine(lines, sourceMap, i, `    ${i.type === 'unknown' ? 'float /* unresolved type */' : i.type} ${i.name} = ${i.code};`, module?.id);
      idx++;
    }
    lines.push('    MaterialResult result;');
    outputValues.forEach((v, i) => {
      lines.push(`    result.${fieldNames[i]} = ${v.code};`);
      const node = this.graph.nodes.get(outputs[i].nodeId)!;
      sourceMap.push({ generated: { startLine: lines.length, endLine: lines.length }, source: node.range, nodeId: node.id, moduleId: owner.get(node.id)?.id });
    });
    lines.push('    return result;', '}', '');
    // Late generation diagnostics must also prevent compiling a falsely complete result.
    if (!hasErrors && this.diagnostics.some(d => d.severity === 'error')) {
      lines.unshift('#error UE_MATERIAL_TRANSLATION_INCOMPLETE');
      for (const mapping of sourceMap) { mapping.generated.startLine++; mapping.generated.endLine++; }
    }
    return { hlsl: lines.join('\n'), sourceMap, modules };
  }

  private instructionLine(lines: string[], sourceMap: SourceMapping[], instruction: Instruction, text: string, moduleId?: string): void {
    if (instruction.comment) lines.push(`${text.match(/^\s*/)?.[0]}// ${safeComment(instruction.comment)}`);
    const startLine = lines.length + 1;
    if (instruction.branches) {
      const indent = text.match(/^\s*/)?.[0] ?? '';
      const declaration = text.slice(indent.length, text.indexOf(instruction.name));
      if (declaration) lines.push(`${indent}${declaration}${instruction.name};`);
      for (const [index, branch] of instruction.branches.entries()) {
        lines.push(`${index === 0 ? '#if' : '#elif'} UE_MATERIAL_SHADING_PATH == ${index} // ${branch.label}`);
        lines.push(`${indent}${instruction.name} = ${this.as(branch.value, instruction.type)};`);
      }
      lines.push('#endif');
    } else if (instruction.staticBranch) {
      const indent = text.match(/^\s*/)?.[0] ?? '';
      const declaration = text.slice(indent.length, text.indexOf(instruction.name));
      if (declaration) lines.push(`${indent}${declaration}${instruction.name};`);
      lines.push(`#if ${instruction.staticBranch.macro}`, `${indent}${instruction.name} = ${this.as(instruction.staticBranch.whenTrue, instruction.type)};`, '#else', `${indent}${instruction.name} = ${this.as(instruction.staticBranch.whenFalse, instruction.type)};`, '#endif');
    } else lines.push(text);
    sourceMap.push({ generated: { startLine, endLine: lines.length }, source: instruction.range, nodeId: instruction.nodeId, moduleId });
  }

  private groupModules(instructions: Instruction[]): ModuleInfo[] {
    const used = new Set(instructions.map(i => i.nodeId));
    const members = new Map<string, string[]>();
    const paths = new Map<string, string>();
    const comments = [...this.graph.comments].filter(c => c.x !== undefined && c.y !== undefined && num(c.props.SizeX) > 0 && num(c.props.SizeY) > 0);
    for (const id of used) {
      const node = this.graph.nodes.get(id)!;
      if (this.options.moduleAssignments && Object.hasOwn(this.options.moduleAssignments, id)) {
        const assignment = this.options.moduleAssignments[id];
        if (assignment === null) continue;
        const owner = this.graph.comments.find(c => c.id === assignment);
        if (!owner) { this.diag(node, 'MODULE_ASSIGNMENT', `手动指定的注释框 ${assignment} 不存在。`); continue; }
        const list = members.get(owner.id) ?? []; list.push(id); members.set(owner.id, list);
        paths.set(owner.id, str(owner.props.Text) || str(owner.props.Desc) || owner.id);
        continue;
      }
      if (node.x === undefined || node.y === undefined) continue;
      const containers = comments.filter(c => node.x! >= c.x! && node.y! >= c.y! && node.x! < c.x! + num(c.props.SizeX) && node.y! < c.y! + num(c.props.SizeY));
      containers.sort((a, b) => num(a.props.SizeX) * num(a.props.SizeY) - num(b.props.SizeX) * num(b.props.SizeY));
      if (!containers.length) continue;
      if (containers.length > 1) {
        const [a, b] = containers;
        const nested = a.x! >= b.x! && a.y! >= b.y! && a.x! + num(a.props.SizeX) <= b.x! + num(b.props.SizeX) && a.y! + num(a.props.SizeY) <= b.y! + num(b.props.SizeY);
        if (!nested) this.diag(node, 'OVERLAPPING_COMMENTS', '节点位于重叠而非嵌套的注释框，暂使用最小框；请核对模块归属。', 'warning');
      }
      const owner = containers[0]; const list = members.get(owner.id) ?? []; list.push(id); members.set(owner.id, list);
      const ancestors = containers.slice().reverse().filter(c => owner.x! >= c.x! && owner.y! >= c.y! && owner.x! + num(owner.props.SizeX) <= c.x! + num(c.props.SizeX) && owner.y! + num(owner.props.SizeY) <= c.y! + num(c.props.SizeY));
      paths.set(owner.id, ancestors.map(c => str(c.props.Text) || str(c.props.Desc) || c.id).join(' / '));
    }
    return [...members].map(([id, nodeIds]) => {
      const comment = this.graph.nodes.get(id)!;
      return { id, name: paths.get(id) || str(comment.props.Text) || str(comment.props.Desc) || id, nodeIds, mode: 'sections' };
    });
  }

  private rootSlots(node: GraphNode): { key: string; name: string; type: ValueType }[] {
    const keys = new Set(Object.entries(node.props).filter(([, v]) => referenceName(rec(v).Expression)).map(([k]) => k));
    const entries = node.props.CustomProperties;
    if (Array.isArray(entries)) for (const entry of entries) {
      const pin = rec(entry);
      if (pin.kind === 'Pin' && pin.Direction !== 'EGPD_Output' && this.graph.connection(node, str(pin.PinName))) keys.add(str(pin.PinName));
    }
    const vector3 = new Set(['basecolor', 'albedo', 'emissivecolor', 'extinction', 'normal', 'worldpositionoffset', 'subsurfacecolor', 'tangent']);
    const scalar = new Set(['metallic', 'specular', 'roughness', 'anisotropy', 'opacity', 'opacitymask', 'ambientocclusion', 'pixeldepthoffset', 'refraction', 'clearcoat', 'clearcoatroughness']);
    return [...keys].map(key => {
      const normalized = key.replace(/\s/g, '').toLowerCase();
      return { key, name: key, type: vector3.has(normalized) ? 'float3' : scalar.has(normalized) ? 'float' : 'unknown' };
    });
  }

  private validateProperties(node: GraphNode, type: string): void {
    const numeric: Record<string, string[]> = {
      Constant: ['R'], Constant2Vector: ['R', 'G'], ScalarParameter: ['DefaultValue'],
      TextureCoordinate: ['CoordinateIndex', 'UTiling', 'VTiling'], Time: ['Period'],
      Sine: ['Period'], Cosine: ['Period'], Clamp: ['MinDefault', 'MaxDefault'],
      LinearInterpolate: ['ConstA', 'ConstB', 'ConstAlpha'],
      TextureSample: ['ConstCoordinate', 'ConstMipValue'], TextureSampleParameter2D: ['ConstCoordinate', 'ConstMipValue'],
    };
    const binary = ['Add', 'Subtract', 'Multiply', 'Divide', 'Min', 'Max', 'Fmod'];
    const fields = binary.includes(type) ? ['ConstA', 'ConstB'] : numeric[type] ?? [];
    for (const key of fields) if (Object.hasOwn(node.props, key) && (typeof node.props[key] !== 'number' || !Number.isFinite(node.props[key])))
      this.diag(node, 'INVALID_NUMERIC_PROPERTY', `${type}.${key} 必须是有限数值。`);
    if (type === 'Constant3Vector' || type === 'Constant4Vector' || type === 'VectorParameter') {
      const field = type === 'VectorParameter' ? 'DefaultValue' : 'Constant';
      if (Object.hasOwn(node.props, field) && (node.props[field] === null || typeof node.props[field] !== 'object' || Array.isArray(node.props[field])))
        this.diag(node, 'INVALID_VECTOR_PROPERTY', `${type}.${field} 必须是 RGBA 结构。`);
      for (const [key, value] of Object.entries(rec(node.props[field]))) if (['R', 'G', 'B', 'A'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value)))
        this.diag(node, 'INVALID_NUMERIC_PROPERTY', `${type}.${field}.${key} 必须是有限数值。`);
    }
    const unary = ['Abs', 'Floor', 'Ceil', 'Frac', 'Saturate', 'OneMinus', 'Sine', 'Cosine', 'Normalize', 'ComponentMask', 'Reroute', 'NamedRerouteDeclaration'];
    const ports = binary.includes(type) || ['DotProduct', 'CrossProduct', 'Distance', 'AppendVector'].includes(type) ? ['A', 'B'] :
      unary.includes(type) ? ['Input'] : type === 'FunctionOutput' ? ['A'] : type === 'Clamp' ? ['Input', 'Min', 'Max'] :
        type === 'LinearInterpolate' ? ['A', 'B', 'Alpha'] : [];
    for (const key of ports) {
      const value = node.props[key];
      if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value)))
        this.diag(node, 'INVALID_INPUT_PROPERTY', `${type}.${key} 必须是连接结构；节点常数请通过 Const 属性提供。`);
    }
  }
}
