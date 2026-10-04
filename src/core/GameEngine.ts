/**
 * GameEngine.ts - Three.js 核心渲染引擎與畫布管理
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PostProcessingManager } from './PostProcessing.ts';

export class GameEngine {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public postProcessing: PostProcessingManager;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;

    // 1. 場景
    this.scene = new THREE.Scene();

    // 2. 鏡頭 (FOV 調至 60 度，提供更自然的透視)
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(CONFIG.CAMERA.FOV, aspect, 0.1, 1600);

    // 3. 渲染器
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // 色彩空間與色調對應 (sRGB + ACESFilmic)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.RENDER.TONE_MAPPING_EXPOSURE;

    // 陰影配置 (PCFSoftShadowMap)
    if (CONFIG.RENDER.SHADOWS_ENABLED) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.container.appendChild(this.renderer.domElement);

    // 4. 後處理管理器
    this.postProcessing = new PostProcessingManager(this.renderer, this.scene, this.camera);

    // 5. 視窗縮放監聽
    window.addEventListener('resize', this.resize);
  }

  public resize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.postProcessing.resize(width, height);
  };

  public render(delta: number = 0.016): void {
    this.postProcessing.render(delta);
  }

  public getRenderInfo(): { calls: number; triangles: number } {
    return this.postProcessing.getSceneRenderInfo();
  }

  public dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
