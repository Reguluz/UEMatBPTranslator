import { flag, num, rec, referenceName, str } from './graph';
import type { Connection, GraphNode } from './graph';
import type { Value, ValueType } from './types';
import type { LoweringContext, Ref } from './lowering';

interface BuiltinFunction {
  asset: string;
  inputs: string[];
  outputs: string[];
  operation: 'km-to-cm' | 'make' | 'break';
  width: number;
}

// These are explicit semantic contracts for the standard Engine assets, not
// basename-based inference or proof of the copied asset's binary contents.
// A project-local function with the same name must remain an unresolved call.
const builtinFunctions: BuiltinFunction[] = [
  { asset: '/Engine/Functions/Engine_MaterialFunctions01/Units/Km-to-Cm.Km-to-Cm', inputs: ['Km'], outputs: ['Cm'], operation: 'km-to-cm', width: 1 },
  { asset: '/Engine/Functions/Engine_MaterialFunctions02/Utility/MakeFloat3.MakeFloat3', inputs: ['X', 'Y', 'Z'], outputs: ['Result'], operation: 'make', width: 3 },
  { asset: '/Engine/Functions/Engine_MaterialFunctions02/Utility/MakeFloat4.MakeFloat4', inputs: ['X', 'Y', 'Z', 'A'], outputs: ['Result'], operation: 'make', width: 4 },
  { asset: '/Engine/Functions/Engine_MaterialFunctions02/Utility/BreakOutFloat3Components.BreakOutFloat3Components', inputs: ['Float3'], outputs: ['R', 'G', 'B'], operation: 'break', width: 3 },
  { asset: '/Engine/Functions/Engine_MaterialFunctions02/Utility/BreakOutFloat4Components.BreakOutFloat4Components', inputs: ['Float4'], outputs: ['R', 'G', 'B', 'A'], operation: 'break', width: 4 },
];

function assetPath(value: Value | undefined): string {
  const reference = str(value).trim();
  const wrapped = /^(?:\/Script\/Engine\.)?MaterialFunction'([^']+)'$/.exec(reference);
  return wrapped?.[1] ?? (reference.startsWith('/Engine/') && !reference.includes("'") ? reference : '');
}

function indexed(node: GraphNode, property: string): { index: number; value: Record<string, Value> }[] {
  const entries: { index: number; value: Record<string, Value> }[] = [];
  const pattern = new RegExp(`^${property}\\((\\d+)\\)$`);
  for (const [key, value] of Object.entries(node.props)) {
    const match = pattern.exec(key);
    if (match) entries.push({ index: Number(match[1]), value: rec(value) });
  }
  return entries.sort((a, b) => a.index - b.index);
}

function nestedLink(node: GraphNode, value: Record<string, Value>, ctx: LoweringContext): Connection | undefined {
  if (!referenceName(value.Expression)) return undefined;
  const mask = flag(value.Mask)
    ? ['R', 'G', 'B', 'A'].filter(channel => flag(value[`Mask${channel}`])).map(channel => ({ R: 'x', G: 'y', B: 'z', A: 'w' })[channel]).join('')
    : undefined;
  return { source: ctx.graph.resolve(value.Expression), outputIndex: num(value.OutputIndex), mask };
}

/** Lower the small, audited set of standard Engine material function calls. */
export function lowerFunction(node: GraphNode, ctx: LoweringContext): Ref[] | undefined {
  if (node.type !== 'MaterialExpressionMaterialFunctionCall') return undefined;
  const asset = assetPath(node.props.MaterialFunction);
  const builtin = builtinFunctions.find(candidate => candidate.asset === asset);
  if (!builtin) return undefined;

  const inputs = indexed(node, 'FunctionInputs');
  const outputs = indexed(node, 'FunctionOutputs');
  const inputNames = inputs.map(entry => str(rec(entry.value.Input).InputName));
  const outputNames = outputs.map(entry => str(rec(entry.value.Output).OutputName));
  const matches = (entries: { index: number }[], actual: string[], expected: string[]): boolean =>
    entries.length === expected.length && entries.every((entry, index) => entry.index === index && actual[index] === expected[index]);
  if (!matches(inputs, inputNames, builtin.inputs) || !matches(outputs, outputNames, builtin.outputs)) {
    ctx.diag(node, 'BUILTIN_FUNCTION_INTERFACE', `内置函数 ${asset} 的序列化接口与语义契约不匹配；需要其真实函数正文。`);
    return ctx.unknown(node, `无法应用内置函数 ${asset} 的接口契约。`);
  }

  const links = inputs.map(entry => nestedLink(node, rec(entry.value.Input), ctx));
  if (links.some(connection => !connection)) {
    ctx.diag(node, 'BUILTIN_FUNCTION_INPUT', `内置函数 ${asset} 存在未连接输入；复制文本不包含函数内部预览默认值，无法安全推断。`);
    return ctx.unknown(node, `内置函数 ${asset} 缺少必要的输入连接。`);
  }

  ctx.diag(node, 'BUILTIN_FUNCTION_CONTRACT', `按精确资产路径和接口应用标准 Engine 函数语义：${asset}。此匹配未验证该资产正文或内容哈希。`, 'info');
  const inputType = builtin.operation === 'break' ? `float${builtin.width}` as ValueType : 'float';
  const values = links.map(connection => ctx.link(node, connection!, inputType));
  if (builtin.operation === 'km-to-cm') {
    return [ctx.emit(node, `${values[0].code} * 100000.0`, 'float', values, '', 'Km_to_Cm')];
  }
  if (builtin.operation === 'make') {
    const type = `float${builtin.width}` as ValueType;
    return [ctx.emit(node, `${type}(${values.map(value => value.code).join(', ')})`, type, values, '', `MakeFloat${builtin.width}`)];
  }
  return builtin.outputs.map((name, index) => ctx.emit(node, `(${values[0].code}).${'xyzw'[index]}`, 'float', values, name, `BreakFloat${builtin.width}_${name}`));
}
