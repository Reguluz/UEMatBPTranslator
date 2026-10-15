const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { translate } = require('../packages/core/dist');

// Small cases isolate semantics present in the supplied real cloud material.
// Reference behavior is UE 5.5/5.7 MaterialExpressions.cpp, HLSLMaterialTranslator.cpp,
// BaseMaterialExpressions.ini and MaterialTexture.ush, not generated golden files.
const expr = (type, id, props = '') => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"\n${props}\nEnd Object\n`;
const link = (id, index = 0) => `(Expression="${id}",OutputIndex=${index})`;
const coordinate = expr('Constant3Vector', 'Coordinates', 'Constant=(R=0.2,G=0.4,B=0.8,A=0.0)');
const volume = (sampler = 'SAMPLERTYPE_LinearColor') => expr('TextureObjectParameter', 'VolumeResource', `ParameterName="CloudVolume"\nTexture="/Script/Engine.VolumeTexture'/Engine/EngineResources/DefaultVolumeTexture.DefaultVolumeTexture'"\nSamplerType=${sampler}`);
const sample = (props = '') => expr('TextureSample', 'Sample', `TextureObject=${link('VolumeResource')}\nCoordinates=${link('Coordinates')}\nMipValueMode=TMVM_MipLevel\nConstMipValue=2\nSamplerSource=SSM_Wrap_WorldGroupSettings\n${props}`);
const valid = result => assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), []);

