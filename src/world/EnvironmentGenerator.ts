/**
 * EnvironmentGenerator.ts - GTA 寫實風格世界環境生成
 * 包括：
 * 1. 黃昏金黃魔幻時刻光影 (太陽高度角 ~24度，#ffb066 暖橘光)
 * 2. 漸層天空穹頂 (天頂深青藍 -> 中層紫粉 -> 地平線暖橘金) 與太陽光暈 (Sun Flare)
 * 3. PMREM 環境反射貼圖 (賦予 scene.environment，使 PBR 材質具備真實天空反射)
 * 4. 指數霧氣 (FogExp2，與地平線橘粉色調融為一體，呈現遠景空氣透視)
 * 5. 動態天候支援 (按 R 切換濕潤模式，按 T 切換夜間霓虹模式)
 * 6. 大氣微粒系統 (空氣浮塵粒子與路面蒸氣)
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';

export class EnvironmentGenerator {
  private groundMesh: THREE.Mesh | null = null;
  private skyDome: THREE.Mesh | null = null;
  private sunSprite: THREE.Sprite | null = null;
  private dirLight: THREE.DirectionalLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private pmremGenerator: THREE.PMREMGenerator | null = null;

  // 大氣粒子系統
  private dustParticles: THREE.Points | null = null;
  private dustGeo: THREE.BufferGeometry | null = null;
  private dustPositions: Float32Array | null = null;

  private isWet = false;
  private isNight = false;

  /**
   * 設定場景環境光影、天空、霧氣與 PMREM 反射
   */
  public setupSceneEnvironment(
    scene: THREE.Scene,
    renderer?: THREE.WebGLRenderer,
    withSkyAndLights: boolean = true
  ): void {
    if (withSkyAndLights) {
      // 1. 漸層天空穹頂
      if (!this.skyDome) {
        this.skyDome = this.createSkyDome();
        scene.add(this.skyDome);
      }

      // 2. 太陽發光光暈 (Sun Lens Glow Sprite)
      if (!this.sunSprite) {
        this.sunSprite = this.createSunSprite();
        scene.add(this.sunSprite);
      }

      // 3. 指數霧氣 (FogExp2: 遠景空氣透視，與地平線暖橘粉融為一體)
      scene.fog = new THREE.FogExp2(
        CONFIG.WORLD.FOG_COLOR,
        CONFIG.WORLD.FOG_DENSITY
      );

      // 4. 半球環境光 (天空天青藍 + 地面暖土棕)
      if (!this.hemiLight) {
        this.hemiLight = new THREE.HemisphereLight(
          CONFIG.WORLD.HEMI_SKY_COLOR,
          CONFIG.WORLD.HEMI_GROUND_COLOR,
          CONFIG.WORLD.HEMI_INTENSITY
        );
        this.hemiLight.position.set(0, 100, 0);
        scene.add(this.hemiLight);
      }

      // 5. 黃昏主太陽方向光 (高度角約 24 度，暖橘色溫 #ffb066)
      if (!this.dirLight) {
        this.dirLight = new THREE.DirectionalLight(
          CONFIG.WORLD.SUN_COLOR,
          CONFIG.WORLD.SUN_INTENSITY
        );
        this.updateSunPosition(new THREE.Vector3(0, 0, 0));
        this.dirLight.castShadow = true;

        // 陰影相機正交範圍
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

        scene.add(this.dirLight);
        scene.add(this.dirLight.target);
      }
    }

    // 6. 大地基底平面網格 (PBR 粗糙土質/基底)
    if (!this.groundMesh) {
      const groundGeo = new THREE.PlaneGeometry(
        CONFIG.WORLD.GROUND_SIZE,
        CONFIG.WORLD.GROUND_SIZE,
        1,
        1
      );
      groundGeo.rotateX(-Math.PI / 2);

      const groundMat = new THREE.MeshStandardMaterial({
        color: CONFIG.WORLD.GROUND_COLOR,
        roughness: 0.92,
        metalness: 0.08
      });

      const dummyPos: THREE.Vector3[] = [];
      const dummyCols: THREE.Vector4[] = [];
      for (let i = 0; i < 8; i++) {
        dummyPos.push(new THREE.Vector3());
        dummyCols.push(new THREE.Vector4(0, 0, 0, 0));
      }

      groundMat.userData.nightUniforms = {
        uNightFactor: { value: 0.0 },
        uGroundVisibility: { value: 1.0 },
        uGroundNightBoost: { value: 0.085 },
        uBaseNightBrightness: { value: 1.0 },
        uNearbyLights: { value: dummyPos },
        uNearbyLightColors: { value: dummyCols }
      };

      groundMat.onBeforeCompile = (shader) => {
        shader.uniforms.uNightFactor = groundMat.userData.nightUniforms.uNightFactor;
        shader.uniforms.uGroundVisibility = groundMat.userData.nightUniforms.uGroundVisibility;
        shader.uniforms.uGroundNightBoost = groundMat.userData.nightUniforms.uGroundNightBoost;
        shader.uniforms.uBaseNightBrightness = groundMat.userData.nightUniforms.uBaseNightBrightness;
        shader.uniforms.uNearbyLights = groundMat.userData.nightUniforms.uNearbyLights;
        shader.uniforms.uNearbyLightColors = groundMat.userData.nightUniforms.uNearbyLightColors;

        shader.vertexShader = `
          varying vec3 vCustomWorldPosition;
        ` + shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vCustomWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
          `
        );

        shader.fragmentShader = `
          uniform float uNightFactor;
          uniform float uGroundVisibility;
          uniform float uGroundNightBoost;
          uniform float uBaseNightBrightness;
          uniform vec3 uNearbyLights[8];
          uniform vec4 uNearbyLightColors[8];
          varying vec3 vCustomWorldPosition;
        ` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `
          #include <dithering_fragment>
          vec3 cGroundNight = vec3(0.227, 0.278, 0.392);
          float boost = uGroundNightBoost * uNightFactor * uGroundVisibility;
          gl_FragColor.rgb += cGroundNight * boost;

          if (uNightFactor > 0.01) {
            vec3 streetLightAccum = vec3(0.0);
            for (int i = 0; i < 8; i++) {
              vec3 lPos = uNearbyLights[i];
              vec4 lCol = uNearbyLightColors[i];
              if (lCol.a > 0.01) {
                float dHoriz = length(vCustomWorldPosition.xz - lPos.xz);
                float d3D = distance(vCustomWorldPosition, lPos);
                float coneFalloff = smoothstep(13.0, 0.0, dHoriz);
                float atten = 1.0 / (1.0 + 0.04 * d3D + 0.012 * d3D * d3D);
                float nDotL = clamp((lPos.y - vCustomWorldPosition.y) / max(0.8, d3D), 0.2, 1.0);
                streetLightAccum += lCol.rgb * (coneFalloff * atten * nDotL * lCol.a * 3.6);
              }
            }
            gl_FragColor.rgb += gl_FragColor.rgb * streetLightAccum * 2.2 + streetLightAccum * 0.06;
          }
          `
        );

        (groundMat as any).customShader = shader;
      };

      this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
      this.groundMesh.name = 'GroundBase';
      this.groundMesh.receiveShadow = true;
      scene.add(this.groundMesh);
    }

    // 7. PMREM 生成天空環境貼圖 (賦予 scene.environment)
    if (renderer && !scene.environment) {
      try {
        this.pmremGenerator = new THREE.PMREMGenerator(renderer);
        this.pmremGenerator.compileEquirectangularShader();
        const renderTarget = this.pmremGenerator.fromScene(scene, 0.04);
        scene.environment = renderTarget.texture;
      } catch (err) {
        console.warn('[EnvironmentGenerator] PMREM generation failed:', err);
      }
    }

    // 8. 大氣微粒系統 (空氣中漂浮的塵埃粒子)
    if (!this.dustParticles) {
      this.setupAtmosphericParticles(scene);
    }
  }

  /**
   * 建立漸層天空穹頂與雲霧紋理
   */
  private createSkyDome(): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // 漸層：天頂深青藍 -> 中層紫粉 -> 地平線暖橘金
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, CONFIG.WORLD.SKY_GRADIENT.TOP);       // #153250
    grad.addColorStop(0.38, '#2a3d58');                          // 青藍過渡
    grad.addColorStop(0.55, CONFIG.WORLD.SKY_GRADIENT.MIDDLE);    // #784c68 紫粉
    grad.addColorStop(0.78, '#c96a4c');                          // 霞紅
    grad.addColorStop(0.92, CONFIG.WORLD.SKY_GRADIENT.HORIZON);   // #f8a768 暖橘金
    grad.addColorStop(1.0, '#dfb498');                           // 地平線暖灰粉 (與霧完全融合)

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 512);

    // 加上薄雲層紋理 (柔和高斯薄雲紋路)
    ctx.fillStyle = 'rgba(255, 230, 210, 0.12)';
    for (let i = 0; i < 12; i++) {
      const y = 280 + (i * 18);
      ctx.fillRect(0, y, 128, 4);
    }

    const skyTex = new THREE.CanvasTexture(canvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    skyTex.wrapS = THREE.ClampToEdgeWrapping;
    skyTex.wrapT = THREE.ClampToEdgeWrapping;

    const skyGeo = new THREE.SphereGeometry(950, 32, 24);
    const skyMat = new THREE.MeshBasicMaterial({
      map: skyTex,
      side: THREE.BackSide,
      depthWrite: false
    });

    const dome = new THREE.Mesh(skyGeo, skyMat);
    dome.name = 'SkyDome';
    return dome;
  }

  /**
   * 建立太陽發光光暈 (Lens Flare Sprite)
   */
  private createSunSprite(): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(128, 128, 8, 128, 128, 120);
    grad.addColorStop(0.0, 'rgba(255, 255, 240, 1.0)');
    grad.addColorStop(0.2, 'rgba(255, 200, 130, 0.85)');
    grad.addColorStop(0.5, 'rgba(255, 140, 70, 0.35)');
    grad.addColorStop(1.0, 'rgba(255, 120, 60, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(160, 160, 1);
    sprite.name = 'SunLensGlow';
    return sprite;
  }

  /**
   * 計算並更新太陽與陰影光源位置 (高度角約 24 度，方位角 215 度)
   */
  private updateSunPosition(center: THREE.Vector3): void {
    if (!this.dirLight) return;

    const elevRad = (CONFIG.WORLD.SUN_ELEVATION_DEG * Math.PI) / 180; // 24度
    const azimRad = (CONFIG.WORLD.SUN_AZIMUTH_DEG * Math.PI) / 180;   // 215度
    const dist = 220;

    const sunX = Math.cos(elevRad) * Math.cos(azimRad) * dist;
    const sunY = Math.sin(elevRad) * dist;
    const sunZ = Math.cos(elevRad) * Math.sin(azimRad) * dist;

    this.dirLight.position.set(center.x + sunX, center.y + sunY, center.z + sunZ);
    this.dirLight.target.position.set(center.x, center.y, center.z);
    this.dirLight.target.updateMatrixWorld();

    if (this.sunSprite) {
      // 太陽光暈貼在天空穹頂內側 (距離約 820m)
      const skyDist = 820;
      this.sunSprite.position.set(
        center.x + Math.cos(elevRad) * Math.cos(azimRad) * skyDist,
        center.y + Math.sin(elevRad) * skyDist,
        center.z + Math.cos(elevRad) * Math.sin(azimRad) * skyDist
      );
    }
  }

  /**
   * 8. 大氣微粒系統 (微小空氣浮塵粒子隨風飄動)
   */
  private setupAtmosphericParticles(scene: THREE.Scene): void {
    const particleCount = 280;
    this.dustPositions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      this.dustPositions[i * 3] = (Math.random() - 0.5) * 80;
      this.dustPositions[i * 3 + 1] = 0.5 + Math.random() * 8.0;
      this.dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 80;
    }

    this.dustGeo = new THREE.BufferGeometry();
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPositions, 3));

    const dustMat = new THREE.PointsMaterial({
      color: 0xffe8cc,
      size: 0.12,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.dustParticles = new THREE.Points(this.dustGeo, dustMat);
    this.dustParticles.name = 'AtmosphericDust';
    scene.add(this.dustParticles);
  }

  /**
   * 切換濕潤模式 (按 R 鍵切換：路面水光反光、濕潤反射)
   */
  public toggleWetMode(): boolean {
    this.isWet = !this.isWet;
    CONFIG.MODES.IS_WET = this.isWet;
    return this.isWet;
  }

  public getIsWet(): boolean {
    return this.isWet;
  }

  /**
   * 切換夜間模式 (按 T 鍵切換：黃昏 -> 深夜霓虹)
   */
  public toggleNightMode(scene: THREE.Scene): boolean {
    this.isNight = !this.isNight;
    CONFIG.MODES.IS_NIGHT = this.isNight;

    if (this.isNight) {
      // 夜間模式光影 (GTA 風格深夜街景：冷藍環境漫射 + 皎潔月光 + 濃郁深藍夜空)
      if (this.dirLight) {
        this.dirLight.intensity = 0.85;
        this.dirLight.color.setHex(0x5a789c); // 皎潔冷月光
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(0x384d70);
        this.hemiLight.groundColor.setHex(0x1a2434);
        this.hemiLight.intensity = 1.25;
      }
      if (scene.fog instanceof THREE.FogExp2) {
        scene.fog.color.setHex(0x0a1424);
        scene.fog.density = 0.0018;
      }
      if (this.sunSprite) {
        this.sunSprite.visible = false;
      }
      if (this.skyDome && (this.skyDome.material as THREE.MeshBasicMaterial).color) {
        (this.skyDome.material as THREE.MeshBasicMaterial).color.setHex(0x142236);
      }
    } else {
      // 恢復黃昏金黃魔幻時刻
      if (this.dirLight) {
        this.dirLight.intensity = CONFIG.WORLD.SUN_INTENSITY;
        this.dirLight.color.setHex(CONFIG.WORLD.SUN_COLOR);
      }
      if (this.hemiLight) {
        this.hemiLight.color.setHex(CONFIG.WORLD.HEMI_SKY_COLOR);
        this.hemiLight.groundColor.setHex(CONFIG.WORLD.HEMI_GROUND_COLOR);
        this.hemiLight.intensity = CONFIG.WORLD.HEMI_INTENSITY;
      }
      if (scene.fog instanceof THREE.FogExp2) {
        scene.fog.color.setHex(CONFIG.WORLD.FOG_COLOR);
        scene.fog.density = CONFIG.WORLD.FOG_DENSITY;
      }
      if (this.sunSprite) {
        this.sunSprite.visible = true;
      }
      if (this.skyDome && (this.skyDome.material as THREE.MeshBasicMaterial).color) {
        (this.skyDome.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      }
    }

    return this.isNight;
  }

  public getIsNight(): boolean {
    return this.isNight;
  }

  /**
   * 每幀更新：太陽陰影盒追隨玩家、大氣微粒動態流動
   */
  public updateEnvironment(playerPos: THREE.Vector3, delta = 0.016): void {
    if (this.dirLight) {
      this.updateSunPosition(playerPos);
    }

    if (this.skyDome) {
      this.skyDome.position.copy(playerPos);
    }

    // 更新空氣浮塵粒子
    if (this.dustParticles && this.dustPositions && this.dustGeo) {
      const posAttr = this.dustGeo.attributes.position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;

      for (let i = 0; i < arr.length; i += 3) {
        // 微風 X 方向漂浮
        arr[i] += delta * 0.45;
        // 緩慢下沉或上升
        arr[i + 1] += Math.sin(arr[i] * 0.5) * delta * 0.15;

        // 相對於玩家循環邊界
        const dx = arr[i] - playerPos.x;
        const dz = arr[i + 2] - playerPos.z;

        if (dx > 40) arr[i] -= 80;
        else if (dx < -40) arr[i] += 80;

        if (dz > 40) arr[i + 2] -= 80;
        else if (dz < -40) arr[i + 2] += 80;
      }

      posAttr.needsUpdate = true;
    }
  }

  public getGroundMesh(): THREE.Mesh | null {
    return this.groundMesh;
  }

  public dispose(scene: THREE.Scene): void {
    if (this.groundMesh) {
      scene.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }
    if (this.skyDome) {
      scene.remove(this.skyDome);
      this.skyDome.geometry.dispose();
      this.skyDome = null;
    }
    if (this.sunSprite) {
      scene.remove(this.sunSprite);
      this.sunSprite = null;
    }
    if (this.dirLight) {
      scene.remove(this.dirLight);
      scene.remove(this.dirLight.target);
      this.dirLight = null;
    }
    if (this.hemiLight) {
      scene.remove(this.hemiLight);
      this.hemiLight = null;
    }
    if (this.dustParticles) {
      scene.remove(this.dustParticles);
      this.dustGeo?.dispose();
      this.dustParticles = null;
    }
    if (this.pmremGenerator) {
      this.pmremGenerator.dispose();
      this.pmremGenerator = null;
    }
  }
}
