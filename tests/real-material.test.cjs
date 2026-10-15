const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { translate, parseClipboard } = require('../packages/core/dist');

// Original, unmodified clipboard export supplied for the reported regression.
const source = fs.readFileSync(path.join(__dirname, 'fixtures/real/volumetric-cloud.blueprint.txt'), 'utf8');
const errors = result => result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');

function assertUsable(result) {
  assert.deepEqual(errors(result), []);
  assert.equal(result.outputs.length, 11, 'The four main outputs and seven advanced volume outputs must all survive.');
  assert.ok(result.outputs.every(output => output.type !== 'unknown'));
  assert.ok(!/UNRESOLVED|UNCONNECTED|unresolved type|#error UE_MATERIAL_TRANSLATION/.test(result.hlsl), 'Generated shader must have no unresolved expressions or incomplete-translation guard.');
  assert.ok(result.outputs.some(output => output.name === 'Volume_ConservativeDensity' && output.type === 'float4'));
  assert.equal(result.materialSettings.VolumetricAdvancedMaterialOutput.MultiScatteringApproximationOctaveCount, 2);
}

test('the original cloud export retains 298 graph objects, 281 algorithm nodes and all material outputs', () => {
  const parsed = parseClipboard(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.objects.length, 298);
  for (const engineVersion of ['5.5', '5.7']) {
    const result = translate(source, { engineVersion });
    assertUsable(result);
    assert.equal(result.stats.nodes, 281);
    assert.equal(result.diagnostics.filter(diagnostic => diagnostic.code === 'BUILTIN_FUNCTION_CONTRACT').length, 8);
    assert.ok(result.modules.some(module => module.name === 'Bypass on mobile'));
    assert.ok(result.modules.some(module => module.name === 'Lightning'));
    assert.ok(result.modules.some(module => module.name === 'Global Density Control'));
    assert.ok(result.modules.some(module => module.mode === 'function'));
    assert.ok(result.modules.some(module => ['scope', 'sections'].includes(module.mode)));
    assert.ok(result.inputs.some(input => input.name === 'VT_Lightning' && input.type === 'Texture3D'));
    assert.ok(result.inputs.some(input => input.name === 'Noise_Texture3D' && input.type === 'Texture3D'));
    assert.ok(result.inputs.some(input => input.name === 'VolumeSampleConservativeDensity' && input.type === 'float4'));
    assert.match(result.hlsl, /\.SampleLevel\(/);
    assert.match(result.hlsl, /UE_DecodeGrayscale\(/);
    assert.match(result.hlsl, /Volume_ConservativeDensity/);
    assert.ok(result.sourceMap.length > 0);
    const lines = source.split('\n').length;
    for (const mapping of result.sourceMap) {
      assert.ok(mapping.source.startLine >= 1 && mapping.source.endLine <= lines);
    }
  }
});

function findDxc() {
  const candidates = process.env.DXC_PATH ? [process.env.DXC_PATH] : ['dxc', 'C:/VulkanSDK/1.4.350.0/Bin/dxc.exe'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-help'], { encoding: 'utf8', timeout: 15000 });
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return candidate;
  }
}
const dxc = findDxc();

function pixelWrapper(result) {
  let textures = 0;
  let samplers = 0;
  const globals = result.inputs.map(input => {
    if (input.type === 'Texture2D' || input.type === 'Texture3D') return `${input.type} Test_${input.name} : register(t${textures++});`;
    if (input.type === 'SamplerState') return `SamplerState Test_${input.name} : register(s${samplers++});`;
    assert.match(input.type, /^(float[234]?|bool)$/);
    return `${input.type} Test_${input.name};`;
  });
  const fields = [...result.hlsl.match(/struct MaterialResult\s*\{([\s\S]*?)\};/)[1].matchAll(/\b(float[234]?|bool)\s+([A-Za-z_]\w*)\s*;/g)];
  assert.equal(fields.length, 11, 'The DXC entry point must consume every advanced and main material output.');
  const colors = fields.map(([, type, name]) => {
    const value = `computed.${name}`;
    if (type === 'float4') return value;
    if (type === 'float3') return `float4(${value}, 1.0)`;
    if (type === 'float2') return `float4(${value}, 0.0, 1.0)`;
    if (type === 'bool') return `(float4)(${value} ? 1.0 : 0.0)`;
    return `(float4)${value}`;
  });
  return `${result.hlsl}\n${globals.join('\n')}\nfloat4 PSMain() : SV_Target0\n{\n    MaterialResult computed = EvaluateMaterial(${result.inputs.map(input => `Test_${input.name}`).join(', ')});\n    return ${colors.join(' + ')};\n}\n`;
}

const paths = [
  { shadingPath: 'deferred' }, { shadingPath: 'forward' }, { shadingPath: 'mobile' },
  ...[0, 1, 2].map(macro => ({ shadingPath: 'preserve', macro })),
];
for (const engineVersion of ['5.5', '5.7']) for (const variant of paths) for (const useNoise3 of [undefined, false, true]) {
  const label = `DXC real cloud UE ${engineVersion}, ${variant.shadingPath}${variant.macro === undefined ? '' : `=${variant.macro}`}, UseNoise3=${useNoise3 === undefined ? 'preserved' : useNoise3}`;
  test(label, { skip: dxc ? false : 'DXC unavailable; install dxc or set DXC_PATH.' }, t => {
    const options = { engineVersion, shadingPath: variant.shadingPath };
    if (useNoise3 !== undefined) options.staticParameters = { UseNoise3: useNoise3 };
    const result = translate(source, options);
    assertUsable(result);
    const shader = pixelWrapper(result);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-real-cloud-dxc-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const shaderPath = path.join(directory, 'cloud.hlsl');
    const binaryPath = path.join(directory, 'cloud.dxil');
    fs.writeFileSync(shaderPath, shader);
    const args = ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-Od', '-Fo', binaryPath];
    if (variant.macro !== undefined) args.push(`-DUE_MATERIAL_SHADING_PATH=${variant.macro}`);
    args.push(shaderPath);
    const compilation = spawnSync(dxc, args, { encoding: 'utf8', timeout: 30000 });
    if (compilation.error) throw compilation.error;
    assert.equal(compilation.status, 0, `${label}\n${compilation.stdout}\n${compilation.stderr}`);
    assert.ok(fs.statSync(binaryPath).size > 0);
  });
}
