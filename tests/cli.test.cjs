const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const sample = path.join(root, 'docs/examples/annotated-mask.txt');
function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: 'utf8' });
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-material-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CLI help and argument errors are usable without reading stdin', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--engine 5\.5\|5\.7/);
  for (const args of [['--unknown'], ['--engine', '5.4'], ['--out'], ['a', 'b'], ['--module-style', 'invalid'], ['--input-type', 'missing=matrix'], ['--module', 'missing']]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stderr.length > 0);
  }
});

test('CLI shading-path option selects a concrete algorithm or preserves explicit variants', () => {
  const input = 'Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="Desktop"\nR=4\nEnd Object\n'
    + 'Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="Mobile"\nR=8\nEnd Object\n'
    + "Begin Object Class=/Script/Engine.MaterialExpressionShadingPathSwitch Name=\"Switch\"\nDefault=(Expression=MaterialExpression'Desktop')\nInputs(2)=(Expression=MaterialExpression'Mobile')\nEnd Object\n";
  const deferred = run(['--shading-path', 'deferred', '--strict'], input);
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.match(deferred.stdout, /4\.0/);
  assert.doesNotMatch(deferred.stdout, /8\.0|UE_MATERIAL_SHADING_PATH|UNRESOLVED/);
  const preserve = run(['--shading-path', 'preserve', '--strict'], input);
  assert.equal(preserve.status, 1);
  assert.match(preserve.stdout, /#if UE_MATERIAL_SHADING_PATH/);
  assert.match(preserve.stdout, /4\.0/);
  assert.match(preserve.stdout, /8\.0/);
  assert.equal(run(['--shading-path', 'desktop'], input).status, 2);
});

test('CLI translates files and stdin identically and writes a complete JSON report', (t) => {
  const dir = temporary(t);
  const out = path.join(dir, 'material.hlsl');
  const report = path.join(dir, 'report.json');
  const result = run([sample, '--engine', '5.5', '--out', out, '--report', report]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const payload = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(payload.engineVersion, '5.5');
  assert.equal(payload.status, 'complete');
  assert.equal(payload.hlsl, fs.readFileSync(out, 'utf8'));
  assert.ok(payload.outputs.length > 0);
  const stdin = run(['-', '--engine', '5.5'], '\uFEFF' + fs.readFileSync(sample, 'utf8'));
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(stdin.stdout, payload.hlsl);
});

test('CLI lists candidate IDs that can be selected for generation', () => {
  const listing = run([sample, '--list-outputs']);
  assert.equal(listing.status, 0, listing.stderr);
  const candidates = JSON.parse(listing.stdout);
  assert.ok(candidates.length > 0);
  const selection = run([sample, '--output', candidates[0].id, '--module-style', 'scopes']);
  assert.equal(selection.status, 0, selection.stderr);
  assert.match(selection.stdout, /float/);
});

test('CLI refuses direct, alias, and hard-link input overwrites before writing', (t) => {
  const dir = temporary(t);
  const input = path.join(dir, 'input.txt');
  const original = fs.readFileSync(sample, 'utf8');
  fs.writeFileSync(input, original);
  const alias = path.join(dir, 'alias.txt');
  fs.linkSync(input, alias);
  for (const args of [[input, '--out', input], [input, '--report', path.join(dir, '.', 'input.txt')], [input, '--out', alias]]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /overwrite input/);
    assert.equal(fs.readFileSync(input, 'utf8'), original);
  }
});

test('CLI rejects colliding report and shader paths', (t) => {
  const dir = temporary(t);
  const destination = path.join(dir, 'same.txt');
  const result = run([sample, '--out', destination, '--report', destination]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /different files/);
  assert.equal(fs.existsSync(destination), false);
});

test('CLI reports unsupported input as failure while preserving a reviewable report', (t) => {
  const dir = temporary(t);
  const report = path.join(dir, 'invalid.json');
  const result = run(['--report', report], 'Begin Object Class=/Script/Engine.MaterialExpressionNotSupported Name="Unknown_0"\nEnd Object\n');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).status, 'unsupported');
  assert.match(result.stderr, /unsupported/i);
});

