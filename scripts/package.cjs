const { createVSIX } = require('@vscode/vsce');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
(async () => {
  await mkdir('artifacts', { recursive: true });
  const version = require('../packages/vscode/package.json').version;
  const output = path.resolve(`artifacts/ue-material-translator-${version}.vsix`);
  await createVSIX({ cwd: path.resolve('packages/vscode'), packagePath: output,
    dependencies: false, allowMissingRepository: true, skipLicense: true });
  console.log(output);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
