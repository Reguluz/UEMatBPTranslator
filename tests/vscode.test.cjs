const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { translate } = require('../packages/core/dist');

const extensionPath = path.join(__dirname, '../packages/vscode/dist/extension.js');
const command = suffix => `ueMaterialTranslator.${suffix}`;
const expression = (type, name, properties = '') =>
  `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${name}"\n${properties}\nEnd Object`;
const single = expression('Constant', 'MaterialExpressionConstant_0', 'R=0.75');
const multi = `${single}\n${expression('Constant', 'MaterialExpressionConstant_1', 'R=0.25')}`;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** A small in-memory implementation of the VSCode APIs used by the real bundle. */
function harness(config = {}) {
  class Position {
    constructor(line, character) { this.line = line; this.character = character; }
  }
  class Range {
    constructor(start, end) {
      const reverse = start.line > end.line || (start.line === end.line && start.character > end.character);
      this.start = reverse ? end : start;
      this.end = reverse ? start : end;
    }
    get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
  }
  class Selection extends Range {
    constructor(anchor, active) { super(anchor, active); this.anchor = anchor; this.active = active; }
  }
  class Uri {
    constructor(parts) { this.scheme = parts.scheme; this.authority = parts.authority || ''; this.path = parts.path; }
    static from(parts) { return new Uri(parts); }
    static file(filePath) { return new Uri({ scheme: 'file', path: filePath.replace(/\\/g, '/') }); }
    static joinPath(base, ...parts) { return new Uri({ ...base, path: path.posix.join(base.path, ...parts) }); }
    get fsPath() { return process.platform === 'win32' ? this.path.replace(/^\/(?=[A-Za-z]:)/, '').replace(/\//g, '\\') : this.path; }
    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  }
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  class TextDocument {
    constructor(uri, text, languageId = 'plaintext') {
      this.uri = uri; this.text = text; this.languageId = languageId; this.version = 1; this.isClosed = false;
    }
    get lines() { return this.text.split(/\r?\n/); }
    get lineCount() { return this.lines.length; }
    offsetAt(position) {
      const lines = this.text.split('\n');
      let result = 0;
      for (let i = 0; i < position.line; i++) result += lines[i].length + 1;
      return result + position.character;
    }
    getText(range) { return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text; }
    lineAt(line) { return { text: this.lines[line], range: new Range(new Position(line, 0), new Position(line, this.lines[line].length)) }; }
    validateRange(range) {
      const clamp = position => {
        const line = Math.max(0, Math.min(this.lineCount - 1, position.line));
        return new Position(line, Math.max(0, Math.min(this.lines[line].length, position.character)));
      };
      return new Range(clamp(range.start), clamp(range.end));
    }
  }
  class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
  class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
  class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange }); } }
  const providers = new Map();
  const documents = new Map();
  const commands = new Map();
  const changedDocument = new EventEmitter();
  const changedEditor = new EventEmitter();
  const diagnosticValues = new Map();
  const shown = [];
  const messages = { info: [], warning: [], error: [] };
  const writes = [];
  const logs = [];
  const calls = { clipboardReads: 0, quickPicks: [], saveDialogs: [], builtins: [], warningMessages: [], outputShows: 0 };
  const quickPicks = [];
  const saveResults = [];
  const warningActions = [];
  let clipboard = '';
  let definitionProvider;
  let symbolProvider;
  const disposable = () => ({ dispose() {} });
  const api = {
    Position, Range, Selection, Uri, EventEmitter, Diagnostic, Location, DocumentSymbol,
    ViewColumn: { One: 1, Two: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    SymbolKind: { Function: 11, Namespace: 2 },
    env: { clipboard: { readText: async () => { calls.clipboardReads++; return clipboard; } } },
    commands: {
      registerCommand: (id, handler) => { commands.set(id, handler); return disposable(); },
      executeCommand: async (id, ...args) => commands.has(id) ? commands.get(id)(...args) : calls.builtins.push(id)
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, items) => diagnosticValues.set(uri.toString(), items),
        clear: () => diagnosticValues.clear(), dispose() {}
      }),
      registerDefinitionProvider: (_selector, provider) => { definitionProvider = provider; return disposable(); },
      registerDocumentSymbolProvider: (_selector, provider) => { symbolProvider = provider; return disposable(); },
      setTextDocumentLanguage: async (document, languageId) => {
        // VSCode closes and recreates a document when its language changes.
        document.isClosed = true;
        const recreated = new TextDocument(document.uri, document.text, languageId);
        documents.set(document.uri.toString(), recreated);
        return recreated;
      }
    },
    workspace: {
      workspaceFolders: [{ uri: Uri.file('/workspace') }],
      get textDocuments() { return [...documents.values()].filter(document => !document.isClosed); },
      getConfiguration: namespace => {
        assert.equal(namespace, 'ueMaterialTranslator');
        return { get: (key, fallback) => Object.hasOwn(config, key) ? config[key] : fallback };
      },
      registerTextDocumentContentProvider: (scheme, provider) => {
        providers.set(scheme, provider);
        provider.onDidChange?.(async uri => {
          const document = documents.get(uri.toString());
          if (document) {
            document.text = await provider.provideTextDocumentContent(uri);
            document.version++;
            changedDocument.fire({ document });
          }
        });
        return disposable();
      },
      onDidChangeTextDocument: changedDocument.event,
      openTextDocument: async uri => {
        let document = documents.get(uri.toString());
        if (!document || document.isClosed) {
          const provider = providers.get(uri.scheme);
          if (!provider) throw new Error(`Unknown document: ${uri}`);
          document = new TextDocument(uri, await provider.provideTextDocumentContent(uri));
          documents.set(uri.toString(), document);
        }
        return document;
      },
      fs: { writeFile: async (uri, data) => {
        writes.push({ uri, text: Buffer.from(data).toString('utf8') });
        documents.set(uri.toString(), new TextDocument(uri, Buffer.from(data).toString('utf8'), 'hlsl'));
      } }
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: changedEditor.event,
      createOutputChannel: () => ({ appendLine: line => logs.push(line), show: () => { calls.outputShows++; }, dispose() {} }),
      setStatusBarMessage: () => disposable(),
      showInformationMessage: async message => { messages.info.push(message); },
      showWarningMessage: async (message, ...actions) => {
        messages.warning.push(message);
        calls.warningMessages.push({ message, actions });
        return warningActions.shift();
      },
      showErrorMessage: async message => { messages.error.push(message); },
      showQuickPick: async (items, options) => {
        calls.quickPicks.push({ items, options });
        return quickPicks.length ? quickPicks.shift()(items) : items.filter(item => item.picked);
      },
      showSaveDialog: async options => { calls.saveDialogs.push(options); return saveResults.shift(); },
      showTextDocument: async (document, options = {}) => {
        assert.equal(document.isClosed, false, 'must display the recreated document returned by setTextDocumentLanguage');
        const range = options.selection || new Range(new Position(0, 0), new Position(0, 0));
        const editor = { document, selection: new Selection(range.start, range.end),
          revealRange: range => { editor.revealed = range; }, viewColumn: options.viewColumn };
        shown.push(editor);
        api.window.activeTextEditor = editor;
        changedEditor.fire(editor);
        return editor;
      }
    }
  };
  const extensionModule = { exports: {} };
  const localRequire = createRequire(extensionPath);
  new Function('exports', 'require', 'module', '__filename', '__dirname', fs.readFileSync(extensionPath, 'utf8'))(
    extensionModule.exports, id => id === 'vscode' ? api : localRequire(id), extensionModule, extensionPath, path.dirname(extensionPath));
  const context = { subscriptions: [] };
  extensionModule.exports.activate(context);
  return {
    api, calls, commands, documents, diagnosticValues, shown, messages, writes, logs, quickPicks, saveResults, warningActions,
    get definitionProvider() { return definitionProvider; },
    get symbolProvider() { return symbolProvider; },
    set clipboard(value) { clipboard = value; },
    async run(suffix) { await api.commands.executeCommand(command(suffix)); await settle(); },
    async openFile(text, filePath = '/workspace/source.txt') {
      const document = new TextDocument(Uri.file(filePath), text);
      documents.set(document.uri.toString(), document);
      await api.window.showTextDocument(document);
      return document;
    },
    async edit(document, text) {
      document.text = text; document.version++; changedDocument.fire({ document }); await settle();
    },
    dispose() { for (const subscription of context.subscriptions.reverse()) subscription.dispose(); }
  };
}

