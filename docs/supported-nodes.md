# 节点与语义说明

此清单对应转换核心及 `lowering-*.ts` 节点族实现。名称省略 `MaterialExpression` 前缀。**UE5.5 和 UE5.7 档案使用同一套已核对规则**；0.1.2 新增规则依据本机两版本源码和真实云材质导出文本验证，数值规则对齐默认材质编译器。实验性 MaterialIR 路径和真实引擎画面对照未覆盖。

## 已实现的节点族

| 类别 | 节点 | 处理方式与条件 |
| --- | --- | --- |
| 常量 | `Constant`、`Constant2Vector`、`Constant3Vector`、`Constant4Vector`、`StaticBool` | 生成明确类型的数值或布尔常量 |
| 参数 | `ScalarParameter`、`VectorParameter` | 显式参数，同名同类型复用；默认值记录在报告/注释中，不自动写成 HLSL 参数默认值 |
| 基础数学 | `Add`、`Subtract`、`Multiply`、`Divide`、`Min`、`Max`、`Fmod` | 检查数值类型及维数；Divide 使用极小分母保护 helper |
| 混合与范围 | `LinearInterpolate`、`Clamp`、`Saturate` | 恢复未连接输入默认值；Clamp 支持 Clamp、ClampMin、ClampMax |
| 一元数学 | `Abs`、`Floor`、`Ceil`、`Frac`、`OneMinus`、`Sine`、`Cosine`、`Power`、`TruncateLWC` | 三角函数读取正周期；Power 使用 UE 正基数保护；TruncateLWC 转为普通 float 精度，不做整数截断 |
| 向量运算 | `DotProduct`、`CrossProduct`、`Normalize`、`Distance`、`Length` | CrossProduct 需要 float3；Normalize 使用防零 helper；标量 Length 为绝对值 |
| 通道组合 | `AppendVector`、`ComponentMask` | Append 总维数最多 4；掩码检查空选择和越界通道 |
| 坐标 | `TextureCoordinate`、`Rotator` | UV 作为上下文输入；Rotator 按 Time × Speed 弧度旋转，默认中心 0.5、速度 0.25 |
| 时间 | `Time` | 显式 GameTime 或 RealTime，处理暂停标记和周期属性 |
| 转接 | `Reroute`、`NamedRerouteDeclaration`、`NamedRerouteUsage` | 恢复数据流；Named Reroute 使用声明引用或 GUID 匹配，保留有意义名称 |
| 着色路径 | `ShadingPathSwitch` | 默认保留 Deferred/Forward/Mobile 分支；也可显式选择路径，对应覆盖输入未连接时使用 Default |
| 条件分支 | `If`、`StaticSwitchParameter` | If 保留 EqualsThreshold；静态参数保留编译期宏或显式选择，DynamicBranch 为运行时 bool |
| 函数接口 | `FunctionInput`、`FunctionOutput` | 可以转换用户单独复制的函数内部图；这不等于解析主图的 MaterialFunctionCall 正文 |
| 纹理资源 | `TextureObject`、`TextureObjectParameter`、`TextureProperty` | 显式 Texture2D/Texture3D 输入，读取尺寸或倒数尺寸 |
| 纹理采样 | `TextureSample`、`TextureSampleParameter2D`、`TextureSampleParameterVolume` | 条件支持，见下文；结果状态至少为 external-dependencies |
| 云与体积 | `CloudSampleAttribute`、`VolumetricAdvancedMaterialInput`、`VolumetricAdvancedMaterialOutput` | 云高度等显式上下文，缓存密度共享 float4，独立体积节点保留全部七项输出及渲染配置 |
| 环境上下文 | `VertexColor`、`WorldPosition`、`VertexNormalWS`、`PixelNormalWS`、`CameraPositionWS`、`CameraVectorWS`、`ObjectPositionWS`、`ObjectRadius`、`TwoSidedSign` | 转为显式上下文输入，调用者提供对应 UE 含义的数据；WorldPosition 模式记录在来源信息中 |

数值类型为 `float` 至 `float4`。标量可以广播到向量；不兼容的向量维数会报错。缺失源只有在类型能由接口要求确定或经显式声明后才能继续，不根据显示名称猜测类型。

