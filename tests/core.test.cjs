const test = require('node:test');
const assert = require('node:assert/strict');
const { translate } = require('../packages/core/dist');

// Deliberately small, handwritten material exports. Expected behavior comes
// from the graph connections and formulas, independently of emitter internals.
const expr = (type, id, properties = '', position) => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"
${properties}
${position ? `MaterialExpressionEditorX=${position[0]}\nMaterialExpressionEditorY=${position[1]}` : ''}
End Object`;
const link = (id, extra = '') => `(Expression="${id}"${extra ? `,${extra}` : ''})`;
const comment = (id, text, x, y, width, height) => expr('Comment', id,
  `Text="${text}"\nSizeX=${width}\nSizeY=${height}`, [x, y]);
const graph = (...nodes) => nodes.join('\n');
const errors = result => result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
const assertComplete = result => assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));

test('arithmetic defaults survive missing and explicitly unconnected inputs in both version profiles', () => {
  for (const engineVersion of ['5.5', '5.7']) {
    const add = translate(expr('Add', 'MaterialExpressionAdd_0', 'A=()\nB=(Expression=None)'), { engineVersion });
    assertComplete(add);
    assert.match(add.hlsl, /0\.0 \+ 1\.0/);
    const multiply = translate(expr('Multiply', 'MaterialExpressionMultiply_0'), { engineVersion });
    assertComplete(multiply);
    assert.match(multiply.hlsl, /0\.0 \* 1\.0/);
    const divide = translate(expr('Divide', 'MaterialExpressionDivide_0'), { engineVersion });
    assertComplete(divide);
    assert.match(divide.hlsl, /UE_SafeDivide\(1\.0, 2\.0\)/);
  }
});

test('resolves Unreal typed object references with inner quoted export paths', () => {
  const text = graph(expr('Constant', 'MaterialExpressionConstant_0', 'R=6'),
    expr('Add', 'MaterialExpressionAdd_0', `A=(Expression=MaterialExpressionConstant'"/Engine/Transient.Material_0:MaterialGraph_0.MaterialGraphNode_0.MaterialExpressionConstant_0"')\nConstB=2`));
  const result = translate(text, { outputs: ['MaterialExpressionAdd_0'] });
  assertComplete(result);
  assert.equal(result.inputs.filter(input => input.kind === 'external').length, 0);
  assert.equal(result.outputs[0].type, 'float');
  assert.equal(result.stats.reachableNodes, 2);
  assert.match(result.hlsl, /6\.0/);
});

test('an explicit empty expression input cannot revive a stale editor pin connection', () => {
  const text = graph(
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="SourceGraph"
Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0"
R=99
End Object
CustomProperties Pin (PinId=11111111222222223333333344444444,Direction="EGPD_Output",PinName="Output")
End Object`,
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="TargetGraph"
Begin Object Class=/Script/Engine.MaterialExpressionAdd Name="MaterialExpressionAdd_0"
A=()
ConstA=7
ConstB=2
End Object
CustomProperties Pin (PinId=55555555666666667777777788888888,PinName="A",LinkedTo=(SourceGraph 11111111222222223333333344444444,))
End Object`,
  );
  const result = translate(text, { outputs: ['MaterialExpressionAdd_0'] });
  assertComplete(result);
  assert.match(result.hlsl, /7\.0 \+ 2\.0/);
  assert.doesNotMatch(result.hlsl, /99\.0/);
  assert.equal(result.stats.reachableNodes, 1);
});

test('a partially copied, masked source requires its original width and retains its selected channels', () => {
  const text = expr('Multiply', 'MaterialExpressionMultiply_0',
    'A=(Expression="MaterialExpressionVectorParameter_Absent",OutputIndex=0,Mask=1,MaskR=1,MaskG=1,MaskB=0,MaskA=0)\nConstB=2');
  const unresolved = translate(text);
  assert.equal(unresolved.status, 'unsupported');
  assert.ok(unresolved.diagnostics.some(diagnostic => diagnostic.code === 'UNKNOWN_EXTERNAL_TYPE'));
  const resolved = translate(text, { externalInputs: { MaterialExpressionVectorParameter_Absent: 'float3' } });
  assert.equal(resolved.status, 'external-dependencies');
  assert.equal(resolved.inputs.filter(input => input.kind === 'external').length, 1);
  assert.equal(resolved.inputs[0].type, 'float3');
  assert.equal(resolved.outputs[0].type, 'float2');
  assert.match(resolved.hlsl, /\)\.xy \* 2\.0/);
  assert.doesNotMatch(resolved.hlsl, /#error/);
});

test('an enabled connection mask with no channels is an error', () => {
  const text = graph(expr('Constant3Vector', 'MaterialExpressionConstant3Vector_0', 'Constant=(R=1,G=2,B=3,A=1)'),
    expr('Add', 'MaterialExpressionAdd_0', `A=${link('MaterialExpressionConstant3Vector_0', 'Mask=1,MaskR=0,MaskG=0,MaskB=0,MaskA=0')}`));
  const result = translate(text);
  assert.equal(result.status, 'unsupported');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'EMPTY_MASK'));
});

test('Named Reroute uses declaration GUIDs rather than display names', () => {
  const guid = '11111111222222223333333344444444';
  const text = graph(
    expr('Constant', 'MaterialExpressionConstant_0', 'R=4'),
    expr('Constant', 'MaterialExpressionConstant_1', 'R=99'),
    expr('NamedRerouteDeclaration', 'MaterialExpressionNamedRerouteDeclaration_0', `Name="Shared Name"\nVariableGuid=${guid}\nInput=${link('MaterialExpressionConstant_0')}`),
    expr('NamedRerouteDeclaration', 'MaterialExpressionNamedRerouteDeclaration_1', `Name="Shared Name"\nVariableGuid=AAAAAAAA222222223333333344444444\nInput=${link('MaterialExpressionConstant_1')}`),
    expr('NamedRerouteUsage', 'MaterialExpressionNamedRerouteUsage_0', `DeclarationGuid=${guid}`),
  );
  const result = translate(text, { outputs: ['MaterialExpressionNamedRerouteUsage_0'] });
  assertComplete(result);
  assert.match(result.hlsl, /4\.0/);
  assert.doesNotMatch(result.hlsl, /99\.0/);
  assert.equal(result.stats.reachableNodes, 3);
});

test('Named Reroute can recover a copied declaration from GUID when a stale object reference remains', () => {
  const guid = '12345678222222223333333344444444';
  const text = graph(expr('Constant', 'MaterialExpressionConstant_0', 'R=8'),
    expr('NamedRerouteDeclaration', 'MaterialExpressionNamedRerouteDeclaration_0', `VariableGuid=${guid}\nInput=${link('MaterialExpressionConstant_0')}`),
    expr('NamedRerouteUsage', 'MaterialExpressionNamedRerouteUsage_0', `Declaration="MaterialExpressionNamedRerouteDeclaration_Stale"\nDeclarationGuid=${guid}`));
  const result = translate(text, { outputs: ['MaterialExpressionNamedRerouteUsage_0'] });
  assertComplete(result);
  assert.equal(result.inputs.filter(input => input.kind === 'external').length, 0);
  assert.match(result.hlsl, /8\.0/);
});

test('cycles produce diagnostics and incomplete shader output without recursive overflow', () => {
  const text = graph(expr('Add', 'MaterialExpressionAdd_0', `A=${link('MaterialExpressionMultiply_0')}`),
    expr('Multiply', 'MaterialExpressionMultiply_0', `A=${link('MaterialExpressionAdd_0')}`));
  const result = translate(text, { outputs: ['MaterialExpressionAdd_0'] });
  assert.equal(result.status, 'unsupported');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'GRAPH_CYCLE'));
  assert.match(result.hlsl, /#error/);
  assert.equal(translate(text).status, 'unsupported');
});

test('overlapping comment frames disclose ambiguous membership', () => {
  const result = translate(graph(expr('Constant', 'MaterialExpressionConstant_0', 'R=2', [75, 25]),
    comment('MaterialExpressionComment_0', 'Left', 0, 0, 100, 100),
    comment('MaterialExpressionComment_1', 'Right', 50, 0, 120, 100)));
  assertComplete(result);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'OVERLAPPING_COMMENTS'));
  assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0].name, 'Left');
});

test('cross-module A1 to B to A2 preserves evaluation order and does not extract cyclic A', () => {
  const text = graph(
    expr('Constant', 'MaterialExpressionConstant_0', 'R=3', [10, 10]),
    expr('Add', 'MaterialExpressionAdd_0', `A=${link('MaterialExpressionConstant_0')}\nConstB=2`, [210, 10]),
    expr('Multiply', 'MaterialExpressionMultiply_0', `A=${link('MaterialExpressionAdd_0')}\nConstB=4`, [20, 30]),
    comment('MaterialExpressionComment_0', 'A', 0, 0, 100, 100),
    comment('MaterialExpressionComment_1', 'B', 200, 0, 100, 100),
  );
  const result = translate(text, { outputs: ['MaterialExpressionMultiply_0'] });
  assertComplete(result);
  assert.notEqual(result.modules.find(module => module.name === 'A').mode, 'function');
  const mainStart = result.hlsl.split('\n').findIndex(line => /^MaterialResult EvaluateMaterial\(/.test(line)) + 1;
  const mainLine = id => Math.min(...result.sourceMap.filter(mapping => mapping.nodeId === id && mapping.generated.startLine >= mainStart).map(mapping => mapping.generated.startLine));
  assert.ok(mainLine('MaterialExpressionConstant_0') < mainLine('MaterialExpressionAdd_0'));
  assert.ok(mainLine('MaterialExpressionAdd_0') < mainLine('MaterialExpressionMultiply_0'));
  assert.equal(result.outputs[0].type, 'float');
});

test('nested comments assign nodes to their innermost frame without overlap warnings', () => {
  const result = translate(graph(
    expr('Constant', 'MaterialExpressionConstant_0', 'R=3', [20, 20]),
    expr('Constant', 'MaterialExpressionConstant_1', 'R=5', [150, 150]),
    expr('Add', 'MaterialExpressionAdd_0', `A=${link('MaterialExpressionConstant_0')}\nB=${link('MaterialExpressionConstant_1')}`, [600, 20]),
    comment('MaterialExpressionComment_0', 'Outer', 0, 0, 500, 500),
    comment('MaterialExpressionComment_1', 'Inner', 100, 100, 200, 200),
  ));
  assertComplete(result);
  assert.equal(result.modules.find(module => module.name === 'Outer').nodeIds.includes('MaterialExpressionConstant_0'), true);
  assert.equal(result.modules.find(module => module.name === 'Outer / Inner').nodeIds.includes('MaterialExpressionConstant_1'), true);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'OVERLAPPING_COMMENTS'), false);
});

test('Vector Parameter channel outputs select G and A independently and share a single parameter', () => {
  const text = graph(expr('VectorParameter', 'MaterialExpressionVectorParameter_0', 'ParameterName="Tint"\nDefaultValue=(R=1,G=2,B=3,A=4)'),
    expr('Add', 'MaterialExpressionAdd_0', `A=${link('MaterialExpressionVectorParameter_0', 'OutputIndex=2')}\nB=${link('MaterialExpressionVectorParameter_0', 'OutputIndex=4')}`));
  const result = translate(text);
  assertComplete(result);
  assert.equal(result.inputs.filter(input => input.name === 'Tint').length, 1);
  assert.equal(result.outputs[0].type, 'float');
  assert.match(result.hlsl, /Tint\.g/);
  assert.match(result.hlsl, /Tint\.a/);
  assert.doesNotMatch(result.hlsl, /Tint\.r;/);
});

test('same named scalar parameters share one shader argument and flag inconsistent defaults', () => {
  const make = secondDefault => graph(
    expr('ScalarParameter', 'MaterialExpressionScalarParameter_0', 'ParameterName="Strength"\nDefaultValue=0.25'),
    expr('ScalarParameter', 'MaterialExpressionScalarParameter_1', `ParameterName="Strength"\nDefaultValue=${secondDefault}`),
    expr('Add', 'MaterialExpressionAdd_0', `A=${link('MaterialExpressionScalarParameter_0')}\nB=${link('MaterialExpressionScalarParameter_1')}`));
  const result = translate(make('0.25'));
  assertComplete(result);
  assert.equal(result.inputs.filter(input => input.kind === 'parameter').length, 1);
  assert.equal(result.inputs[0].defaultValue, 0.25);
  const conflict = translate(make('0.75'));
  assert.ok(conflict.diagnostics.some(diagnostic => diagnostic.code === 'PARAMETER_DEFAULT_CONFLICT'));
});

test('composite vector defaults retain every explicit component without flattening or changing alpha', () => {
  const result = translate(expr('VectorParameter', 'MaterialExpressionVectorParameter_0',
    'ParameterName="Tint"\nDefaultValue=(R=0.125,G=-0.25,B=2.5,A=0.375)'),
    { outputs: ['MaterialExpressionVectorParameter_0:5'] });
  assertComplete(result);
  assert.equal(result.outputs[0].type, 'float4');
  assert.deepEqual(JSON.parse(JSON.stringify(result.inputs[0].defaultValue)), { R: 0.125, G: -0.25, B: 2.5, A: 0.375 });
  assert.equal(result.outputs.length, 1);
});

test('a connected static view-bias flag overrides the false property and preserves renderer bias', () => {
  const result = translate(graph(expr('StaticBool', 'MaterialExpressionStaticBool_0', 'Value=True'),
    expr('TextureSample', 'MaterialExpressionTextureSample_0',
      `Texture="Texture2D'/Game/T_Test.T_Test'"\nAutomaticViewMipBias=False\nAutomaticViewMipBiasValue=${link('MaterialExpressionStaticBool_0')}`)));
  // UE uses this linked static bool in preference to the serialized property.
  assert.equal(result.status, 'external-dependencies');
  assert.equal(errors(result).length, 0);
  assert.match(result.hlsl, /\.SampleBias\([^\n]+EffectiveMaterialTextureMipBias/);
  assert.ok(result.inputs.some(input => input.name === 'EffectiveMaterialTextureMipBias'));
});

test('explicit output selection excludes dead unsupported nodes and their diagnostics', () => {
  const text = graph(expr('Constant', 'MaterialExpressionConstant_0', 'R=7'),
    expr('Custom', 'MaterialExpressionCustom_0', 'Code="return SomethingUnknown();"'));
  const result = translate(text, { outputs: ['MaterialExpressionConstant_0:0'] });
  assertComplete(result);
  assert.equal(result.stats.reachableNodes, 1);
  assert.equal(errors(result).length, 0);
  assert.doesNotMatch(result.hlsl, /UNRESOLVED|SomethingUnknown/);
  assert.equal(result.outputs.length, 1);
});

test('material root editor pins recover named final outputs and coerce scalar base color', () => {
  const root = `Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Root Name="MaterialGraphNode_Root_0"