test('VSCode real activate registers commands without reading clipboard; translation opens read-only source and HLSL', async t => {
  const app = harness(); t.after(() => app.dispose());
  assert.equal(app.commands.size, 6);
  assert.equal(app.calls.clipboardReads, 0);
  app.clipboard = single;
  await app.run('translateClipboard');
  assert.equal(app.calls.clipboardReads, 1);
  assert.deepEqual(app.messages.error, []);
  assert.equal(app.shown.length, 2);
  assert.equal(app.shown[0].viewColumn, 1);
  assert.equal(app.shown[0].document.uri.authority, 'source');
  assert.equal(app.shown[0].document.getText(), single);
  assert.equal(app.shown[1].viewColumn, 2);
  assert.equal(app.shown[1].document.uri.authority, 'generated');
  assert.equal(app.shown[1].document.languageId, 'hlsl');
  assert.equal(app.shown[1].document.getText(), translate(single).hlsl);
  assert.equal(app.writes.length, 0);
});

test('VSCode selected text maps F12 and source command to original line/column, then immutable snapshot after edits', async t => {
  const app = harness(); t.after(() => app.dispose());
  const prefix = 'Unrelated preface\n  ';
  const original = await app.openFile(prefix + single + '\nUnrelated suffix');
  app.api.window.activeTextEditor.selection = new app.api.Selection(
    new app.api.Position(1, 2), new app.api.Position(3, 'End Object'.length));
  await app.run('translateSelection');
  const generated = app.api.window.activeTextEditor.document;
  const mapping = translate(single).sourceMap[0];
  assert.ok(mapping, 'constant translation should have a source map');
  const at = new app.api.Position(mapping.generated.startLine - 1, 0);
  const location = await app.definitionProvider.provideDefinition(generated, at);
  assert.equal(location.uri.toString(), original.uri.toString());
  assert.equal(location.range.start.line, mapping.source.startLine);
  assert.equal(location.range.start.character, mapping.source.startLine === 1 ? 2 : 0);
  app.api.window.activeTextEditor.selection = new app.api.Selection(at, at);
  await app.run('revealSource');
  assert.equal(app.api.window.activeTextEditor.document, original);
  assert.equal(app.api.window.activeTextEditor.revealed.start.line, location.range.start.line);
  await app.edit(original, 'changed; old line positions must not be used');
  const frozen = await app.definitionProvider.provideDefinition(generated, at);
  assert.equal(frozen.uri.authority, 'source');
  assert.equal(frozen.range.start.line, mapping.source.startLine - 1);
  assert.equal(frozen.range.start.character, 0);
  assert.equal(app.documents.get(frozen.uri.toString()).getText(), single);
});

