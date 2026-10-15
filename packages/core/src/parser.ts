import type { Diagnostic, ParsedClipboard, RawObject, Value } from './types.js';

interface ScanState {
  quote: string | null;
  escaped: boolean;
  delimiters: string[];
}

const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function newState(): ScanState {
  return { quote: null, escaped: false, delimiters: [] };
}

/** Walk serialized text without treating commas inside strings or structs as separators. */
function scanCharacter(state: ScanState, character: string): void {
  if (state.quote !== null) {
    if (state.escaped) state.escaped = false;
    else if (character === '\\') state.escaped = true;
    else if (character === state.quote) state.quote = null;
    return;
  }
  if (character === '"' || character === "'") {
    state.quote = character;
  } else if (character === '(' || character === '[' || character === '{') {
    state.delimiters.push(character);
  } else if (character in closing) {
    if (state.delimiters.pop() !== closing[character]) {
      throw new SyntaxError(`Unexpected closing delimiter ${character}.`);
    }
  }
}

function isTopLevel(state: ScanState): boolean {
  return state.quote === null && state.delimiters.length === 0;
}

function finishScan(state: ScanState): void {
  if (state.quote !== null) throw new SyntaxError('Unterminated quoted string.');
  if (state.delimiters.length !== 0) throw new SyntaxError('Unbalanced value delimiters.');
}

function splitTopLevel(text: string, separator: string): string[] {
  const state = newState();
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === separator && isTopLevel(state)) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    } else {
      scanCharacter(state, character);
    }
  }
  finishScan(state);
  parts.push(text.slice(start).trim());
  // Unreal often writes a final comma, especially in LinkedTo tuples.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function findAssignment(text: string): number {
  const state = newState();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=' && isTopLevel(state)) return index;
    scanCharacter(state, text[index]);
  }
  finishScan(state);
  return -1;
}

function decodeQuoted(text: string): string {
  const quote = text[0];
  let result = '';
  let closedAt = -1;
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === quote) {
      closedAt = index;
      break;
    }
    if (character !== '\\') {
      result += character;
      continue;
    }
    index += 1;
    if (index >= text.length) throw new SyntaxError('Unterminated string escape.');
    const escaped = text[index];
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\' };
    // Unknown escapes may occur in paths or Custom HLSL; keep them verbatim.
    result += escaped in escapes ? escapes[escaped] : `\\${escaped}`;
  }
  if (closedAt < 0) throw new SyntaxError('Unterminated quoted string.');
  if (text.slice(closedAt + 1).trim() !== '') throw new SyntaxError('Unexpected text after quoted string.');
  return result;
}

/** Parse an Unreal exported property value. Unknown enums/references stay lossless strings. */
export function parseValue(input: string): Value {
  const text = input.trim();
  if (text === '') throw new SyntaxError('Missing property value.');
  if (text[0] === '"' || text[0] === "'") return decodeQuoted(text);
  const state = newState();
  for (const character of text) scanCharacter(state, character);
  finishScan(state);

  if (/^none$/i.test(text)) return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  // GUIDs are unquoted 32-digit hexadecimal tokens; digit-only GUIDs must not
  // become rounded JavaScript numbers (or turn an all-zero GUID into 0).
  if (/^[0-9a-fA-F]{32}$/.test(text)) return text;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fF]?$/.test(text)) {
    const number = Number(text.replace(/[fF]$/, ''));
    if (!Number.isFinite(number)) throw new SyntaxError('Numeric value is outside the finite number range.');
    if (/^[+-]?\d+$/.test(text) && !Number.isSafeInteger(number)) return text;
    return number;
  }

  const first = text[0];
  if (first === '(' || first === '[' || first === '{') {
    const expected = first === '(' ? ')' : first === '[' ? ']' : '}';
    if (text[text.length - 1] !== expected) throw new SyntaxError('Unexpected text after compound value.');
    const contents = text.slice(1, -1).trim();
    if (contents === '') return first === '[' ? [] : {};
    const parts = splitTopLevel(contents, ',');
    if (parts.some(part => part === '')) throw new SyntaxError('Empty element in compound value.');
    const assignments = parts.map(findAssignment);
    if (assignments.every(index => index < 0)) return parts.map(parseValue);
    if (assignments.some(index => index < 0)) throw new SyntaxError('Mixed named and positional compound values.');
    const result: Record<string, Value> = Object.create(null) as Record<string, Value>;
    parts.forEach((part, index) => {
      const key = part.slice(0, assignments[index]).trim();
      if (!key) throw new SyntaxError('Missing compound property name.');
      if (Object.hasOwn(result, key)) throw new SyntaxError(`Duplicate compound property ${key}.`);
      result[key] = parseValue(part.slice(assignments[index] + 1));
    });
    return result;
  }
  return text;
}

function parseHeader(text: string): Record<string, Value> {
  const attributes: Record<string, Value> = Object.create(null) as Record<string, Value>;
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    if (cursor === text.length) break;
    const match = /^([A-Za-z_][\w.]*)\s*=\s*/.exec(text.slice(cursor));
    if (!match) throw new SyntaxError(`Invalid object header near ${text.slice(cursor, cursor + 40)}.`);
    const key = match[1];
    cursor += match[0].length;
    const start = cursor;
    const state = newState();
    for (; cursor < text.length; cursor += 1) {
      if (/\s/.test(text[cursor]) && isTopLevel(state) && /^\s+[A-Za-z_][\w.]*\s*=/.test(text.slice(cursor))) break;
      scanCharacter(state, text[cursor]);
    }
    finishScan(state);
    attributes[key] = parseValue(text.slice(start, cursor));
  }
  return attributes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse UE material clipboard exports without requiring the engine.
 * Object hierarchy and indexed property keys are retained for graph reconstruction.
 */