CustomProperties Pin (PinId=AAAAAAAA000000000000000000000001,PinName="Base Color",LinkedTo=(ColorGraph 11111111222222223333333344444444,))
CustomProperties Pin (PinId=AAAAAAAA000000000000000000000002,PinName="Roughness",LinkedTo=(RoughnessGraph 55555555666666667777777788888888,))
End Object`;
  const text = graph(
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="ColorGraph"
${expr('Constant', 'MaterialExpressionConstant_0', 'R=0.25')}
CustomProperties Pin (PinId=11111111222222223333333344444444,PinName="Output",Direction="EGPD_Output")
End Object`,
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="RoughnessGraph"
${expr('Constant', 'MaterialExpressionConstant_1', 'R=0.75')}
CustomProperties Pin (PinId=55555555666666667777777788888888,PinName="Output",Direction="EGPD_Output")
End Object`, root,
  );
  const result = translate(text);
  assertComplete(result);
  assert.equal(result.outputs.length, 2);
  assert.deepEqual(result.outputs.map(output => [output.name, output.type]), [['Base Color', 'float3'], ['Roughness', 'float']]);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'INFERRED_OUTPUTS'), false);
  assert.match(result.hlsl, /(?:float3\(|\(float3\)\()Constant_0\)/);
});

test('selecting one root output does not compile unsupported sibling material branches', () => {
  const text = graph(
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="ColorGraph"
${expr('Constant3Vector', 'MaterialExpressionConstant3Vector_0', 'Constant=(R=0.1,G=0.2,B=0.3,A=1)')}
CustomProperties Pin (PinId=11111111222222223333333344444444,PinName="Output",Direction="EGPD_Output")
End Object`,
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="UnknownGraph"
${expr('Custom', 'MaterialExpressionCustom_0', 'Code="return MissingDependency();"')}
CustomProperties Pin (PinId=55555555666666667777777788888888,PinName="Output",Direction="EGPD_Output")
End Object`,
    `Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Root Name="MaterialGraphNode_Root_0"
