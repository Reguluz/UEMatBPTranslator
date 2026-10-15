import type { Diagnostic, RawObject, SourceRange, Value } from './types';

export const rec = (v: Value | undefined): Record<string, Value> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
export const num = (v: Value | undefined, fallback = 0): number => typeof v === 'number' ? v : fallback;
export const str = (v: Value | undefined, fallback = ''): string => typeof v === 'string' ? v : fallback;
export const flag = (v: Value | undefined): boolean => v === true || v === 1 || v === 'True';
export function referenceName(value: Value | undefined): string {
  const s = str(value);
  if (!s || s === 'None') return '';
  const quoted = (/'([^']+)'/.exec(s)?.[1] ?? s).replace(/^"|"$/g, '');
  return quoted.split(/[.:/]/).at(-1) ?? quoted;
}
export function identifier(value: string, fallback = 'value'): string {
  let name = value.normalize('NFKD').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = fallback;
  if (/^\d/.test(name)) name = `v_${name}`;
  // Prefix HLSL keywords and intrinsic/type names to keep generated declarations valid.
  if (/^(?:float\d?(?:x\d)?|int\d?|uint\d?|bool|void|return|if|else|for|while|do|switch|case|break|continue|struct|in|out|inout|const|static|uniform|sampler|Texture\w*|SamplerState|true|false|register|buffer|vector|matrix|namespace|class|typedef|technique|pass|compile|discard|groupshared|cbuffer|tbuffer|linear|centroid|sample|nointerpolation|precise|shared|volatile|extern|inline|snorm|unorm|point|line|triangle|sin|cos|abs|normalize|length|dot|cross|min|max|clamp|lerp|saturate|pow|frac|floor|ceil)$/i.test(name)) name = `v_${name}`;
  return name;
}
export interface GraphNode {
  id: string; type: string; raw: RawObject; props: Record<string, Value>;
  wrapper?: RawObject; range: SourceRange; x?: number; y?: number;
}
export interface Connection { source: string; outputIndex: number; mask?: string }
export interface MaterialGraph {
  nodes: Map<string, GraphNode>; comments: GraphNode[]; diagnostics: Diagnostic[];
  resolve(ref: Value | undefined): string;
  connection(node: GraphNode, key: string): Connection | undefined;
  dependencies(node: GraphNode): Connection[];
}
export function buildGraph(objects: RawObject[]): MaterialGraph {
  const nodes = new Map<string, GraphNode>();
  const comments: GraphNode[] = [];
  const diagnostics: Diagnostic[] = [];
  const aliases = new Map<string, Set<string>>();
  const addAlias = (key: string, id: string) => {
    if (!key) return;
    const ids = aliases.get(key) ?? new Set<string>(); ids.add(id); aliases.set(key, ids);
  };
  function visit(object: RawObject, parent?: RawObject, owner = ''): void {
    const classType = (object.className ?? '').split(/[./]/).at(-1) ?? '';
    const guessed = object.name.replace(/_\d+$/, '');
    const type = classType || (guessed.startsWith('MaterialExpression') ? guessed : '');
    if (type.startsWith('MaterialExpression') || type === 'MaterialGraphNode_Root') {
      const baseId = object.name;
      const existing = nodes.get(baseId);
      const sameOwner = existing?.wrapper?.name === parent?.name;
      let id = existing && !sameOwner ? `${owner}.${baseId}` : baseId;
      const prior = nodes.get(id);
      if (prior) {
        prior.props = { ...prior.props, ...object.properties };
        prior.range = { startLine: Math.min(prior.range.startLine, object.range.startLine), endLine: Math.max(prior.range.endLine, object.range.endLine) };
        if (classType) prior.type = classType;
      } else {
        nodes.set(id, { id, type, raw: object, props: { ...object.properties }, wrapper: parent, range: object.range });
      }
      addAlias(baseId, id); addAlias(object.objectPath ?? '', id);
    }
    for (const child of object.children) visit(child, object, object.name);
  }
  for (const object of objects) visit(object);
  // Some graph nodes serialize their expression type only in the MaterialExpression reference.
  function wrappers(object: RawObject): void {
    if ((object.className ?? '').includes('MaterialGraphNode') && !(object.className ?? '').includes('_Root')) {
      const ref = str(object.properties.MaterialExpression);
      const name = referenceName(ref);
      if (name && !nodes.has(name)) {
        const type = /(?:\/Script\/Engine\.)?(MaterialExpression\w+)'/.exec(ref)?.[1];
        if (type) nodes.set(name, { id: name, type, raw: object, props: {}, wrapper: object, range: object.range });
      }
    }
    for (const child of object.children) wrappers(child);
  }
  for (const object of objects) wrappers(object);
  const wrapperIds = new Map<string, string>();
  for (const node of nodes.values()) {
    node.x = typeof node.props.MaterialExpressionEditorX === 'number' ? node.props.MaterialExpressionEditorX :
      typeof node.wrapper?.properties.NodePosX === 'number' ? node.wrapper.properties.NodePosX : 0;
    node.y = typeof node.props.MaterialExpressionEditorY === 'number' ? node.props.MaterialExpressionEditorY :
      typeof node.wrapper?.properties.NodePosY === 'number' ? node.wrapper.properties.NodePosY : 0;
    if (node.wrapper) wrapperIds.set(node.wrapper.name, node.id);
    if (node.type === 'MaterialExpressionComment') comments.push(node);
    addAlias(node.id, node.id);
  }
  const resolve = (ref: Value | undefined): string => {
    const raw = str(ref); const name = referenceName(ref);
    const choices = aliases.get(raw) ?? aliases.get(name);
    if (choices?.size === 1) return [...choices][0];
    if (choices && choices.size > 1) {
      if (!diagnostics.some(d => d.code === 'AMBIGUOUS_REFERENCE' && d.message.includes(name)))
        diagnostics.push({ severity: 'error', code: 'AMBIGUOUS_REFERENCE', message: `引用 ${name} 对应多个对象，无法唯一解析。` });
      return `Ambiguous_${name}`;
    }
    return wrapperIds.get(name) ?? name;
  };
  function fromValue(value: Value | undefined): Connection | undefined {
    const p = rec(value);
    if (!referenceName(p.Expression)) return undefined;
    const mask = flag(p.Mask) ? ['R', 'G', 'B', 'A'].filter(k => flag(p[`Mask${k}`])).map(k => ({ R: 'x', G: 'y', B: 'z', A: 'w' })[k]).join('') : undefined;
    return { source: resolve(p.Expression), outputIndex: num(p.OutputIndex), mask };
  }
  function pins(node: GraphNode): Record<string, Value>[] {
    const entries = node.wrapper?.properties.CustomProperties ?? node.props.CustomProperties;
    return Array.isArray(entries) ? entries.map(rec).filter(p => p.kind === 'Pin') : [];
  }
  function connection(node: GraphNode, key: string): Connection | undefined {
    const direct = fromValue(node.props[key]);
    if (direct) return direct;
    // Explicit None is authoritative; do not revive stale visual links.
    if (Object.hasOwn(node.props, key)) return undefined;
    const pin = pins(node).find(p => p.Direction !== 'EGPD_Output' && str(p.PinName).replace(/\s/g, '').toLowerCase() === key.replace(/\s/g, '').toLowerCase());
    const links = pin?.LinkedTo;
    if (!Array.isArray(links) || !links.length) return undefined;
    const link = str(links[0]); const match = /^([^\s]+)\s+([^\s]+)/.exec(link);
    if (!match) return undefined;
    const sourceId = wrapperIds.get(match[1]) ?? match[1]; const source = nodes.get(sourceId);
    const outputs = source ? pins(source).filter(p => p.Direction === 'EGPD_Output') : [];
    const outputIndex = outputs.findIndex(p => p.PinId === match[2]);
    if (source && outputIndex < 0) return undefined;
    return { source: sourceId, outputIndex: Math.max(0, outputIndex) };
  }
  function dependencies(node: GraphNode): Connection[] {
    const result: Connection[] = [];
    function scan(value: Value): void {
      const link = fromValue(value); if (link) { result.push(link); return; }
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') Object.values(value).forEach(scan);
    }
    Object.values(node.props).forEach(scan);
    for (const p of pins(node)) if (p.Direction !== 'EGPD_Output') {
      const c = connection(node, str(p.PinName)); if (c) result.push(c);
    }
    if (node.type === 'MaterialExpressionNamedRerouteUsage') {
      let source = resolve(node.props.Declaration);
      if (!source || !nodes.has(source)) {
        const guid = str(node.props.DeclarationGuid);
        const declarations = [...nodes.values()].filter(n => n.type === 'MaterialExpressionNamedRerouteDeclaration' && guid && str(n.props.VariableGuid) === guid);
        if (declarations.length === 1) source = declarations[0].id;
      }
      if (source) result.push({ source, outputIndex: 0 });
    }
    return [...new Map(result.map(c => [`${c.source}:${c.outputIndex}:${c.mask ?? ''}`, c])).values()];
  }
  return { nodes, comments, diagnostics, resolve, connection, dependencies };
}