test('volume resource dimensions survive named reroutes into explicit-LOD sampling in both UE profiles', () => {
  const source = volume() + coordinate
    + expr('NamedRerouteDeclaration', 'Declare', `Input=${link('VolumeResource')}\nName="Cloud volume"\nVariableGuid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
    + expr('NamedRerouteUsage', 'Use', 'Declaration="Declare"\nDeclarationGuid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    + expr('TextureSample', 'Sample', `TextureObject=${link('Use')}\nCoordinates=${link('Coordinates')}\nMipValueMode=TMVM_MipLevel\nConstMipValue=2\nSamplerSource=SSM_Wrap_WorldGroupSettings`);
  for (const engineVersion of ['5.5', '5.7']) {
    const result = translate(source, { engineVersion, outputs: ['Sample:5'] });
    valid(result);
    assert.equal(result.outputs[0].type, 'float4');
    assert.equal(result.inputs.find(input => input.name === 'CloudVolume').type, 'Texture3D');
    assert.match(result.hlsl, /\.SampleLevel\([^\n]+, 2\.0\)/);
    assert.ok(!result.inputs.some(input => /MaterialTextureMipBias|DerivativeMultiply/.test(input.name)));
  }
});

test('grayscale decode comes from the connected texture object and replicates red into every channel', () => {
  const result = translate(volume('SAMPLERTYPE_Grayscale') + coordinate + sample(), { outputs: ['Sample:5'] });
  valid(result);
  assert.match(result.hlsl, /UE_DecodeGrayscale\(/);
  assert.match(result.hlsl, /return gray\.xxxx;/);
  assert.match(result.hlsl, /gray \*= gray;/);
  assert.equal(result.inputs.find(input => input.name === 'GrayscaleManualSrgb').type, 'bool');
  assert.equal(result.inputs.find(input => input.name === 'GrayscaleUndoHardwareSrgb').type, 'bool');
});

test('linear grayscale also replicates red into alpha without the sRGB platform transform', () => {
  const result = translate(volume('SAMPLERTYPE_LinearGrayscale') + coordinate + sample(), { outputs: ['Sample:4'] });
  valid(result);
  assert.equal(result.outputs[0].type, 'float');
  assert.match(result.hlsl, /\.rrrr/);
  assert.doesNotMatch(result.hlsl, /UE_DecodeGrayscale/);
});

test('volume sampling requires coordinates as UE does', () => {
  const result = translate(volume() + expr('TextureSample', 'Sample', `TextureObject=${link('VolumeResource')}`), { outputs: ['Sample'] });
  assert.ok(result.diagnostics.some(d => d.severity === 'error' && d.message.includes('UVW')));
});

test('partial copies infer missing volume coordinates as a float3 external input', () => {
  const result = translate(volume() + sample().replace(link('Coordinates'), link('AbsentCoordinates')), { outputs: ['Sample'] });
  valid(result);
  assert.ok(result.inputs.some(input => input.kind === 'external' && input.type === 'float3'));
});

test('cloud altitude and shadow-distance ports are four scalar renderer inputs', () => {
  const result = translate(expr('CloudSampleAttribute', 'Cloud'), { outputs: ['Cloud:0', 'Cloud:1', 'Cloud:2', 'Cloud:3'] });
  valid(result);
  assert.deepEqual(result.outputs.map(output => output.type), ['float', 'float', 'float', 'float']);
  for (const name of ['Altitude', 'AltitudeInLayer', 'NormAltitudeInLayer', 'ShadowSampleDistance']) {
    assert.ok(result.inputs.some(input => input.name === `CloudSample${name}` && input.type === 'float' && input.source.includes('UE volume renderer context')));
  }
});

test('VolumetricAdvancedMaterialInput returns xyz and xyzw of the same cached float4 density', () => {
  const result = translate(expr('VolumetricAdvancedMaterialInput', 'VolumeContext'), { outputs: ['VolumeContext:0', 'VolumeContext:1'] });
  valid(result);
  assert.deepEqual(result.outputs.map(output => output.type), ['float3', 'float4']);
  assert.equal(result.inputs.filter(input => input.name === 'VolumeSampleConservativeDensity').length, 1);
  assert.equal(result.inputs.find(input => input.name === 'VolumeSampleConservativeDensity').type, 'float4');
  assert.match(result.hlsl, /VolumeSampleConservativeDensity\)\.xyz/);
});

test('TextureProperty has three size components for volume textures and two for 2D textures', () => {
  for (const [resource, expected] of [[volume(), 'float3'], [expr('TextureObjectParameter', 'VolumeResource', 'ParameterName="Map"\nTexture="/Script/Engine.Texture2D\'/Game/Map.Map\'"'), 'float2']]) {
    const result = translate(resource + expr('TextureProperty', 'Size', `TextureObject=${link('VolumeResource')}`), { outputs: ['Size'] });
    valid(result);
    assert.equal(result.outputs[0].type, expected);
    assert.match(result.hlsl, expected === 'float3' ? /GetDimensions\(width, height, depth\)/ : /GetDimensions\(width, height\)/);
  }
});

test('texel size uses the reciprocal of each texture dimension', () => {
  const result = translate(volume() + expr('TextureProperty', 'Texel', `TextureObject=${link('VolumeResource')}\nProperty=TMTM_TexelSize`), { outputs: ['Texel'] });
  valid(result);
  assert.equal(result.outputs[0].type, 'float3');
  assert.match(result.hlsl, /1\.0 \/ UE_TextureSize3D\(/);
});

const mapSample = props => expr('TextureSampleParameter2D', 'Map', `ParameterName="Map"\nTexture="/Script/Engine.Texture2D'/Game/Map.Map'"\nSamplerType=SAMPLERTYPE_LinearColor\n${props}`);

test('omitted AutomaticViewMipBias uses UE true default and preserves effective renderer bias', () => {
  const result = translate(mapSample(''), { outputs: ['Map'] });
  valid(result);
  assert.match(result.hlsl, /\.SampleBias\([^\n]+EffectiveMaterialTextureMipBias/);
  assert.equal(result.inputs.find(input => input.name === 'EffectiveMaterialTextureMipBias').type, 'float');
});

test('asset sampler explicit LOD receives automatic view bias but volume sampling never does', () => {
  const result = translate(mapSample('MipValueMode=TMVM_MipLevel\nConstMipValue=3'), { outputs: ['Map'] });
  valid(result);
  assert.match(result.hlsl, /\.SampleLevel\([^\n]+\(3\.0 \+ EffectiveMaterialTextureMipBias\)\)/);
  const plain = translate(mapSample('AutomaticViewMipBias=False'), { outputs: ['Map'] });
  valid(plain);
  assert.match(plain.hlsl, /\.Sample\(/);
  assert.ok(!plain.inputs.some(input => input.name === 'EffectiveMaterialTextureMipBias'));
});

test('named sample parameters follow their own Compile path and use the view-bias property', () => {
  const source = expr('StaticBool', 'EnableBias', 'Value=True')
    + mapSample(`AutomaticViewMipBias=False\nAutomaticViewMipBiasValue=${link('EnableBias')}`);
  const result = translate(source, { outputs: ['Map'] });
  valid(result);
  assert.match(result.hlsl, /\.Sample\(/);
  assert.ok(!result.inputs.some(input => input.name === 'EffectiveMaterialTextureMipBias'));
});

test('shared sampling preserves the UE selected sampler contract without adding manual bias twice', () => {
  const result = translate(mapSample('SamplerSource=SSM_Wrap_WorldGroupSettings'), { outputs: ['Map'] });
  valid(result);
  assert.match(result.hlsl, /\.Sample\(/);
  assert.ok(!result.inputs.some(input => input.name === 'EffectiveMaterialTextureMipBias'));
  assert.ok(result.inputs.some(input => input.type === 'SamplerState' && input.source.includes('including per-view mip bias')));
});

test('named sample parameters without a serialized default texture keep their own resource identity', () => {
  const source = expr('TextureObject', 'LiteralTexture', 'Texture="/Script/Engine.Texture2D\'/Game/Cloud.Cloud\'"')
    + expr('TextureSample', 'LiteralSample', `TextureObject=${link('LiteralTexture')}\nAutomaticViewMipBias=False`)
    + expr('TextureSampleParameter2D', 'NamedSample', 'ParameterName="Cloud"\nAutomaticViewMipBias=False');
  const result = translate(source, { outputs: ['LiteralSample', 'NamedSample'] });
  valid(result);
  const textures = result.inputs.filter(input => input.type === 'Texture2D');
  assert.equal(textures.length, 2);
  assert.notEqual(textures[0].name, textures[1].name);
});

const dxcCandidates = process.env.DXC_PATH ? [process.env.DXC_PATH] : ['dxc', 'C:/VulkanSDK/1.4.350.0/Bin/dxc.exe'];
const dxc = dxcCandidates.find(candidate => spawnSync(candidate, ['-help'], { encoding: 'utf8', timeout: 15000 }).status === 0);
test('volume sampling, dimensions, grayscale decode and volume context produce valid standalone DXIL', { skip: dxc ? false : 'DXC unavailable' }, t => {
  const result = translate(volume('SAMPLERTYPE_Grayscale') + coordinate + sample()
    + expr('TextureProperty', 'Size', `TextureObject=${link('VolumeResource')}`)
    + expr('VolumetricAdvancedMaterialInput', 'Density'), { outputs: ['Sample:5', 'Size', 'Density:1'] });
  valid(result);
  const globals = result.inputs.map((input, index) => `${input.type} Test_${input.name}${input.type.startsWith('Texture') ? ` : register(t${index})` : input.type === 'SamplerState' ? ` : register(s${index})` : ''};`).join('\n');
  const fields = [...result.hlsl.match(/struct MaterialResult\s*\{([\s\S]*?)\};/)[1].matchAll(/\b(float[234]?)\s+([A-Za-z_]\w*)\s*;/g)];
  assert.equal(fields.length, 3);
  const colors = fields.map(([, type, name]) => type === 'float4' ? `result.${name}` : type === 'float3' ? `float4(result.${name}, 1.0)` : type === 'float2' ? `float4(result.${name}, 0.0, 1.0)` : `(float4)result.${name}`);
  const material = result.hlsl + '\n' + globals + `\nfloat4 PSMain() : SV_Target0\n{\n    MaterialResult result = EvaluateMaterial(${result.inputs.map(input => `Test_${input.name}`).join(', ')});\n    return ${colors.join(' + ')};\n}\n`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-volume-dxc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'volume.hlsl');
  fs.writeFileSync(input, material);
  const compilation = spawnSync(dxc, ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-Od', '-Fo', path.join(directory, 'volume.dxil'), input], { encoding: 'utf8', timeout: 30000 });
  assert.equal(compilation.status, 0, `${compilation.stdout}\n${compilation.stderr}\n${material}`);
});
