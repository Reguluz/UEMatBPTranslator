const esbuild = require('esbuild');
esbuild.build({ entryPoints: ['packages/vscode/src/extension.ts'], bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
  outfile: 'packages/vscode/dist/extension.js', sourcemap: true, logLevel: 'info'
}).catch(() => { process.exitCode = 1; });
