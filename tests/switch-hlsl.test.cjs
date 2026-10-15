const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { translate } = require('../packages/core/dist');

const candidates = process.env.DXC_PATH ? [process.env.DXC_PATH] : ['dxc', 'C:/VulkanSDK/1.4.350.0/Bin/dxc.exe'];
const dxc = candidates.find(candidate => spawnSync(candidate, ['-help'], { encoding: 'utf8', timeout: 10000 }).status === 0);
const enabled = { skip: dxc ? false : 'DXC not available; set DXC_PATH.' };
const expr = (type, id, props) => `Begin Object Class=/Script/Engine.MaterialExpression${type} Name="${id}"\n${props}\nEnd Object\n`;
const link = id => `(Expression=MaterialExpression'${id}')`;
// Hand-authored regression: the four-output user material is not available yet.
const source = expr('Constant', 'D', 'R=11') + expr('Constant', 'F', 'R=22') + expr('Constant', 'M', 'R=33')
  + expr('ShadingPathSwitch', 'Path', `Inputs(0)=${link('D')}\nInputs(1)=${link('F')}\nInputs(2)=${link('M')}\nMaterialExpressionEditorX=10\nMaterialExpressionEditorY=10`)
  + expr('Comment', 'Group', 'Text="Bypass on mobile"\nMaterialExpressionEditorX=0\nMaterialExpressionEditorY=0\nSizeX=100\nSizeY=100')
  + expr('FunctionOutput', 'Output', `A=${link('Path')}\nOutputName="Value"`);

function compile(t, result, define, expected, shouldFail = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-material-path-dxc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shader = path.join(directory, 'test.hlsl');
  const assembly = path.join(directory, 'test.ll');
  fs.writeFileSync(shader, result.hlsl + '\nfloat4 PSMain() : SV_Target { MaterialResult r=EvaluateMaterial(); return float4(r.Value, 0.0, 0.0, 1.0); }\n');
  const args = ['-T', 'ps_6_3', '-E', 'PSMain', '-HV', '2021', '-O3', '-Fo', path.join(directory, 'test.dxil'), '-Fc', assembly];
  if (define !== undefined) args.push('-D', `UE_MATERIAL_SHADING_PATH=${define}`);
  const compilation = spawnSync(dxc, [...args, shader], { encoding: 'utf8', timeout: 30000 });
  if (compilation.error) throw compilation.error;
  if (shouldFail) { assert.notEqual(compilation.status, 0, 'Unknown shading paths must never silently select Deferred.'); return; }
  assert.equal(compilation.status, 0, compilation.stderr + '\n' + result.hlsl);
  const text = fs.readFileSync(assembly, 'utf8');
  const value = /call void @dx\.op\.storeOutput\.f32\(i32 \d+, i32 \d+, i32 \d+, i8 0, float ([^)]+)\)/.exec(text)?.[1];
  assert.ok(value, text);
  const numeric = /^0x[0-9a-f]{16}$/i.test(value) ? Buffer.from(value.slice(2), 'hex').readDoubleBE(0) : Number(value);
  assert.equal(numeric, expected, 'The actual optimized shader must produce the selected path value.');
}

for (const engineVersion of ['5.5', '5.7']) {
  for (const moduleStyle of ['auto', 'scopes']) {
    test(`DXC ${engineVersion} ${moduleStyle}: each preserved path evaluates to its independent reference`, enabled, t => {
      const result = translate(source, { engineVersion, moduleStyle });
      assert.equal(result.status, 'external-dependencies', JSON.stringify(result.diagnostics));
      for (const [index, expected] of [11, 22, 33].entries()) compile(t, result, index, expected);
    });
  }
  test(`DXC ${engineVersion}: explicit shading paths compile without platform macros`, enabled, t => {
    for (const [index, shadingPath] of ['deferred', 'forward', 'mobile'].entries()) {
      const result = translate(source, { engineVersion, shadingPath });
      assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
      compile(t, result, undefined, [11, 22, 33][index]);
    }
  });
}
test('DXC rejects preserved shaders without a path, or with an invalid path', enabled, t => {
  const result = translate(source);
  compile(t, result, undefined, undefined, true);
  compile(t, result, 9, undefined, true);
});
