const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseClipboard, parseValue } = require('../packages/core/dist/parser.js');

const plain = value => JSON.parse(JSON.stringify(value));

test('parses realistic UE graph exports, nested reopen blocks, pins and source ranges', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/parser/material-clipboard.txt'), 'utf8');
  const parsed = parseClipboard(fixture);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.objects.length, 3);
  const coordinate = parsed.objects[0];
  assert.equal(coordinate.className, '/Script/UnrealEd.MaterialGraphNode');
  assert.ok(coordinate.objectPath.endsWith("MaterialGraphNode_0'"));
  assert.equal(coordinate.children.length, 2);
  assert.equal(coordinate.children[1].properties.UTiling, 2);
  assert.equal(coordinate.children[1].properties.MaterialExpressionGuid, '11111111222222223333333344444444');
  assert.deepEqual(coordinate.range, { startLine: 1, endLine: 16 });
  const multiply = parsed.objects[1];
  assert.equal(multiply.children[1].properties.A.OutputIndex, 0);
  assert.equal(multiply.children[1].properties.Desc, 'UV scale, with "quoted text" and (parentheses)');
  const pins = multiply.properties.CustomProperties;
  assert.equal(pins.length, 2);
  assert.equal(pins[0].kind, 'Pin');
  assert.equal(pins[0].PinName, 'A');
  assert.equal(pins[1].PinName, 'B');
  assert.equal(pins[0]['PinType.PinCategory'], 'materialinput');
  assert.deepEqual(plain(pins[0].LinkedTo), ['MaterialGraphNode_0 11111111222222223333333344444444']);
  assert.equal(parsed.objects[2].properties.NodeComment, 'UV preprocessing');
});

test('parses escaped strings, nested structs, arrays, enums, functions and numeric edge cases', () => {
  assert.deepEqual(plain(parseValue('(R=-.5,G=1e-3,B=2.0f,A=1)')), { R: -0.5, G: 0.001, B: 2, A: 1 });
  assert.deepEqual(plain(parseValue('((Name="x,y",Input=(X=1,Y=2)),(Name="z",Input=()))')), [
    { Name: 'x,y', Input: { X: 1, Y: 2 } }, { Name: 'z', Input: {} },
  ]);
  assert.deepEqual(plain(parseValue('[1,True,None]')), [1, true, null]);
  assert.equal(parseValue('"line\\nnext\\t\\\"quoted\\\"\\\\tail"'), 'line\nnext\t"quoted"\\tail');
  assert.equal(parseValue('"C:\\Unknown\\Path"'), 'C:\\Unknown\\Path');
  assert.equal(parseValue('NSLOCTEXT("Material", "Key", "Value, (extra)")'), 'NSLOCTEXT("Material", "Key", "Value, (extra)")');
  assert.equal(parseValue("Texture2D'/Game/Textures/T_Test.T_Test'"), "Texture2D'/Game/Textures/T_Test.T_Test'");
  assert.equal(parseValue('00000000000000000000000000000000'), '00000000000000000000000000000000');
  assert.equal(parseValue('9007199254740993'), '9007199254740993');
});

test('retains indexed properties and multiline compound and Custom HLSL values', () => {
  const parsed = parseClipboard(`\uFEFFBegin Object Class=/Script/Engine.MaterialExpressionCustom Name="Custom_0" ObjectPath="/Transient/Custom_0"
Inputs(0)=(InputName="A",
 Input=(Expression="MaterialExpressionConstant_0",OutputIndex=0))
Inputs(1)=(InputName="B",Input=())
Code="float x = 1;\\nreturn float2(x, x);"
Description="first line
second line"
End Object`);
  assert.deepEqual(parsed.diagnostics, []);
  const object = parsed.objects[0];
  assert.equal(object.objectPath, '/Transient/Custom_0');
  assert.equal(object.properties['Inputs(0)'].Input.Expression, 'MaterialExpressionConstant_0');
  assert.equal(object.properties['Inputs(1)'].InputName, 'B');
  assert.equal(object.properties.Code, 'float x = 1;\nreturn float2(x, x);');
  assert.equal(object.properties.Description, 'first line\nsecond line');
  assert.deepEqual(object.range, { startLine: 1, endLine: 8 });
});

test('reports truncated objects and malformed values as errors', () => {
  for (const text of ['Begin Object Name="A"\nInput=(X=1', 'Begin Object Name="A"\nCode="unclosed', 'Begin Object Name="A"\nInput=(X=1]\nEnd Object']) {
    const parsed = parseClipboard(text);
    assert.ok(parsed.diagnostics.some(diagnostic => diagnostic.severity === 'error' && diagnostic.code === 'INVALID_PROPERTY_VALUE'));
  }
  const truncated = parseClipboard('Begin Object Name="A"\nX=1');
  assert.ok(truncated.diagnostics.some(diagnostic => diagnostic.code === 'UNCLOSED_OBJECT'));
  assert.deepEqual(truncated.objects[0].range, { startLine: 1, endLine: 2 });
  assert.ok(parseClipboard('not a clipboard').diagnostics.some(diagnostic => diagnostic.code === 'NO_OBJECTS'));
  assert.ok(parseClipboard('End Object').diagnostics.some(diagnostic => diagnostic.code === 'UNMATCHED_END_OBJECT'));
  assert.ok(parseClipboard('Begin Object Class=/Script/Engine.MaterialExpressionAdd\nEnd Object').diagnostics.some(diagnostic => diagnostic.code === 'MISSING_OBJECT_NAME'));
  const recovered = parseClipboard('Begin Object Name="A"\nInput=(X=1\nEnd Object\nBegin Object Name="B"\nValue=2\nEnd Object');
  assert.equal(recovered.objects.length, 2);
  assert.equal(recovered.objects[1].properties.Value, 2);
  assert.equal(recovered.diagnostics.filter(diagnostic => diagnostic.code === 'UNCLOSED_OBJECT').length, 0);
});

test('rejects invalid individual values instead of returning malformed shader data', () => {
  for (const value of ['', '"unterminated', '(X=1,Y=2', '(X=1,2)', '(X=1,,Y=2)', '(X=1,X=2)', '"value" extra', '1e9999']) {
    assert.throws(() => parseValue(value), SyntaxError, value);
  }
});

test('does not let serialized prototype-like keys mutate the property dictionary', () => {
  const parsed = parseClipboard('Begin Object Name="A"\n__proto__=(polluted=True)\nEnd Object');
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.objects[0].properties.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test('retains ordered UE array removals without treating them as unknown statements', () => {
  const parsed = parseClipboard(`Begin Object Class=/Script/Engine.MaterialExpressionVectorParameter Name="MaterialExpressionVectorParameter_0"
Outputs(0)=(OutputName="RGB")
Outputs(4)=(OutputName="AmbientOcclusion")
Outputs.RemoveIndex(5)
Outputs.RemoveIndex(4)
End Object`);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(plain(parsed.objects[0].properties.__ArrayOperations), [
    { property: 'Outputs', operation: 'RemoveIndex', index: 5 },
    { property: 'Outputs', operation: 'RemoveIndex', index: 4 },
  ]);
  assert.equal(parsed.objects[0].properties['Outputs(4)'].OutputName, 'AmbientOcclusion');
});