export function parseClipboard(input: string): ParsedClipboard {
  const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const objects: RawObject[] = [];
  const diagnostics: Diagnostic[] = [];
  const stack: RawObject[] = [];
  const diagnose = (severity: Diagnostic['severity'], code: string, message: string, startLine: number, endLine = startLine): void => {
    diagnostics.push({ severity, code, message, range: { startLine, endLine } });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const startLine = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    const begin = /^Begin\s+Object(?:\s+(.*))?$/i.exec(line);
    if (begin) {
      let header: Record<string, Value> = {};
      try {
        header = parseHeader(begin[1] ?? '');
      } catch (error) {
        diagnose('error', 'INVALID_OBJECT_HEADER', errorMessage(error), startLine);
      }
      const name = typeof header.Name === 'string' ? header.Name : `__unnamed_${startLine}`;
      if (typeof header.Name !== 'string' || !header.Name) diagnose('error', 'MISSING_OBJECT_NAME', 'Begin Object must include a non-empty Name.', startLine);
      const path = header.ObjectPath ?? header.ExportPath;
      const object: RawObject = {
        name,
        ...(typeof header.Class === 'string' ? { className: header.Class } : {}),
        ...(typeof path === 'string' ? { objectPath: path } : {}),
        properties: Object.create(null) as Record<string, Value>,
        children: [],
        range: { startLine, endLine: startLine },
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(object);
      else objects.push(object);
      stack.push(object);
      continue;
    }
    if (/^End\s+Object\s*$/i.test(line)) {
      const object = stack.pop();
      if (object) object.range.endLine = startLine;
      else diagnose('error', 'UNMATCHED_END_OBJECT', 'End Object has no matching Begin Object.', startLine);
      continue;
    }

    const object = stack[stack.length - 1];
    if (!object) {
      diagnose('warning', 'TEXT_OUTSIDE_OBJECT', 'Ignored text outside a Begin Object block.', startLine);
      continue;
    }
    let statement = line;
    const state = newState();
    let invalid = false;
    try {
      for (const character of statement) scanCharacter(state, character);
      while (!isTopLevel(state) && index + 1 < lines.length) {
        // Recover at an object boundary after an unterminated struct so one bad
        // property does not consume every subsequent clipboard object.
        if (state.quote === null && /^(?:Begin\s+Object(?:\s|$)|End\s+Object\s*$)/i.test(lines[index + 1].trim())) break;
        index += 1;
        const continuation = lines[index];
        statement += `\n${continuation}`;
        // A literal newline terminates an escape but not a quoted string.
        scanCharacter(state, '\n');
        for (const character of continuation) scanCharacter(state, character);
      }
      finishScan(state);
    } catch (error) {
      diagnose('error', 'INVALID_PROPERTY_VALUE', errorMessage(error), startLine, index + 1);
      invalid = true;
    }
    if (invalid) continue;

    try {
      // UE exports changes to class-default arrays as commands, rather than
      // assignments. Keep the ordered operations for graph reconstruction:
      // inherited output slots cannot be reconstructed by deleting local keys.
      const removeIndex = /^([A-Za-z_][\w.:-]*)\.RemoveIndex\(\s*(\d+)\s*\)$/.exec(statement);
      if (removeIndex) {
        const arrayIndex = Number(removeIndex[2]);
        if (!Number.isSafeInteger(arrayIndex)) throw new SyntaxError('Array removal index is outside the safe integer range.');
        const operations = object.properties.__ArrayOperations;
        if (operations !== undefined && !Array.isArray(operations)) throw new SyntaxError('Array operations conflict with an ordinary property.');
        object.properties.__ArrayOperations = [
          ...(operations as Value[] | undefined ?? []),
          { property: removeIndex[1], operation: 'RemoveIndex', index: arrayIndex },
        ];
        continue;
      }
      const custom = /^CustomProperties\s+(\S+)\s+([\s\S]+)$/.exec(statement);
      if (custom) {
        const value = parseValue(custom[2]);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SyntaxError('CustomProperties entry must be a named compound value.');
        const entries = object.properties.CustomProperties;
        if (entries !== undefined && !Array.isArray(entries)) throw new SyntaxError('CustomProperties conflicts with an ordinary property.');
        const entry: Record<string, Value> = Object.assign(Object.create(null), value, { kind: custom[1] }) as Record<string, Value>;
        object.properties.CustomProperties = [...(entries as Value[] | undefined ?? []), entry];
        continue;
      }
      const assignment = findAssignment(statement);
      if (assignment < 0) {
        diagnose('warning', 'UNRECOGNIZED_STATEMENT', 'Unrecognized object statement; it was not interpreted as a property.', startLine, index + 1);
        continue;
      }
      const key = statement.slice(0, assignment).trim();
      if (!/^[A-Za-z_][\w.:-]*(?:\([^\r\n]*\))?$/.test(key)) throw new SyntaxError(`Invalid property name ${key}.`);
      const value = parseValue(statement.slice(assignment + 1));
      if (Object.hasOwn(object.properties, key)) {
        diagnose('warning', 'DUPLICATE_PROPERTY', `Property ${key} was repeated; the last serialized value is used.`, startLine, index + 1);
      }
      object.properties[key] = value;
    } catch (error) {
      diagnose('error', 'INVALID_PROPERTY_VALUE', errorMessage(error), startLine, index + 1);
    }
  }
  for (const object of stack) {
    object.range.endLine = lines.length;
    diagnose('error', 'UNCLOSED_OBJECT', `Object ${object.name} has no matching End Object.`, object.range.startLine, lines.length);
  }
  if (objects.length === 0) diagnose('error', 'NO_OBJECTS', 'No Unreal Begin Object blocks were found.', 1, Math.max(1, lines.length));
  return { objects, diagnostics };
}
