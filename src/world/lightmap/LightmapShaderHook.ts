/**
 * LightmapShaderHook.ts - 光照圖材質 Shader 注入共用模組
 * 遵循 RULES.md：所有材質共用單一光學運算模型，零冗餘程式碼
 */

import * as THREE from 'three';
import { ChunkLightmapManager } from './ChunkLightmapManager.ts';

export class LightmapShaderHook {
  /**
   * 取得全域光照圖 Uniforms 參照
   */
  public static getUniforms(): Record<string, THREE.IUniform> {
    const mgr = ChunkLightmapManager.getInstance();
    return {
      uLightmap: mgr.uniforms.uLightmap,
      uLightmapBounds: mgr.uniforms.uLightmapBounds,
      uNightFactor: mgr.uniforms.uNightFactor,
      uNightTurnOnRatio: mgr.uniforms.uNightTurnOnRatio,
      uGroundVisibility: mgr.uniforms.uGroundVisibility,
      uBaseNightBrightness: mgr.uniforms.uBaseNightBrightness,
      uHeatmapMode: mgr.uniforms.uHeatmapMode
    };
  }

  /**
   * 綁定 Uniforms 到 WebGLProgramParameters
   */
  public static bindUniforms(shader: THREE.WebGLProgramParametersWithUniforms): void {
    const u = LightmapShaderHook.getUniforms();
    for (const key of Object.keys(u)) {
      shader.uniforms[key] = u[key];
    }
  }

