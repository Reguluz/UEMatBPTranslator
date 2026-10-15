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
const volume = (properties = '', position) => expr('VolumetricAdvancedMaterialOutput', 'Volume', properties, position);
const root = properties => `Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Root Name="Root"\n${properties}\nEnd Object\n`;
const slots = ['PhaseG', 'PhaseG2', 'PhaseBlend', 'MultiScatteringContribution', 'MultiScatteringOcclusion', 'MultiScatteringEccentricity', 'ConservativeDensity'];

// UE5.5/5.7 source: MaterialExpressions.cpp custom output returns seven slots;
// ConservativeDensity uses ForceCast(Float4), with scalar replication and vector
// zero extension. VolumetricCloud.usf consumes slots 0..5 as scalar floats.
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
function numeric(t, result, expression, expected) {
  assert.equal(result.inputs.length, 0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-volume-output-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'test.hlsl');
  const assembly = path.join(directory, 'test.ll');
  fs.writeFileSync(source, `${result.hlsl}\nfloat4 PSMain() : SV_Target { MaterialResult r = EvaluateMaterial(); return ${expression}; }`);
  const compilation = spawnSync(dxc, ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-O3', '-Fo', path.join(directory, 'test.dxil'), '-Fc', assembly, source], { encoding: 'utf8', timeout: 30000 });
  if (compilation.error) throw compilation.error;
  assert.equal(compilation.status, 0, compilation.stderr + '\n' + result.hlsl);
  const stores = [...fs.readFileSync(assembly, 'utf8').matchAll(/call void @dx\.op\.storeOutput\.f32\(i32 \d+, i32 \d+, i32 \d+, i8 (\d+), float ([^)]+)\)/g)];
  const actual = new Map(stores.map(([, channel, value]) => [Number(channel), /^0x[0-9a-f]{16}$/i.test(value) ? Buffer.from(value.slice(2), 'hex').readDoubleBE() : Number(value)]));
  expected.forEach((value, channel) => assert.ok(Number.isFinite(actual.get(channel)) && Math.abs(actual.get(channel) - value) < 2e-6, `channel ${channel}: expected ${value}, actual ${actual.get(channel)}`));
}
const complete = result => assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));