test('VSCode diagnostics apply selection offset and relocate to snapshot after original changes', async t => {
  const app = harness(); t.after(() => app.dispose());
  const unsupported = expression('UnrecognizedForTest', 'MaterialExpressionUnrecognizedForTest_0');
  const original = await app.openFile(`Header\n  ${unsupported}\nFooter`);
  app.api.window.activeTextEditor.selection = new app.api.Selection(
    new app.api.Position(1, 2), new app.api.Position(3, 'End Object'.length));
  await app.run('translateSelection');
  const initial = app.diagnosticValues.get(original.uri.toString());
  assert.ok(initial?.length, 'unsupported node must appear in Problems');
  const nodeDiagnostic = initial.find(item => item.range.start.line === 1);
  assert.ok(nodeDiagnostic);
  assert.equal(nodeDiagnostic.range.start.character, 2);
  assert.equal(nodeDiagnostic.source, 'UE Material Translator');
  await app.edit(original, 'Changed');
  assert.equal(app.diagnosticValues.has(original.uri.toString()), false);
  const snapshotUri = [...app.diagnosticValues.keys()][0];
  assert.match(snapshotUri, /^ue-material-translator:\/\/source\//);
  assert.ok(app.diagnosticValues.get(snapshotUri).some(item => item.range.start.line === 0));
});

test('VSCode incomplete conversion warns with an actionable full diagnostic log, including after output selection', async t => {
  const app = harness(); t.after(() => app.dispose());
  const unsupported = expression('UnrecognizedForTest', 'MaterialExpressionUnrecognizedForTest_0');
  const input = `${single}\n${unsupported}`;
  const result = translate(input);
  assert.equal(result.status, 'unsupported');
  app.clipboard = input;
  app.warningActions.push('查看诊断');
  await app.run('translateClipboard');
  assert.equal(app.calls.quickPicks.length, 0, 'incomplete first translation must not force an output picker');
  assert.match(app.messages.warning[0], /未完整转换/);
  assert.deepEqual(app.calls.warningMessages[0].actions, ['查看诊断', '打开 Problems']);
  assert.equal(app.calls.outputShows, 1, 'view diagnostics action must show the translator output channel');
  assert.match(app.api.window.activeTextEditor.document.getText(), /#error UE_MATERIAL_TRANSLATION_INCOMPLETE/);
  for (const item of result.diagnostics) {
    assert.ok(app.logs.includes(item.message), `must log complete diagnostic message ${item.code}`);
    assert.ok(app.logs.some(line => line.includes(`[${item.severity}] ${item.code}`) &&
      line.includes(`节点 ${item.nodeId || '解析/图级'}`) && line.includes(`:${item.range?.startLine || 1}`)),
    `must log diagnostic identity, source node and source line for ${item.code}`);
  }
  app.quickPicks.push(items => items.filter(item => item.outputId.includes('UnrecognizedForTest')));
  app.warningActions.push('打开 Problems');
  await app.run('selectOutputs');
  assert.equal(app.calls.warningMessages.length, 2, 'retranslation must report incomplete output again');
  assert.match(app.calls.warningMessages[1].message, /未完整转换/);
  assert.ok(app.calls.builtins.includes('workbench.actions.view.problems'));
  assert.match(app.api.window.activeTextEditor.document.getText(), /#error UE_MATERIAL_TRANSLATION_INCOMPLETE/);
});

test('VSCode diagnostic output uses original selection line numbers', async t => {
  const app = harness(); t.after(() => app.dispose());
  const unsupported = expression('UnrecognizedForTest', 'MaterialExpressionUnrecognizedForTest_0');
  const original = await app.openFile(`Header\n  ${unsupported}\nFooter`);
  app.api.window.activeTextEditor.selection = new app.api.Selection(
    new app.api.Position(1, 2), new app.api.Position(3, 'End Object'.length));
  await app.run('translateSelection');
  assert.ok(app.logs.some(line => line.includes('MaterialExpressionUnrecognizedForTest_0') &&
    line.includes(`${original.uri.fsPath}:2`)), 'output log must locate the selected node in the original document');
});

test('VSCode multi-output picks regenerate content; cancellation and empty choices preserve result', async t => {
  const app = harness(); t.after(() => app.dispose());
  app.clipboard = multi;
  await app.run('translateClipboard');
  assert.equal(app.calls.quickPicks.length, 0, 'first translation must immediately use core defaults without a picker');
  assert.equal(app.api.window.activeTextEditor.document.getText(), translate(multi).hlsl);
  app.quickPicks.push(items => [items[1]]);
  await app.run('selectOutputs');
  assert.equal(app.calls.quickPicks[0].options.canPickMany, true);
  assert.equal(app.calls.quickPicks[0].items.length, 2);
  const generated = app.api.window.activeTextEditor.document;
  const selectedId = app.calls.quickPicks[0].items[1].outputId;
  assert.equal(generated.getText(), translate(multi, { outputs: [selectedId] }).hlsl);
  const before = generated.getText();
  app.quickPicks.push(() => undefined);
  await app.run('selectOutputs');
  assert.equal(generated.getText(), before);
  assert.equal(app.calls.quickPicks[1].items.filter(item => item.picked).length, 1);
  app.quickPicks.push(() => []);
  await app.run('selectOutputs');
  assert.equal(generated.getText(), before);
  app.quickPicks.push(items => items);
  await app.run('selectOutputs');
  assert.equal(generated.getText(), translate(multi).hlsl);
  assert.equal(app.calls.quickPicks.length, 4);
});

test('VSCode export handles cancellation, protects input path, and writes exact HLSL on save', async t => {
  const app = harness(); t.after(() => app.dispose());
  const original = await app.openFile(single);
  await app.run('translateDocument');
  const hlsl = app.api.window.activeTextEditor.document.getText();
  await app.run('exportHlsl');
  assert.equal(app.writes.length, 0);
  app.saveResults.push(original.uri);
  await app.run('exportHlsl');
  assert.equal(app.writes.length, 0);
  assert.ok(app.messages.error.some(message => message.includes('保留原始节点文本')));
  if (process.platform === 'win32') {
    app.saveResults.push(app.api.Uri.file(original.uri.path.toUpperCase()));
    await app.run('exportHlsl');
    assert.equal(app.writes.length, 0, 'case variation must not bypass source protection on Windows');
  }
  const destination = app.api.Uri.file('/workspace/generated.hlsl');
  app.saveResults.push(destination);
  await app.run('exportHlsl');
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].uri.toString(), destination.toString());
  assert.equal(app.writes[0].text, hlsl);
  assert.equal(original.getText(), single);
});

test('VSCode engine/module/external-type settings reach actual core and module outline uses mapped lines', async t => {
  const external = expression('Multiply', 'MaterialExpressionMultiply_0',
    "A=(Expression=MaterialExpressionConstant'MissingSource')\nConstB=0.5");
  const config = { engineVersion: '5.5', moduleStyle: 'scopes', externalInputTypes: { MissingSource: 'float3', Bad: 'invalid' } };
  const app = harness(config); t.after(() => app.dispose());
  app.clipboard = external;
  await app.run('translateClipboard');
  assert.equal(app.api.window.activeTextEditor.document.getText(), translate(external, {
    engineVersion: '5.5', moduleStyle: 'scopes', externalInputs: { MissingSource: 'float3' }
  }).hlsl);
  assert.ok(app.logs.some(line => line.includes('UE 5.5')));
  const annotated = fs.readFileSync(path.join(__dirname, '../docs/examples/annotated-mask.txt'), 'utf8');
  app.clipboard = annotated;
  await app.run('translateClipboard');
  const document = app.api.window.activeTextEditor.document;
  const symbols = app.symbolProvider.provideDocumentSymbols(document);
  assert.ok(symbols.some(symbol => symbol.name === 'Mask intensity'));
  for (const symbol of symbols) {
    assert.ok(symbol.range.start.line >= 0);
    assert.ok(symbol.range.end.line < document.lineCount);
    assert.ok(symbol.selectionRange.start.line >= symbol.range.start.line);
  }
});

test('VSCode shading-path settings reach the bundled core and preserve is the safe default', async t => {
  const branch = (index, value) => expression('Constant', `MaterialExpressionConstant_${index}`, `R=${value}`);
  const input = [branch(0, 0.1), branch(1, 0.2), branch(2, 0.3),
    expression('ShadingPathSwitch', 'MaterialExpressionShadingPathSwitch_0',
      "Inputs(0)=(Expression=MaterialExpressionConstant'MaterialExpressionConstant_0')\n" +
      "Inputs(1)=(Expression=MaterialExpressionConstant'MaterialExpressionConstant_1')\n" +
      "Inputs(2)=(Expression=MaterialExpressionConstant'MaterialExpressionConstant_2')")].join('\n');
  const generated = new Map();
  for (const configured of [undefined, 'preserve', 'deferred', 'forward', 'mobile', 'invalid']) {
    const app = harness(configured === undefined ? {} : { shadingPath: configured });
    t.after(() => app.dispose());
    app.clipboard = input;
    await app.run('translateClipboard');
    const target = ['deferred', 'forward', 'mobile'].includes(configured) ? configured : 'preserve';
    const actual = app.api.window.activeTextEditor.document.getText();
    assert.equal(actual, translate(input, { shadingPath: target }).hlsl, `${configured} must reach actual core`);
    assert.equal(app.calls.quickPicks.length, 0);
    assert.deepEqual(app.messages.error, []);
    generated.set(configured, actual);
  }
  assert.equal(generated.get(undefined), generated.get('preserve'));
  assert.equal(generated.get('invalid'), generated.get('preserve'));
  assert.equal(new Set(['preserve', 'deferred', 'forward', 'mobile'].map(key => generated.get(key))).size, 4,
    'explicit target settings must select different real algorithms instead of being ignored');
});

test('VSCode manifest references only packaged runtime files and exposes all six registered commands', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../packages/vscode/package.json'), 'utf8'));
  assert.equal(manifest.publisher, 'local-tools');
  assert.equal(manifest.main, './dist/extension.js');
  assert.equal(manifest.engines.vscode, '^1.96.0');
  assert.deepEqual(manifest.contributes.configuration.properties['ueMaterialTranslator.shadingPath'].enum,
    ['preserve', 'deferred', 'forward', 'mobile']);
  assert.equal(manifest.contributes.configuration.properties['ueMaterialTranslator.shadingPath'].default, 'preserve');
  assert.deepEqual(manifest.contributes.configuration.properties['ueMaterialTranslator.staticParameters'].default, {});
  assert.equal(manifest.contributes.configuration.properties['ueMaterialTranslator.staticParameters'].additionalProperties.type, 'boolean');
  assert.ok(manifest.contributes.configuration.properties['ueMaterialTranslator.externalInputTypes'].additionalProperties.enum.includes('Texture3D'));
  assert.ok(fs.existsSync(path.join(path.dirname(extensionPath), '../', manifest.main)));
  for (const grammar of manifest.contributes.grammars) {
    const grammarFile = path.join(__dirname, '../packages/vscode', grammar.path);
    assert.equal(JSON.parse(fs.readFileSync(grammarFile, 'utf8')).scopeName, grammar.scopeName);
  }
  const app = harness();
  try {
    assert.deepEqual(manifest.contributes.commands.map(item => item.command).sort(), [...app.commands.keys()].sort());
  } finally { app.dispose(); }
});

