const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { translate } = require('../packages/core/dist');
const { parseClipboard } = require('../packages/core/dist/parser');
const { buildGraph } = require('../packages/core/dist/graph');

const expression = (type, properties = '') => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="Source"
${properties}
End Object`;
const vector = properties => expression('VectorParameter', `ParameterName="Tint"\n${properties}`);
const complete = result => assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));

test('renaming VectorParameter outputs preserves inherited channel masks and removes RGBA', () => {
  const text = vector('Outputs(0)=(OutputName="Color")\nOutputs(1)=(OutputName="Red")\nOutputs(2)=(OutputName="Green")\nOutputs(3)=(OutputName="Blue")\nOutputs(4)=(OutputName="Occlusion")\nOutputs.RemoveIndex(5)');
  for (const engineVersion of ['5.5', '5.7']) {
    const result = translate(text, { engineVersion, outputs: [0, 1, 2, 3, 4].map(index => `Source:${index}`) });
    complete(result);
    assert.deepEqual(result.outputs.map(output => output.type), ['float3', 'float', 'float', 'float', 'float']);
    assert.deepEqual(result.candidates.map(output => output.type), ['float3', 'float', 'float', 'float', 'float']);
    assert.equal(result.candidates.length, 5);
    assert.match(result.hlsl, /Tint\.(?:rgb|xyz)/);
    for (const component of ['r', 'g', 'b', 'a']) assert.match(result.hlsl, new RegExp(`Tint\\.(?:${component}|${{ r: 'x', g: 'y', b: 'z', a: 'w' }[component]})\\b`));
    assert.ok(result.outputs.at(-1).name.endsWith('_Occlusion'));
  }
});

test('partial mask channel overrides merge with the class default mask in selected and unselected ports', () => {
  const text = vector('Outputs(1)=(OutputName="Green instead",MaskR=0,MaskG=1)');
  const selected = translate(text, { outputs: ['Source:1'] });
  complete(selected);
  assert.equal(selected.outputs[0].type, 'float');
  assert.match(selected.hlsl, /Tint\.y\b/);
  const metadata = translate(text, { outputs: ['Source:0'] });
  complete(metadata);
  assert.equal(metadata.candidates.find(candidate => candidate.id === 'Source:1').type, 'float');
  const extended = translate(vector('Outputs(1)=(MaskG=1)'), { outputs: ['Source:1'] });
  complete(extended);
  assert.equal(extended.outputs[0].type, 'float2');
  assert.match(extended.hlsl, /Tint\.xy\b/);
});

test('explicit Mask=false exposes the full source even when inherited channels are populated', () => {
  const text = vector('Outputs(1)=(OutputName="Whole value",Mask=False)');
  const result = translate(text, { outputs: ['Source:1'] });
  complete(result);
  assert.equal(result.outputs[0].type, 'float4');
  assert.equal(result.candidates.find(candidate => candidate.id === 'Source:1').type, 'float4');
  assert.match(result.hlsl, /result\.[A-Za-z_]\w* = Tint;/);
});

test('the RGBA port inherits all four enabled mask channels before a partial override', () => {
  const result = translate(vector('Outputs(5)=(OutputName="GBA",MaskR=0)'), { outputs: ['Source:5'] });
  complete(result);
  assert.equal(result.outputs[0].type, 'float3');
  assert.equal(result.candidates.find(candidate => candidate.id === 'Source:5').type, 'float3');
  assert.match(result.hlsl, /Tint\.yzw\b/);
});

test('Mask=true inherits channel fields and rejects a mask with no default or explicit channels', () => {
  const inherited = translate(vector('Outputs(0)=(Mask=True)'), { outputs: ['Source:0'] });
  complete(inherited);
  assert.equal(inherited.outputs[0].type, 'float3');
  const empty = translate(expression('Constant3Vector', 'Constant=(R=1,G=2,B=3,A=1)\nOutputs(0)=(Mask=True)'), { outputs: ['Source:0'] });
  assert.equal(empty.status, 'unsupported');
  assert.ok(empty.diagnostics.some(diagnostic => diagnostic.code === 'OUTPUT_MASK'));
  assert.match(empty.hlsl, /#error/);
});

test('renaming WorldPosition ports preserves XYZ, XY and Z widths', () => {
  const text = expression('WorldPosition', 'Outputs(0)=(OutputName="World")\nOutputs(1)=(OutputName="Planar")\nOutputs(2)=(OutputName="Height")');
  const result = translate(text, { outputs: ['Source:0', 'Source:1', 'Source:2'] });
  complete(result);
  assert.deepEqual(result.outputs.map(output => output.type), ['float3', 'float2', 'float']);
  assert.deepEqual(result.candidates.map(output => output.type), ['float3', 'float2', 'float']);
  assert.doesNotMatch(result.hlsl, /#error/);
  assert.match(result.hlsl, /WorldPositionWS\.xy\b/);
  assert.match(result.hlsl, /WorldPositionWS\.z\b/);
});

test('all 19 renamed VectorParameters in the real cloud export retain RGB and alpha types', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/real/volumetric-cloud.blueprint.txt'), 'utf8');
  const parsed = parseClipboard(text);
  assert.deepEqual(parsed.diagnostics, []);
  const graph = buildGraph(parsed.objects);
  const nodes = [...graph.nodes.values()].filter(node => node.type === 'MaterialExpressionVectorParameter'
    && node.props.__ArrayOperations?.some(operation => operation.property === 'Outputs' && operation.operation === 'RemoveIndex' && operation.index === 5));
  assert.equal(nodes.length, 19);
  const outputs = nodes.flatMap(node => [`${node.id}:0`, `${node.id}:4`]);
  for (const engineVersion of ['5.5', '5.7']) {
    const result = translate(text, { engineVersion, outputs });
    complete(result);
    for (const node of nodes) {
      const selected = result.outputs.filter(output => output.nodeId === node.id);
      assert.deepEqual(selected.map(output => output.type), ['float3', 'float'], node.id);
      const candidates = result.candidates.filter(output => output.nodeId === node.id);
      assert.equal(candidates.length, 5, `${node.id}: removed RGBA port must not survive`);
      assert.deepEqual(candidates.map(output => output.type), ['float3', 'float', 'float', 'float', 'float'], node.id);
    }
  }
});
