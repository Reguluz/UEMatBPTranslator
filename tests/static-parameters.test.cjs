const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { translate } = require('../packages/core/dist');

const expr = (type, id, properties = '', position) => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"\n${properties}\n${position ? `MaterialExpressionEditorX=${position[0]}\nMaterialExpressionEditorY=${position[1]}` : ''}\nEnd Object\n`;
const link = id => `(Expression="${id}")`;
const scalar = (id, value, position) => expr('Constant', id, `R=${value}`, position);
const vector = (id, x, y, z) => z === undefined ? expr('Constant2Vector', id, `R=${x}\nG=${y}`) : expr('Constant3Vector', id, `Constant=(R=${x},G=${y},B=${z},A=1)`);
const output = source => expr('FunctionOutput', 'Output', `A=${link(source)}\nOutputName="Value"`, [500, 500]);
const sw = (properties = '') => expr('StaticSwitchParameter', 'Switch', `A=${link('On')}\nB=${link('Off')}\nParameterName="UseDetail"\n${properties}`, [30, 10]);
const grouped = properties => scalar('On', 11, [10, 10]) + scalar('Off', 23, [20, 10]) + sw(properties) +
  expr('Comment', 'Group', 'Text="Detail Selection"\nSizeX=100\nSizeY=100', [0, 0]) + output('Switch');

// Source contract checked against UE5.5/5.7 GetEffectiveInput, Compile,
// DynamicBoolParameter, DynamicBranch and ForceCast in installed engine source.
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
const dxcEnabled = { skip: !dxc && 'DXC unavailable' };
function numeric(t, result, expression, expected, { defines = {}, args = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-static-parameter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'test.hlsl');
  const assembly = path.join(directory, 'test.ll');
  fs.writeFileSync(source, `${result.hlsl}\nfloat4 PSMain() : SV_Target { MaterialResult r = EvaluateMaterial(${args.join(', ')}); return ${expression}; }`);
  const compileArgs = ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-O3', '-Fo', path.join(directory, 'test.dxil'), '-Fc', assembly];
  for (const [key, value] of Object.entries(defines)) compileArgs.push('-D', `${key}=${value}`);
  const compilation = spawnSync(dxc, [...compileArgs, source], { encoding: 'utf8', timeout: 30000 });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, compilation.stderr + '\n' + result.hlsl);
  const stores = [...fs.readFileSync(assembly, 'utf8').matchAll(/call void @dx\.op\.storeOutput\.f32\(i32 \d+, i32 \d+, i32 \d+, i8 (\d+), float ([^)]+)\)/g)];
  const actual = new Map(stores.map(([, channel, value]) => [Number(channel), /^0x[0-9a-f]{16}$/i.test(value) ? Buffer.from(value.slice(2), 'hex').readDoubleBE() : Number(value)]));
  expected.forEach((value, channel) => assert.ok(Number.isFinite(actual.get(channel)) && Math.abs(actual.get(channel) - value) < 2e-6, `channel ${channel}: expected ${value}, actual ${actual.get(channel)}`));
}

