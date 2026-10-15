import { flag, num, referenceName, str } from './graph';
import type { GraphNode } from './graph';
import type { LoweringContext, Ref } from './lowering';
import type { ValueType } from './types';

/** Resource and volume-context lowering. Verified against UE 5.5/5.7 MaterialExpressions.cpp,
 * HLSLMaterialTranslator.cpp, BaseMaterialExpressions.ini and MaterialTexture.ush. */
export function lowerTexture(node: GraphNode, ctx: LoweringContext): Ref[] | undefined {
  const type = node.type.replace('MaterialExpression', '');
  const p = node.props;
  if (type === 'CloudSampleAttribute') {
    const slots = [
      ['Altitude', 'sample altitude relative to the planet ground, centimeters'],
      ['AltitudeInLayer', 'sample altitude relative to the cloud layer bottom, centimeters'],
      ['NormAltitudeInLayer', 'normalized cloud layer altitude: bottom = 0, top = 1'],
      ['ShadowSampleDistance', 'shadow sample distance from primary view sample, centimeters; primary samples = 0'],
    ];
    return slots.map(([name, meaning]) => ctx.parameter(`context:CloudSample:${name}`, `CloudSample${name}`, 'float', 'context', `UE volume renderer context: ${meaning}`));
  }
  if (type === 'VolumetricAdvancedMaterialInput') {
    const density = ctx.parameter('context:VolumeSampleConservativeDensity', 'VolumeSampleConservativeDensity', 'float4', 'context',
      'UE volume renderer context: previously evaluated VolumetricAdvancedMaterialOutput.ConservativeDensity; x = conservative density, yzw = cached material values');
    return [{ ...density, code: `(${density.code}).xyz`, type: 'float3' }, density];
  }
  if (type === 'TextureObject' || type === 'TextureObjectParameter') {
    const resourceType = textureType(node);
    if (!resourceType) return ctx.unknown(node, `暂不支持该维度的纹理资源：${str(p.Texture)}。`);
    return [textureParameter(node, ctx, resourceType)];
  }
  if (type === 'TextureProperty') return textureProperty(node, ctx);
  if (['TextureSample', 'TextureSampleParameter2D', 'TextureSampleParameterVolume'].includes(type)) return sampleTexture(node, ctx);
  return undefined;
}

