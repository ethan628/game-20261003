/**
 * WeatherRenderer.ts - GTA 風格動態天氣與時間渲染系統
 * 遵循 RULES.md：
 * 1. 動態天空穹頂（日夜暮光漸層、日月方位、月相、雲層飄移、星空）
 * 2. 嚴格效能預算：雨絲 InstancedMesh (1 Draw Call) + 水花 InstancedMesh (1 Draw Call) <= 2 Draw Calls
 * 3. 雨絲與水花採用 GPU Vertex Shader 循環下落與展開，CPU 逐幀零負載 (0.00 ms)
 * 4. 天文光影連動 (日出/日落/正午/深夜/雷雨閃電/動態濃霧)
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { TimeSystem } from '../systems/time/TimeSystem.ts';
import { WeatherSystem } from '../systems/weather/WeatherSystem.ts';
import { RoadGenerator } from './RoadGenerator.ts';
import { TerrainFeatureGenerator } from './TerrainFeatureGenerator.ts';

// 天空色彩關鍵點定義
interface SkyColorSet {
  top: THREE.Color;
  mid: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sunLight: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  sunIntensity: number;
}

export class WeatherRenderer {
  private scene: THREE.Scene;
  private timeSystem: TimeSystem;
  private weatherSystem: WeatherSystem;
  private roadGenerator?: RoadGenerator;
  private terrainFeatureGen?: TerrainFeatureGenerator;

  // 渲染元件
  private skyDomeMesh: THREE.Mesh | null = null;
  private skyMaterial: THREE.ShaderMaterial | null = null;
  private dirLight: THREE.DirectionalLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private bounceLight: THREE.DirectionalLight | null = null; // 暖色反射補光 (從下往上照，4~6% 強度)

  // 雨絲與水花 (GPU InstancedMesh)
  private rainMesh: THREE.InstancedMesh | null = null;
  private rainMaterial: THREE.ShaderMaterial | null = null;
  private splashMesh: THREE.InstancedMesh | null = null;
  private splashMaterial: THREE.ShaderMaterial | null = null;

  // 品質設定
  private quality: 'low' | 'medium' | 'high' = 'high';

  // 暫存向量
  private tmpSunDir = new THREE.Vector3();
  private tmpMoonDir = new THREE.Vector3();
  private lastNightState: boolean = false;
  private onNightModeChangeCallback?: (isNight: boolean) => void;

  // 夜間效果與曝光調節
  private renderer?: THREE.WebGLRenderer;
  private currentExposure: number = CONFIG.RENDER.TONE_MAPPING_EXPOSURE;
  private targetExposure: number = CONFIG.RENDER.TONE_MAPPING_EXPOSURE;
  private nightBrightnessMultiplier: number = CONFIG.NIGHT_LIGHTING.BASE_NIGHT_BRIGHTNESS;
  private urbanLightPollution: number = CONFIG.NIGHT_LIGHTING.URBAN_LIGHT_POLLUTION;
  private activePreset: 'ground_visible' | 'gta_contrast' | 'soft' | 'dim' = CONFIG.NIGHT_LIGHTING.DEFAULT_PRESET;
  private groundVisibility: number = CONFIG.NIGHT_LIGHTING.GROUND_VISIBILITY;
  private lastUpdateTimestamp: number = 0;

  // 程序生成夜空 PMREM 環境反射貼圖 (低頻 5s 更新一次)
  private pmremGenerator?: THREE.PMREMGenerator;
  private nightEnvRenderTarget?: THREE.WebGLRenderTarget;
  private envCanvas?: HTMLCanvasElement;
  private envTexture?: THREE.CanvasTexture;
  private lastEnvUpdateTime: number = 0;

  constructor(
    scene: THREE.Scene,
    timeSystem: TimeSystem,
    weatherSystem: WeatherSystem,
    roadGenerator?: RoadGenerator,
    renderer?: THREE.WebGLRenderer
  ) {
    this.scene = scene;
    this.timeSystem = timeSystem;
    this.weatherSystem = weatherSystem;
    this.roadGenerator = roadGenerator;
    this.renderer = renderer;
    if (renderer) {
      this.setRenderer(renderer);
    }

    try {
      const savedPreset = localStorage.getItem('GTA_NIGHT_PRESET') as any;
      if (savedPreset && savedPreset in CONFIG.NIGHT_LIGHTING.PRESETS) {
        this.activePreset = savedPreset as 'ground_visible' | 'gta_contrast' | 'soft' | 'dim';
      }
    } catch (_) {}

    this.setupLighting();
    this.setupSkyDome();
    this.setupRainParticles();
    this.setupSplashParticles();
  }

  public setRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    if (renderer) {
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      if (!this.pmremGenerator) {
        this.pmremGenerator = new THREE.PMREMGenerator(renderer);
        this.pmremGenerator.compileEquirectangularShader();
      }
    }
  }

  public setNightBrightness(val: number): void {
    // 夜晚亮度滑桿僅調整「月光與環境光強度」(0.6 ~ 1.4)，不再影響全域曝光或墊高
    this.nightBrightnessMultiplier = Math.max(0.6, Math.min(1.4, val));
  }

  public getNightBrightness(): number {
    return this.nightBrightnessMultiplier;
  }

  public setGroundVisibility(val: number): void {
    this.groundVisibility = Math.max(0.5, Math.min(2.0, val));
    this.roadGenerator?.setGroundVisibility(this.groundVisibility);
    this.terrainFeatureGen?.setGroundVisibility(this.groundVisibility);
  }

  public getGroundVisibility(): number {
    return this.groundVisibility;
  }

  public setNightPreset(presetId: 'ground_visible' | 'gta_contrast' | 'soft' | 'dim'): void {
    if (CONFIG.NIGHT_LIGHTING.PRESETS[presetId]) {
      this.activePreset = presetId;
      try {
        localStorage.setItem('GTA_NIGHT_PRESET', presetId);
      } catch (_) {}
    }
  }

  public getNightPreset(): 'ground_visible' | 'gta_contrast' | 'soft' | 'dim' {
    return this.activePreset;
  }

  public setUrbanLightPollution(val: number): void {
    this.urbanLightPollution = Math.max(0.0, Math.min(2.0, val));
  }

  public getUrbanLightPollution(): number {
    return this.urbanLightPollution;
  }

  public setRoadGenerator(roadGen: RoadGenerator): void {
    this.roadGenerator = roadGen;
    this.roadGenerator.setGroundVisibility(this.groundVisibility);
  }

  public setTerrainFeatureGenerator(gen: TerrainFeatureGenerator): void {
    this.terrainFeatureGen = gen;
    this.terrainFeatureGen.setGroundVisibility(this.groundVisibility);
  }

  public setNightModeChangeCallback(callback: (isNight: boolean) => void): void {
    this.onNightModeChangeCallback = callback;
  }

  /**
   * 程序生成夜空 PMREM 環境反射貼圖 (天空漸層、光害帶、亮斑，低頻 5s 更新一次)
   * 使濕潤路面與建築玻璃在無路燈處也能真實反射夜空微光，杜絕死黑
   */
  private updateEnvironmentMap(
    nightFactor: number,
    sunMoon: any,
    _weatherParams: any,
    now: number
  ): void {
    if (!this.renderer || !this.pmremGenerator) return;
    if (this.lastEnvUpdateTime > 0 && now - this.lastEnvUpdateTime < 5000.0) {
      return;
    }
    this.lastEnvUpdateTime = now;

    if (!this.envCanvas) {
      this.envCanvas = document.createElement('canvas');
      this.envCanvas.width = 256;
      this.envCanvas.height = 128;
      this.envTexture = new THREE.CanvasTexture(this.envCanvas);
      this.envTexture.mapping = THREE.EquirectangularReflectionMapping;
    }

    const ctx = this.envCanvas.getContext('2d')!;
    const w = 256;
    const h = 128;

    // 天空上亮下暗漸層 (Equirectangular: y=0 為天頂，y=h*0.5 為地平線，y=h 為地面)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    if (nightFactor > 0.05) {
      // 夜間天空：天頂深冷海軍板岩藍，地平線微弱暖光害紫，地面深黑藍
      skyGrad.addColorStop(0.0, '#0a1428'); // 天頂冷深藍
      skyGrad.addColorStop(0.35, '#162038');
      skyGrad.addColorStop(0.48, '#261834'); // 光害帶
      skyGrad.addColorStop(0.50, '#101420'); // 地平線
      skyGrad.addColorStop(0.70, '#0c101c'); // 地面
      skyGrad.addColorStop(1.0, '#080a12');
    } else {
      // 白天天空：天頂湛藍，地平線淺天藍
      skyGrad.addColorStop(0.0, '#1d4ed8');
      skyGrad.addColorStop(0.35, '#38bdf8');
      skyGrad.addColorStop(0.50, '#bae6fd');
      skyGrad.addColorStop(0.70, '#64748b');
      skyGrad.addColorStop(1.0, '#334155');
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // 月亮亮斑 (若夜晚且月亮仰角 > 0)
    if (nightFactor > 0.1 && sunMoon.moon.altitudeDeg > 0) {
      const az = sunMoon.moon.azimuthRad;
      const alt = sunMoon.moon.altitudeRad;
      const mx = ((az / (Math.PI * 2)) % 1.0) * w;
      const my = Math.max(4, Math.min(h - 4, (0.5 - (alt / Math.PI)) * h));
      const moonGrad = ctx.createRadialGradient(mx, my, 0, mx, my, 16);
      moonGrad.addColorStop(0.0, 'rgba(190, 215, 255, 0.90)');
      moonGrad.addColorStop(0.35, 'rgba(130, 170, 255, 0.35)');
      moonGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
      ctx.fillStyle = moonGrad;
      ctx.beginPath();
      ctx.arc(mx, my, 16, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.envTexture) {
      this.envTexture.needsUpdate = true;
      const prevRt = this.nightEnvRenderTarget;
      this.nightEnvRenderTarget = this.pmremGenerator.fromEquirectangular(this.envTexture);
      this.scene.environment = this.nightEnvRenderTarget.texture;
      if (prevRt) {
        prevRt.dispose();
      }
    }
  }

  public setQuality(quality: 'low' | 'medium' | 'high'): void {
    if (this.quality !== quality) {
      this.quality = quality;
      // 重建粒子
      this.setupRainParticles();
      this.setupSplashParticles();
    }
  }

  /**
   * 初始化光照系統
   */
  private setupLighting(): void {
    // 1. 半球環境光
    this.hemiLight = new THREE.HemisphereLight(0x8cc4f0, 0x6e523e, 1.15);
    this.hemiLight.position.set(0, 100, 0);
    this.scene.add(this.hemiLight);

    // 2. 主方向光 (太陽/月亮)
    this.dirLight = new THREE.DirectionalLight(0xffb066, 1.6);
    this.dirLight.castShadow = CONFIG.RENDER.SHADOWS_ENABLED;

    // 3. 暖色地面反射向上補光 (街道鈉燈向上反彈，4~6% 強度，不投射陰影)
    this.bounceLight = new THREE.DirectionalLight(0xff8844, 0.0);
    this.bounceLight.castShadow = false;
    this.scene.add(this.bounceLight);
    this.scene.add(this.bounceLight.target);

    const d = CONFIG.WORLD.SHADOW_CAMERA_RADIUS;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.camera.near = 20;
    this.dirLight.shadow.camera.far = 450;
    this.dirLight.shadow.bias = -0.00025;
    this.dirLight.shadow.mapSize.width = CONFIG.WORLD.SHADOW_MAP_SIZE;
    this.dirLight.shadow.mapSize.height = CONFIG.WORLD.SHADOW_MAP_SIZE;

    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    // 3. 全域霧氣 (FogExp2: 空氣透視，隨晝夜與降雨濃霧動態過渡)
    if (!this.scene.fog) {
      this.scene.fog = new THREE.FogExp2(0x1c1e36, 0.0016);
    }
    this.scene.background = new THREE.Color(0x0e1424);
  }

  /**
   * 初始化動態天空穹頂 Shader
   */
  private setupSkyDome(): void {
    const skyGeo = new THREE.SphereGeometry(920, 32, 24);

    const vertexShader = `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      uniform vec3 uSunDir;
      uniform vec3 uMoonDir;
      uniform float uMoonPhase;
      uniform float uMoonIllum;
      uniform float uCloudCover;
      uniform float uRainIntensity;
      uniform float uTime;
      uniform float uThunderFlash;
      uniform vec3 uTopColor;
      uniform vec3 uMidColor;
      uniform vec3 uHorizonColor;
      uniform float uNightFactor;
      uniform float uUrbanLightPollution;

      varying vec3 vWorldPosition;

      // 簡易 2D 雜訊產生器
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float fbm(vec2 p) {
        float v = 0.0;
        v += 0.5000 * noise(p); p *= 2.02;
        v += 0.2500 * noise(p); p *= 2.03;
        v += 0.1250 * noise(p);
        return v;
      }

      void main() {
        vec3 dir = normalize(vWorldPosition);
        float h = max(0.0, dir.y);

        // 漸層插值：Horizon -> Mid -> Top
        vec3 skyColor = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.25, h));
        skyColor = mix(skyColor, uTopColor, smoothstep(0.25, 0.9, h));

        // 太陽圓盤與日暈
        float sunDot = max(0.0, dot(dir, uSunDir));
        if (uSunDir.y > -0.05) {
          float sunDisk = smoothstep(0.9995, 0.9999, sunDot);
          float sunGlow = pow(sunDot, 64.0) * 0.45 + pow(sunDot, 12.0) * 0.25;
          skyColor += vec3(1.0, 0.95, 0.85) * (sunDisk * 2.5 + sunGlow * (1.0 - uCloudCover * 0.85));
        }

        // 月球圓盤與月相 (只在仰角大於 0 度時顯示，視覺直徑約 2 度，附小範圍柔和光暈，雨雲遮蔽)
        float moonDot = max(0.0, dot(dir, uMoonDir));
        if (uMoonDir.y > 0.0 && uSunDir.y < 0.15) {
          // 視覺直徑約 2 度 (cos(1度) ~ 0.99985)
          float moonDisk = smoothstep(0.9997, 0.9999, moonDot);
          vec3 moonColor = vec3(0.85, 0.90, 1.0) * uMoonIllum;
          // 小範圍光暈 (高次方集中衰減，杜絕巨大發光圓盤)
          float moonGlow = pow(moonDot, 256.0) * 0.20 * uMoonIllum;
          float cloudOcclusion = (1.0 - uCloudCover * 0.85) * (1.0 - uRainIntensity * 0.95);
          skyColor += (moonColor * moonDisk * 1.5 + vec3(0.5, 0.65, 0.9) * moonGlow) * cloudOcclusion;
        }

        // 夜空星星 (夜間且仰角較高時顯現)
        if (uSunDir.y < -0.08 && h > 0.05) {
          vec2 starCoord = dir.xz / (dir.y + 0.1) * 220.0;
          float starVal = hash(floor(starCoord));
          if (starVal > 0.985) {
            float twinkle = sin(uTime * 3.0 + starVal * 62.0) * 0.35 + 0.65;
            float starAlpha = (starVal - 0.985) / 0.015 * twinkle;
            float nightFactor = clamp((-uSunDir.y - 0.08) * 4.0, 0.0, 1.0);
            skyColor += vec3(0.9, 0.95, 1.0) * starAlpha * nightFactor * (1.0 - uCloudCover);
          }
        }

        // 雲層渲染 (FBM 隨時間風向流動)
        if (h > 0.01 && uCloudCover > 0.02) {
          vec2 cloudUv = (dir.xz / (h + 0.15)) * 0.75 + vec2(uTime * 0.008, uTime * 0.004);
          float cloudDensity = fbm(cloudUv * 3.0);
          float cloudMask = smoothstep(1.0 - uCloudCover * 0.85, 1.2, cloudDensity + uCloudCover * 0.4);

          // 雲層受日光/天色反射
          vec3 cloudBaseColor = mix(vec3(0.92, 0.90, 0.88), vec3(0.35, 0.38, 0.42), clamp(uRainIntensity + (1.0 - max(0.0, uSunDir.y)) * 0.6, 0.0, 0.85));
          if (uSunDir.y < -0.05) {
            // 夜晚雲層：底層受城鎮散射光照亮呈暗橘紫 (GTA 城市夜空雲底反射)
            vec3 cloudNightBase = vec3(0.12, 0.14, 0.22);
            vec3 cloudPollutionTint = vec3(0.25, 0.13, 0.06);
            cloudBaseColor = mix(cloudNightBase, cloudPollutionTint, clamp(uUrbanLightPollution * 0.70 * (1.0 - h * 0.45), 0.0, 0.9));
          }

          skyColor = mix(skyColor, cloudBaseColor, cloudMask * min(1.0, uCloudCover * 1.4));
        }

        // 城市光害 (Urban Light Pollution) - 夜晚靠近地平線窄頻帶 (約 8~12 度)
        if (uNightFactor > 0.01 && uUrbanLightPollution > 0.01) {
          float horGlow = pow(max(0.0, 1.0 - h * 5.5), 3.0);
          vec3 lightPollutionColor = mix(vec3(0.22, 0.10, 0.03), vec3(0.14, 0.05, 0.18), smoothstep(0.0, 0.15, h));
          skyColor += lightPollutionColor * horGlow * uUrbanLightPollution * uNightFactor * (1.0 + uCloudCover * 0.6);
        }

        // 雷雨閃電全天空瞬間泛白
        if (uThunderFlash > 0.01) {
          skyColor += vec3(0.85, 0.90, 1.0) * uThunderFlash * 1.8;
        }

        gl_FragColor = vec4(skyColor, 1.0);
      }
    `;

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonPhase: { value: 0.5 },
        uMoonIllum: { value: 0.5 },
        uCloudCover: { value: 0.1 },
        uRainIntensity: { value: 0.0 },
        uTime: { value: 0.0 },
        uThunderFlash: { value: 0.0 },
        uTopColor: { value: new THREE.Color(0x1e3a5f) },
        uMidColor: { value: new THREE.Color(0x38bdf8) },
        uHorizonColor: { value: new THREE.Color(0xbae6fd) },
        uNightFactor: { value: 0.0 },
        uUrbanLightPollution: { value: CONFIG.NIGHT_LIGHTING.URBAN_LIGHT_POLLUTION }
      },
      side: THREE.BackSide,
      depthWrite: false
    });

    this.skyDomeMesh = new THREE.Mesh(skyGeo, this.skyMaterial);
    this.skyDomeMesh.name = 'WeatherSkyDome';
    this.scene.add(this.skyDomeMesh);
  }

  /**
   * 初始化 GPU 雨絲 InstancedMesh (1 Draw Call)
   */
  private setupRainParticles(): void {
    if (this.rainMesh) {
      this.scene.remove(this.rainMesh);
      this.rainMesh.geometry.dispose();
      this.rainMesh = null;
    }

    const count = CONFIG.WEATHER.PARTICLE_COUNTS[this.quality] || 3200;

    // 雨絲細長幾何體 (寬 0.016m, 長 0.80m)
    const rainGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.80, 4);

    // 自訂 ShaderMaterial (純 GPU 循環下落)
    const vertexShader = `
      uniform float uTime;
      uniform float uSpeed;
      uniform vec3 uWind;
      uniform vec3 uPlayerPos;
      uniform vec3 uBoxSize;

      attribute vec3 aInitialPos;
      attribute float aPhase;

      void main() {
        vec3 p = aInitialPos;

        // 循環下落公式
        float fallDist = (uTime + aPhase) * uSpeed;
        p.y = mod(p.y - fallDist, uBoxSize.y) - (uBoxSize.y * 0.5);

        // 風向斜傾
        p.x += uWind.x * ((p.y + uBoxSize.y * 0.5) / uBoxSize.y);
        p.z += uWind.z * ((p.y + uBoxSize.y * 0.5) / uBoxSize.y);

        vec3 worldPos = position + p + uPlayerPos;
        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `;

    const fragmentShader = `
      uniform float uRainIntensity;
      uniform float uThunderFlash;

      void main() {
        vec3 color = vec3(0.85, 0.92, 1.0);
        if (uThunderFlash > 0.05) {
          color = vec3(1.0);
        }
        float alpha = clamp(uRainIntensity * 0.55, 0.0, 0.65);
        gl_FragColor = vec4(color, alpha);
      }
    `;

    this.rainMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0.0 },
        uSpeed: { value: 24.0 }, // 24 m/s 雨落下速度
        uWind: { value: new THREE.Vector3(2, 0, 1) },
        uPlayerPos: { value: new THREE.Vector3(0, 0, 0) },
        uBoxSize: { value: new THREE.Vector3(75.0, 36.0, 75.0) },
        uRainIntensity: { value: 0.0 },
        uThunderFlash: { value: 0.0 }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });

    const instGeo = new THREE.InstancedBufferGeometry();
    instGeo.index = rainGeo.index;
    instGeo.attributes = rainGeo.attributes;

    const initialPos = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const boxSize = new THREE.Vector3(75.0, 36.0, 75.0);

    for (let i = 0; i < count; i++) {
      initialPos[i * 3 + 0] = (Math.random() - 0.5) * boxSize.x;
      initialPos[i * 3 + 1] = Math.random() * boxSize.y;
      initialPos[i * 3 + 2] = (Math.random() - 0.5) * boxSize.z;
      phases[i] = Math.random() * 10.0;
    }

    instGeo.setAttribute('aInitialPos', new THREE.InstancedBufferAttribute(initialPos, 3));
    instGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));

    this.rainMesh = new THREE.InstancedMesh(instGeo, this.rainMaterial, count);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.name = 'GPURainParticles';
    this.rainMesh.visible = false;
    this.scene.add(this.rainMesh);
  }

  /**
   * 初始化地面水花 InstancedMesh (1 Draw Call)
   */
  private setupSplashParticles(): void {
    if (this.splashMesh) {
      this.scene.remove(this.splashMesh);
      this.splashMesh.geometry.dispose();
      this.splashMesh = null;
    }

    const count = CONFIG.WEATHER.SPLASH_COUNTS[this.quality] || 0;
    if (count <= 0) return;

    // 水花漣漪圓盤
    const splashGeo = new THREE.PlaneGeometry(0.35, 0.35);
    splashGeo.rotateX(-Math.PI / 2);

    const vertexShader = `
      uniform float uTime;
      uniform vec3 uPlayerPos;
      attribute vec3 aSplashPos;
      attribute float aSplashPhase;

      varying float vProgress;

      void main() {
        float cycle = mod((uTime * 3.5) + aSplashPhase, 1.0);
        vProgress = cycle;

        vec3 p = position * (0.3 + cycle * 1.4);
        vec3 worldPos = p + aSplashPos + uPlayerPos;
        worldPos.y = 0.04; // 貼近柏油路面

        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `;

    const fragmentShader = `
      varying float vProgress;
      uniform float uRainIntensity;

      void main() {
        // 同心圓環光圈
        float alpha = (1.0 - vProgress) * clamp(uRainIntensity, 0.0, 1.0) * 0.45;
        gl_FragColor = vec4(0.85, 0.95, 1.0, alpha);
      }
    `;

    this.splashMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0.0 },
        uPlayerPos: { value: new THREE.Vector3(0, 0, 0) },
        uRainIntensity: { value: 0.0 }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const instGeo = new THREE.InstancedBufferGeometry();
    instGeo.index = splashGeo.index;
    instGeo.attributes = splashGeo.attributes;

    const splashPos = new Float32Array(count * 3);
    const splashPhases = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      splashPos[i * 3 + 0] = (Math.random() - 0.5) * 45.0;
      splashPos[i * 3 + 1] = 0.0;
      splashPos[i * 3 + 2] = (Math.random() - 0.5) * 45.0;
      splashPhases[i] = Math.random();
    }

    instGeo.setAttribute('aSplashPos', new THREE.InstancedBufferAttribute(splashPos, 3));
    instGeo.setAttribute('aSplashPhase', new THREE.InstancedBufferAttribute(splashPhases, 1));

    this.splashMesh = new THREE.InstancedMesh(instGeo, this.splashMaterial, count);
    this.splashMesh.frustumCulled = false;
    this.splashMesh.name = 'GPUSplashParticles';
    this.splashMesh.visible = false;
    this.scene.add(this.splashMesh);
  }

  /**
   * 計算當前暮光與天氣下的色彩集
   */
  private evaluateSkyColors(): SkyColorSet {
    const sunMoon = this.timeSystem.getSunMoonInfo();
    const weatherParams = this.weatherSystem.getVisualParams();
    const sunAltDeg = sunMoon.sun.altitudeDeg;

    // 白天基準 (正午晴空)
    const dayTop = new THREE.Color(0x1d4ed8);      // 湛藍
    const dayMid = new THREE.Color(0x38bdf8);      // 天青
    const dayHor = new THREE.Color(0xbae6fd);      // 柔和淺天藍
    const dayFog = new THREE.Color(0xdbeafe);
    const daySun = new THREE.Color(0xfff6e5);      // 暖白
    const dayHemiSky = new THREE.Color(0x8cc4f0);
    const dayHemiGrd = new THREE.Color(0x6e523e);

    // 黃昏/日出金黃魔幻時刻
    const sunsetTop = new THREE.Color(0x1e1b4b);    // 深紫夜空
    const sunsetMid = new THREE.Color(0xb91c1c);    // 晚霞磚紅
    const sunsetHor = new THREE.Color(0xfb923c);    // 金黃暮光地平線
    const sunsetFog = new THREE.Color(0xfdba74);
    const sunsetSun = new THREE.Color(0xff8833);    // 橘金日光
    const sunsetHemiSky = new THREE.Color(0xd97706);
    const sunsetHemiGrd = new THREE.Color(0x451a03);

    // 深夜皎潔月光 (GTA 城市夜空：天頂深海軍板岩藍、地平線窄光害微光紫、冷藍天空環境光、暖橘棕地面環境光)
    const nightTop = new THREE.Color(0x060a18);    // 深海軍板岩藍天頂
    const nightMid = new THREE.Color(0x141830);    // 藍紫深夜色調
    const nightHor = new THREE.Color(0x221832);    // 地平線暗紫
    const nightFog = new THREE.Color(0x141c33);    // 夜間近景暗藍霧色 (#141c33)
    const nightMoon = new THREE.Color(0x6f8cff);   // 虛擬/真實月光冷藍 (#6f8cff)
    const nightHemiSky = new THREE.Color(0x2a3d70); // 深藍冷調天空環境光 (#2a3d70)
    const nightHemiGrd = new THREE.Color(0x6b3f22); // 暖橘棕地面環境光 (#6b3f22，街道鈉燈反彈)

    // 陰雨天偏灰冷調
    const overcastTop = new THREE.Color(0x475569);
    const overcastMid = new THREE.Color(0x64748b);
    const overcastHor = new THREE.Color(0x94a3b8);
    const overcastFog = new THREE.Color(0x94a3b8);
    const overcastSun = new THREE.Color(0xcfd8dc);
    const overcastHemiSky = new THREE.Color(0x64748b);
    const overcastHemiGrd = new THREE.Color(0x334155);

    let baseSet: SkyColorSet;

    if (sunAltDeg > 12.0) {
      // 燦爛白天
      baseSet = {
        top: dayTop.clone(),
        mid: dayMid.clone(),
        horizon: dayHor.clone(),
        fog: dayFog.clone(),
        sunLight: daySun.clone(),
        hemiSky: dayHemiSky.clone(),
        hemiGround: dayHemiGrd.clone(),
        sunIntensity: 1.55
      };
    } else if (sunAltDeg > -2.0) {
      // 日出日落黃金時段插值 (12° ~ -2°)
      const t = (sunAltDeg + 2.0) / 14.0; // 0=黃昏, 1=白天
      baseSet = {
        top: sunsetTop.clone().lerp(dayTop, t),
        mid: sunsetMid.clone().lerp(dayMid, t),
        horizon: sunsetHor.clone().lerp(dayHor, t),
        fog: sunsetFog.clone().lerp(dayFog, t),
        sunLight: sunsetSun.clone().lerp(daySun, t),
        hemiSky: sunsetHemiSky.clone().lerp(dayHemiSky, t),
        hemiGround: sunsetHemiGrd.clone().lerp(dayHemiGrd, t),
        sunIntensity: THREE.MathUtils.lerp(1.10, 1.55, t)
      };
    } else if (sunAltDeg > -12.0) {
      // 暮光轉夜 (-2° ~ -12°)
      const t = (sunAltDeg + 12.0) / 10.0; // 0=夜, 1=暮光
      baseSet = {
        top: nightTop.clone().lerp(sunsetTop, t),
        mid: nightMid.clone().lerp(sunsetMid, t),
        horizon: nightHor.clone().lerp(sunsetHor, t),
        fog: nightFog.clone().lerp(sunsetFog, t),
        sunLight: nightMoon.clone().lerp(sunsetSun, t),
        hemiSky: nightHemiSky.clone().lerp(sunsetHemiSky, t),
        hemiGround: nightHemiGrd.clone().lerp(sunsetHemiGrd, t),
        sunIntensity: THREE.MathUtils.lerp(0.35, 1.10, t)
      };
    } else {
      // 深夜
      baseSet = {
        top: nightTop.clone(),
        mid: nightMid.clone(),
        horizon: nightHor.clone(),
        fog: nightFog.clone(),
        sunLight: nightMoon.clone(),
        hemiSky: nightHemiSky.clone().multiplyScalar(this.nightBrightnessMultiplier),
        hemiGround: nightHemiGrd.clone().multiplyScalar(this.nightBrightnessMultiplier),
        sunIntensity: Math.max(0.20, (0.35 + sunMoon.moonIllumination * 0.25) * this.nightBrightnessMultiplier)
      };
    }

    // 融入雲量與降雨 (Overcast/Rain Blend)
    const overcastFactor = Math.min(1.0, weatherParams.cloudCover * 0.75 + weatherParams.rainIntensity * 0.5);
    if (overcastFactor > 0.01) {
      if (sunAltDeg > -2.0) {
        // 白天與暮光：融入陰雨天淺灰調
        baseSet.top.lerp(overcastTop, overcastFactor * 0.85);
        baseSet.mid.lerp(overcastMid, overcastFactor * 0.85);
        baseSet.horizon.lerp(overcastHor, overcastFactor * 0.90);
        baseSet.fog.lerp(overcastFog, overcastFactor * 0.95);
        baseSet.sunLight.lerp(overcastSun, overcastFactor * 0.75);
        baseSet.hemiSky.lerp(overcastHemiSky, overcastFactor * 0.85);
        baseSet.hemiGround.lerp(overcastHemiGrd, overcastFactor * 0.85);
        baseSet.sunIntensity *= (1.0 - overcastFactor * 0.55);
      } else {
        // 夜間雨天：雲層阻擋月光，維持深邃藍紫夜空與暗沉色調 (避免白晝陰天灰洗白夜景)
        baseSet.fog.lerp(nightFog, 0.45);
        baseSet.sunIntensity *= (1.0 - overcastFactor * 0.65);
      }
    }

    return baseSet;
  }

  /**
   * 逐幀更新天氣與時間渲染 (每幀耗時嚴格 < 0.2 ms)
   */
  public update(playerPos: THREE.Vector3, totalTimeSec: number): void {
    const sunMoon = this.timeSystem.getSunMoonInfo();
    const weatherParams = this.weatherSystem.getVisualParams();
    const isSunUp = sunMoon.isSunAboveHorizon;
    const sunAltDeg = sunMoon.sun.altitudeDeg;
    const nightFactor = Math.max(0, Math.min(1, (-sunAltDeg - 2.0) / 10.0));

    const preset = (CONFIG.NIGHT_LIGHTING.PRESETS as any)[this.activePreset] || CONFIG.NIGHT_LIGHTING.PRESETS.gta_contrast;

    // 曝光補償平滑過渡 (白天 1.0，夜晚最高 1.25 倍，10 秒平滑過渡；不再大幅拉曝光)
    const baseExp = 1.0;
    const targetNightExp = preset.exposure;
    this.targetExposure = THREE.MathUtils.lerp(baseExp, targetNightExp, nightFactor);
    const dt = this.lastUpdateTimestamp > 0 ? Math.min(0.1, (performance.now() - this.lastUpdateTimestamp) * 0.001) : 0.016;
    this.lastUpdateTimestamp = performance.now();
    this.currentExposure += (this.targetExposure - this.currentExposure) * Math.min(1.0, dt * CONFIG.NIGHT_LIGHTING.EXPOSURE_LERP_SPEED * 1.0);
    if (this.renderer) {
      this.renderer.toneMappingExposure = this.currentExposure;
    }

    // 1. 同步天空穹頂位置與 Shader Uniforms
    if (this.skyDomeMesh && this.skyMaterial) {
      this.skyDomeMesh.position.copy(playerPos);

      const colors = this.evaluateSkyColors();
      const uniforms = this.skyMaterial.uniforms;

      this.tmpSunDir.set(...sunMoon.sun.directionVector).normalize();
      this.tmpMoonDir.set(...sunMoon.moon.directionVector).normalize();

      uniforms.uSunDir.value.copy(this.tmpSunDir);
      uniforms.uMoonDir.value.copy(this.tmpMoonDir);
      uniforms.uMoonPhase.value = sunMoon.moonPhase;
      uniforms.uMoonIllum.value = sunMoon.moonIllumination;
      uniforms.uCloudCover.value = weatherParams.cloudCover;
      uniforms.uRainIntensity.value = weatherParams.rainIntensity;
      uniforms.uTime.value = totalTimeSec;
      uniforms.uThunderFlash.value = weatherParams.thunderFlash;
      uniforms.uTopColor.value.copy(colors.top);
      uniforms.uMidColor.value.copy(colors.mid);
      uniforms.uHorizonColor.value.copy(colors.horizon);
      uniforms.uNightFactor.value = nightFactor;
      uniforms.uUrbanLightPollution.value = preset.lightPollution;

      // 2. 更新主光源 (太陽 / 月亮 / 虛擬月光)
      if (this.dirLight) {
        const lightDist = 200.0;
        if (isSunUp) {
          this.dirLight.position.set(
            playerPos.x + this.tmpSunDir.x * lightDist,
            playerPos.y + Math.max(15.0, this.tmpSunDir.y * lightDist),
            playerPos.z + this.tmpSunDir.z * lightDist
          );
          this.dirLight.target.position.copy(playerPos);
          this.dirLight.target.updateMatrixWorld();
          this.dirLight.color.copy(colors.sunLight);
          this.dirLight.intensity = colors.sunIntensity;
        } else {
          // 夜間月光：在水平面上時用真實位置，水平面下時固定仰角約 35 度、方位依月亮方位
          const moonAltDeg = sunMoon.moon.altitudeDeg;
          if (moonAltDeg > 0.0) {
            this.dirLight.position.set(
              playerPos.x + this.tmpMoonDir.x * lightDist,
              playerPos.y + Math.max(15.0, this.tmpMoonDir.y * lightDist),
              playerPos.z + this.tmpMoonDir.z * lightDist
            );
            const moonPower = 1.55 * preset.moonIntensity * this.nightBrightnessMultiplier;
            this.dirLight.color.set(CONFIG.NIGHT_LIGHTING.COLOR_MOON_BLUE);
            this.dirLight.intensity = moonPower;
          } else {
            // 虛擬月光：固定仰角 35 度 (約 0.61 rad)，方位依月亮方位
            const moonAzimuthRad = sunMoon.moon.azimuthRad;
            const virtPitchRad = 35.0 * (Math.PI / 180.0);
            const virtX = Math.sin(moonAzimuthRad) * Math.cos(virtPitchRad) * lightDist;
            const virtY = Math.sin(virtPitchRad) * lightDist;
            const virtZ = Math.cos(moonAzimuthRad) * Math.cos(virtPitchRad) * lightDist;
            this.dirLight.position.set(playerPos.x + virtX, playerPos.y + virtY, playerPos.z + virtZ);
            this.dirLight.color.set(CONFIG.NIGHT_LIGHTING.COLOR_MOON_BLUE);
            this.dirLight.intensity = 1.55 * preset.moonIntensity * this.nightBrightnessMultiplier;
          }
          this.dirLight.target.position.copy(playerPos);
          this.dirLight.target.updateMatrixWorld();
        }

        // 閃電增益
        if (weatherParams.thunderFlash > 0.05) {
          this.dirLight.intensity += weatherParams.thunderFlash * CONFIG.WEATHER.LIGHTNING.SURGE_LIGHT_INTENSITY;
          this.dirLight.color.setRGB(1.0, 1.0, 1.0);
        }
      }

      // 3. 暖色地面反射向上補光 (街道鈉燈向上反彈，4~6% 強度，不投射陰影)
      if (this.bounceLight) {
        if (nightFactor > 0.01) {
          this.bounceLight.position.set(playerPos.x, playerPos.y - 40.0, playerPos.z);
          this.bounceLight.target.position.set(playerPos.x, playerPos.y + 40.0, playerPos.z);
          this.bounceLight.target.updateMatrixWorld();
          this.bounceLight.color.set(CONFIG.NIGHT_LIGHTING.COLOR_BOUNCE_ORANGE);
          this.bounceLight.intensity = 1.55 * preset.bounceIntensity * nightFactor * this.nightBrightnessMultiplier;
        } else {
          this.bounceLight.intensity = 0.0;
        }
      }

      // 4. 更新半球環境光
      if (this.hemiLight) {
        if (weatherParams.thunderFlash > 0.05) {
          this.hemiLight.color.setRGB(1.0, 1.0, 1.0);
          this.hemiLight.intensity = 2.8;
        } else {
          this.hemiLight.color.copy(colors.hemiSky);
          this.hemiLight.groundColor.copy(colors.hemiGround);
          // 夜間環境光強度為白天的 18~24% (由 preset.hemiIntensity 決定)
          const targetNightHemi = 1.15 * preset.hemiIntensity * this.nightBrightnessMultiplier;
          this.hemiLight.intensity = THREE.MathUtils.lerp(1.15, targetNightHemi, nightFactor);
        }
      }

      // 5. 更新霧氣 (FogExp2)
      if (this.scene.fog instanceof THREE.FogExp2) {
        if (nightFactor > 0.05) {
          // 夜間近景霧色偏暗藍 (#141c33)，避免暮光鮭魚粉染入地面
          this.scene.fog.color.set(CONFIG.NIGHT_LIGHTING.COLOR_NIGHT_FOG);
        } else {
          this.scene.fog.color.copy(colors.fog);
        }
        const baseDensity = 0.0016;
        const targetDensity = baseDensity * weatherParams.fogDensity + weatherParams.rainIntensity * 0.0028;
        this.scene.fog.density = targetDensity;
      }
    }

    // 5. 更新 GPU 雨絲 InstancedMesh (晴天雨量 <= 0.005 時徹底隱藏並停止)
    if (this.rainMesh && this.rainMaterial) {
      if (weatherParams.rainIntensity > 0.005) {
        this.rainMesh.visible = true;
        const u = this.rainMaterial.uniforms;
        u.uTime.value = totalTimeSec;
        u.uPlayerPos.value.copy(playerPos);
        u.uRainIntensity.value = weatherParams.rainIntensity;
        u.uThunderFlash.value = weatherParams.thunderFlash;

        // 風向斜傾
        const windSpeed = weatherParams.windSpeedMps;
        const windAng = weatherParams.windAngleRad;
        u.uWind.value.set(
          Math.cos(windAng) * (windSpeed * 0.35),
          0,
          Math.sin(windAng) * (windSpeed * 0.35)
        );
      } else {
        this.rainMesh.visible = false;
      }
    }

    // 6. 更新地面水花 InstancedMesh (雨量 <= 0.04 時徹底隱藏)
    if (this.splashMesh && this.splashMaterial) {
      if (weatherParams.rainIntensity > 0.04) {
        this.splashMesh.visible = true;
        const u = this.splashMaterial.uniforms;
        u.uTime.value = totalTimeSec;
        u.uPlayerPos.value.copy(playerPos);
        u.uRainIntensity.value = weatherParams.rainIntensity;
      } else {
        this.splashMesh.visible = false;
      }
    }

    // 7. 同步路面動態濕潤
    if (this.roadGenerator) {
      this.roadGenerator.setWetness(weatherParams.wetness);
    }

    // 8. 同步夜間因子與地面可見度至道路與地貌生成器
    this.roadGenerator?.setNightFactor(nightFactor);
    this.terrainFeatureGen?.setNightFactor(nightFactor);

    // 9. 更新低頻動態夜空 PMREM 環境貼圖 (每 5 秒一次)
    this.updateEnvironmentMap(nightFactor, sunMoon, weatherParams, performance.now());

    // 8. 夜間模式狀態變更偵測
    const isNight = sunMoon.isNight;
    if (isNight !== this.lastNightState) {
      this.lastNightState = isNight;
      CONFIG.MODES.IS_NIGHT = isNight;
      this.onNightModeChangeCallback?.(isNight);
    }
  }

  public getDrawCallsCount(): number {
    let count = 1; // SkyDome
    if (this.rainMesh && this.rainMesh.visible) count++;
    if (this.splashMesh && this.splashMesh.visible) count++;
    return count;
  }

  public dispose(): void {
    if (this.skyDomeMesh) {
      this.scene.remove(this.skyDomeMesh);
      this.skyDomeMesh.geometry.dispose();
      this.skyMaterial?.dispose();
    }
    if (this.rainMesh) {
      this.scene.remove(this.rainMesh);
      this.rainMesh.geometry.dispose();
      this.rainMaterial?.dispose();
    }
    if (this.splashMesh) {
      this.scene.remove(this.splashMesh);
      this.splashMesh.geometry.dispose();
      this.splashMaterial?.dispose();
    }
    if (this.dirLight) {
      this.scene.remove(this.dirLight);
      this.scene.remove(this.dirLight.target);
    }
    if (this.hemiLight) {
      this.scene.remove(this.hemiLight);
    }
  }
}
