const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** Runs only inside an isolated VSCode Extension Development Host. */
exports.run = async function run() {
  const root = path.resolve(__dirname, '..');
  const resultFile = path.resolve(process.env.UE_MATERIAL_SMOKE_RESULT || path.join(root, 'artifacts/vscode-smoke/result.json'));
  const relative = path.relative(root, resultFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Smoke-test results must stay inside the workspace.');
  const result = { startedAt: new Date().toISOString(), status: 'running', checks: [] };
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  const persist = () => fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  persist();
  try {
    const extension = vscode.extensions.getExtension('local-tools.ue-material-translator');
    assert.ok(extension, 'development extension must be available');
    await extension.activate();
    result.checks.push('development extension activates');

    const commands = await vscode.commands.getCommands(true);
    for (const suffix of ['translateClipboard', 'translateDocument', 'translateSelection', 'selectOutputs', 'exportHlsl', 'revealSource']) {
      assert.ok(commands.includes(`ueMaterialTranslator.${suffix}`), `command ${suffix} must be registered`);
    }
    result.checks.push('all six commands register');

    const sample = fs.readFileSync(path.join(root, 'docs/examples/annotated-mask.txt'), 'utf8');
    const inputFile = path.join(path.dirname(resultFile), 'test-input.blueprint.txt');
    fs.writeFileSync(inputFile, sample);
    const input = await vscode.workspace.openTextDocument(vscode.Uri.file(inputFile));
    await vscode.window.showTextDocument(input, { preview: false });
    await vscode.commands.executeCommand('ueMaterialTranslator.translateDocument');
    const generated = vscode.window.activeTextEditor?.document;
    assert.ok(generated, 'generated document must be shown');
    assert.equal(generated.uri.scheme, 'ue-material-translator');
    assert.equal(generated.uri.authority, 'generated');
    assert.equal(generated.languageId, 'hlsl');
    const { translate } = require('../packages/core/dist');
    const expected = translate(sample);
    assert.equal(generated.getText(), expected.hlsl);
    assert.equal(fs.readFileSync(inputFile, 'utf8'), sample);
    const snapshot = vscode.workspace.textDocuments.find(document =>
      document.uri.scheme === 'ue-material-translator' && document.uri.authority === 'source');
    assert.ok(snapshot, 'read-only source snapshot must be open');
    assert.equal(snapshot.getText(), sample);
    assert.notEqual(vscode.workspace.fs.isWritableFileSystem(generated.uri.scheme), true);
    result.checks.push('translateDocument opens source snapshot and exact HLSL with read-only virtual scheme');

    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', generated.uri);
    assert.ok(symbols.some(symbol => symbol.name === 'Mask intensity'));
    result.checks.push('native document-symbol provider exposes module outline');

    const mapping = expected.sourceMap[0];
    assert.ok(mapping, 'sample must provide a source mapping');
    const at = new vscode.Position(mapping.generated.startLine - 1, 0);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', generated.uri, at);
    assert.ok(definitions.some(definition =>
      (definition.uri || definition.targetUri)?.toString() === input.uri.toString()));
    vscode.window.activeTextEditor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('ueMaterialTranslator.revealSource');
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), input.uri.toString());
    assert.equal(vscode.window.activeTextEditor.selection.start.line, mapping.source.startLine - 1);
    result.checks.push('native F12 provider and source command locate original material node');

    result.status = 'passed';
    result.finishedAt = new Date().toISOString();
    result.clipboardAccessed = false;
    result.userProfileModified = false;
    result.notes = 'Export cancel/path protection is covered by the isolated API regressions; this host test opens no save dialogs.';
    persist();
  } catch (error) {
    result.status = 'failed';
    result.finishedAt = new Date().toISOString();
    result.error = error instanceof Error ? error.stack : String(error);
    persist();
    throw error;
  }
};
