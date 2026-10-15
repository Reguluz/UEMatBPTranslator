import type { Connection, GraphNode, MaterialGraph } from './graph';
import type { Diagnostic, ShaderInput, TranslationOptions, Value, ValueType } from './types';

/** A typed expression and the emitted instructions it depends on. */
export interface Ref { code: string; type: ValueType; deps: string[] }

/** Narrow interface shared by node-family lowering modules. */
export interface LoweringContext {
  graph: MaterialGraph;
  options: TranslationOptions;
  input(node: GraphNode, key: string, fallback?: number | Ref, expected?: ValueType): Ref;
  connected(node: GraphNode, key: string): boolean;
  emit(node: GraphNode, expression: string, type: ValueType, refs?: Ref[], suffix?: string, label?: string): Ref;
  parameter(key: string, label: string, type: ValueType, kind: ShaderInput['kind'], source?: string, defaultValue?: Value): Ref;
  common(node: GraphNode, refs: Ref[]): ValueType;
  as(ref: Ref, type: ValueType): string;
  diag(node: GraphNode | undefined, code: string, message: string, severity?: Diagnostic['severity']): void;
  link(node: GraphNode, connection: Connection, expected?: ValueType): Ref;
  helper(name: string, source: string): void;
  requireExternal(): void;
  unknown(node: GraphNode, reason: string): Ref[];
  channels(node: GraphNode, base: Ref): Ref[];
}
