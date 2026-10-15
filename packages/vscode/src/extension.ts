import * as vscode from 'vscode';
import { translate, type TranslationOptions, type TranslationResult, type ValueType } from '@ue-material-translator/core';

const SCHEME = 'ue-material-translator';
const COMMAND_PREFIX = 'ueMaterialTranslator';

interface InputSnapshot {
  text: string;
  name: string;
  originalDocument?: vscode.TextDocument;
  originalVersion?: number;
  origin: vscode.Position;
}

interface Session {
  id: string;
  input: InputSnapshot;
  options: TranslationOptions;
  result: TranslationResult;
  sourceUri: vscode.Uri;
  outputUri: vscode.Uri;
}

interface OutputPick extends vscode.QuickPickItem {
  outputId: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new TranslatorController();
  context.subscriptions.push(controller);
  controller.register(context);
}

class TranslatorController implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(COMMAND_PREFIX);
  private readonly output = vscode.window.createOutputChannel('UE Material Translator');
  private nextId = 1;
  private lastSession?: Session;

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.changed.event,
        provideTextDocumentContent: uri => {
          const session = this.findSession(uri);
          return session ? (uri.authority === 'source' ? session.input.text : session.result.hlsl) : '';
        }
      }),
      vscode.languages.registerDefinitionProvider({ scheme: SCHEME, language: 'hlsl' }, {
        provideDefinition: async (document, position) => {
          const session = this.findSession(document.uri);
          if (!session) return undefined;
          const mapping = this.mappingAt(session, position.line);
          if (!mapping) return undefined;
          const target = await this.sourceTarget(session);
          return new vscode.Location(target.document.uri,
            this.sourceRange(session, mapping.source.startLine, mapping.source.endLine, target.document, target.original));
        }
      }),
      vscode.languages.registerDocumentSymbolProvider({ scheme: SCHEME, language: 'hlsl' }, {
        provideDocumentSymbols: document => this.moduleSymbols(document)
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        const session = editor && this.findSession(editor.document.uri);
        if (session) {
          this.lastSession = session;
          void this.refreshDiagnostics(session);
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.lastSession?.input.originalDocument?.uri.toString() === event.document.uri.toString()) {
          void this.refreshDiagnostics(this.lastSession);
        }
      })
    );

    this.command(context, 'translateClipboard', async () => {
      const text = await vscode.env.clipboard.readText();
      await this.createSession({ text, name: 'Clipboard', origin: new vscode.Position(0, 0) });
    });
    this.command(context, 'translateDocument', async () => {
      const editor = this.inputEditor();
      if (!editor) return;
      await this.createSession({
        text: editor.document.getText(), name: this.documentName(editor.document),
        originalDocument: editor.document, originalVersion: editor.document.version,
        origin: new vscode.Position(0, 0)
      });
    });
    this.command(context, 'translateSelection', async () => {
      const editor = this.inputEditor();
      if (!editor) return;
      if (editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('请先选择材质节点文本，再执行翻译选区。');
        return;
      }
      await this.createSession({
        text: editor.document.getText(editor.selection), name: this.documentName(editor.document),
        originalDocument: editor.document, originalVersion: editor.document.version,
        origin: editor.selection.start
      });
    });
    this.command(context, 'selectOutputs', async () => {
      const session = this.currentSession();
      if (!session) return;
      const selected = await this.pickOutputs(session.result);
      if (!selected) return;
      session.options = { ...session.options, outputs: selected };
      session.result = translate(session.input.text, session.options);
      this.changed.fire(session.outputUri);
      await this.refreshDiagnostics(session);
      this.report(session);
    });
    this.command(context, 'exportHlsl', async () => {
      const session = this.currentSession();
      if (!session) return;
      const originalUri = session.input.originalDocument?.uri;
      const defaultUri = originalUri && originalUri.scheme === 'file'
        ? vscode.Uri.joinPath(originalUri, '..', `${session.input.name.replace(/\.[^.]+$/, '')}.hlsl`)
        : vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'Material.hlsl')
          : undefined;
      const uri = await vscode.window.showSaveDialog({
        defaultUri, filters: { HLSL: ['hlsl'] }, saveLabel: '保存 HLSL',
        title: '保存材质算法'
      });
      if (!uri) return;
      const sameFile = originalUri?.scheme === 'file' && uri.scheme === 'file' &&
        (process.platform === 'win32'
          ? originalUri.fsPath.toLowerCase() === uri.fsPath.toLowerCase()
          : originalUri.fsPath === uri.fsPath);
      if (sameFile || originalUri?.toString() === uri.toString()) {
        void vscode.window.showErrorMessage('请选择不同的输出文件，以保留原始节点文本。');
        return;
      }
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(session.result.hlsl));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    });
    this.command(context, 'revealSource', async () => {
      const editor = vscode.window.activeTextEditor;
      const session = editor && this.findSession(editor.document.uri);
      if (!editor || !session || editor.document.uri.authority !== 'generated') {
        void vscode.window.showInformationMessage('请在生成的 HLSL 中选择一行，再跳转到原始节点。');
        return;
      }
      const mapping = this.mappingAt(session, editor.selection.active.line);
      if (!mapping) {
        void vscode.window.showInformationMessage('这一行没有对应的原始节点；请在算法语句上重试。');
        return;
      }
      const target = await this.sourceTarget(session);
      const range = this.sourceRange(session, mapping.source.startLine, mapping.source.endLine,
        target.document, target.original);
      const sourceEditor = await vscode.window.showTextDocument(target.document, {
        viewColumn: vscode.ViewColumn.One, preview: false, selection: range
      });
      sourceEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    });
  }

  dispose(): void {
    this.changed.dispose();
    this.diagnostics.dispose();
    this.output.dispose();
  }

  private command(context: vscode.ExtensionContext, suffix: string, handler: () => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(`${COMMAND_PREFIX}.${suffix}`, async () => {
      try {
        await handler();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(message);
        void vscode.window.showErrorMessage(`材质翻译失败：${message}`);
      }
    }));
  }

  private inputEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme === SCHEME) {
      void vscode.window.showInformationMessage('请先打开包含原始材质节点文本的文件。');
      return undefined;
    }
    return editor;
  }

  private documentName(document: vscode.TextDocument): string {
    return document.uri.path.split('/').pop() || 'Material';
  }

  private readOptions(): TranslationOptions {
    const config = vscode.workspace.getConfiguration(COMMAND_PREFIX);
    const version = config.get<string>('engineVersion', '5.7');
    const style = config.get<string>('moduleStyle', 'auto');
    const shadingPath = config.get<string>('shadingPath', 'preserve');
    const configuredTypes = config.get<unknown>('externalInputTypes', {});
    const supportedTypes = new Set(['float', 'float2', 'float3', 'float4', 'bool', 'Texture2D', 'Texture3D', 'SamplerState']);
    const entries = configuredTypes && typeof configuredTypes === 'object' && !Array.isArray(configuredTypes)
      ? Object.entries(configuredTypes) : [];
    const externalInputs = Object.fromEntries(entries
      .filter((entry): entry is [string, ValueType] => typeof entry[1] === 'string' && supportedTypes.has(entry[1])));
    const configuredAssignments = config.get<unknown>('moduleAssignments', {});
    const assignmentEntries = configuredAssignments && typeof configuredAssignments === 'object' && !Array.isArray(configuredAssignments)
      ? Object.entries(configuredAssignments) : [];
    const moduleAssignments = Object.fromEntries(assignmentEntries
      .filter((entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null));
    const configuredStaticParameters = config.get<unknown>('staticParameters', {});
    const staticEntries = configuredStaticParameters && typeof configuredStaticParameters === 'object' && !Array.isArray(configuredStaticParameters)
      ? Object.entries(configuredStaticParameters) : [];
    const staticParameters = Object.fromEntries(staticEntries
      .filter((entry): entry is [string, boolean] => entry[0].trim().length > 0 && typeof entry[1] === 'boolean'));
    return {
      engineVersion: version === '5.5' ? '5.5' : '5.7',
      moduleStyle: style === 'scopes' || style === 'functions' ? style : 'auto',
      shadingPath: shadingPath === 'deferred' || shadingPath === 'forward' || shadingPath === 'mobile'
        ? shadingPath : 'preserve',
      externalInputs,
      moduleAssignments,
      staticParameters
    };
  }

  private async createSession(input: InputSnapshot): Promise<void> {
    if (!input.text.trim()) {
      void vscode.window.showInformationMessage('输入为空，请先复制或打开材质节点文本。');
      return;
    }
    const options = this.readOptions();
    const result = translate(input.text, options);
    const id = String(this.nextId++);
    const session: Session = {
      id, input, options, result,
      sourceUri: vscode.Uri.from({ scheme: SCHEME, authority: 'source', path: `/${id}/${input.name}.blueprint.txt` }),
      outputUri: vscode.Uri.from({ scheme: SCHEME, authority: 'generated', path: `/${id}/${input.name.replace(/\.[^.]+$/, '')}.hlsl` })
    };
    this.sessions.set(id, session);
    this.lastSession = session;
    const sourceDocument = await vscode.workspace.openTextDocument(session.sourceUri);
    await vscode.window.showTextDocument(sourceDocument, { viewColumn: vscode.ViewColumn.One, preview: false });
    let outputDocument = await vscode.workspace.openTextDocument(session.outputUri);
    if (outputDocument.languageId !== 'hlsl') {
      outputDocument = await vscode.languages.setTextDocumentLanguage(outputDocument, 'hlsl');
    }
    await vscode.window.showTextDocument(outputDocument, { viewColumn: vscode.ViewColumn.Two, preview: false });
    await this.refreshDiagnostics(session);
    this.report(session);
  }

  private async pickOutputs(result: TranslationResult): Promise<string[] | undefined> {
    if (!result.candidates.length) {
      void vscode.window.showInformationMessage('没有可选择的算法输出，请查看 Problems 中的诊断。');
      return undefined;
    }
    const defaults = new Set(result.outputs.map(output => output.id));
    const items: OutputPick[] = result.candidates.map(candidate => ({
      label: candidate.name,
      description: candidate.type,
      detail: `${candidate.nodeId} · 输出端口 ${candidate.outputIndex}`,
      outputId: candidate.id,
      picked: defaults.has(candidate.id)
    }));
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true, title: '选择一个或多个材质算法输出',
      placeHolder: '勾选希望保留的末端；取消将保留此前结果', ignoreFocusOut: true
    });
    if (!selected) return undefined;
    if (!selected.length) {
      void vscode.window.showInformationMessage('至少需要一个输出；此前结果已保留。');
      return undefined;
    }
    return selected.map(item => item.outputId);
  }

  private findSession(uri: vscode.Uri): Session | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    const id = uri.path.split('/')[1];
    return id ? this.sessions.get(id) : undefined;
  }

  private currentSession(): Session | undefined {
    const editor = vscode.window.activeTextEditor;
    const session = (editor && this.findSession(editor.document.uri)) || this.lastSession;
    if (!session) void vscode.window.showInformationMessage('请先翻译一段材质节点文本。');
    return session;
  }

  private mappingAt(session: Session, line: number): TranslationResult['sourceMap'][number] | undefined {
    return session.result.sourceMap
      .filter(mapping => mapping.generated.startLine <= line + 1 && mapping.generated.endLine >= line + 1)
      .sort((left, right) =>
        (left.generated.endLine - left.generated.startLine) - (right.generated.endLine - right.generated.startLine))[0];
  }

  private async sourceTarget(session: Session): Promise<{ document: vscode.TextDocument; original: boolean }> {
    const document = session.input.originalDocument;
    if (document && !document.isClosed && document.version === session.input.originalVersion) {
      return { document, original: true };
    }
    return { document: await vscode.workspace.openTextDocument(session.sourceUri), original: false };
  }

  private sourceRange(session: Session, startLine: number, endLine: number,
    document: vscode.TextDocument, original: boolean): vscode.Range {
    const lines = session.input.text.split(/\r?\n/);
    const relativeStart = Math.max(0, Math.min(lines.length - 1, startLine - 1));
    const relativeEnd = Math.max(relativeStart, Math.min(lines.length - 1, endLine - 1));
    const offset = original ? session.input.origin : new vscode.Position(0, 0);
    const start = new vscode.Position(offset.line + relativeStart, relativeStart === 0 ? offset.character : 0);
    const end = new vscode.Position(offset.line + relativeEnd,
      (relativeEnd === 0 ? offset.character : 0) + (lines[relativeEnd]?.length || 0));
    return document.validateRange(new vscode.Range(start, end));
  }

  private async refreshDiagnostics(session: Session): Promise<void> {
    const target = await this.sourceTarget(session);
    if (this.lastSession !== session) return;
    const severity = {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      info: vscode.DiagnosticSeverity.Information
    };
    const items = session.result.diagnostics.map(item => {
      const range = this.sourceRange(session, item.range?.startLine || 1,
        item.range?.endLine || item.range?.startLine || 1, target.document, target.original);
      const diagnostic = new vscode.Diagnostic(range, item.message, severity[item.severity]);
      diagnostic.code = item.code;
      diagnostic.source = 'UE Material Translator';
      return diagnostic;
    });
    this.diagnostics.clear();
    this.diagnostics.set(target.document.uri, items);
  }

  private moduleSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const session = this.findSession(document.uri);
    if (!session) return [];
    return session.result.modules.flatMap(module => {
      const mappings = session.result.sourceMap.filter(mapping => mapping.moduleId === module.id);
      if (!mappings.length) return [];
      const first = Math.min(...mappings.map(mapping => mapping.generated.startLine));
      const last = Math.max(...mappings.map(mapping => mapping.generated.endLine));
      const start = new vscode.Position(Math.max(0, Math.min(document.lineCount - 1, first - 1)), 0);
      const endLine = Math.max(start.line, Math.min(document.lineCount - 1, last - 1));
      const range = new vscode.Range(start, document.lineAt(endLine).range.end);
      const kind = module.mode === 'function' ? vscode.SymbolKind.Function : vscode.SymbolKind.Namespace;
      return [new vscode.DocumentSymbol(module.name, module.reason || module.mode, kind, range,
        new vscode.Range(start, document.lineAt(start.line).range.end))];
    });
  }

  private report(session: Session): void {
    const statuses: Record<TranslationResult['status'], string> = {
      complete: '完整转换',
      'external-dependencies': '带外部依赖',
      unsupported: '存在未知或未支持的语义'
    };
    const summary = `UE ${session.result.engineVersion} · ${statuses[session.result.status]} · ${session.result.diagnostics.length} 条诊断`;
    this.output.appendLine(`${session.input.name}: ${summary}`);
    const original = session.input.originalDocument;
    const useOriginal = original && !original.isClosed && original.version === session.input.originalVersion;
    const source = useOriginal ? original.uri.fsPath : `${session.input.name}（只读原文快照）`;
    const offset = useOriginal ? session.input.origin.line : 0;
    for (const diagnostic of session.result.diagnostics) {
      const startLine = (diagnostic.range?.startLine || 1) + offset;
      const endLine = (diagnostic.range?.endLine || diagnostic.range?.startLine || 1) + offset;
      const line = endLine === startLine ? String(startLine) : `${startLine}-${endLine}`;
      this.output.appendLine(`[${diagnostic.severity}] ${diagnostic.code} | 节点 ${diagnostic.nodeId || '解析/图级'} | ${source}:${line}`);
      this.output.appendLine(diagnostic.message);
    }
    vscode.window.setStatusBarMessage(`UE Material: ${summary}`, 12000);
    if (session.result.status !== 'complete') {
      const message = session.result.status === 'unsupported'
        ? `材质未完整转换：${summary}。生成代码含未解析内容，请查看诊断原因。`
        : `材质翻译包含外部依赖：${summary}。请查看诊断和生成代码中的依赖说明。`;
      void vscode.window.showWarningMessage(message, '查看诊断', '打开 Problems')
        .then(action => {
          if (action === '查看诊断') this.output.show();
          else if (action === '打开 Problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
        });
    }
  }
}