  /**
   * 注入 Vertex Shader 中的世界座標 Varying
   */
  public static injectVertexShader(vertexShader: string): string {
    if (vertexShader.includes('vCustomWorldPosition')) {
      return vertexShader;
    }
    return `
      varying vec3 vCustomWorldPosition;
    ` + vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
       vCustomWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `
    );
  }

  /**
   * 注入地面材質（柏油路、人行道、標線、草地、廣場）Fragment Shader
   */
  public static injectGroundFragmentShader(fragmentShader: string): string {
    const header = `
      uniform sampler2D uLightmap;
      uniform vec4 uLightmapBounds;
      uniform float uNightFactor;
      uniform float uNightTurnOnRatio;
      uniform float uGroundVisibility;
      uniform float uBaseNightBrightness;
      uniform float uHeatmapMode;
      varying vec3 vCustomWorldPosition;
    `;

    const body = `
      #include <dithering_fragment>

      // 1. 世界座標光照圖雙線性取樣
      vec2 lmUv = (vCustomWorldPosition.xz - uLightmapBounds.xy) / uLightmapBounds.zw;
      vec4 lmSample = texture2D(uLightmap, lmUv);

      // 2. 光源黃昏逐盞點亮開關
      float lampOn = smoothstep(lmSample.a - 0.08, lmSample.a + 0.08, uNightTurnOnRatio);
      vec3 lightmapColor = lmSample.rgb * (uNightFactor * uBaseNightBrightness * lampOn);
      float lightLum = dot(lightmapColor, vec3(0.299, 0.587, 0.114));

      if (uHeatmapMode > 0.5) {
        // F16 熱圖模式：紅＝太暗 (< 0.25)，綠＝達標 (>= 0.25)
        if (lightLum >= 0.25) {
          gl_FragColor.rgb = mix(vec3(0.12, 0.92, 0.22), vec3(0.20, 1.0, 0.90), clamp((lightLum - 0.25) * 1.5, 0.0, 1.0));
        } else {
          gl_FragColor.rgb = mix(vec3(0.95, 0.08, 0.08), vec3(0.95, 0.68, 0.12), clamp(lightLum / 0.25, 0.0, 1.0));
        }
      } else {
        // 正常渲染：底色 * (夜間環境項 + 光照圖顏色 * 夜間因子)
        // 維持地面可見度下限，不回全黑
        vec3 cGroundNight = vec3(0.227, 0.278, 0.392);
        float nightBoost = 0.095 * uNightFactor * uGroundVisibility;
        gl_FragColor.rgb += cGroundNight * nightBoost;

        // 光照圖只提亮，不改色相造成粉紅偏色
        if (uNightFactor > 0.01) {
          gl_FragColor.rgb += gl_FragColor.rgb * lightmapColor * 2.8 + lightmapColor * 0.08;
        }
      }
    `;

    return header + fragmentShader.replace('#include <dithering_fragment>', body);
  }

  /**
   * 注入建築外牆材質 Fragment Shader (底部 6m 以內照亮並向上漸淡)
   */
  public static injectBuildingFragmentShader(fragmentShader: string): string {
    const header = `
      uniform sampler2D uLightmap;
      uniform vec4 uLightmapBounds;
      uniform float uNightFactor;
      uniform float uNightTurnOnRatio;
      uniform float uBaseNightBrightness;
      uniform float uHeatmapMode;
      varying vec3 vCustomWorldPosition;
    `;

    const body = `
      #include <dithering_fragment>

      // 1. 建築垂直漸層與天光
      float vertGrad = mix(0.78, 1.15, clamp(vCustomWorldPosition.y * 0.05, 0.0, 1.0));
      gl_FragColor.rgb *= vertGrad;

      float fakeAo = smoothstep(0.1, 1.8, vCustomWorldPosition.y);
      gl_FragColor.rgb *= mix(0.72, 1.0, fakeAo);

      float skyWash = smoothstep(6.0, 26.0, vCustomWorldPosition.y);
      gl_FragColor.rgb += vec3(0.015, 0.025, 0.055) * skyWash * uNightFactor;

      if (uNightFactor > 0.01) {
        // 2. 世界座標光照圖取樣 (底部 6m 內漸淡)
        vec2 lmUv = (vCustomWorldPosition.xz - uLightmapBounds.xy) / uLightmapBounds.zw;
        vec4 lmSample = texture2D(uLightmap, lmUv);
        float lampOn = smoothstep(lmSample.a - 0.08, lmSample.a + 0.08, uNightTurnOnRatio);
        vec3 lightmapColor = lmSample.rgb * (uNightFactor * uBaseNightBrightness * lampOn);

        float heightFade = clamp(1.0 - vCustomWorldPosition.y / 6.0, 0.0, 1.0);
        gl_FragColor.rgb += gl_FragColor.rgb * (lightmapColor * heightFade * 2.2) + (lightmapColor * heightFade * 0.06);

        // 3. 輪廓邊緣光 (Fresnel Rim Light)
        vec3 viewDir = normalize(cameraPosition - vCustomWorldPosition);
        float rim = 1.0 - max(0.0, dot(viewDir, normal));
        rim = pow(rim, 3.2);
        gl_FragColor.rgb += vec3(0.04, 0.07, 0.14) * rim * uNightFactor * 0.75;
      }
    `;

    return header + fragmentShader.replace('#include <dithering_fragment>', body);
  }

  /**
   * 注入動態實體（行人、車輛）Fragment Shader (讀取光照圖並調亮)
   */
  public static injectEntityFragmentShader(fragmentShader: string): string {
    const header = `
      uniform sampler2D uLightmap;
      uniform vec4 uLightmapBounds;
      uniform float uNightFactor;
      uniform float uNightTurnOnRatio;
      uniform float uBaseNightBrightness;
      varying vec3 vCustomWorldPosition;
    `;

    const body = `
      #include <dithering_fragment>
      if (uNightFactor > 0.01) {
        vec2 lmUv = (vCustomWorldPosition.xz - uLightmapBounds.xy) / uLightmapBounds.zw;
        vec4 lmSample = texture2D(uLightmap, lmUv);
        float lampOn = smoothstep(lmSample.a - 0.08, lmSample.a + 0.08, uNightTurnOnRatio);
        vec3 lightmapColor = lmSample.rgb * (uNightFactor * uBaseNightBrightness * lampOn);
        gl_FragColor.rgb += gl_FragColor.rgb * lightmapColor * 2.2 + lightmapColor * 0.06;
      }
    `;

    return header + fragmentShader.replace('#include <dithering_fragment>', body);
  }
}
