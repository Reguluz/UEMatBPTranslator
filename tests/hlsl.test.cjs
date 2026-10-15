const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { translate } = require('../packages/core/dist');

// Fixtures here are hand-authored clipboard-shaped graphs, not UE exports.
const expression = (type, id, properties = '') => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"
${properties}
End Object\n`;
const link = (id, outputIndex = 0) => `(Expression=MaterialExpression'${id}',OutputIndex=${outputIndex})`;
const position = (x, y) => `MaterialExpressionEditorX=${x}\nMaterialExpressionEditorY=${y}\n`;
const comment = (id, label, x) => expression('Comment', id, `Text="${label}"\nSizeX=100\nSizeY=100\n${position(x, 0)}`);

function findDxc() {
  const candidates = process.env.DXC_PATH ? [process.env.DXC_PATH] : [
    'dxc',
    ...(process.platform === 'win32' ? ['C:/VulkanSDK/1.4.350.0/Bin/dxc.exe'] : []),
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-help'], { encoding: 'utf8', timeout: 15000 });
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `DXC is present but failed to run: ${candidate}\n${result.stderr}`);
    return candidate;
  }
  return undefined;
}

const dxc = findDxc();
const enabled = { skip: dxc ? false : 'DXC is unavailable; install dxc or set DXC_PATH to compile generated HLSL.' };

function pixelWrapper(result) {
  const fields = [...(result.hlsl.match(/struct MaterialResult\s*\{([\s\S]*?)\};/)?.[1] ?? '').matchAll(/\b(float[234]?|bool)\s+([A-Za-z_]\w*)\s*;/g)];
  assert.equal(fields.length, result.outputs.length, 'The wrapper must consume every selected material result.');
  assert.ok(fields.length > 0);
  let textures = 0;
  let samplers = 0;
  const globals = result.inputs.map(input => {
    if (input.type === 'Texture2D') return `Texture2D Test_${input.name} : register(t${textures++});`;
    if (input.type === 'SamplerState') return `SamplerState Test_${input.name} : register(s${samplers++});`;
    assert.match(input.type, /^(float[234]?|bool)$/);
    return `${input.type} Test_${input.name};`;
  });
  const toColor = ([, type, name]) => {
    const access = `computed.${name}`;
    if (type === 'float4') return access;
    if (type === 'float3') return `float4(${access}, 1.0)`;
    if (type === 'float2') return `float4(${access}, 0.0, 1.0)`;
    if (type === 'bool') return `float4(${access} ? 1.0 : 0.0, 0.0, 0.0, 1.0)`;
    return `float4(${access}, ${access}, ${access}, 1.0)`;
  };
  return `${result.hlsl}\n${globals.join('\n')}