test('VSCode empty inputs and invalid editor actions leave documents untouched; malformed settings fall back safely', async t => {
  const app = harness({ engineVersion: 'unknown', moduleStyle: 'unknown', shadingPath: 'unknown', externalInputTypes: null, moduleAssignments: null, staticParameters: null });
  t.after(() => app.dispose());
  await app.run('translateClipboard');
  assert.equal(app.shown.length, 0);
  await app.run('translateSelection');
  assert.equal(app.shown.length, 0);
  await app.openFile(single);
  await app.run('translateSelection');
  assert.equal(app.shown.length, 1);
  await app.run('translateDocument');
  assert.equal(app.messages.error.length, 0);
  assert.equal(app.api.window.activeTextEditor.document.getText(), translate(single).hlsl);
  const before = app.shown.length;
  await app.run('translateDocument');
  assert.equal(app.shown.length, before, 'generated HLSL must never be treated as copied material input');
});

test('VSCode manual module assignments pass string and null overrides to the real core', async t => {
  const annotated = fs.readFileSync(path.join(__dirname, '../docs/examples/annotated-mask.txt'), 'utf8');
  const baseline = translate(annotated, { moduleStyle: 'scopes' });
  const module = baseline.modules.find(item => item.name === 'Mask intensity');
  assert.ok(module?.nodeIds.length, 'annotated material must contain a module');
  const nodeId = module.nodeIds[0];
  const config = { moduleStyle: 'scopes', moduleAssignments: { [nodeId]: null, InvalidEntry: 42 } };
  const app = harness(config); t.after(() => app.dispose());
  app.clipboard = annotated;
  await app.run('translateClipboard');
  const withoutNode = translate(annotated, { moduleStyle: 'scopes', moduleAssignments: { [nodeId]: null } });
  assert.equal(app.api.window.activeTextEditor.document.getText(), withoutNode.hlsl);
  assert.notEqual(withoutNode.hlsl, baseline.hlsl, 'null override must change generated module grouping');
  config.moduleAssignments = { [nodeId]: module.id };
  await app.run('translateClipboard');
  assert.equal(app.api.window.activeTextEditor.document.getText(), translate(annotated, {
    moduleStyle: 'scopes', moduleAssignments: { [nodeId]: module.id }
  }).hlsl);
});

