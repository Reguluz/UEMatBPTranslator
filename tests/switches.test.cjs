const test = require('node:test');
const assert = require('node:assert/strict');
const { translate } = require('../packages/core/dist');

// These are deliberately hand-authored clipboard-shaped graphs. They reproduce
// the reported switch/output shape; they are not exports of the user's graph.
const expr = (type, id, properties = '') => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"
${properties}
End Object`;
const link = id => `(Expression=MaterialExpression'${id}')`;
const graph = (...nodes) => nodes.join('\n');
const parameter = (id, name) => expr('ScalarParameter', id, `ParameterName="${name}"\nDefaultValue=0.5`);
const output = (id, name, source) => expr('FunctionOutput', id, `OutputName="${name}"\nA=${link(source)}`);
const assertComplete = result => assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics, null, 2));
const assertPreserved = result => {
  assert.equal(result.status, 'external-dependencies', JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false, JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'SHADING_PATH_VARIANTS'));
  assert.doesNotMatch(result.hlsl, /#error UE_MATERIAL_TRANSLATION_INCOMPLETE/);
};
const inputNames = result => result.inputs.map(input => input.name).sort();

test('unknown nodes retain every named input dependency and identify the unsupported operation', () => {
  const source = graph(
    parameter('FirstParameter', 'FirstFactor'),
    parameter('SecondParameter', 'SecondFactor'),
    parameter('ArrayParameter', 'ArrayFactor'),
    parameter('FunctionParameter', 'FunctionFactor'),
    expr('Multiply', 'KnownProduct', `A=${link('FirstParameter')}\nB=${link('SecondParameter')}`),
    expr('FutureOperation', 'Future', [
      `PrimaryData=${link('KnownProduct')}`,
      `Inputs(0)=${link('ArrayParameter')}`,
      `FunctionInputs(0)=(Input=(InputName="Detail"),ExpressionInput=${link('FunctionParameter')})`,
    ].join('\n')),
    output('Final', 'Algorithm', 'Future'),
  );
  const result = translate(source);

  assert.equal(result.status, 'unsupported');
  assert.match(result.hlsl, /^#error UE_MATERIAL_TRANSLATION_INCOMPLETE/m);
  assert.deepEqual(inputNames(result), ['ArrayFactor', 'FirstFactor', 'FunctionFactor', 'SecondFactor']);
  const productMapping = result.sourceMap.find(mapping => mapping.nodeId === 'KnownProduct');
  assert.ok(productMapping, 'Known upstream math must still be emitted.');
  assert.match(result.hlsl, /FirstFactor(?:_value)?\s*\*\s*SecondFactor(?:_value)?/);
  const productDeclaration = result.hlsl.split('\n')[productMapping.generated.startLine - 1];
  const productSymbol = /\bfloat\s+(\w+)\s*=/.exec(productDeclaration)?.[1];
  assert.ok(productSymbol, productDeclaration);
  assert.match(result.hlsl, new RegExp(`UNRESOLVED_Future\\([^)]*\\b${productSymbol}\\b`), 'The unresolved call must retain its actual input calculation.');
  assert.match(result.hlsl, /UNRESOLVED_/);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'error'
    && diagnostic.nodeId === 'Future' && /FutureOperation/.test(diagnostic.message)), JSON.stringify(result.diagnostics));
});

test('unresolved material functions retain their supplied input algorithms without inventing a result', () => {
  const result = translate(graph(
    parameter('ScaleParameter', 'DetailScale'),
    expr('FunctionInput', 'Coordinates', 'InputName="UV"\nInputType=FunctionInput_Vector2'),
    expr('Multiply', 'ScaledCoordinates', `A=${link('Coordinates')}\nB=${link('ScaleParameter')}`),
    expr('MaterialFunctionCall', 'ExternalFunction', [
      "MaterialFunction=MaterialFunction'/Game/Materials/MF_External.MF_External'",
      `FunctionInputs(0)=(ExpressionInput=${link('ScaledCoordinates')})`,
    ].join('\n')),
    output('Final', 'Result', 'ExternalFunction'),
  ));

  assert.equal(result.status, 'unsupported');
  assert.match(result.hlsl, /^#error/m);
  assert.ok(result.inputs.some(input => input.name === 'UV' && input.type === 'float2'));
  assert.ok(result.inputs.some(input => input.name === 'DetailScale'));
  assert.ok(result.sourceMap.some(mapping => mapping.nodeId === 'ScaledCoordinates'));
  assert.match(result.hlsl, /UNRESOLVED_/);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.nodeId === 'ExternalFunction' && diagnostic.severity === 'error'));
});

test('unspecified shading path preserves Deferred, Forward and Mobile alternatives with known result types', () => {
  for (const engineVersion of ['5.5', '5.7']) {
    const source = graph(
      parameter('DeferredSource', 'DeferredStrength'),
      parameter('ForwardSource', 'ForwardStrength'),
      parameter('MobileSource', 'MobileStrength'),
      expr('ShadingPathSwitch', 'Path', [
        `Inputs(0)=${link('DeferredSource')}`,
        `Inputs(1)=${link('ForwardSource')}`,
        `Inputs(2)=${link('MobileSource')}`,
      ].join('\n')),
      output('Final', 'Strength', 'Path'),
    );
    const implicit = translate(source, { engineVersion });
    const explicit = translate(source, { engineVersion, shadingPath: 'preserve' });
    assertPreserved(implicit);
    assertPreserved(explicit);
    assert.equal(implicit.hlsl, explicit.hlsl, 'Preserving branches must be the default.');
    assert.deepEqual(inputNames(implicit), ['DeferredStrength', 'ForwardStrength', 'MobileStrength']);
    assert.equal(implicit.outputs[0].type, 'float');
    assert.match(implicit.hlsl, /^\s*#if\b/m);
    assert.match(implicit.hlsl, /^\s*#elif\b/m);
    assert.match(implicit.hlsl, /^\s*#endif\b/m);
    assert.match(implicit.hlsl, /DEFERRED/i);
    assert.match(implicit.hlsl, /FORWARD/i);
    assert.match(implicit.hlsl, /MOBILE/i);
    assert.match(implicit.hlsl, /^\s*#error\s+[^\n]*SHADING_PATH/im, 'The caller must choose a compile-time path.');
    assert.doesNotMatch(implicit.hlsl, /^\s*#define\s+UE_MATERIAL_SHADING_PATH\s+[012]\b/m, 'Do not silently default to a path.');
    assert.doesNotMatch(implicit.hlsl, /UNRESOLVED_|unresolved type/);
  }
});

test('an explicit shading path activates only its matching Inputs slot', () => {
  for (const [shadingPath, index] of [['deferred', 0], ['forward', 1], ['mobile', 2]]) {
    const nodes = [
      parameter('ActiveParameter', 'ChosenStrength'),
      parameter('UnusedParameter', 'UnusedStrength'),
      expr('Add', 'ActiveAlgorithm', `A=${link('ActiveParameter')}\nConstB=2`),
      expr('FutureOperation', 'UnsupportedAlgorithm', `UnusualInput=${link('UnusedParameter')}`),
    ];
    nodes.push(expr('ShadingPathSwitch', 'Path', [0, 1, 2].map(slot =>
      `Inputs(${slot})=${link(slot === index ? 'ActiveAlgorithm' : 'UnsupportedAlgorithm')}`).join('\n')));
    nodes.push(output('Final', 'Strength', 'Path'));
    const result = translate(graph(...nodes), { shadingPath });

    assertComplete(result);
    assert.deepEqual(inputNames(result), ['ChosenStrength']);
    assert.equal(result.outputs[0].type, 'float');
    assert.match(result.hlsl, /ChosenStrength(?:_value)?\s*\+\s*2\.0/);
    assert.doesNotMatch(result.hlsl, /UNRESOLVED_|UnusedStrength/);
    assert.equal(result.sourceMap.some(mapping => mapping.nodeId === 'UnsupportedAlgorithm'), false);
  }
});

test('a missing or explicitly empty shading path input uses Default', () => {
  for (const shadingPath of ['deferred', 'forward', 'mobile']) {
    for (const emptyInputs of ['', 'Inputs(0)=()\nInputs(1)=(Expression=None)\nInputs(2)=()']) {
      const result = translate(graph(
        parameter('FallbackParameter', 'FallbackStrength'),
        expr('ShadingPathSwitch', 'Path', `Default=${link('FallbackParameter')}\n${emptyInputs}`),
        output('Final', 'Strength', 'Path'),
      ), { shadingPath });
      assertComplete(result);
      assert.deepEqual(inputNames(result), ['FallbackStrength']);
      assert.equal(result.outputs[0].type, 'float');
      assert.doesNotMatch(result.hlsl, /UNRESOLVED_/);
    }
  }
});

test('a shading path with neither connected input nor Default is diagnosed instead of replaced by zero', () => {
  const result = translate(graph(expr('ShadingPathSwitch', 'Path'), output('Final', 'Strength', 'Path')), { shadingPath: 'mobile' });
  assert.equal(result.status, 'unsupported');
  assert.match(result.hlsl, /^#error/m);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.nodeId === 'Path' && diagnostic.severity === 'error'));
});

test('four named function outputs behind mobile bypasses retain their upstream algorithms', () => {
  const nodes = [
    expr('FunctionInput', 'Color', 'InputName="SurfaceColor"\nInputType=FunctionInput_Vector3'),
    expr('FunctionInput', 'Density', 'InputName="Density"\nInputType=FunctionInput_Scalar'),
    parameter('Gain', 'EmissionGain'),
    expr('Multiply', 'AlbedoMath', `A=${link('Color')}\nB=${link('Density')}`),
    expr('Multiply', 'EmissiveMath', `A=${link('Color')}\nB=${link('Gain')}`),
    expr('OneMinus', 'ExtinctionMath', `Input=${link('Density')}`),
    expr('Saturate', 'OcclusionMath', `Input=${link('Density')}`),
    expr('Constant', 'MobileZero', 'R=0'),
    expr('Constant', 'MobileOne', 'R=1'),
  ];
  for (const [suffix, name, algorithm, mobile] of [
    ['0', 'Albedo', 'AlbedoMath', 'MobileZero'],
    ['1', 'Emissive Color', 'EmissiveMath', 'MobileZero'],
    ['3', 'Extinction', 'ExtinctionMath', 'MobileOne'],
    ['2', 'Ambient Occlusion', 'OcclusionMath', 'MobileOne'],
  ]) {
    const id = `MaterialExpressionShadingPathSwitch_${suffix}`;
    nodes.push(expr('ShadingPathSwitch', id,
      `Default=${link(algorithm)}\nInputs(2)=${link(mobile)}\nMaterialExpressionEditorX=100\nMaterialExpressionEditorY=100`));
    nodes.push(output(`Output${suffix}`, name, id));
  }
  nodes.push(expr('Comment', 'BypassFrame', 'Text="Bypass on mobile"\nMaterialExpressionEditorX=0\nMaterialExpressionEditorY=0\nSizeX=500\nSizeY=500'));

  const result = translate(graph(...nodes));
  assertPreserved(result);
  assert.deepEqual(result.outputs.map(candidate => [candidate.name, candidate.type]).sort(), [
    ['Albedo', 'float3'], ['Ambient Occlusion', 'float'], ['Emissive Color', 'float3'], ['Extinction', 'float'],
  ].sort());
  assert.deepEqual(inputNames(result), ['Density', 'EmissionGain', 'SurfaceColor']);
  assert.match(result.hlsl, /SurfaceColor\s*\*\s*Density/);
  assert.match(result.hlsl, /SurfaceColor\s*\*\s*EmissionGain/);
  assert.match(result.hlsl, /1\.0\s*-\s*Density/);
  assert.match(result.hlsl, /saturate\(Density\)/);
  assert.match(result.hlsl, /Bypass on mobile/);
  assert.doesNotMatch(result.hlsl, /UNRESOLVED_|unresolved type/);
  for (const nodeId of ['AlbedoMath', 'EmissiveMath', 'ExtinctionMath', 'OcclusionMath']) {
    assert.ok(result.sourceMap.some(mapping => mapping.nodeId === nodeId), `${nodeId} must remain traceable.`);
  }
});