function textureType(node: GraphNode): ValueType | undefined {
  const asset = str(node.props.Texture);
  const volume = /(?:^|[./])(?:VolumeTexture|TextureRenderTargetVolume)'/.test(asset);
  if (node.type.endsWith('Parameter2D') && volume) return undefined;
  if (node.type.endsWith('ParameterVolume') && /(?:^|[./])(?:Texture2D|TextureRenderTarget2D)'/.test(asset)) return undefined;
  if (volume || node.type.endsWith('ParameterVolume')) return 'Texture3D';
  if (/(?:^|[./])(?:TextureCube|TextureCubeArray|Texture2DArray|TextureRenderTargetCube|TextureRenderTarget2DArray|TextureExternal|SparseVolumeTexture)'/.test(asset)) return undefined;
  return 'Texture2D';
}

function textureParameter(node: GraphNode, ctx: LoweringContext, type: ValueType): Ref {
  const p = node.props;
  const name = str(p.ParameterName);
  // TextureSampleParameter::Compile explicitly falls back to plain TextureSample
  // for NAME_None. TextureObjectParameter always retains parameter identity.
  const isParameter = node.type === 'MaterialExpressionTextureObjectParameter'
    || /MaterialExpressionTextureSampleParameter(?:2D|Volume)$/.test(node.type) && !!name && name !== 'None';
  const label = isParameter && name && name !== 'None' ? name : referenceName(p.Texture) || node.id;
  return ctx.parameter(isParameter ? `texture-param:${name || 'None'}` : `texture:${str(p.Texture, node.id)}`, label, type, 'resource', str(p.Texture, node.id), isParameter ? p.Texture : undefined);
}

function effectiveSamplerType(node: GraphNode, ctx: LoweringContext): string | undefined {
  if (!ctx.connected(node, 'TextureObject')) return str(node.props.SamplerType, 'SAMPLERTYPE_Color');
  const first = ctx.graph.connection(node, 'TextureObject');
  const seen = new Set<string>();
  const types = new Set<string>();
  function visit(id: string): void {
    if (seen.has(id)) return;
    seen.add(id);
    const source = ctx.graph.nodes.get(id);
    if (!source) return;
    if (/MaterialExpressionTextureObject(?:Parameter)?$/.test(source.type)) {
      types.add(str(source.props.SamplerType, 'SAMPLERTYPE_Color')); return;
    }
    for (const dependency of ctx.graph.dependencies(source)) visit(dependency.source);
  }
  if (first) visit(first.source);
  if (types.size > 1) return undefined;
  return [...types][0] ?? str(node.props.SamplerType, 'SAMPLERTYPE_Color');
}

function coordinates(node: GraphNode, ctx: LoweringContext, key: string, expected: 'float2' | 'float3'): Ref {
  const connection = ctx.graph.connection(node, key);
  const value = ctx.input(node, key, undefined, connection && !ctx.graph.nodes.has(connection.source) ? expected : undefined);
  if (value.type === expected || value.type === 'unknown') return value;
  if (value.type === 'float') return { ...value, code: `(${expected})(${value.code})`, type: expected };
  if (expected === 'float3' && value.type === 'float2') return { ...value, code: `float3(${value.code}, 0.0)`, type: expected };
  if (value.type === 'float4' || expected === 'float2' && value.type === 'float3') return { ...value, code: `(${value.code}).${expected === 'float2' ? 'xy' : 'xyz'}`, type: expected };
  ctx.diag(node, 'INPUT_TYPE', `${key} 需要数值坐标 ${expected}，实际为 ${value.type}。`);
  return { ...value, type: 'unknown' };
}

function textureProperty(node: GraphNode, ctx: LoweringContext): Ref[] {
  const texture = ctx.input(node, 'TextureObject');
  if (!['Texture2D', 'Texture3D'].includes(texture.type)) return ctx.unknown(node, `TextureProperty 要求 Texture2D 或 Texture3D，实际为 ${texture.type}。`);
  const dimension = texture.type === 'Texture3D' ? 3 : 2;
  const resultType = `float${dimension}` as ValueType;
  const property = str(node.props.Property, 'TMTM_TextureSize');
  if (!['TMTM_TextureSize', 'TMTM_TexelSize'].includes(property)) return ctx.unknown(node, `未知纹理属性 ${property}。`);
  const helper = `UE_TextureSize${dimension}D`;
  const components = dimension === 3 ? 'width, height, depth' : 'width, height';
  ctx.helper(helper, `${resultType} ${helper}(${texture.type} textureResource)\n{\n    uint ${components};\n    textureResource.GetDimensions(${components});\n    return ${resultType}(${components});\n}`);
  const size = `${helper}(${texture.code})`;
  ctx.requireExternal();
  ctx.diag(node, 'TEXTURE_SIZE_CONTRACT', 'TextureProperty 读取 mip 0 的资源尺寸；请绑定与 UE 暴露的纹理尺寸一致的资源视图（含流送/LOD 状态）。', 'warning');
  return [ctx.emit(node, property === 'TMTM_TexelSize' ? `(1.0 / ${size})` : size, resultType, [texture])];
}

function sampleTexture(node: GraphNode, ctx: LoweringContext): Ref[] {
  const p = node.props;
  const resourceType = textureType(node);
  if (!resourceType && !ctx.connected(node, 'TextureObject')) return ctx.unknown(node, `暂不支持该维度的纹理采样：${str(p.Texture)}。`);
  const texture = ctx.connected(node, 'TextureObject') ? ctx.input(node, 'TextureObject') : textureParameter(node, ctx, resourceType!);
  if (!['Texture2D', 'Texture3D'].includes(texture.type)) return ctx.unknown(node, `纹理采样需要 Texture2D 或 Texture3D，实际为 ${texture.type}。`);
  // UE GetTextureForExpression obtains the decode type from a connected texture
  // object, overriding this sample node's own SamplerType property.
  const samplerType = effectiveSamplerType(node, ctx);
  if (!samplerType) return ctx.unknown(node, 'TextureObject 的上游资源采用不同采样解码类型，无法生成单一解码算法。');
  if (!['SAMPLERTYPE_Color', 'SAMPLERTYPE_LinearColor', 'SAMPLERTYPE_Masks', 'SAMPLERTYPE_Data', 'SAMPLERTYPE_Grayscale', 'SAMPLERTYPE_LinearGrayscale', 'SAMPLERTYPE_Alpha', 'SAMPLERTYPE_DistanceFieldFont'].includes(samplerType))
    return ctx.unknown(node, `纹理采样类型 ${samplerType} 的解码尚未实现。`);
  const gather = str(p.GatherMode, 'TGM_None');
  if (gather !== 'TGM_None') return ctx.unknown(node, `纹理 Gather 模式 ${gather} 尚未实现。`);
  const source = str(p.SamplerSource, 'SSM_FromTextureAsset');
  if (!['SSM_FromTextureAsset', 'SSM_Wrap_WorldGroupSettings', 'SSM_Clamp_WorldGroupSettings'].includes(source)) return ctx.unknown(node, `未知采样器来源 ${source}。`);
  const mode = str(p.MipValueMode, 'TMVM_None');
  if (!['TMVM_None', 'TMVM_MipLevel', 'TMVM_MipBias', 'TMVM_Derivative'].includes(mode)) return ctx.unknown(node, `未知 MipValueMode ${mode}。`);

  // A linked static bool overrides the property. Missing serialized properties use
  // the UE constructor default (true). Only 2D resources can use view mip bias.
  let automatic = texture.type === 'Texture2D' && (!Object.hasOwn(p, 'AutomaticViewMipBias') && !Object.hasOwn(p, 'bAutomaticViewMipBias') || flag(p.AutomaticViewMipBias) || flag(p.bAutomaticViewMipBias));
  let automaticOverride: Ref | undefined;
  // The named sample-parameter Compile path passes the property directly. Only
  // plain samples (including NAME_None parameter fallback) evaluate this pin.
  const sampleParameterName = str(p.ParameterName);
  const usesGenericCompile = node.type === 'MaterialExpressionTextureSample' || !sampleParameterName || sampleParameterName === 'None';
  if (texture.type === 'Texture2D' && usesGenericCompile && ctx.connected(node, 'AutomaticViewMipBiasValue')) {
    const override = ctx.input(node, 'AutomaticViewMipBiasValue');
    if (override.type === 'bool') {
      if (override.code === 'false' || override.code === 'true') automatic = override.code === 'true';
      else { automatic = true; automaticOverride = override; }
    } else ctx.diag(node, 'NON_STATIC_MIP_BIAS', 'Apply View MipBias 输入未解析为静态 bool；与 UE 一致，使用 AutomaticViewMipBias 属性。', 'warning');
  }
  const samplerContract = automatic && source !== 'SSM_FromTextureAsset'
    ? `${source}; bind the UE-selected shared sampler, including per-view mip bias only for enabled surface/decal SM5 sampling${automaticOverride ? ` with Apply View MipBias = ${automaticOverride.code}` : ''}; SampleLevel ignores sampler mip bias`
    : `${source}; bind the matching UE asset/group sampler (no additional manually applied view mip bias)`;
  const sampler = ctx.parameter(`sampler:${texture.code}:${source}:${automatic ? 'auto' : 'plain'}:${automaticOverride?.code ?? ''}`, `${texture.code}_${source === 'SSM_FromTextureAsset' ? 'Sampler' : source.includes('Clamp') ? 'ClampSampler' : 'WrapSampler'}`, 'SamplerState', 'resource', samplerContract);
  const coordinateType = texture.type === 'Texture3D' ? 'float3' : 'float2';
  if (texture.type === 'Texture3D' && !ctx.connected(node, 'Coordinates')) return ctx.unknown(node, '与 UE 一致：VolumeTexture 采样必须连接 UVW 坐标。');
  const uv = ctx.connected(node, 'Coordinates') ? coordinates(node, ctx, 'Coordinates', coordinateType)
    : ctx.parameter(`uv:${num(p.ConstCoordinate)}`, `UV${num(p.ConstCoordinate)}`, 'float2', 'context', `UE material texture coordinate set ${num(p.ConstCoordinate)}`);
  const refs = [texture, sampler, uv];
  if (automaticOverride) refs.push(automaticOverride);
  let call: string;
  const manualViewBias = automatic && source === 'SSM_FromTextureAsset';
  const conditional = (ref: Ref, otherwise: string): string => automaticOverride ? `(${automaticOverride.code} ? ${ref.code} : ${otherwise})` : ref.code;
  const viewBias = (): string => {
    const bias = ctx.parameter('context:EffectiveMaterialTextureMipBias', 'EffectiveMaterialTextureMipBias', 'float', 'context', 'UE renderer context: View.MaterialTextureMipBias gated to zero outside pixel surface/decal SM5 sampling');
    refs.push(bias); return conditional(bias, '0.0');
  };
  if (mode === 'TMVM_None') call = manualViewBias ? `${texture.code}.SampleBias(${sampler.code}, ${uv.code}, ${viewBias()})` : `${texture.code}.Sample(${sampler.code}, ${uv.code})`;
  else if (mode === 'TMVM_MipLevel' || mode === 'TMVM_MipBias') {
    const mip = ctx.input(node, 'MipValue', num(p.ConstMipValue, -1), 'float'); refs.push(mip);
    const level = manualViewBias ? `(${mip.code} + ${viewBias()})` : mip.code;
    call = `${texture.code}.${mode === 'TMVM_MipLevel' ? 'SampleLevel' : 'SampleBias'}(${sampler.code}, ${uv.code}, ${level})`;
  } else {
    const dx = coordinates(node, ctx, 'CoordinatesDX', coordinateType);
    const dy = coordinates(node, ctx, 'CoordinatesDY', coordinateType); refs.push(dx, dy);
    let x = dx.code, y = dy.code;
    if (manualViewBias) {
      const multiply = ctx.parameter('context:EffectiveMaterialTextureDerivativeMultiply', 'EffectiveMaterialTextureDerivativeMultiply', 'float', 'context', 'UE renderer context: View.MaterialTextureDerivativeMultiply gated to one outside pixel surface/decal SM5 sampling');
      refs.push(multiply); const factor = conditional(multiply, '1.0');
      x = `(${x} * ${factor})`; y = `(${y} * ${factor})`;
    }
    call = `${texture.code}.SampleGrad(${sampler.code}, ${uv.code}, ${x}, ${y})`;
  }
  ctx.requireExternal();
  ctx.diag(node, 'TEXTURE_RESOURCE_CONTRACT', `请绑定与 UE 纹理资产一致的格式、sRGB 资源视图及采样器（${samplerType}, ${source}）。平台视图/导入设置不在复制文本中；视图 Mip Bias 已保留在显式上下文或采样器契约中。`, 'warning');
  let sampled = ctx.emit(node, call, 'float4', refs, 'sample');
  if (samplerType === 'SAMPLERTYPE_Grayscale') {
    // MaterialTexture.ush has platform-specific R8 sRGB decoding. Express its
    // environment switches as inputs instead of assuming the desktop D3D path.
    const manual = ctx.parameter('context:GrayscaleManualSrgb', 'GrayscaleManualSrgb', 'bool', 'context', 'UE shader platform: COMPILER_GLSL_ES3_1 || VULKAN_PROFILE; enables R8 sRGB approximation', false);
    const undo = ctx.parameter('context:GrayscaleUndoHardwareSrgb', 'GrayscaleUndoHardwareSrgb', 'bool', 'context', 'UE shader platform: MOBILE_EMULATION && ResolvedView.MobilePreviewMode > 0.5; undo hardware sRGB before manual decoding', false);
    ctx.helper('UE_DecodeGrayscale', 'float4 UE_DecodeGrayscale(float4 value, bool manualSrgb, bool undoHardwareSrgb)\n{\n    float gray = value.r;\n    if (manualSrgb)\n    {\n        if (undoHardwareSrgb) gray = pow(gray, 1.0 / 2.2);\n        gray *= gray;\n    }\n    return gray.xxxx;\n}');
    sampled = ctx.emit(node, `UE_DecodeGrayscale(${sampled.code}, ${manual.code}, ${undo.code})`, 'float4', [sampled, manual, undo], 'decoded');
  } else if (['SAMPLERTYPE_LinearGrayscale', 'SAMPLERTYPE_Alpha', 'SAMPLERTYPE_DistanceFieldFont'].includes(samplerType)) {
    sampled = ctx.emit(node, `(${sampled.code}).rrrr`, 'float4', [sampled], 'decoded');
  }
  return ctx.channels(node, sampled);
}