CustomProperties Pin (PinId=AAAAAAAA000000000000000000000001,PinName="Base Color",LinkedTo=(ColorGraph 11111111222222223333333344444444,))
CustomProperties Pin (PinId=AAAAAAAA000000000000000000000002,PinName="Emissive Color",LinkedTo=(UnknownGraph 55555555666666667777777788888888,))
End Object`,
  );
  const result = translate(text, { outputs: ['MaterialGraphNode_Root_0:0'] });
  assertComplete(result);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].name, 'Base Color');
  assert.equal(result.outputs[0].type, 'float3');
  assert.doesNotMatch(result.hlsl, /UNRESOLVED|MissingDependency/);
});

test('out-of-range channel masks fail instead of dropping or inventing vector components', () => {
  const result = translate(graph(expr('Constant2Vector', 'MaterialExpressionConstant2Vector_0', 'R=3\nG=5'),
    expr('ComponentMask', 'MaterialExpressionComponentMask_0', `Input=${link('MaterialExpressionConstant2Vector_0')}\nB=True`)));
  assert.equal(result.status, 'unsupported');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'MASK_CHANNEL'));
});

test('serialized Constant4Vector RGB and Alpha outputs use their declared masks', () => {
  const result = translate(expr('Constant4Vector', 'MaterialExpressionConstant4Vector_0',
    `Constant=(R=0.125,G=0.25,B=0.5,A=0.75)