VectorParameter、VertexColor 与纹理采样默认暴露 RGB、R、G、B、A、RGBA 输出端口；`Outputs(n)` 按字段覆盖构造默认值，省略 Mask 不会清除原通道。识别 `Outputs.RemoveIndex(n)`，已删除端口不再出现。WorldPosition 暴露 XYZ、XY、Z。连接中的 OutputIndex 与通道掩码分别解析。

Frac 使用等价式 `x - floor(x)` 生成代码。这也避开了本机验证用 DXC 对负数局部常量调用 `frac(x)` 的常量折叠差异；回归检查确认 `Frac(-0.2)` 输出约为 `0.8`。

输入包含 `MaterialGraphNode_Root` 时，恢复其已连接属性作为算法输出，支持表达式属性连线及图 Pin 连线。BaseColor、EmissiveColor、Normal 等常见属性按 float3 接口处理；Roughness、Opacity 等常见属性按标量处理。没有材质根节点时，先查找 FunctionOutput，再使用局部图末端。

## 函数接口

FunctionInput 支持 Scalar、Vector2、Vector3、Vector4、Texture2D、Texture3D、StaticBool。预览值作为默认值时，值保留为元数据；预览表达式不会在运行时隐式替换显式函数参数。

MaterialFunctionCall 对以下标准 Engine 资产应用精确路径及输入输出接口契约：`Engine_MaterialFunctions01/Units/Km-to-Cm`（×100000）、`Engine_MaterialFunctions02/Utility/MakeFloat3`、`MakeFloat4`、`BreakOutFloat3Components`、`BreakOutFloat4Components`。本机 UE5.5/5.7 对应资产已核对；运行时不读取资产，诊断明确提示未验证用户资产正文或哈希。同名项目函数、路径/接口不同或输入未连接时不会套用契约，其余函数仍需要正文并生成错误诊断。

## 数学和静态参数

If 在连接 AEqualsB 时使用 `abs(A-B) > EqualsThreshold` 判断是否进入大小比较；未连接 equality 分支时使用 A >= B，忽略阈值。Power 读取真实属性名 Exponent，默认指数 2，采用 UE PositiveClampedPow；可证明的常量指数 0/1 保留原编译器快捷路径。向量指数目前明确不支持，避免默认编译器与实验性路径差异。

StaticSwitchParameter 默认生成 `UE_STATIC_参数名` 宏，未定义时采用节点 DefaultValue。通过核心 staticParameters、CLI `--static-parameters` JSON 或扩展设置可只展开一个分支；动态分支不受静态覆盖影响。动态数值分支按较大维数转换，标量复制，较短向量补零。

## 云与独立体积输出

CloudSampleAttribute 四端口依次为 Altitude、AltitudeInLayer、NormAltitudeInLayer、ShadowSampleDistance；前三者分别为相对地面高度（cm）、相对云层底高度（cm）、层内归一化高度。VolumetricAdvancedMaterialInput 的 float3/float4 输出均来自同一个渲染器缓存密度 float4。

独立输出节点的 PhaseG、PhaseG2、PhaseBlend、MultiScatteringContribution/Occlusion/Eccentricity 按云渲染器消费接口输出 float；ConservativeDensity 输出 float4。标量复制为四通道，float2/3 补零；未连接密度默认 `(1,1,1,0)`。渲染配置如多重散射阶数、地面贡献和体积阴影保留在 materialSettings 及代码注释中，工具不实现云渲染器的积分过程。

## 着色路径分支

`ShadingPathSwitch` 使用以下输入，不把注释框标题作为平台选择依据：

| 序列化输入 | 路径或用途 |
| --- | --- |
| `Inputs(0)` | Deferred |
| `Inputs(1)` | Forward |
| `Inputs(2)` | Mobile |
| `Default` | 所选路径没有连接覆盖输入时的回退 |

`Default` 不是 Deferred 的别名。所选端口已连接但引用的源节点不在复制文本中时，按外部依赖处理，不改用 Default。Mobile 是此节点的一条路径，不等于移动渲染器内部 Forward/Deferred 配置的数值枚举。

默认 `shadingPath: 'preserve'` 保留各路径的上游计算及预处理分支，不假设当前 UE 工程的渲染配置。编译生成代码须显式定义 `UE_MATERIAL_SHADING_PATH=0`（Deferred）、`1`（Forward）或 `2`（Mobile）；未定义或无效会触发 `#error`。这一配置要求使结果至少为 `external-dependencies`；分支仍有未知节点或类型时为 `unsupported`。

