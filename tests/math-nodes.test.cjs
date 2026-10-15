const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { translate } = require('../packages/core/dist');

const expression = (type, id, properties = '') => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"\n${properties}\nEnd Object\n`;
const link = id => `(Expression="${id}")`;
const scalar = (id, value) => expression('Constant', id, `R=${value}`);
const v2 = (id, x, y) => expression('Constant2Vector', id, `R=${x}\nG=${y}`);
const v3 = (id, x, y, z) => expression('Constant3Vector', id, `Constant=(R=${x},G=${y},B=${z},A=1)`);
const parameter = (id, name) => expression('ScalarParameter', id, `ParameterName="${name}"\nDefaultValue=1`);
const ifGraph = (a, b, options = {}) => scalar('A', a) + scalar('B', b) + scalar('GT', 10) + scalar('EQ', 20) + scalar('LT', 30) +
  expression('If', 'Result', `A=${link('A')}\nB=${link('B')}\nAGreaterThanB=${link('GT')}\nALessThanB=${link('LT')}\n${options.noEqual ? '' : `AEqualsB=${link('EQ')}\n`}${options.threshold === undefined ? '' : `EqualsThreshold=${options.threshold}`}`);

// References are arithmetic results chosen independently from emitter strings.
// Rules verified in the user's installed UE 5.5/5.7 MaterialExpressions.cpp,
// HLSLMaterialTranslator.cpp and Common.ush (legacy material compiler).
const cases = [
  { name: 'If chooses equality inside an explicit threshold', source: ifGraph(0.25, 0, { threshold: 0.5 }), expected: [20] },
  { name: 'If threshold boundary is inclusive', source: ifGraph(0.5, 0, { threshold: 0.5 }), expected: [20] },
  { name: 'If chooses greater outside threshold', source: ifGraph(0.75, 0, { threshold: 0.5 }), expected: [10] },
  { name: 'If chooses less outside threshold', source: ifGraph(-0.75, 0, { threshold: 0.5 }), expected: [30] },
  { name: 'If defaults threshold to 1e-5', source: ifGraph(0.000005, 0), expected: [20] },
  { name: 'If absent equality ignores threshold and uses greater at equality', source: ifGraph(1, 1, { noEqual: true, threshold: 2 }), expected: [10] },
  { name: 'If absent equality ignores threshold for a nearby smaller value', source: ifGraph(0.5, 1, { noEqual: true, threshold: 2 }), expected: [30] },
  { name: 'Power reads serialized Exponent rather than the display caption Exp', source: scalar('Base', 3) + scalar('Exp', 3) + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Exp')}`), expected: [27] },
  { name: 'Power default exponent is 2', source: scalar('Base', 3) + expression('Power', 'Result', `Base=${link('Base')}`), expected: [9] },
  { name: 'Power negative base is clamped', source: scalar('Base', -2) + expression('Power', 'Result', `Base=${link('Base')}`), expected: [0] },
  { name: 'Power suppresses the tiny-base singularity', source: scalar('Base', 1e-9) + expression('Power', 'Result', `Base=${link('Base')}\nConstExponent=-1`), expected: [0] },
  { name: 'Power constant exponent 1 preserves base before positive clamping', source: scalar('Base', -2) + expression('Power', 'Result', `Base=${link('Base')}\nConstExponent=1`), expected: [-2] },
  { name: 'Power literal connected exponent 0 uses the compile-time identity', source: scalar('Base', 0) + scalar('Exponent', 0) + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Exponent')}`), expected: [1] },
  { name: 'Power follows reroutes when proving a compile-time exponent of 1', source: scalar('Base', -2) + scalar('Exponent', 1) + expression('Reroute', 'Pass', `Input=${link('Exponent')}`) + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Pass')}`), expected: [-2] },
  { name: 'Power uses a folded scalar arithmetic exponent of 1', source: scalar('Base', -2) + expression('Add', 'Exponent', 'ConstA=0.75\nConstB=0.25') + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Exponent')}`), expected: [-2] },
  { name: 'Power recognizes a constant zero exponent from multiplication', source: scalar('Base', -2) + parameter('Variable', 'VariableExponent') + expression('Multiply', 'Exponent', `A=${link('Variable')}\nConstB=0`) + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Exponent')}`), arguments: { VariableExponent: 7 }, expected: [1] },
  { name: 'Power dynamic exponent 1 retains positive clamping', source: scalar('Base', -2) + parameter('Exponent', 'DynamicExponent') + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Exponent')}`), arguments: { DynamicExponent: 1 }, expected: [0] },
  { name: 'Power scalar exponent applies independently to every vector channel', source: v3('Base', 2, -3, 4) + expression('Power', 'Result', `Base=${link('Base')}\nConstExponent=2`), expected: [4, 0, 16] },
  { name: 'Rotator Time is radians and orientation is cos U minus sin V', source: v2('UV', 1, 0.5) + scalar('Time', Math.PI / 2) + expression('Rotator', 'Result', `Coordinate=${link('UV')}\nTime=${link('Time')}\nSpeed=1`), expected: [0.5, 1] },
  { name: 'Rotator default speed is 0.25 radians per second', source: v2('UV', 1, 0.5) + scalar('Time', Math.PI * 2) + expression('Rotator', 'Result', `Coordinate=${link('UV')}\nTime=${link('Time')}`), expected: [0.5, 1] },
  { name: 'Rotator preserves a third coordinate and custom origin', source: v3('UVW', 1, 0, 7) + scalar('Time', Math.PI / 2) + expression('Rotator', 'Result', `Coordinate=${link('UVW')}\nTime=${link('Time')}\nSpeed=1\nCenterX=0\nCenterY=0`), expected: [0, 1, 7] },
  { name: 'Length of a scalar is absolute value', source: scalar('Input', -7) + expression('Length', 'Result', `Input=${link('Input')}`), expected: [7] },
  { name: 'Length uses all vector components', source: v3('Input', 3, 4, 12) + expression('Length', 'Result', `Input=${link('Input')}`), expected: [13] },
  { name: 'TruncateLWC casts precision without rounding away fractions', source: v3('Input', -1.25, 0.5, 2.75) + expression('TruncateLWC', 'Result', `Input=${link('Input')}`), expected: [-1.25, 0.5, 2.75] },
];

function findDxc() {
  for (const candidate of process.env.DXC_PATH ? [process.env.DXC_PATH] : ['dxc', 'C:/VulkanSDK/1.4.350.0/Bin/dxc.exe']) {
    const probe = spawnSync(candidate, ['-help'], { encoding: 'utf8', timeout: 15000 });
    if (probe.error?.code === 'ENOENT') continue;
    if (probe.error) throw probe.error;
    assert.equal(probe.status, 0, probe.stderr);
    return candidate;
  }
}
const dxc = findDxc();

function constantOutput(t, result, args) {
  const field = /struct MaterialResult\s*\{\s*(float[234]?)\s+(\w+)\s*;/.exec(result.hlsl);
  assert.ok(field, result.hlsl);
  const outputType = field[1];
  const value = `result.${field[2]}`;
  const rgba = outputType === 'float' ? `float4(${value}, 0, 0, 1)` :
    outputType === 'float2' ? `float4(${value}, 0, 1)` :
    outputType === 'float3' ? `float4(${value}, 1)` : value;
  const invocation = result.inputs.map(input => {
    assert.ok(Object.hasOwn(args, input.name), `Missing test argument ${input.name}`);
    return String(args[input.name]);
  }).join(', ');
  const source = `${result.hlsl}\nfloat4 PSMain() : SV_Target0\n{\nMaterialResult result = EvaluateMaterial(${invocation});\nreturn ${rgba};\n}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-math-reference-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shader = path.join(directory, 'test.hlsl');
  const assembly = path.join(directory, 'test.ll');
  fs.writeFileSync(shader, source);
  const compilation = spawnSync(dxc, ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-O3', '-Fc', assembly, '-Fo', path.join(directory, 'test.dxil'), shader], { encoding: 'utf8', timeout: 30000 });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, `${compilation.stderr}\n${source}`);
  const stores = [...fs.readFileSync(assembly, 'utf8').matchAll(/call void @dx\.op\.storeOutput\.f32\(i32 \d+, i32 \d+, i32 \d+, i8 (\d+), float ([^)]+)\)/g)];
  assert.equal(stores.length, 4);
  return new Map(stores.map(([, channel, value]) => {
    if (/^0x[0-9a-f]{16}$/i.test(value)) return [Number(channel), Buffer.from(value.slice(2), 'hex').readDoubleBE()];
    assert.match(value, /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i);
    return [Number(channel), Number(value)];
  }));
}

for (const engineVersion of ['5.5', '5.7']) {
  for (const fixture of cases) {
    test(`Math reference UE ${engineVersion}: ${fixture.name}`, { skip: !dxc && 'DXC unavailable' }, t => {
      const result = translate(fixture.source, { engineVersion, outputs: ['Result'] });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      assert.equal(result.outputs.length, 1);
      const actual = constantOutput(t, result, fixture.arguments || {});
      fixture.expected.forEach((expected, channel) => assert.ok(Math.abs(actual.get(channel) - expected) <= Math.max(2e-6, Math.abs(expected) * 1e-6),
        `channel ${channel}: expected ${expected}, got ${actual.get(channel)}`));
    });
  }
}

test('Rotator defaults reuse the same UV and game-time context identities', () => {
  const source = expression('Rotator', 'Result') + expression('TextureCoordinate', 'UV') + expression('Time', 'Clock');
  const result = translate(source, { outputs: ['Result', 'UV', 'Clock'] });
  assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
  assert.equal(result.inputs.filter(input => input.name === 'UV0').length, 1);
  assert.equal(result.inputs.filter(input => input.name === 'GameTime').length, 1);
  assert.equal(result.inputs.length, 2);
});

test('Power vector exponent is diagnosed because UE compiler paths disagree', () => {
  const result = translate(v3('Base', 1, 2, 3) + v3('Exponent', 2, 3, 4) + expression('Power', 'Result', `Base=${link('Base')}\nExponent=${link('Exponent')}`), { outputs: ['Result'] });
  assert.equal(result.status, 'unsupported');
  assert.ok(result.diagnostics.some(d => d.code === 'UNSUPPORTED_NODE' && /Power/.test(d.message)));
});

test('If still reports its required inputs instead of using fabricated zeros', () => {
  const result = translate(expression('If', 'Result'), { outputs: ['Result'] });
  assert.equal(result.status, 'unsupported');
  for (const name of ['A', 'AGreaterThanB', 'ALessThanB']) assert.ok(result.diagnostics.some(d => d.code === 'REQUIRED_INPUT' && d.message.includes(`.${name} `)));
});