Outputs(0)=(OutputName="RGB",Mask=1,MaskR=1,MaskG=1,MaskB=1,MaskA=0)
Outputs(1)=(OutputName="Alpha",Mask=1,MaskR=0,MaskG=0,MaskB=0,MaskA=1)`),
    { outputs: ['MaterialExpressionConstant4Vector_0:0', 'MaterialExpressionConstant4Vector_0:1'] });
  assertComplete(result);
  assert.deepEqual(result.outputs.map(output => output.type), ['float3', 'float']);
  assert.match(result.hlsl, /float4\(0\.125, 0\.25, 0\.5, 0\.75\)/);
  assert.match(result.hlsl, /\.(?:xyz|rgb);/);
  assert.match(result.hlsl, /\.(?:w|a);/);
  assert.equal(errors(result).length, 0);
});

test('single-sided Clamp does not compile the unused bound or its unsupported dependency', () => {
  for (const [mode, ignored, operation] of [['CMODE_ClampMin', 'Max', 'max'], ['CMODE_ClampMax', 'Min', 'min']]) {
    const result = translate(graph(expr('Constant', 'MaterialExpressionConstant_0', 'R=0.25'),
      expr('Custom', 'MaterialExpressionCustom_0', 'Code="return Unavailable();"'),
      expr('Clamp', 'MaterialExpressionClamp_0',
        `Input=${link('MaterialExpressionConstant_0')}\nClampMode=${mode}\n${ignored}=${link('MaterialExpressionCustom_0')}\nMinDefault=0.1\nMaxDefault=0.9`)),
      { outputs: ['MaterialExpressionClamp_0'] });
    assertComplete(result);
    assert.equal(result.stats.reachableNodes, 2);
    assert.equal(errors(result).length, 0);
    assert.doesNotMatch(result.hlsl, /UNRESOLVED|Unavailable/);
    assert.ok(result.hlsl.includes(`${operation}(`));
  }
});

test('manual module assignments resolve overlapping frames and null assignments ungroup nodes', () => {
  const id = 'MaterialExpressionConstant_0';
  const left = 'MaterialExpressionComment_0';
  const right = 'MaterialExpressionComment_1';
  const text = graph(expr('Constant', id, 'R=2', [75, 25]),
    comment(left, 'Left', 0, 0, 100, 100), comment(right, 'Right', 50, 0, 120, 100));
  const assigned = translate(text, { moduleAssignments: { [id]: right } });
  assertComplete(assigned);
  assert.equal(assigned.modules.length, 1);
  assert.equal(assigned.modules[0].id, right);
  assert.equal(assigned.modules[0].name, 'Right');
  assert.equal(assigned.diagnostics.some(diagnostic => diagnostic.code === 'OVERLAPPING_COMMENTS'), false);
  const ungrouped = translate(text, { moduleAssignments: { [id]: null } });
  assertComplete(ungrouped);
  assert.equal(ungrouped.modules.length, 0);
  assert.equal(ungrouped.diagnostics.some(diagnostic => diagnostic.code === 'OVERLAPPING_COMMENTS'), false);
  assert.match(ungrouped.hlsl, /2\.0/);
});

test('invalid serialized float properties fail explicitly instead of becoming numeric defaults', () => {
  const cases = [
    expr('Constant', 'MaterialExpressionConstant_0', 'R=abc'),
    expr('Constant3Vector', 'MaterialExpressionConstant3Vector_0', 'Constant=(R=abc,G=2,B=3,A=1)'),
    expr('Add', 'MaterialExpressionAdd_0', 'ConstA=abc\nConstB=2'),
    expr('TextureCoordinate', 'MaterialExpressionTextureCoordinate_0', 'UTiling=abc'),
    expr('ScalarParameter', 'MaterialExpressionScalarParameter_0', 'ParameterName="Strength"\nDefaultValue=abc'),
  ];
  for (const text of cases) {
    const result = translate(text);
    assert.equal(result.status, 'unsupported', text);
    assert.ok(errors(result).length > 0, text);
    assert.match(result.hlsl, /#error/, text);
  }
});