test('CLI allows typed external inputs but strict mode rejects incomplete results', (t) => {
  const dir = temporary(t);
  const report = path.join(dir, 'external.json');
  const input = `Begin Object Class=/Script/Engine.MaterialExpressionAdd Name="MaterialExpressionAdd_0"
  A=(Expression=MaterialExpressionScalarParameter'MissingParameter')
  ConstB=1.0
End Object
`;
  const options = ['--input-type', 'MissingParameter=float', '--report', report];
  const ordinary = run(options, input);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).status, 'external-dependencies');
  const strict = run([...options, '--strict'], input);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /strict mode/);
});

test('CLI can override individual module assignments or remove grouping', (t) => {
  const dir = temporary(t);
  const report = path.join(dir, 'modules.json');
  const ungrouped = run([sample, '--module', 'MaterialExpressionMultiply_0=-', '--report', report]);
  assert.equal(ungrouped.status, 0, ungrouped.stderr);
  const ungroupedResult = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.ok(ungroupedResult.modules.length > 0);
  assert.ok(ungroupedResult.modules.every(module => !module.nodeIds.includes('MaterialExpressionMultiply_0')));
  const grouped = run([sample, '--module', 'MaterialExpressionMultiply_0=MaterialExpressionComment_0', '--report', report]);
  assert.equal(grouped.status, 0, grouped.stderr);
  const groupedResult = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.ok(groupedResult.modules.some(module => module.id === 'MaterialExpressionComment_0' && module.nodeIds.includes('MaterialExpressionMultiply_0')));
});

test('CLI loads static parameter boolean overrides by their real ParameterName', t => {
  const dir = temporary(t);
  const config = path.join(dir, 'static.json');
  const input = 'Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="Detail"\nR=4\nEnd Object\n'
    + 'Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="Simple"\nR=8\nEnd Object\n'
    + 'Begin Object Class=/Script/Engine.MaterialExpressionStaticSwitchParameter Name="Switch"\nParameterName="Use detail"\nA=(Expression="Detail")\nB=(Expression="Simple")\nEnd Object';
  for (const selected of [true, false]) {
    fs.writeFileSync(config, '\uFEFF' + JSON.stringify({ 'Use detail': selected }));
    const result = run(['--static-parameters', config, '--strict'], input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, selected ? /4\.0/ : /8\.0/);
    assert.doesNotMatch(result.stdout, selected ? /8\.0|#if UE_STATIC/ : /4\.0|#if UE_STATIC/);
  }
});

test('CLI rejects malformed static configuration and protects the configuration file', t => {
  const dir = temporary(t);
  const config = path.join(dir, 'static.json');
  for (const value of ['null', '[]', 'true', '{"UseDetail":1}', '{"UseDetail":"true"}', '{"":true}', '{']) {
    fs.writeFileSync(config, value);
    const result = run([sample, '--static-parameters', config]);
    assert.equal(result.status, 2, value + ': ' + result.stderr);
    assert.equal(result.stdout, '');
  }
  fs.writeFileSync(config, '{"UseDetail":true}');
  for (const destinationOption of ['--out', '--report']) {
    const result = run([sample, '--static-parameters', config, destinationOption, config]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /overwrite static parameter file/);
    assert.equal(fs.readFileSync(config, 'utf8'), '{"UseDetail":true}');
  }
  assert.equal(run(['--static-parameters']).status, 2);
  assert.equal(run([sample, '--static-parameters', config, '--static-parameters', config]).status, 2);
  assert.equal(run(['--help', '--static-parameters', path.join(dir, 'absent.json')]).status, 0);
});

test('CLI external inputs accept Texture3D and preserve its resource type', t => {
  const dir = temporary(t);
  const report = path.join(dir, 'volume.json');
  const input = 'Begin Object Class=/Script/Engine.MaterialExpressionTextureProperty Name="TextureSize"\nTextureObject=(Expression="MissingVolume")\nEnd Object';
  const result = run(['--input-type', 'MissingVolume=Texture3D', '--report', report], input);
  assert.equal(result.status, 0, result.stderr);
  const translated = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(translated.status, 'external-dependencies');
  assert.equal(translated.inputs.find(input => input.source === 'MissingVolume:0').type, 'Texture3D');
  assert.match(result.stdout, /Texture3D/);
  assert.doesNotMatch(result.stdout, /#error|UNRESOLVED/);
});