float4 PSMain() : SV_Target0
{
    MaterialResult computed = EvaluateMaterial(${result.inputs.map(input => `Test_${input.name}`).join(', ')});
    return ${fields.map(toColor).join(' + ')};
}
`;
}

function compile(t, source, options, expectedStatus = 'complete') {
  const result = translate(source, options);
  assert.equal(result.status, expectedStatus, JSON.stringify(result.diagnostics, null, 2));
  assert.ok(!result.hlsl.includes('#error'), result.hlsl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-material-dxc-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const shaderPath = path.join(temp, 'material.hlsl');
  const binaryPath = path.join(temp, 'material.dxil');
  const shader = pixelWrapper(result);
  fs.writeFileSync(shaderPath, shader, 'utf8');
  const compilation = spawnSync(dxc, ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-Od', '-Fo', binaryPath, shaderPath], {
    encoding: 'utf8', timeout: 30000,
  });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, `${compilation.stdout}\n${compilation.stderr}\n${shader}`);
  assert.ok(fs.statSync(binaryPath).size > 0, 'DXC must produce actual DXIL bytecode.');
  return result;
}

const math = [
  expression('Constant3Vector', 'Direction', 'Constant=(R=0.2,G=0.4,B=0.8,A=1.0)'),
  expression('ScalarParameter', 'Strength', 'ParameterName="Strength"\nDefaultValue=0.5'),
  expression('Time', 'Clock', 'bOverride_Period=True\nPeriod=3.0\nbIgnorePause=True'),
  expression('Sine', 'Wave', `Input=${link('Clock')}\nPeriod=2.0`),
  expression('Multiply', 'Scale', `A=${link('Direction')}\nB=${link('Wave')}`),
  expression('Divide', 'Divide', `A=${link('Scale')}\nB=${link('Strength')}`),
  expression('Normalize', 'Normal', `Input=${link('Divide')}`),
  expression('DotProduct', 'Dot', `A=${link('Normal')}\nB=${link('Direction')}`),
  expression('Saturate', 'Final', `Input=${link('Dot')}`),
].join('');

const channels = [
  expression('VectorParameter', 'Tint', 'ParameterName="Tint"\nDefaultValue=(R=0.25,G=0.5,B=0.75,A=0.8)'),
  expression('ComponentMask', 'RG', `Input=${link('Tint', 5)}\nR=True\nG=True\nB=False\nA=False`),
  expression('AppendVector', 'RGA', `A=${link('RG')}\nB=${link('Tint', 4)}`),
  expression('FunctionOutput', 'Constructed', `A=${link('RGA')}\nOutputName="Constructed"`),
  expression('FunctionOutput', 'FullColor', `A=${link('Tint', 5)}\nOutputName="FullColor"`),
  expression('FunctionOutput', 'Red', `A=${link('Tint', 1)}\nOutputName="Red"`),
].join('');

const broadcasts = [
  expression('ScalarParameter', 'Amount', 'ParameterName="Amount"\nDefaultValue=0.4'),
  expression('Constant3Vector', 'Axis', 'Constant=(R=0.2,G=0.4,B=0.8,A=1.0)'),
  expression('ComponentMask', 'Repeated', `Input=${link('Amount')}\nR=True\nG=True\nB=True\nA=True`),
  expression('CrossProduct', 'Cross', `A=${link('Amount')}\nB=${link('Axis')}`),
  expression('LinearInterpolate', 'Blend', `A=${link('Axis')}\nB=${link('Amount')}\nAlpha=${link('Amount')}`),
  expression('FunctionOutput', 'RepeatedOutput', `A=${link('Repeated')}\nOutputName="Repeated"`),
  expression('FunctionOutput', 'CrossOutput', `A=${link('Cross')}\nOutputName="Cross"`),
  expression('FunctionOutput', 'BlendOutput', `A=${link('Blend')}\nOutputName="Blend"`),
  expression('FunctionOutput', 'LinkMaskOutput', `A=(Expression=MaterialExpression'Amount',Mask=1,MaskR=1,MaskG=1,MaskB=0,MaskA=0)\nOutputName="LinkMask"`),
].join('');

const grouped = [
  comment('Group', 'Mask intensity', 0),
  expression('ScalarParameter', 'Intensity', 'ParameterName="Intensity"\nDefaultValue=0.5\n' + position(10, 10)),
  expression('Multiply', 'Mask', `A=${link('Intensity')}\nConstB=0.75\n${position(50, 40)}`),
].join('');

const interleaved = [
  comment('GroupA', 'A', 0),
  comment('GroupB', 'B', 200),
  expression('ScalarParameter', 'A1', 'ParameterName="Intensity"\nDefaultValue=0.5\n' + position(10, 10)),
  expression('Add', 'B1', `A=${link('A1')}\nConstB=1.0\n${position(210, 10)}`),
  expression('Multiply', 'A2', `A=${link('B1')}\nB=${link('A1')}\n${position(50, 40)}`),
].join('');

function texture(mode) {
  return [
    expression('TextureObjectParameter', 'Texture', 'ParameterName="Albedo"\nTexture=Texture2D\'/Game/Textures/T_Test.T_Test\''),
    expression('TextureCoordinate', 'UV', 'CoordinateIndex=0\nUTiling=2.0\nVTiling=2.0'),
    expression('Constant2Vector', 'DX', 'R=0.01\nG=0.0'),
    expression('Constant2Vector', 'DY', 'R=0.0\nG=0.01'),
    expression('TextureSample', 'Sample', `TextureObject=${link('Texture')}\nCoordinates=${link('UV')}\nCoordinatesDX=${link('DX')}\nCoordinatesDY=${link('DY')}\nSamplerType=SAMPLERTYPE_Color\nSamplerSource=SSM_FromTextureAsset\nMipValueMode=${mode}\nConstMipValue=0.0\nAutomaticViewMipBias=False`),
    expression('FunctionOutput', 'Color', `A=${link('Sample', 0)}\nOutputName="Color"`),
    expression('FunctionOutput', 'Alpha', `A=${link('Sample', 4)}\nOutputName="Alpha"`),
  ].join('');
}

for (const engineVersion of ['5.5', '5.7']) {
  test(`DXC UE ${engineVersion}: math helpers and time form a valid pixel shader`, enabled, t => {
    compile(t, math, { engineVersion });
  });
  test(`DXC UE ${engineVersion}: vector parameter channels and multiple outputs compile`, enabled, t => {
    const result = compile(t, channels, { engineVersion });
    assert.equal(result.outputs.length, 3);
  });
  test(`DXC UE ${engineVersion}: scalar broadcasting through masks and typed inputs compiles`, enabled, t => {
    const result = compile(t, broadcasts, { engineVersion });
    assert.equal(result.outputs.length, 4);
  });
  test(`DXC UE ${engineVersion}: automatic module function compiles`, enabled, t => {
    const result = compile(t, grouped, { engineVersion, moduleStyle: 'auto' });
    assert.ok(result.modules.some(module => module.mode === 'function'));
  });
  test(`DXC UE ${engineVersion}: module scopes compile`, enabled, t => {
    const result = compile(t, grouped, { engineVersion, moduleStyle: 'scopes' });
    assert.ok(result.modules.some(module => module.mode === 'scope'));
  });
  test(`DXC UE ${engineVersion}: interleaved modules preserve compilable sections`, enabled, t => {
    const result = compile(t, interleaved, { engineVersion, moduleStyle: 'auto' });
    assert.equal(result.modules.find(module => module.id === 'GroupA')?.mode, 'sections');
  });
  for (const mode of ['TMVM_None', 'TMVM_MipLevel', 'TMVM_MipBias', 'TMVM_Derivative']) {
    test(`DXC UE ${engineVersion}: Texture2D ${mode} compiles with explicit resources`, enabled, t => {
      const result = compile(t, texture(mode), { engineVersion }, 'external-dependencies');
      assert.ok(result.inputs.some(input => input.type === 'Texture2D'));
      assert.ok(result.inputs.some(input => input.type === 'SamplerState'));
    });
  }
}

// Optimized constant-only shaders expose their final RGBA values in DXIL's
// documented storeOutput operation. This checks independent reference values,
// without evaluating a copy of the translator's expression rules in JavaScript.
function compileConstant(t, source, engineVersion, expected) {
  const result = translate(source, { engineVersion });
  assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.inputs.length, 0, 'Numeric fixtures must contain no runtime inputs.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-material-dxc-numeric-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const shaderPath = path.join(temp, 'material.hlsl');
  const binaryPath = path.join(temp, 'material.dxil');
  const assemblyPath = path.join(temp, 'material.ll');
  fs.writeFileSync(shaderPath, pixelWrapper(result), 'utf8');
  const compilation = spawnSync(dxc, ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-O3', '-Fo', binaryPath, '-Fc', assemblyPath, shaderPath], {
    encoding: 'utf8', timeout: 30000,
  });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, `${compilation.stdout}\n${compilation.stderr}\n${result.hlsl}`);
  assert.ok(fs.statSync(binaryPath).size > 0);
  const assembly = fs.readFileSync(assemblyPath, 'utf8');
  const stores = [...assembly.matchAll(/call void @dx\.op\.storeOutput\.f32\(i32 \d+, i32 \d+, i32 \d+, i8 (\d+), float ([^)]+)\)/g)];
  assert.equal(stores.length, 4, 'Expected four constant output stores in optimized DXIL.\n' + assembly);
  const actual = new Map();
  for (const [, channel, value] of stores) {
    let numeric;
    if (/^0x[0-9a-f]{16}$/i.test(value)) {
      // LLVM's hexadecimal float literals encode the equivalent IEEE double.
      numeric = Buffer.from(value.slice(2), 'hex').readDoubleBE(0);
    } else {
      assert.match(value, /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i,
        'Constant fixture unexpectedly produced a non-literal output: ' + value);
      numeric = Number(value);
    }
    actual.set(Number(channel), numeric);
  }
  expected.forEach((reference, channel) => {
    const value = actual.get(channel);
    const tolerance = Math.max(2e-6, Math.abs(reference) * 1e-6);
    assert.ok(Number.isFinite(value) && Math.abs(value - reference) <= tolerance,
      `channel ${channel}: expected ${reference}, DXC constant output ${value}`);
  });
}

const scalar = (id, value) => expression('Constant', id, `R=${value}`);
const vector3 = (id, r, g, b) => expression('Constant3Vector', id, `Constant=(R=${r},G=${g},B=${b},A=1.0)`);
const numericCases = [
  {
    name: 'Sine quarter-cycle uses UE period 1',
    source: scalar('Value', 0.25) + expression('Sine', 'Result', `Input=${link('Value')}\nPeriod=1.0`),
    expected: [1, 1, 1, 1],
  },
  {
    name: 'Sine quarter-cycle uses UE period 2',
    source: scalar('Value', 0.5) + expression('Sine', 'Result', `Input=${link('Value')}\nPeriod=2.0`),
    expected: [1, 1, 1, 1],
  },
  {
    name: 'Divide protects a zero divisor',
    source: scalar('Numerator', 4) + scalar('Denominator', 0) + expression('Divide', 'Result', `A=${link('Numerator')}\nB=${link('Denominator')}`),
    expected: [400000, 400000, 400000, 1],
  },
  {
    name: 'Frac of a negative value remains positive',
    source: scalar('Value', -0.2) + expression('Frac', 'Result', `Input=${link('Value')}`),
    expected: [0.8, 0.8, 0.8, 1],
  },
  {
    name: 'Normalize protects a zero vector',
    source: vector3('Value', 0, 0, 0) + expression('Normalize', 'Result', `Input=${link('Value')}`),
    expected: [0, 0, 0, 1],
  },
  {
    name: 'Dot product uses all vector components',
    source: vector3('A', 1, 2, 3) + vector3('B', 4, 5, 6) + expression('DotProduct', 'Result', `A=${link('A')}\nB=${link('B')}`),
    expected: [32, 32, 32, 1],
  },
  {
    name: 'Lerp evaluates scalar endpoints',
    source: scalar('A', 2) + scalar('B', 10) + expression('LinearInterpolate', 'Result', `A=${link('A')}\nB=${link('B')}\nConstAlpha=0.25`),
    expected: [4, 4, 4, 1],
  },
  {
    name: 'Lerp evaluates vector endpoints',
    source: vector3('A', 1, 2, 3) + vector3('B', 5, 10, 15) + expression('LinearInterpolate', 'Result', `A=${link('A')}\nB=${link('B')}\nConstAlpha=0.25`),
    expected: [2, 4, 6, 1],
  },
];

for (const engineVersion of ['5.5', '5.7']) {
  for (const fixture of numericCases) {
    test(`DXC constant reference UE ${engineVersion}: ${fixture.name}`, enabled, t => {
      compileConstant(t, fixture.source, engineVersion, fixture.expected);
    });
  }
}
