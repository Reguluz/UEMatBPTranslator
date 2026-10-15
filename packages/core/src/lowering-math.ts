import { num, type GraphNode } from './graph';
import type { LoweringContext, Ref } from './lowering';
import type { ValueType } from './types';

const literal = (value: number): string => Number.isFinite(value) ? Number.isInteger(value) ? `${value}.0` : String(value) : 'INVALID_NONFINITE_VALUE';
const numeric = (type: ValueType): boolean => /^float[234]?$/.test(type);

/** Follow scalar constant chains; material parameters remain dynamic inputs. */
function scalarConstant(node: GraphNode, key: string, ctx: LoweringContext, fallback?: number, visited = new Set<string>()): number | undefined {
  const connection = ctx.graph.connection(node, key);
  if (!connection) return fallback === undefined ? undefined : Math.fround(fallback);
  const source = ctx.graph.nodes.get(connection.source);
  if (!source || connection.outputIndex !== 0 || visited.has(source.id)) return undefined;
  const seen = new Set(visited).add(source.id);
  const input = (key: string, fallback?: number) => scalarConstant(source, key, ctx, fallback, seen);
  const type = source.type.replace('MaterialExpression', '');
  if (type === 'Constant') return Math.fround(num(source.props.R));
  if (['Reroute', 'NamedRerouteDeclaration', 'TruncateLWC'].includes(type)) return input('Input');
  if (type === 'NamedRerouteUsage') {
    const declaration = ctx.graph.nodes.get(ctx.graph.dependencies(source)[0]?.source);
    return declaration ? scalarConstant(declaration, 'Input', ctx, undefined, seen) : undefined;
  }
  if (['Add', 'Subtract', 'Multiply', 'Min', 'Max'].includes(type)) {
    const a = input('A', num(source.props.ConstA, type === 'Subtract' ? 1 : 0));
    const b = input('B', num(source.props.ConstB, 1));
    // UE folds multiplication by a literal zero even when the other side varies.
    if (type === 'Multiply' && (a === 0 || b === 0)) return 0;
    if (a === undefined || b === undefined) return undefined;
    return Math.fround(type === 'Add' ? a + b : type === 'Subtract' ? a - b : type === 'Multiply' ? a * b : type === 'Min' ? Math.min(a, b) : Math.max(a, b));
  }
  if (['Abs', 'Floor', 'Ceil', 'Frac', 'OneMinus', 'Saturate', 'Length'].includes(type)) {
    const value = input('Input');
    if (value === undefined) return undefined;
    return Math.fround(type === 'Abs' || type === 'Length' ? Math.abs(value) : type === 'Floor' ? Math.floor(value) : type === 'Ceil' ? Math.ceil(value) :
      type === 'Frac' ? value - Math.floor(value) : type === 'OneMinus' ? 1 - value : Math.min(1, Math.max(0, value)));
  }
  return undefined;
}

// Verified against UE 5.5/5.7 MaterialExpressions.cpp, HLSLMaterialTranslator.cpp,
// MaterialExpression{If,Power,Rotator}.h, and Shaders/Private/Common.ush.
// Use our own helper names: output is standalone HLSL, independent of UE headers.
const powerHelper = `float UE_PositiveClampedPow(float base, float exponent)
{
    return base <= 2.980233e-8 ? 0.0 : pow(base, exponent);
}
float2 UE_PositiveClampedPow(float2 base, float exponent)
{
    return float2(UE_PositiveClampedPow(base.x, exponent), UE_PositiveClampedPow(base.y, exponent));
}
float3 UE_PositiveClampedPow(float3 base, float exponent)
{
    return float3(UE_PositiveClampedPow(base.xy, exponent), UE_PositiveClampedPow(base.z, exponent));
}
float4 UE_PositiveClampedPow(float4 base, float exponent)
{
    return float4(UE_PositiveClampedPow(base.xy, exponent), UE_PositiveClampedPow(base.zw, exponent));
}`;

