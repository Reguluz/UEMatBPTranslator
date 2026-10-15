const test = require('node:test');
const assert = require('node:assert/strict');
const { translate } = require('../packages/core/dist');
const expression = (type, name, props = '') => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${name}"\n${props}\nEnd Object\n`;

test('sampling without an explicit view-bias contract is never silently simplified', () => {
  const result = translate(expression('TextureSample', 'Sample', "Texture=Texture2D'/Game/T.T'"));
  assert.equal(result.status, 'external-dependencies');
  assert.ok(result.inputs.some(input => input.name === 'EffectiveMaterialTextureMipBias' && input.kind === 'context'));
  assert.match(result.hlsl, /\.SampleBias\([^\n]+EffectiveMaterialTextureMipBias/);
  assert.doesNotMatch(result.hlsl, /^#error/m);
});

test('cube resources are not misrepresented as 2D samples or texture objects', () => {
  for (const type of ['TextureSample', 'TextureObject', 'TextureObjectParameter']) {
    const result = translate(expression(type, 'Cube', "Texture=TextureCube'/Game/T_Cube.T_Cube'\nAutomaticViewMipBias=False"), { outputs: ['Cube:0'] });
    assert.equal(result.status, 'unsupported', type);
    assert.ok(result.diagnostics.some(d => /维度|TextureCube/.test(d.message)), type);
  }
});

test('late symbol errors preserve one-based source mappings after the error guard', () => {
  const result = translate(expression('ScalarParameter', 'StrengthNode', 'ParameterName="Strength"\nDefaultValue=0.5'), { functionName: 'Strength' });
  assert.equal(result.status, 'unsupported');
  assert.match(result.hlsl, /^#error/m);
  const lines = result.hlsl.split('\n');
  for (const mapping of result.sourceMap) {
    assert.ok(mapping.generated.startLine >= 1);
    assert.ok(/Strength|result\./.test(lines[mapping.generated.startLine - 1]), lines[mapping.generated.startLine - 1]);
  }
});

test('resource ports cannot be selected as arithmetic results', () => {
  const result = translate(expression('TextureObjectParameter', 'Texture', "Texture=Texture2D'/Game/T.T'\nParameterName=Albedo"), { outputs: ['Texture:0'] });
  assert.equal(result.status, 'unsupported');
  assert.ok(result.diagnostics.some(d => d.code === 'RESOURCE_OUTPUT'));
});