for (const engineVersion of ['5.5', '5.7']) {
  for (const defaultValue of [false, true]) {
    test(`Static UE ${engineVersion}: default ${defaultValue} preserves both compile-time branches`, () => {
      const result = translate(grouped(`DefaultValue=${defaultValue ? 'True' : 'False'}`), { engineVersion });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      assert.match(result.hlsl, new RegExp(`#define UE_STATIC_UseDetail ${Number(defaultValue)}`));
      assert.match(result.hlsl, /#if UE_STATIC_UseDetail/);
      assert.equal(result.inputs.length, 0);
      assert.equal(result.materialSettings.StaticParameter_UseDetail, defaultValue);
      assert.equal(result.stats.reachableNodes, 4);
    });
  }
  for (const moduleStyle of ['auto', 'functions', 'scopes']) {
    test(`Static DXC UE ${engineVersion} ${moduleStyle}: macro overrides produce either branch`, dxcEnabled, t => {
      const result = translate(grouped('DefaultValue=False'), { engineVersion, moduleStyle });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      assert.ok(result.modules.some(m => m.id === 'Group' && m.mode === (moduleStyle === 'scopes' ? 'scope' : 'function')));
      numeric(t, result, 'float4(r.Value, 0, 0, 1)', [23, 0, 0, 1]);
      numeric(t, result, 'float4(r.Value, 0, 0, 1)', [11, 0, 0, 1], { defines: { UE_STATIC_UseDetail: 1 } });
    });
  }
  for (const selected of [false, true]) {
    test(`Static UE ${engineVersion}: explicit ${selected} only visits the selected algorithm`, () => {
      const source = selected ? scalar('On', 31) + expr('Custom', 'Off', 'Code="MissingFunction()"') + sw() + output('Switch') :
        expr('Custom', 'On', 'Code="MissingFunction()"') + scalar('Off', 47) + sw() + output('Switch');
      const result = translate(source, { engineVersion, staticParameters: { UseDetail: selected } });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      assert.doesNotMatch(result.hlsl, /UNRESOLVED|MissingFunction|#if UE_STATIC/);
      assert.equal(result.stats.reachableNodes, 3);
      assert.equal(result.materialSettings.StaticParameter_UseDetail, selected);
    });
  }
  test(`Static UE ${engineVersion}: override retains the structural requirement for both pins`, () => {
    const source = scalar('On', 1) + expr('StaticSwitchParameter', 'Switch', `A=${link('On')}\nParameterName="UseDetail"`) + output('Switch');
    const result = translate(source, { engineVersion, staticParameters: { UseDetail: true } });
    assert.equal(result.status, 'unsupported');
    assert.ok(result.diagnostics.some(d => d.severity === 'error' && /StaticSwitchParameter/.test(d.message)));
  });
  test(`Dynamic UE ${engineVersion}: runtime bool remains explicit and no macro is generated`, () => {
    const result = translate(grouped('DynamicBranch=True\nDefaultValue=True'), { engineVersion });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    assert.equal(result.inputs.length, 1);
    assert.deepEqual([result.inputs[0].name, result.inputs[0].type, result.inputs[0].defaultValue], ['UseDetail', 'bool', true]);
    assert.doesNotMatch(result.hlsl, /#if UE_STATIC/);
  });
  test(`Dynamic UE ${engineVersion}: static overrides cannot replace a runtime bool parameter`, () => {
    const result = translate(grouped('DynamicBranch=True\nDefaultValue=False'), { engineVersion, staticParameters: { UseDetail: true } });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    assert.equal(result.inputs.length, 1, 'DynamicBoolParameter does not read StaticParameters in UE.');
    assert.equal(result.inputs[0].type, 'bool');
  });
  test(`Dynamic DXC UE ${engineVersion}: float2 to float3 conversion appends zero and selects correctly`, dxcEnabled, t => {
    const result = translate(vector('On', 2, 3) + vector('Off', 5, 7, 11) + sw('DynamicBranch=True') + output('Switch'), { engineVersion });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    assert.equal(result.outputs[0].type, 'float3');
    numeric(t, result, 'float4(r.Value, 1)', [2, 3, 0, 1], { args: ['true'] });
    numeric(t, result, 'float4(r.Value, 1)', [5, 7, 11, 1], { args: ['false'] });
  });
  for (const missing of ['A', 'B']) {
    test(`Dynamic DXC UE ${engineVersion}: missing ${missing} returns the available branch`, dxcEnabled, t => {
      const source = scalar('Available', 17) + expr('StaticSwitchParameter', 'Switch', `${missing === 'A' ? 'B' : 'A'}=${link('Available')}\nDynamicBranch=True\nParameterName="UseDetail"`) + output('Switch');
      const result = translate(source, { engineVersion });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      numeric(t, result, 'float4(r.Value, 0, 0, 1)', [17, 0, 0, 1], { args: result.inputs.map(() => 'false') });
    });
  }
  for (const dynamic of [false, true]) {
    test(`${dynamic ? 'Dynamic' : 'Static'} DXC UE ${engineVersion}: boolean branches retain boolean result type`, dxcEnabled, t => {
      const source = expr('StaticBool', 'On', 'Value=True') + expr('StaticBool', 'Off', 'Value=False') + sw(`DynamicBranch=${dynamic ? 'True' : 'False'}\nDefaultValue=False`) + output('Switch');
      const result = translate(source, { engineVersion });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      assert.equal(result.outputs[0].type, 'bool');
      numeric(t, result, 'float4(r.Value ? 1.0 : 0.0, 0, 0, 1)', [0, 0, 0, 1], { args: dynamic ? ['false'] : [] });
      numeric(t, result, 'float4(r.Value ? 1.0 : 0.0, 0, 0, 1)', [1, 0, 0, 1], dynamic ? { args: ['true'] } : { defines: { UE_STATIC_UseDetail: 1 } });
    });
  }
}

test('same-name static parameters share a macro and report inconsistent defaults', () => {
  const source = scalar('On', 1) + scalar('Off', 2) + sw('DefaultValue=True') +
    expr('StaticSwitchParameter', 'Second', `A=${link('On')}\nB=${link('Off')}\nParameterName="UseDetail"\nDefaultValue=False`);
  const result = translate(source, { outputs: ['Switch', 'Second'] });
  assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
  assert.equal([...result.hlsl.matchAll(/#define UE_STATIC_UseDetail /g)].length, 1);
  assert.ok(result.diagnostics.some(d => d.code === 'STATIC_DEFAULT_CONFLICT'));
});
