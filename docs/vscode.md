# VSCode 使用说明

扩展的命令面板前缀是 **UE Material:**。

## 安装与转换

1. 在仓库执行 `npm install`、`npm run package:vscode`。
2. 在 VSCode 扩展视图的菜单中选择 **Install from VSIX…**，安装 `artifacts/ue-material-translator-0.1.2.vsix`。已有旧版时选择同一安装入口更新，必要时执行 **Developer: Reload Window** 重新加载。
3. 在 UE 材质编辑器选择节点和相关注释框，执行复制。
4. 按 **Ctrl+Shift+P** 或 **F1** 打开 VSCode 命令面板，搜索 **UE Material**，执行 **UE Material: 翻译剪贴板中的材质节点**。菜单入口也可使用 **查看 → 命令面板…**。

也可以将文本保存在文件中，执行 **翻译当前文件**；只想分析一部分文本时，选择完整的节点对象块，再执行 **翻译当前选区**。

扩展在左侧保留输入文本快照，在右侧显示生成的 HLSL。首次转换直接使用核心的默认输出：优先材质根节点已连接属性，其次 FunctionOutput，最后使用各末端节点的首个输出。需要选择其他端口或中间节点时，执行 **重新选择算法输出**，在多选列表中勾选所需项并重新生成。

## 阅读、诊断与保存

- **Problems** 显示转换诊断，包括未知节点、缺失依赖、类型和模块划分问题。
- **输出 → UE Material Translator** 显示本次转换状态及完整诊断，每项包含严重性、诊断代码、节点、原文位置和原因；不完整结果的提示中可点击 **查看诊断** 或 **打开 Problems**。
- **Outline** 显示生成结果的模块和输出结构。
- 在生成的 HLSL 上按 **F12**，或执行 **跳转到当前算法的原始节点**，定位对应的输入节点。
- 执行 **保存生成的 HLSL** 将当前结果保存为 `.hlsl`。

当输入文件已经变化时，来源导航使用转换时的文本快照。快照帮助解释已有结果；修改原文后需要再次转换，才能生成新的算法和映射。

## 设置

在 VSCode 设置中搜索 `ueMaterialTranslator`，或编辑工作区 `settings.json`：

```json
{
  "ueMaterialTranslator.engineVersion": "5.7",
  "ueMaterialTranslator.shadingPath": "preserve",
  "ueMaterialTranslator.moduleStyle": "auto",
  "ueMaterialTranslator.staticParameters": {
    "UseNoise3": false
  },
  "ueMaterialTranslator.externalInputTypes": {
    "MissingParameter": "float3"
  },
  "ueMaterialTranslator.moduleAssignments": {
    "MaterialExpressionMultiply_0": "MaterialExpressionComment_0",
    "MaterialExpressionConstant_0": null
  }
}
```

| 设置 | 用途 |
| --- | --- |
| `engineVersion` | `'5.5'` 或 `'5.7'`，默认 `'5.7'` |
| `shadingPath` | `'preserve'`、`'deferred'`、`'forward'` 或 `'mobile'`；默认保留 ShadingPathSwitch 全部路径，不假设当前工程配置 |
| `staticParameters` | 实际静态参数名到布尔值的覆盖；省略的静态参数保留宏和原始默认值 |
| `moduleStyle` | `'auto'`、`'scopes'` 或 `'functions'` |
| `externalInputTypes` | 为未复制的上游源声明类型；键为源 ID 或 `源ID:输出序号` |
| `moduleAssignments` | 节点 ID 到注释框 ID 的归属覆盖；`null` 表示取消该节点分组 |

扩展接受的外部输入类型有 `float`、`float2`、`float3`、`float4`、`bool`、`Texture2D`、`Texture3D` 和 `SamplerState`。请使用诊断中的源 ID，不要根据节点显示标题猜测 ID。

模块模式是生成偏好。无法安全提取函数时，工具保留计算依赖顺序，并在报告中解释实际采用的模式。

修改着色路径、输入类型或模块归属设置后，需要重新转换。模块 ID 可从 CLI 报告或输入文本中的 MaterialExpressionComment 名称获得；归属设置只影响生成组织，不改变计算连线。

## ShadingPathSwitch 与不完整输出

默认 `preserve` 生成 Deferred、Forward 和 Mobile 分支。阅读单一桌面延迟路径时，将 `ueMaterialTranslator.shadingPath` 改为 `deferred` 后重新翻译；桌面前向使用 `forward`，移动路径使用 `mobile`。显式选择只遍历对应端口；端口未连接才使用 Default，不会自动拿 Default 替换已连接但缺少上游的输入。

编译保留版 HLSL 须由调用者定义宏 `UE_MATERIAL_SHADING_PATH`，`0` 为 Deferred、`1` 为 Forward、`2` 为 Mobile。未定义或取值无效时，生成代码中的 `#error` 会要求补充配置。这一要求本身对应“带外部依赖”，不表示节点不支持；若完整诊断还包含未知语义，结果仍为 `unsupported`。各路径的具体规则和已核实文档见 [节点说明](supported-nodes.md#着色路径分支)。

如果出现 `UE_MATERIAL_TRANSLATION_INCOMPLETE`，先阅读生成代码头部的错误摘要，再查看输出通道中的具体节点和原因。未知节点会保留可恢复的上游计算，仍以 `UNRESOLVED_...` 标记缺失语义并阻止编译；不能只删除 `#error` 后将其视为完整算法。0.1.2 已加入真实云材质整图回归，包含体积纹理、云上下文和独立体积输出。

本地 VSIX 不包含 UE 编辑器集成，也不读取 `.uasset`。转换质量取决于复制文本是否包含相关计算、注释和可解析的依赖。