export function lowerMath(node: GraphNode, ctx: LoweringContext): Ref[] | undefined {
  const type = node.type.replace('MaterialExpression', '');
  if (type === 'If') {
    const a = ctx.input(node, 'A');
    const b = ctx.input(node, 'B', num(node.props.ConstB));
    // UE permits primitive comparison inputs. Vector comparisons need component
    // selection semantics; do not silently truncate them to their first channel.
    if (a.type !== 'float' || b.type !== 'float')
      ctx.diag(node, 'IF_COMPARISON_TYPE', '当前 If 比较仅支持 float 标量，不能隐式截断向量比较。');
    const greater = ctx.input(node, 'AGreaterThanB');
    const less = ctx.input(node, 'ALessThanB');
    const equal = ctx.connected(node, 'AEqualsB') ? ctx.input(node, 'AEqualsB') : undefined;
    const refs = equal ? [greater, less, equal] : [greater, less];
    const resultType = ctx.common(node, refs);
    const unequal = `(${a.code} >= ${b.code} ? ${ctx.as(greater, resultType)} : ${ctx.as(less, resultType)})`;
    const expression = equal
      ? `(abs(${a.code} - ${b.code}) > ${literal(num(node.props.EqualsThreshold, 0.00001))} ? ${unequal} : ${ctx.as(equal, resultType)})`
      : unequal;
    return [ctx.emit(node, expression, resultType, [a, b, ...refs])];
  }
  if (type === 'Power') {
    const base = ctx.input(node, 'Base');
    const exponent = ctx.input(node, 'Exponent', num(node.props.ConstExponent, 2));
    if (!numeric(base.type)) ctx.diag(node, 'POWER_BASE_TYPE', 'Power.Base 必须为数值标量或向量。');
    if (exponent.type !== 'float') {
      // UE's analytic-derivative and legacy paths disagree on vector exponents.
      // The clipboard does not identify which path was compiled.
      return ctx.unknown(node, 'Power 的向量 Exponent 在 UE 不同编译路径下存在语义差异；请使用标量指数。');
    }
    const constantExponent = scalarConstant(node, 'Exponent', ctx, num(node.props.ConstExponent, 2));
    // Match UE compile-time identities; exponent 1 intentionally preserves
    // negative bases, while a dynamic exponent equal to 1 still uses the helper.
    if (constantExponent === 1) return [ctx.emit(node, base.code, base.type, [base, exponent])];
    if (constantExponent === 0) return [ctx.emit(node, base.type === 'float' ? '1.0' : `(${base.type})(1.0)`, base.type, [base, exponent])];
    if (constantExponent !== undefined && scalarConstant(node, 'Base', ctx) === 0)
      return [ctx.emit(node, '0.0', base.type, [base, exponent])];
    ctx.helper('UE_PositiveClampedPow', powerHelper);
    return [ctx.emit(node, `UE_PositiveClampedPow(${base.code}, ${exponent.code})`, base.type, [base, exponent])];
  }
  if (type === 'Rotator') {
    const coordinateIndex = num(node.props.ConstCoordinate);
    const coordinate = ctx.connected(node, 'Coordinate') ? ctx.input(node, 'Coordinate') :
      ctx.parameter(`uv:${coordinateIndex}`, `UV${coordinateIndex}`, 'float2', 'context', node.id);
    const time = ctx.connected(node, 'Time') ? ctx.input(node, 'Time') :
      ctx.parameter('game-time', 'GameTime', 'float', 'context', 'Elapsed game seconds respecting pause');
    if (!['float2', 'float3'].includes(coordinate.type))
      ctx.diag(node, 'ROTATOR_COORDINATE_TYPE', 'Rotator.Coordinate 需要 float2 或 float3；float3 会保留 Z 分量。');
    if (time.type !== 'float') ctx.diag(node, 'ROTATOR_TIME_TYPE', 'Rotator.Time 需要 float 标量。');
    const angle = ctx.emit(node, `${time.code} * ${literal(num(node.props.Speed, 0.25))}`, 'float', [time], 'angle');
    const center = `float2(${literal(num(node.props.CenterX, 0.5))}, ${literal(num(node.props.CenterY, 0.5))})`;
    const offset = ctx.emit(node, `(${coordinate.code}).xy - ${center}`, 'float2', [coordinate], 'offset');
    const cosine = ctx.emit(node, `cos(${angle.code})`, 'float', [angle], 'cos');
    const sine = ctx.emit(node, `sin(${angle.code})`, 'float', [angle], 'sin');
    const xy = `float2(${cosine.code} * ${offset.code}.x - ${sine.code} * ${offset.code}.y, ${sine.code} * ${offset.code}.x + ${cosine.code} * ${offset.code}.y) + ${center}`;
    return [ctx.emit(node, coordinate.type === 'float3' ? `float3(${xy}, (${coordinate.code}).z)` : xy,
      coordinate.type === 'float3' ? 'float3' : 'float2', [coordinate, offset, cosine, sine])];
  }
  if (type === 'Length') {
    const value = ctx.input(node, 'Input');
    if (!numeric(value.type)) ctx.diag(node, 'LENGTH_INPUT_TYPE', 'Length.Input 必须为数值标量或向量。');
    return [ctx.emit(node, `${value.type === 'float' ? 'abs' : 'length'}(${value.code})`, 'float', [value])];
  }
  if (type === 'TruncateLWC') {
    const value = ctx.input(node, 'Input');
    if (!numeric(value.type)) ctx.diag(node, 'TRUNCATE_LWC_INPUT_TYPE', 'TruncateLWC.Input 必须为数值标量或向量。');
    // The portable IR already uses float (non-LWC). This is a precision cast,
    // never floor/trunc; preserve fractional and negative values.
    return [ctx.emit(node, value.code, value.type, [value])];
  }
  return undefined;
}
