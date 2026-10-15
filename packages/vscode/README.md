# UE Material Translator

将 UE 5.5 / UE 5.7 材质图中复制的节点文本转换为便于理解的 HLSL。转换在本地完成，运行时无需安装 Unreal Engine。

## 安装

按 **Ctrl+Shift+P** 或 **F1** 打开 VSCode 命令面板，执行 `Extensions: Install from VSIX...`，选择项目生成的 `ue-material-translator-0.1.2.vsix`。安装旧版本的用户可通过同一入口更新，再执行 `Developer: Reload Window`。

从源码构建时，在仓库根目录运行 `npm install`、`npm run build`，再运行项目提供的 VSIX 打包命令。也可以从 `packages/vscode` 执行 `npm run package`；该命令调用根目录的 `build:extension`。

## 使用

1. 在材质编辑器中框选节点，尽量包含注释框与命名中继，复制文本。
2. 在设置中选择 `UE Material Translator: Engine Version`（5.5 或 5.7）。
3. 在 VSCode 命令面板执行 `UE Material: 翻译剪贴板中的材质节点`。也可将文本粘贴到文件后执行“翻译当前文件”或“翻译当前选区”。
4. 首次翻译直接显示核心默认输出，不弹出选择框。需要查看中间结果或其他端口时，使用生成文档顶部的“重新选择算法输出”按钮，勾选一个或多个输出。取消选择将保留已有结果。
5. 左侧展示只读原始文本快照，右侧展示只读 HLSL。未完整转换时会出现警告通知，点击“查看诊断”打开 `UE Material Translator` 输出频道，查看具体原因、节点 ID 和原文行号；“打开 Problems”定位原节点。右侧编辑器的大纲按模块组织。
6. 在生成代码上使用“转到定义”（F12），或执行 `UE Material: 跳转到当前算法的原始节点` 回看节点文本。
7. 使用 `UE Material: 重新选择算法输出` 调整输出；使用 `UE Material: 保存生成的 HLSL` 导出。

诊断与来源跳转在原文件没有修改时定位原文件；原文件发生变化后定位保存的只读快照，避免使用过期行号。翻译选区时会考虑选区在原文件中的起始行与列。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `ueMaterialTranslator.engineVersion` | `5.7` | 源 UE 版本，支持 `5.5`、`5.7` |
| `ueMaterialTranslator.moduleStyle` | `auto` | `auto`、`scopes`、`functions`；函数提取仍受依赖安全约束 |
| `ueMaterialTranslator.shadingPath` | `preserve` | 保留 `ShadingPathSwitch` 全部分支；也可明确选择 `deferred`、`forward` 或 `mobile`，重新翻译后生效 |
| `ueMaterialTranslator.staticParameters` | `{}` | 静态参数实际名称到布尔值的覆盖，例如 `{"UseNoise3":true}`；省略时保留编译期宏与默认值 |
| `ueMaterialTranslator.externalInputTypes` | `{}` | 缺失上游节点的已知真实类型，以节点 ID 或 `ID:输出端口索引` 为键 |
| `ueMaterialTranslator.moduleAssignments` | `{}` | 节点 ID 到注释框 ID 的手动归属；`null` 将节点移出模块 |

框选复制缺少上游节点且无法推断类型时，先查看诊断给出的来源，再在设置 JSON 中填写已知类型，例如：

```json
"ueMaterialTranslator.externalInputTypes": {
  "MaterialExpressionVectorParameter_0:0": "float4"
}
```

然后重新翻译。支持 `float`、`float2`、`float3`、`float4`、`bool`、`Texture2D`、`Texture3D` 和 `SamplerState`。请按原节点的真实类型填写。

注释框重叠或自动归属不符合原意时，在设置 JSON 中按真实节点 ID 调整，然后重新翻译：

```json
"ueMaterialTranslator.moduleAssignments": {
  "MaterialExpressionMultiply_0": "MaterialExpressionComment_0",
  "MaterialExpressionConstant_0": null
}
```

上例把乘法节点放入指定注释框，并将常量节点移出模块。注释框 ID 可在原始文本中查看；无效 ID 会由核心报告诊断。

材质包含 `ShadingPathSwitch`（例如注释为“Bypass on mobile”的区域）时，默认 `preserve` 会在 HLSL 中保留各路径的算法，并报告需要显式定义 `UE_MATERIAL_SHADING_PATH` 的外部依赖。若只想展开桌面延迟渲染路径，在设置 JSON 中指定 `"ueMaterialTranslator.shadingPath": "deferred"`，然后重新翻译；`forward` 和 `mobile` 分别展开前向渲染和移动路径。该设置描述渲染路径，不由 UE 版本推断。

## 输出边界

0.1.2 已加入真实云材质回归，补齐 Texture3D、云采样上下文、独立体积输出、If/Power/Rotator、静态开关和五个标准 Engine 函数契约，并修复重命名端口丢失默认通道掩码的问题。独立体积节点的七项算法输出与已连接的根节点属性一起保留。

输出用于学习和算法阅读。坐标、时间及纹理资源可能成为显式输入；外部材质函数正文不会自动从 `.uasset` 中读取。完整性以警告通知、输出频道与 Problems 中的诊断为准。存在未知语义时，生成代码仍保留 `#error UE_MATERIAL_TRANSLATION_INCOMPLETE`，不能作为完整着色器编译。未知节点、未复制的依赖和不支持的语义不会被静默当作常量零。

扩展不持续读取剪贴板，只在用户执行相应命令时读取；不执行复制文本内的 Custom HLSL；不修改或覆盖输入文本。保存时使用 VSCode 的标准保存对话框，由用户选择输出位置。
