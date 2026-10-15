const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClipboard } = require('../packages/core/dist/parser');
const { buildGraph } = require('../packages/core/dist/graph');
const { lowerFunction } = require('../packages/core/dist/lowering-functions');
const { translate } = require('../packages/core/dist');

const paths = {
  km: '/Engine/Functions/Engine_MaterialFunctions01/Units/Km-to-Cm.Km-to-Cm',
  make3: '/Engine/Functions/Engine_MaterialFunctions02/Utility/MakeFloat3.MakeFloat3',
  make4: '/Engine/Functions/Engine_MaterialFunctions02/Utility/MakeFloat4.MakeFloat4',
  break3: '/Engine/Functions/Engine_MaterialFunctions02/Utility/BreakOutFloat3Components.BreakOutFloat3Components',
  break4: '/Engine/Functions/Engine_MaterialFunctions02/Utility/BreakOutFloat4Components.BreakOutFloat4Components',
};
const call = (asset, inputs, outputs) => `Begin Object Class=/Script/Engine.MaterialExpressionMaterialFunctionCall Name="MaterialExpressionMaterialFunctionCall_0"
MaterialFunction="/Script/Engine.MaterialFunction'${asset}'"
${inputs.map(([name, extra = ''], index) => `FunctionInputs(${index})=(ExpressionInputId=529C1D96441E07EB03A9E59B8A7F67B6,Input=(Expression="/Script/Engine.MaterialExpressionConstant4Vector'MaterialGraphNode_0.MaterialExpressionConstant4Vector_0'",InputName="${name}"${extra}))`).join('\n')}
${outputs.map((name, index) => `FunctionOutputs(${index})=(ExpressionOutputId=0DD6F9954C067C3E5DDBBBA0D6910DD2,Output=(OutputName="${name}"))`).join('\n')}
End Object`;

function lower(text) {
  const parsed = parseClipboard(text);
  assert.deepEqual(parsed.diagnostics, []);
  const graph = buildGraph(parsed.objects);
  const node = graph.nodes.get('MaterialExpressionMaterialFunctionCall_0');
  const links = [];
  const diagnostics = [];
  const ctx = {
    graph,
    options: { engineVersion: '5.7' },
    link(owner, connection, type) {
      links.push({ connection, type });
      return { code: `input${links.length}`, type, deps: [connection.source] };
    },
    emit(owner, code, type, refs = []) { return { code, type, deps: refs.flatMap(ref => ref.deps) }; },
    diag(owner, code, message, severity = 'error') { diagnostics.push({ code, severity, message }); },
    unknown(owner, reason) { diagnostics.push({ code: 'UNKNOWN', reason }); return [{ code: 'UNRESOLVED', type: 'unknown', deps: [] }]; },
  };
  return { refs: lowerFunction(node, ctx), links, diagnostics };
}

test('standard Engine function contracts recover Km scaling and vector construction', () => {
  const km = lower(call(paths.km, [['Km']], ['Cm']));
  assert.equal(km.refs[0].code, 'input1 * 100000.0');
  assert.equal(km.refs[0].type, 'float');
  assert.equal(km.links[0].type, 'float');
  for (const count of [3, 4]) {
    const names = ['X', 'Y', 'Z', 'A'].slice(0, count);
    const result = lower(call(paths[`make${count}`], names.map(name => [name]), ['Result']));
    assert.equal(result.refs[0].code, `float${count}(${names.map((name, index) => `input${index + 1}`).join(', ')})`);
    assert.equal(result.refs[0].type, `float${count}`);
    assert.equal(result.links.length, count);
    assert.ok(result.links.every(link => link.type === 'float'));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'BUILTIN_FUNCTION_CONTRACT' && diagnostic.severity === 'info'));
  }
});

test('BreakOutFloat3 and Float4 return separate scalar outputs in RGBA order', () => {
  for (const count of [3, 4]) {
    const result = lower(call(paths[`break${count}`], [[`Float${count}`, ',OutputIndex=1']], ['R', 'G', 'B', 'A'].slice(0, count)));
    assert.deepEqual(result.refs.map(ref => ref.code), ['x', 'y', 'z', 'w'].slice(0, count).map(channel => `(input1).${channel}`));
    assert.ok(result.refs.every(ref => ref.type === 'float'));
    assert.equal(result.links[0].connection.outputIndex, 1);
    assert.equal(result.links[0].type, `float${count}`);
  }
});