for (const engineVersion of ['5.5', '5.7']) {
  test(`Volume UE ${engineVersion}: a standalone output exports all seven slots`, () => {
    const result = translate(volume(), { engineVersion });
    complete(result);
    assert.deepEqual(result.outputs.map(o => [o.nodeId, o.outputIndex, o.name, o.type]), slots.map((slot, index) => ['Volume', index, `Volume_${slot}`, index === 6 ? 'float4' : 'float']));
    assert.equal(result.stats.reachableNodes, 1);
    assert.equal(result.stats.expressions, 7);
  });
  test(`Volume UE ${engineVersion}: root sinks also retain the independent custom output`, () => {
    const source = scalar('Color', 0.25) + root(`Albedo=${link('Color')}`) + scalar('Density', 0.75) + volume(`ConservativeDensity=${link('Density')}`);
    const result = translate(source, { engineVersion });
    complete(result);
    assert.equal(result.outputs.length, 8);
    assert.ok(result.outputs.some(o => o.nodeId === 'Root' && o.name === 'Albedo'));
    for (const [index, slot] of slots.entries()) assert.ok(result.outputs.some(o => o.nodeId === 'Volume' && o.outputIndex === index && o.name === `Volume_${slot}`));
    assert.ok(result.sourceMap.some(m => m.nodeId === 'Density'));
  });
  test(`Volume UE ${engineVersion}: explicit FunctionOutput sinks also retain the independent custom output`, () => {
    const source = scalar('Value', 0.25) + expr('FunctionOutput', 'Output', `A=${link('Value')}\nOutputName="Value"`) + volume();
    const result = translate(source, { engineVersion });
    complete(result);
    assert.equal(result.outputs.length, 8);
    assert.equal(result.outputs.filter(o => o.nodeId === 'Volume').length, 7);
  });
  test(`Volume UE ${engineVersion}: output selection can inspect just density without visiting other slots`, () => {
    const source = expr('Custom', 'UnknownPhase', 'Code="NotAvailable()"') + scalar('Density', 0.75) + volume(`PhaseG=${link('UnknownPhase')}\nConservativeDensity=${link('Density')}`);
    const result = translate(source, { engineVersion, outputs: ['Volume:6'] });
    complete(result);
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].name, 'Volume_ConservativeDensity');
    assert.equal(result.stats.reachableNodes, 2);
    assert.doesNotMatch(result.hlsl, /NotAvailable|UNRESOLVED/);
  });
  test(`Volume UE ${engineVersion}: renderer settings retain defaults and serialized overrides`, () => {
    const defaults = translate(volume(), { engineVersion });
    complete(defaults);
    assert.deepEqual(defaults.materialSettings.VolumetricAdvancedMaterialOutput, {
      PerSamplePhaseEvaluation: false, MultiScatteringApproximationOctaveCount: 0,
      bGroundContribution: false, bGrayScaleMaterial: false, bRayMarchVolumeShadow: true,
      bClampMultiScatteringContribution: true,
    });
    const overridden = translate(volume('PerSamplePhaseEvaluation=True\nMultiScatteringApproximationOctaveCount=2\nbGroundContribution=True\nbGrayScaleMaterial=True\nbRayMarchVolumeShadow=False\nbClampMultiScatteringContribution=False'), { engineVersion });
    complete(overridden);
    assert.deepEqual(overridden.materialSettings.VolumetricAdvancedMaterialOutput, {
      PerSamplePhaseEvaluation: true, MultiScatteringApproximationOctaveCount: 2,
      bGroundContribution: true, bGrayScaleMaterial: true, bRayMarchVolumeShadow: false,
      bClampMultiScatteringContribution: false,
    });
  });
  test(`Volume DXC UE ${engineVersion}: default phase and multiscattering values match source`, dxcEnabled, t => {
    const result = translate(volume(), { engineVersion });
    complete(result);
    numeric(t, result, 'float4(r.Volume_PhaseG, r.Volume_PhaseG2, r.Volume_PhaseBlend, 1)', [0, 0, 0, 1]);
    numeric(t, result, 'float4(r.Volume_MultiScatteringContribution, r.Volume_MultiScatteringOcclusion, r.Volume_MultiScatteringEccentricity, 1)', [0.5, 0.5, 0.5, 1]);
    numeric(t, result, 'r.Volume_ConservativeDensity', [1, 1, 1, 0]);
  });
  test(`Volume DXC UE ${engineVersion}: serialized phase constants and connected first components are respected`, dxcEnabled, t => {
    const source = expr('Constant3Vector', 'G', 'Constant=(R=0.25,G=0.5,B=0.75,A=1)') + volume(`PhaseG=${link('G')}\nConstPhaseG2=-0.25\nConstPhaseBlend=0.75\nConstMultiScatteringContribution=0.125\nConstMultiScatteringOcclusion=0.25\nConstMultiScatteringEccentricity=0.875`);
    const result = translate(source, { engineVersion });
    complete(result);
    numeric(t, result, 'float4(r.Volume_PhaseG, r.Volume_PhaseG2, r.Volume_PhaseBlend, 1)', [0.25, -0.25, 0.75, 1]);
    numeric(t, result, 'float4(r.Volume_MultiScatteringContribution, r.Volume_MultiScatteringOcclusion, r.Volume_MultiScatteringEccentricity, 1)', [0.125, 0.25, 0.875, 1]);
  });
  for (const fixture of [
    { name: 'scalar replicated', source: scalar('Density', 0.25), expected: [0.25, 0.25, 0.25, 0.25] },
    { name: 'float2 padded', source: expr('Constant2Vector', 'Density', 'R=0.25\nG=0.5'), expected: [0.25, 0.5, 0, 0] },
    { name: 'float3 padded', source: expr('Constant3Vector', 'Density', 'Constant=(R=0.25,G=0.5,B=0.75,A=1)'), expected: [0.25, 0.5, 0.75, 0] },
    { name: 'float4 retained', source: expr('Constant4Vector', 'Density', 'Constant=(R=0.25,G=0.5,B=0.75,A=0.875)'), expected: [0.25, 0.5, 0.75, 0.875] },
  ]) {
    test(`Volume DXC UE ${engineVersion}: ConservativeDensity ${fixture.name}`, dxcEnabled, t => {
      const result = translate(fixture.source + volume(`ConservativeDensity=${link('Density')}`), { engineVersion });
      complete(result);
      assert.equal(result.outputs.find(o => o.outputIndex === 6).type, 'float4');
      numeric(t, result, 'r.Volume_ConservativeDensity', fixture.expected);
    });
  }
  for (const moduleStyle of ['auto', 'functions', 'scopes']) {
    test(`Volume DXC UE ${engineVersion} ${moduleStyle}: grouped upstream computation remains an exported density`, dxcEnabled, t => {
      const source = scalar('DensitySource', 0.25, [10, 10]) + expr('Multiply', 'Density', `A=${link('DensitySource')}\nConstB=2`, [20, 10]) +
        volume(`ConservativeDensity=${link('Density')}`, [30, 10]) + expr('Comment', 'Group', 'Text="Density Shape"\nSizeX=100\nSizeY=100', [0, 0]);
      const result = translate(source, { engineVersion, moduleStyle });
      complete(result);
      assert.ok(result.modules.some(m => m.id === 'Group' && m.mode === (moduleStyle === 'scopes' ? 'scope' : 'function')));
      numeric(t, result, 'r.Volume_ConservativeDensity', [0.5, 0.5, 0.5, 0.5]);
      assert.ok(result.sourceMap.some(m => m.nodeId === 'Density' && m.moduleId === 'Group'));
    });
  }
}