CLI 的 `--shading-path deferred|forward|mobile`、核心 API 的同名 `shadingPath` 选项和 VSCode 的 `ueMaterialTranslator.shadingPath` 可只转换指定路径，未选分支不参与语义转换。`preserve` 会转换所有路径，因此需要阅读单一路径时应在翻译前明确选择。

两版枚举均为 Deferred、Forward、Mobile 顺序，包含独立 Forward 值；已核对本机 UE5.5/5.7 源码及真实复制样本。`FeatureLevelSwitch` 和 `QualitySwitch` 尚未实现。

## 纹理采样条件

支持的 SamplerType：

- `SAMPLERTYPE_Color`
- `SAMPLERTYPE_LinearColor`
- `SAMPLERTYPE_Masks`
- `SAMPLERTYPE_Data`
- `SAMPLERTYPE_Grayscale`、`SAMPLERTYPE_LinearGrayscale`、`SAMPLERTYPE_Alpha`、`SAMPLERTYPE_DistanceFieldFont`

支持 `SSM_FromTextureAsset`、`SSM_Wrap_WorldGroupSettings`、`SSM_Clamp_WorldGroupSettings` 采样器来源，分别生成显式采样器参数。

省略 AutomaticViewMipBias 时使用 UE 构造默认值 true；仅 2D 纹理启用。资产采样器通过显式有效 View Mip Bias / 导数乘数上下文保留偏移；Shared Wrap/Clamp 由调用者绑定 UE 对应视图采样器，避免重复加偏移。体积纹理禁用此项。连接 TextureObject 时，解码类型由上游资源节点决定。

| MipValueMode | 生成形式 |
| --- | --- |
| `TMVM_None` | `Texture2D.Sample` |
| `TMVM_MipLevel` | `Texture2D.SampleLevel` |
| `TMVM_MipBias` | `Texture2D.SampleBias` |
| `TMVM_Derivative` | `Texture2D.SampleGrad`，需要显式 DX/DY 输入 |

同样支持 Texture3D 对应采样方法，体积纹理必须连接 UVW。灰阶解码复制红通道至 RGBA，并通过显式平台布尔上下文保留 R8 sRGB 路径；LinearGrayscale、Alpha、DistanceFieldFont 复制红通道。法线、Cube/Array 及其他未实现解码或维度仍报错。资源格式、sRGB 视图、采样器和导数环境需调用者绑定，状态为 `external-dependencies`。

## 标签和模块

注释框恢复依赖表达式位置和框的尺寸。坐标按序列化值及缺省 `0` 恢复；节点归属按节点坐标判断，嵌套时选择最小的包含框，并将上层框名保留为 `Outer / Inner` 路径。生成结构以这些叶模块为单位；首版没有生成完整的多层嵌套模块树。框重叠时发出警告，并保留实际选择的归属。

依赖允许时生成辅助函数；连续但不能提取函数时生成作用域；节点交错时用同名代码段保持原拓扑顺序。节点 `Desc` 保存为局部注释。缺少框尺寸时不推断归属。

可通过 CLI 的 `--module 节点ID=注释框ID` 修正归属，或传 `--module 节点ID=-` 取消分组。核心 API 对应 `moduleAssignments`。归属调整不会改动数据流；函数是否可提取仍需通过依赖检查。

## 不支持与验证边界

Custom、不匹配标准契约的 MaterialFunctionCall 以及其他未列出的表达式会生成错误诊断和阻止编译的 `#error`。核心继续遍历这些节点的上游，保留已支持的计算和参数，并使用带上游输入的 `UNRESOLVED_...(...)` 标记未知计算；该结果仍是 `unsupported`。生成代码头部列出部分错误原因，完整诊断请查看 JSON 报告或 VSCode 输出通道。

Substrate、Landscape、复杂场景采样等未列节点尚未实现。编译通过证明语法和类型层面成立，不证明与 UE 的全部渲染语义等价。

0.1.2 已对真实云材质的 298 个图对象、281 个计算/输出节点、11 个最终输出回归，包含两版本档案、三条路径及静态参数变体的 DXC 编译验证。