test('function inputs preserve nested output ports and connection masks from real exports', () => {
  const result = lower(call(paths.make3, [
    ['X', ',OutputIndex=1,Mask=1,MaskR=1'],
    ['Y', ',OutputIndex=2,Mask=1,MaskG=1'],
    ['Z', ',OutputIndex=3,Mask=1,MaskB=1'],
  ], ['Result']));
  assert.deepEqual(result.links.map(link => link.connection), [
    { source: 'MaterialExpressionConstant4Vector_0', outputIndex: 1, mask: 'x' },
    { source: 'MaterialExpressionConstant4Vector_0', outputIndex: 2, mask: 'y' },
    { source: 'MaterialExpressionConstant4Vector_0', outputIndex: 3, mask: 'z' },
  ]);
});

test('same-basename user functions and changed Engine interfaces cannot receive builtin semantics', () => {
  for (const asset of ['/Game/Utility/MakeFloat3.MakeFloat3', '/Engine/Other/MakeFloat3.MakeFloat3']) {
    assert.equal(lower(call(asset, [['X'], ['Y'], ['Z']], ['Result'])).refs, undefined);
  }
  for (const text of [
    call(paths.make3, [['X'], ['Z'], ['Y']], ['Result']),
    call(paths.make3, [['X'], ['Y'], ['Z']], ['Changed']),
    call(paths.make3, [['X'], ['Y']], ['Result']),
  ]) {
    const result = lower(text);
    assert.equal(result.refs[0].type, 'unknown');
    assert.equal(result.links.length, 0);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'BUILTIN_FUNCTION_INTERFACE'));
  }
});

test('missing builtin inputs do not invent absent function preview defaults', () => {
  const result = lower(call(paths.km, [['Km']], ['Cm']).replace(/Expression="[^"]+",InputName=/, 'Expression=None,InputName='));
  assert.equal(result.refs[0].type, 'unknown');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'BUILTIN_FUNCTION_INPUT'));
});

test('nested MakeFloat4 and BreakOutFloat4 survive end-to-end lowering in both UE profiles', () => {
  const vector = `Begin Object Class=/Script/Engine.MaterialExpressionConstant4Vector Name="MaterialExpressionConstant4Vector_0"
Constant=(R=1,G=2,B=3,A=4)
End Object`;
  const make = call(paths.make4, ['X', 'Y', 'Z', 'A'].map((name, index) => [name, `,Mask=1,Mask${'RGBA'[index]}=1`]), ['Result']);
  const split = call(paths.break4, [['Float4']], ['R', 'G', 'B', 'A'])
    .replace('Name="MaterialExpressionMaterialFunctionCall_0"', 'Name="MaterialExpressionMaterialFunctionCall_1"')
    .replace("/Script/Engine.MaterialExpressionConstant4Vector'MaterialGraphNode_0.MaterialExpressionConstant4Vector_0'", "/Script/Engine.MaterialExpressionMaterialFunctionCall'MaterialExpressionMaterialFunctionCall_0'");
  for (const engineVersion of ['5.5', '5.7']) {
    const result = translate([vector, make, split].join('\n'), {
      engineVersion,
      outputs: [0, 1, 2, 3].map(index => `MaterialExpressionMaterialFunctionCall_1:${index}`),
    });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    assert.equal(result.outputs.length, 4);
    assert.ok(result.outputs.every(output => output.type === 'float'));
    assert.doesNotMatch(result.hlsl, /#error|UNRESOLVED/);
    assert.match(result.hlsl, /float4\(\(Constant4Vector_0\)\.x, \(Constant4Vector_0\)\.y, \(Constant4Vector_0\)\.z, \(Constant4Vector_0\)\.w\)/);
    for (const channel of 'xyzw') assert.match(result.hlsl, new RegExp(`\\(MakeFloat4\\)\\.${channel}`));
  }
});

test('unknown project functions keep upstream calculation and an explicit compilation error', () => {
  const text = `Begin Object Class=/Script/Engine.MaterialExpressionConstant4Vector Name="MaterialExpressionConstant4Vector_0"
Constant=(R=11,G=12,B=13,A=14)
End Object\n${call('/Game/Utility/MakeFloat3.MakeFloat3', [['X'], ['Y'], ['Z']], ['Result'])}`;
  const result = translate(text);
  assert.equal(result.status, 'unsupported');
  assert.match(result.hlsl, /#error/);
  assert.match(result.hlsl, /float4\(11\.0, 12\.0, 13\.0, 14\.0\)/);
});