test('VSCode static parameter settings select actual branches and filter malformed values', async t => {
  const input = [expression('Constant', 'Detail', 'R=4'), expression('Constant', 'Simple', 'R=8'),
    expression('StaticSwitchParameter', 'Switch', 'ParameterName="Use detail"\nA=(Expression="Detail")\nB=(Expression="Simple")')].join('\n');
  for (const selected of [true, false]) {
    const app = harness({ staticParameters: { 'Use detail': selected, Invalid: 1, '': false } });
    t.after(() => app.dispose());
    app.clipboard = input;
    await app.run('translateClipboard');
    const actual = app.api.window.activeTextEditor.document.getText();
    assert.equal(actual, translate(input, { staticParameters: { 'Use detail': selected } }).hlsl);
    assert.match(actual, selected ? /4\.0/ : /8\.0/);
    assert.doesNotMatch(actual, selected ? /8\.0|#if UE_STATIC/ : /4\.0|#if UE_STATIC/);
    assert.deepEqual(app.messages.error, []);
  }
  for (const staticParameters of [null, [], 'bad', { 'Use detail': 'true' }]) {
    const app = harness({ staticParameters });
    t.after(() => app.dispose());
    app.clipboard = input;
    await app.run('translateClipboard');
    assert.equal(app.api.window.activeTextEditor.document.getText(), translate(input).hlsl);
    assert.deepEqual(app.messages.error, []);
  }
});

test('VSCode external input types retain Texture3D when passed to the bundled core', async t => {
  const input = expression('TextureProperty', 'TextureSize', 'TextureObject=(Expression="MissingVolume")');
  const app = harness({ externalInputTypes: { MissingVolume: 'Texture3D', Invalid: 'TextureCube' } });
  t.after(() => app.dispose());
  app.clipboard = input;
  await app.run('translateClipboard');
  const actual = app.api.window.activeTextEditor.document.getText();
  assert.equal(actual, translate(input, { externalInputs: { MissingVolume: 'Texture3D' } }).hlsl);
  assert.match(actual, /Texture3D/);
  assert.doesNotMatch(actual, /#error|UNRESOLVED/);
});
