# 架构与核心接口

三个 npm 工作区共用独立 TypeScript 核心。CLI 和 VSCode 插件不各自实现材质语义；修改节点规则应在核心中完成。

```text
UE 复制文本
    ↓
对象解析：Begin/End Object、同名对象重新打开、属性及嵌套值
    ↓
表达式图：节点 ID、输入连接、输出端口、分量掩码
    ↓
类型与节点语义：默认输入、显式外部输入、未知语义诊断
    ↓
模块：注释框归属、Named Reroute、依赖边界
    ↓
HLSL：拓扑顺序、共享变量、模块函数/作用域、来源映射
```

## 使用核心

```typescript
import { translate } from '@ue-material-translator/core';

const result = translate(clipboardText, {
  engineVersion: '5.7',
  shadingPath: 'preserve',
  moduleStyle: 'auto',
  externalInputs: { MissingParameter: 'float3' },
});

console.log(result.hlsl);
console.log(result.status, result.diagnostics);
```

`TranslationOptions`：

| 字段 | 类型/用途 |
| --- | --- |
| `engineVersion` | `'5.5' \| '5.7'`；默认 `'5.7'` |
| `shadingPath` | `'preserve' \| 'deferred' \| 'forward' \| 'mobile'`；默认 `'preserve'`，控制 ShadingPathSwitch 的保留或静态选择 |
| `staticParameters` | 静态参数名到 boolean 的映射；省略时保留编译期宏与节点默认值 |
| `outputs` | 候选 ID 数组；默认优先材质根节点的已连接属性，其次 FunctionOutput，最后保留各末端节点的首个输出 |
| `moduleStyle` | `'auto' \| 'scopes' \| 'functions'` |
| `functionName` | 顶层 HLSL 函数的期望名称，由核心清理为合法标识符 |
| `externalInputs` | 外部源 ID 或 `源ID:输出序号` 到值类型的映射 |
| `moduleAssignments` | 节点 ID 到注释框 ID 的映射；值为 `null` 时取消该节点分组 |

完整结果包括：

- `hlsl`、`status`、`engineVersion`。
- `diagnostics`：严重性、稳定代码、说明、可选节点 ID 和原文行号。
- `inputs`：参数、上下文、资源和外部输入。
- `outputs`：本次选择的输出；`candidates`：可选输出及 ID。
- `modules`：模块名称、节点集合、实际生成模式和必要时的回退原因。
- `sourceMap`：生成 HLSL 行到输入文本行的对应关系。
- `stats`：节点、可达节点和生成表达式数量。
- `materialSettings`：独立体积输出的渲染配置及已用静态参数值。

所有行号从 **1** 开始，范围端点均包含在内。来源映射可供编辑器导航，不插入大量节点标识到 HLSL 正文。

## 着色路径和未知节点

`ShadingPathSwitch` 根据 `Inputs(0)`、`Inputs(1)`、`Inputs(2)` 恢复 Deferred、Forward、Mobile 输入；序列化属性优先，缺少对应属性时才允许通过图 Pin 名称恢复连接。特定路径端口未连接时使用 `Default`，已连接但上游未复制时保留缺失依赖，不能以 `Default` 替换。

默认 `shadingPath: 'preserve'` 保留三个路径的算法与预处理选择，使用 `UE_MATERIAL_SHADING_PATH=0/1/2` 表示 Deferred/Forward/Mobile。宏未定义或取值无效会触发生成代码中的 `#error`；这属于显式的外部配置契约，单独存在时返回 `external-dependencies`。保留模式分析全部分支，任何分支内的未知语义仍可使结果成为 `unsupported`。显式选择 `'deferred'`、`'forward'` 或 `'mobile'` 时，仅遍历所选的覆盖输入或 `Default`，不因未选分支的未知节点额外失败。

未知表达式是语义边界，但不会截断图遍历。核心继续恢复其连接上游并将结果作为 `UNRESOLVED_...(...)` 的可见输入；占位不代表算法已实现。错误诊断决定 `unsupported` 状态，并在代码头部输出诊断代码、节点与原因以及 `#error`。CLI 的标准错误和 JSON 报告、VSCode 的 Problems 与输出通道提供完整诊断。

字段与枚举依据见 [节点语义说明](supported-nodes.md#着色路径分支)。0.1.2 已使用真实云材质导出文本回归，独立体积输出与普通根节点一起作为默认算法出口。

## 扩展和验证

新增节点时必须同时明确输入默认值、输入输出类型、输出端口含义、掩码规则和引擎特有行为。不能仅将节点名称映射成同名 HLSL 函数。例如周期、极小分母、采样方式和向量广播需要单独核对。

语义按节点族组织于 `lowering-math.ts`、`lowering-texture.ts` 和 `lowering-functions.ts`，通过 `LoweringContext` 共用图解析、类型、符号和依赖。`translator.ts` 负责基本表达式、输出选择、静态分支和模块生成。

测试覆盖同名声明和赋值、缺失源与未连接输入的区别、通道选择、共享节点、模块交错依赖、未知语义、输出选择和 CLI 文件安全。`tests/fixtures/real/volumetric-cloud.blueprint.txt` 保留用户提供的真实复制文本，`tests/real-material.test.cjs` 对两版本档案和平台/静态分支运行整图回归。UE 引擎数值与画面对照仍需补充。

`tests/hlsl.test.cjs` 读取实际核心输出，包装 `PSMain` 入口，把每个选定的输出写入像素颜色，并通过 DXC 编译为 `ps_6_3` 字节码。每项测试使用独立临时目录并在结束后清理；可通过 `DXC_PATH` 指定编译器，无编译器时明确跳过。这验证真实 HLSL 的类型和编译路径，不模拟 GPU 数值，也不证明 UE 运行环境等价。

常量图还启用优化并读取 DXIL `storeOutput` 的常量值，与手工参考的 Sine 周期、零分母 Divide、负数 Frac、零向量 Normalize、Dot 和标量/向量 Lerp 结果对照。这类验证使用编译器实际求值，参考值不复制核心实现；仍不替代 GPU 执行和真实 UE 工程对照。
