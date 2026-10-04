/**
 * PostProcessing.ts - GTA 風格化寫實後處理管線 (EffectComposer)
 * 包含：
 * 1. UnrealBloomPass (柔和發光，僅對高亮度自發光招牌/車燈/夕陽光暈生效)
 * 2. 自訂 GTA Cinematic Color Grading (橘青對比 Teal & Orange、暗部偏藍、高光偏橘、中間調微降飽和、S-Curve 壓暗)
 * 3. 暗角 (Vignette) 與膠片微顆粒 (Film Grain)
 * 4. 支援 Low / Medium / High 品質分級與一鍵開關
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CONFIG } from '../config.ts';

const GTACinematicShader = {
  name: 'GTACinematicShader',
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0.0 },
    tealOrangeStrength: { value: 0.45 },
    contrast: { value: 1.08 },
    saturation: { value: 0.92 },
    vignetteStrength: { value: 0.55 },
    grainStrength: { value: 0.025 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float tealOrangeStrength;
    uniform float contrast;
    uniform float saturation;
    uniform float vignetteStrength;
    uniform float grainStrength;
    varying vec2 vUv;

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      
      // 1. 膠片微顆粒 (Film Grain)
      if (grainStrength > 0.001) {
        float noise = fract(sin(dot(vUv * 120.0 + fract(time * 0.05), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        color.rgb += noise * grainStrength;
      }
      
      // 2. 飽和度調節 (GTA 寫實稍微低飽和)
      float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      color.rgb = mix(vec3(luma), color.rgb, saturation);
      
      // 3. 橘青對比分級 (Teal & Orange：暗部偏冷藍、高光偏暖橘，採用乘法調色，絕不全域加法提亮或壓平對比)
      vec3 shadowTint = vec3(0.92, 0.96, 1.10);
      vec3 highlightTint = vec3(1.06, 0.98, 0.90);
      
      float shadowWeight = smoothstep(0.45, 0.02, luma);
      float highlightWeight = smoothstep(0.40, 0.90, luma);
      
      vec3 graded = color.rgb;
      graded *= mix(vec3(1.0), shadowTint, shadowWeight * tealOrangeStrength * 0.9);
      graded *= mix(vec3(1.0), highlightTint, highlightWeight * tealOrangeStrength * 0.7);
      
      // 4. S-Curve 對比度增強 (加強明暗分層，局部光源更爆發、暗處深沉)
      graded = clamp(graded, 0.0, 1.0);
      graded = (graded - 0.5) * contrast + 0.5;
      graded = clamp(graded, 0.0, 1.0);
      
      // 5. 輕微暗角 (Vignette)
      if (vignetteStrength > 0.001) {
        vec2 coord = (vUv - 0.5) * 2.0;
        float rf = dot(coord, coord) * 0.38;
        float vig = clamp(1.0 - rf * vignetteStrength, 0.0, 1.0);
        graded *= vig;
      }
      
      gl_FragColor = vec4(clamp(graded, 0.0, 1.0), color.a);
    }
  `
};

export class PostProcessingManager {
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;
  private cinematicPass: ShaderPass;
  private outputPass: OutputPass;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isEnabled: boolean;
  private currentQuality: 'low' | 'medium' | 'high';
  private sceneCalls = 0;
  private sceneTriangles = 0;
  private lastBaseRenderTimeMs = 0;
  private lastPostProcessingTimeMs = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.isEnabled = CONFIG.POST_PROCESSING.ENABLED;
    this.currentQuality = CONFIG.POST_PROCESSING.QUALITY;

    const width = window.innerWidth;
    const height = window.innerHeight;

    this.composer = new EffectComposer(this.renderer);

    // 1. 基本場景渲染 Pass (紀錄 3D 場景真實 Draw Calls 與面數)
    this.renderPass = new RenderPass(this.scene, this.camera);
    const origRenderPass = this.renderPass.render.bind(this.renderPass);
    this.renderPass.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
      const t0 = performance.now();
      origRenderPass(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      this.lastBaseRenderTimeMs = performance.now() - t0;
      this.sceneCalls = renderer.info.render.calls;
      this.sceneTriangles = renderer.info.render.triangles;
    };
    this.composer.addPass(this.renderPass);

    // 2. Bloom Pass (只對發光招牌/夕陽反射發光)
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      CONFIG.POST_PROCESSING.BLOOM_STRENGTH,
      CONFIG.POST_PROCESSING.BLOOM_RADIUS,
      CONFIG.POST_PROCESSING.BLOOM_THRESHOLD
    );
    this.composer.addPass(this.bloomPass);

    // 3. 自訂 GTA Cinematic 色彩分級 Pass
    this.cinematicPass = new ShaderPass(GTACinematicShader);
    this.cinematicPass.uniforms.tealOrangeStrength.value = CONFIG.POST_PROCESSING.TEAL_ORANGE_STRENGTH;
    this.cinematicPass.uniforms.contrast.value = CONFIG.POST_PROCESSING.CONTRAST;
    this.cinematicPass.uniforms.saturation.value = CONFIG.POST_PROCESSING.SATURATION;
    this.cinematicPass.uniforms.vignetteStrength.value = CONFIG.POST_PROCESSING.VIGNETTE;
    this.cinematicPass.uniforms.grainStrength.value = CONFIG.POST_PROCESSING.GRAIN;
    this.composer.addPass(this.cinematicPass);

    // 4. Output Pass (標準色彩空間轉換)
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.applyQuality(this.currentQuality);
  }

  public setQuality(quality: 'low' | 'medium' | 'high'): void {
    this.currentQuality = quality;
    CONFIG.POST_PROCESSING.QUALITY = quality;
    this.applyQuality(quality);
  }

  public getQuality(): 'low' | 'medium' | 'high' {
    return this.currentQuality;
  }

  public cycleQuality(): 'low' | 'medium' | 'high' {
    const list: ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];
    const nextIdx = (list.indexOf(this.currentQuality) + 1) % list.length;
    this.setQuality(list[nextIdx]);
    return this.currentQuality;
  }

  private applyQuality(quality: 'low' | 'medium' | 'high'): void {
    if (!this.composer) return;

    if (quality === 'low') {
      this.bloomPass.enabled = false;
      this.cinematicPass.uniforms.grainStrength.value = 0.0;
      this.cinematicPass.uniforms.vignetteStrength.value = 0.2;
      this.cinematicPass.uniforms.tealOrangeStrength.value = 0.2;
    } else if (quality === 'medium') {
      this.bloomPass.enabled = true;
      this.bloomPass.strength = 0.25;
      this.cinematicPass.uniforms.grainStrength.value = 0.012;
      this.cinematicPass.uniforms.vignetteStrength.value = 0.45;
      this.cinematicPass.uniforms.tealOrangeStrength.value = 0.40;
    } else {
      // High
      this.bloomPass.enabled = true;
      this.bloomPass.strength = CONFIG.POST_PROCESSING.BLOOM_STRENGTH;
      this.cinematicPass.uniforms.grainStrength.value = CONFIG.POST_PROCESSING.GRAIN;
      this.cinematicPass.uniforms.vignetteStrength.value = CONFIG.POST_PROCESSING.VIGNETTE;
      this.cinematicPass.uniforms.tealOrangeStrength.value = CONFIG.POST_PROCESSING.TEAL_ORANGE_STRENGTH;
    }
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    CONFIG.POST_PROCESSING.ENABLED = enabled;
  }

  public toggle(): boolean {
    this.isEnabled = !this.isEnabled;
    CONFIG.POST_PROCESSING.ENABLED = this.isEnabled;
    return this.isEnabled;
  }

  public getIsEnabled(): boolean {
    return this.isEnabled;
  }

  public getSceneRenderInfo(): { calls: number; triangles: number } {
    if (!this.isEnabled || !this.composer) {
      return {
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles
      };
    }
    return {
      calls: this.sceneCalls,
      triangles: this.sceneTriangles
    };
  }

  public resize(width: number, height: number): void {
    this.composer?.setSize(width, height);
    this.bloomPass.setSize(width, height);
  }

  public render(delta: number): void {
    const t0 = performance.now();
    if (this.isEnabled && this.composer) {
      this.cinematicPass.uniforms.time.value += delta;
      this.composer.render();
      const totalTime = performance.now() - t0;
      this.lastPostProcessingTimeMs = Math.max(0, totalTime - this.lastBaseRenderTimeMs);
    } else {
      this.renderer.render(this.scene, this.camera);
      this.lastBaseRenderTimeMs = performance.now() - t0;
      this.lastPostProcessingTimeMs = 0;
    }
  }

  public getTimingInfo(): { baseRenderMs: number; postProcessingMs: number } {
    return {
      baseRenderMs: this.lastBaseRenderTimeMs,
      postProcessingMs: this.lastPostProcessingTimeMs
    };
  }

  public dispose(): void {
    this.composer = null;
  }
}
