export type EngineVersion = '5.5' | '5.7';
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export type ValueType = 'float' | 'float2' | 'float3' | 'float4' | 'bool' | 'Texture2D' | 'Texture3D' | 'SamplerState' | 'unknown';
/** All line numbers are one-based and inclusive. */
export interface SourceRange { startLine: number; endLine: number }
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'; code: string; message: string;
  range?: SourceRange; nodeId?: string;
}
export interface RawObject {
  className?: string; name: string; objectPath?: string;
  properties: Record<string, Value>; children: RawObject[]; range: SourceRange;
}
export interface ParsedClipboard { objects: RawObject[]; diagnostics: Diagnostic[] }
export interface TranslationOptions {
  engineVersion?: EngineVersion; outputs?: string[];
  /** Preserve compile-time variants, or explicitly choose the material shading path. */
  shadingPath?: 'preserve' | 'deferred' | 'forward' | 'mobile';
  /** Explicit material static-parameter values; omitted values retain compile-time variants. */
  staticParameters?: Record<string, boolean>;
  moduleStyle?: 'auto' | 'scopes' | 'functions'; functionName?: string;
  /** Keys are the external source expression id, or source id plus :outputIndex. */
  externalInputs?: Record<string, ValueType>;
  /** Explicit node id -> comment id ownership; null removes a node from grouping. */
  moduleAssignments?: Record<string, string | null>;
}
export interface ShaderInput {
  name: string; type: ValueType; kind: 'parameter' | 'context' | 'resource' | 'external';
  defaultValue?: Value; source?: string;
}
export interface OutputCandidate {
  id: string; nodeId: string; name: string; type: ValueType; outputIndex: number;
}
export interface ModuleInfo {
  id: string; name: string; nodeIds: string[];
  mode: 'function' | 'scope' | 'sections'; reason?: string;
}
export interface SourceMapping {
  generated: SourceRange; source: SourceRange; nodeId: string; moduleId?: string;
}
export interface TranslationResult {
  hlsl: string; status: 'complete' | 'external-dependencies' | 'unsupported';
  engineVersion: EngineVersion; diagnostics: Diagnostic[]; inputs: ShaderInput[];
  outputs: OutputCandidate[]; candidates: OutputCandidate[]; modules: ModuleInfo[];
  sourceMap: SourceMapping[];
  stats: { nodes: number; reachableNodes: number; expressions: number };
  /** Renderer settings copied from material custom-output nodes; no hidden rendering implementation. */
  materialSettings?: Record<string, Value>;
}
