# UE Material Translator

把 UE 材质编辑器中复制的节点文本转换为便于学习、阅读和代码审查的 HLSL。转换核心、命令行工具和 VSCode 插件均在本地运行，不需要启动 Unreal Engine，也不调用大模型或上传材质文本。

提供 UE **5.5** 和 **5.7** 版本档案。0.1.2 使用真实 `m_SimpleVolumetricCloud` 节点文本作为回归样本，并依据本机两版引擎源码补齐体积纹理、云采样、内置函数与数学规则。规则对齐默认材质编译器；版本选择不代表全部节点或实验性 MaterialIR 路径已经验证。DXC 检查也不替代 UE 渲染画面对照。

## 开始使用

构建和打包需要 Node.js **22.12 或更新版本**以及 npm，当前已在 Node.js 24.4.0 上验证。打包依赖通过 CommonJS 加载 ESM，需要该版本起默认启用的 [`require(esm)` 支持](https://r2.nodejs.org/docs/v22.12.0/api/modules.html#loading-ecmascript-modules-using-require)。

```powershell
npm install
npm run build
npm test
npm run package:vscode
```

`npm test` 在发现 DXC 时，还会把核心输出包装成实际像素着色器并编译为 DXIL，覆盖数学链、通道、纹理采样和模块组织；常量图另从优化字节码读取输出，与手工参考结果对照。可通过 `DXC_PATH` 指定编译器路径；缺少 DXC 时，这组测试会明确显示跳过。此检查不替代 UE 引擎数值或图像对照。

单独运行编译验证：`node --test tests/hlsl.test.cjs`。当前本机 DXC 验证已通过，覆盖两个版本档案和上述生成路径。

从仓库运行 CLI：

```powershell
node packages/cli/dist/index.js docs/examples/annotated-mask.txt --engine 5.5 --out material.hlsl --report material.report.json
```

`docs/examples/annotated-mask.txt` 是手工构造的示例，用于演示注释模块和参数运算，不是从 UE 实际导出的资产。生产使用时，请在材质编辑器框选所需节点，尽量同时选择相关注释框，再复制并保存为 UTF-8 文本。

## 命令行

```text
ue-material [input.txt|-] [options]

--engine 5.5|5.7               默认 5.7
--shading-path preserve|deferred|forward|mobile
                              默认 preserve，保留 ShadingPathSwitch 的各路径
--out <file.hlsl>              保存 HLSL；省略时写入标准输出
--report <file.json>           保存完整结果，包括 HLSL、诊断和来源映射
--output <candidate-id>        选择输出，可重复；省略时使用各末端节点的首个输出
--input-type <source-id=type>  指定未复制上游的类型，可重复
--static-parameters <json>     读取静态参数名到布尔值的 JSON 文件
--module <node-id=comment-id>  手动调整模块归属，可重复；comment-id 为 - 时取消分组
--list-outputs                仅将候选输出列表写为 JSON
--module-style auto|scopes|functions
--strict                      转换结果非 complete 时失败
--help
```

仓库安装后也可通过 `npm exec -- ue-material ...` 调用工作区命令。

```powershell
# 查看可选择的末端输出，再把列表中的真实 id 传给 --output
node packages/cli/dist/index.js copied.txt --list-outputs

# 部分复制：声明报告中缺失源的类型
node packages/cli/dist/index.js copied.txt --input-type MissingParameter=float3 --out material.hlsl

# 只阅读已明确选择的桌面延迟渲染路径
node packages/cli/dist/index.js copied.txt --shading-path deferred --out material.hlsl

# 修正注释框归属；ID 取自报告中的节点与模块信息
node packages/cli/dist/index.js copied.txt --module MaterialExpressionMultiply_0=MaterialExpressionComment_0

# 管道输入；报告与 HLSL 分开保存
Get-Content -Raw -Encoding UTF8 copied.txt | node packages/cli/dist/index.js --engine 5.7 --out material.hlsl --report report.json
```

`--input-type` 的键是报告中的外部源 ID，也可以是 `源ID:输出序号`。类型限 `float`、`float2`、`float3`、`float4`、`bool`、`Texture2D`、`Texture3D`。工具不会把类型未知的缺失连接静默当作标量。

静态参数文件例如 `{"UseNoise3": true}`，按实际 ParameterName 匹配。未覆盖的 StaticSwitchParameter 生成编译期宏及原始默认值；带 DynamicBranch 的节点仍为运行时 bool 参数。

诊断写入标准错误，便于将标准输出直接保存为 HLSL。`--out`、`--report` 不能覆盖输入文件，也不能指向同一文件。父目录须已存在。退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 完整转换；或默认模式下仅存在明确的外部依赖 |
| `1` | 不支持的语义；或 `--strict` 下存在任何不完整结果 |
| `2` | 参数、文件读取或文件写入错误 |

即使退出码是 `1`，仍可写出 HLSL 和报告供审阅。不要仅凭输出文件存在就判断转换成功。

## VSCode 插件

运行 `npm run package:vscode` 生成 `artifacts/ue-material-translator-0.1.2.vsix`，然后在 VSCode 扩展菜单中执行 **Install from VSIX…**，选择该安装包。此项目不会自动安装插件或发布到 Marketplace。

按 **Ctrl+Shift+P** 或 **F1** 打开命令面板，搜索 **UE Material**，执行 **翻译当前文件** 或 **翻译剪贴板中的材质节点**。扩展显示生成的 HLSL、转换诊断和模块结构，支持选择输出并回溯相应输入节点。具体命令和设置见 [VSCode 使用说明](docs/vscode.md)。

## 理解转换结果

输出是用于理解计算的独立 HLSL 函数，不是 UE 完整生成的材质着色器。材质输入参数、UV、时间、纹理及其他运行环境数据通过显式输入表达。多个输出用结构体表达，共享计算保留为局部变量，避免重复展开。

| 状态 | 含义 |
| --- | --- |
| `complete` | 当前已支持规则范围内，所选算法和类型均可恢复 |
| `external-dependencies` | 算法包含已明确标识的外部输入或资源条件，需调用者补充 |
| `unsupported` | 存在未知节点、未知类型、缺失函数正文或其他无法可靠恢复的语义 |

`complete` 也不是与 UE 渲染结果等价的证明。纹理资源格式、sRGB 解码、采样器状态、屏幕导数和运行环境会影响结果；诊断和报告列出的条件必须一同阅读。

`ShadingPathSwitch` 默认按 `preserve` 保留 Deferred、Forward 和 Mobile 分支，不自动选择桌面路径。生成结果需要调用者定义宏 `UE_MATERIAL_SHADING_PATH`：`0` 为 Deferred，`1` 为 Forward，`2` 为 Mobile；未定义或取值无效时 HLSL 会 `#error`。仅由此产生的状态为 `external-dependencies`；若分支中还有未知语义，则仍为 `unsupported`。阅读单一路径可设置 CLI 的 `--shading-path deferred|forward|mobile` 或 VSCode 的 `ueMaterialTranslator.shadingPath`，再重新转换。明确选择路径时，只转换该路径的已连接输入；该端口未连接才回退到 `Default`。

遇到不支持的节点时，现在仍遍历并保留可恢复的上游计算，帮助继续阅读；未知节点本身保留 `UNRESOLVED_...` 占位，状态仍是 `unsupported`，并生成阻止编译的 `#error`。生成代码头部会列出错误原因，完整诊断见 JSON 报告或 VSCode **输出 → UE Material Translator**，其中包含诊断代码、节点和原文位置。

注释框用于推断模块。`auto` 尝试提取依赖清晰的函数；`scopes` 使用局部作用域；`functions` 请求提取函数，但遇到交错依赖时仍保留可安全表达的结构并给出原因。节点说明保留为注释；Named Reroute 按声明引用恢复数据流。模块几何关系含歧义时，不承诺原作者意图可以完全自动恢复。

可用 `--module 节点ID=注释框ID` 显式修正归属，或用 `--module 节点ID=-` 取消该节点的分组。手动调整只影响模块组织，不改动数据连接。

## 当前边界

- 支持列表与具体默认值见 [节点与语义说明](docs/supported-nodes.md)。未知节点不会被零值替代。
- 0.1.2 的真实回归覆盖四个材质属性及 VolumetricAdvancedMaterialOutput 的七项独立输出，避免遗漏相位、多重散射和保守密度算法。生成样例见 `artifacts/volumetric-cloud.hlsl`。
- Material Function 仅对五个精确 Engine 路径和匹配接口应用已核对的标准语义：Km-to-Cm、MakeFloat3/4、BreakOutFloat3/4Components。其他函数仍需要正文；运行工具不会读取 `.uasset`。同名项目函数不会自动套用标准规则。
- Custom 节点可能依赖引擎 helper、include 或外部定义。正文可读并不意味着它能在引擎外编译。
- 暂不承诺 Substrate、Landscape、复杂场景采样及全部引擎专有节点的语义恢复。
- 输入包含材质根节点连线时，默认输出对应已连接的材质属性，并保留独立体积自定义输出；否则优先 FunctionOutput 和体积输出，再取各末端节点的首个端口。候选列表还包含中间节点和其他端口，可显式选择。
- DXC 语法检查和与真实 UE 材质的数值/图像对照是不同层次的验证。当前自动化测试不替代真实引擎对照。

## 项目结构

```text
packages/core/     文本解析、图恢复、类型推导、模块划分和 HLSL 生成
packages/cli/      文件/标准输入、输出选择、诊断和 JSON 报告
packages/vscode/   编辑器交互和来源导航
tests/            合成与真实文本回归、DXC 数值/编译验证和 CLI/扩展集成测试
docs/             使用说明、支持边界和合成样例
```

核心 API 与实现约定见 [架构说明](docs/architecture.md)。
