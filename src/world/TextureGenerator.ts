/**
 * TextureGenerator.ts - 程序化 PBR 紋理生成器 (Canvas-based Procedural Textures)
 * 依照需求產生：
 * 1. 柏油路面 (Albedo, NormalMap, RoughnessMap: 含裂縫、油漬、補丁、輪胎痕)
 * 2. 人行道地磚 (Albedo, NormalMap: 含磁磚縫、污垢)
 * 3. 磨損道路標線 (帶有剝落缺損與褪色遮罩)
 * 4. 建築外牆 (髒污下緣漸層、雨水流痕、水泥凹凸)
 * 5. 窗戶貼圖 (反光、亮燈、窗簾)
 * 6. 人孔蓋 (鑄鐵防滑紋)
 * 7. 牆面程序海報與塗鴉 (虛構、無品牌)
 */

import * as THREE from 'three';

export interface PbrTextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export class TextureGenerator {
  private static asphaltTextures: PbrTextureSet | null = null;
  private static wetAsphaltTextures: PbrTextureSet | null = null;
  private static sidewalkTextures: PbrTextureSet | null = null;
  private static wallTextures: Record<string, PbrTextureSet> = {};
  private static windowTexture: THREE.CanvasTexture | null = null;
  private static manholeTexture: THREE.CanvasTexture | null = null;
  private static graffitiTextures: THREE.CanvasTexture[] = [];
  private static markingWearTexture: THREE.CanvasTexture | null = null;

  /**
   * 建立簡單 pseudo-noise 數值
   */
  private static noise2D(x: number, y: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
    return n - Math.floor(n);
  }

  private static smoothNoise(x: number, y: number): number {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sfx = fx * fx * (3 - 2 * fx);
    const sfy = fy * fy * (3 - 2 * fy);

    const n00 = this.noise2D(i, j);
    const n10 = this.noise2D(i + 1, j);
    const n01 = this.noise2D(i, j + 1);
    const n11 = this.noise2D(i + 1, j + 1);

    const nx0 = n00 * (1 - sfx) + n10 * sfx;
    const nx1 = n01 * (1 - sfx) + n11 * sfx;
    return nx0 * (1 - sfy) + nx1 * sfy;
  }

  private static fbm(x: number, y: number, octaves = 4): number {
    let val = 0;
    let amp = 0.5;
    let freq = 1.0;
    for (let o = 0; o < octaves; o++) {
      val += amp * this.smoothNoise(x * freq, y * freq);
      freq *= 2.0;
      amp *= 0.5;
    }
    return val;
  }

  /**
   * 從高度圖生成切線空間法線貼圖 (Tangent-space Normal Map)
   */
  private static createNormalMapFromHeight(heightData: Float32Array, width: number, height: number, strength = 2.5): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const xLeft = (x - 1 + width) % width;
        const xRight = (x + 1) % width;
        const yUp = (y - 1 + height) % height;
        const yDown = (y + 1) % height;

        const hL = heightData[y * width + xLeft];
        const hR = heightData[y * width + xRight];
        const hU = heightData[yUp * width + x];
        const hD = heightData[yDown * width + x];

        const dx = (hR - hL) * strength;
        const dy = (hD - hU) * strength;
        const dz = 1.0;

        const len = Math.hypot(dx, dy, dz);
        const nx = dx / len;
        const ny = dy / len;
        const nz = dz / len;

        const idx = (y * width + x) * 4;
        data[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
        data[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
        data[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  /**
   * 1. 柏油路面 PBR 貼圖 (Albedo, Normal, Roughness)
   */
  public static getAsphaltTextures(isWet = false): PbrTextureSet {
    if (isWet && this.wetAsphaltTextures) return this.wetAsphaltTextures;
    if (!isWet && this.asphaltTextures) return this.asphaltTextures;

    const size = 512;
    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = size;
    albedoCanvas.height = size;
    const aCtx = albedoCanvas.getContext('2d')!;

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = size;
    roughCanvas.height = size;
    const rCtx = roughCanvas.getContext('2d')!;

    const heightData = new Float32Array(size * size);

    // 基礎柏油色調 (深灰帶微藍冷調)
    const baseR = 52, baseG = 56, baseB = 64;
    const albedoImg = aCtx.createImageData(size, size);
    const roughImg = rCtx.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        // 柏油碎石微噪點
        const micro = this.fbm(u * 64, v * 64, 3);
        // 宏觀路面不均勻度
        const macro = this.fbm(u * 6, v * 6, 2);

        // 隨機瀝青補丁 (矩形修補痕跡)
        let patch = 0;
        if (u > 0.25 && u < 0.65 && v > 0.35 && v < 0.75) {
          patch = (this.smoothNoise(u * 12, v * 12) > 0.4) ? 0.12 : 0;
        }

        // 輪胎痕 (暗色深槽)
        const tireTrack1 = Math.exp(-Math.pow((u - 0.3) * 18, 2)) * 0.18;
        const tireTrack2 = Math.exp(-Math.pow((u - 0.7) * 18, 2)) * 0.18;
        const tire = Math.max(tireTrack1, tireTrack2) * (0.8 + 0.2 * this.smoothNoise(u * 20, v * 20));

        // 油漬水窪 (中央深色圓形髒污)
        const oilDist = Math.hypot(u - 0.5, v - 0.55);
        const oilStain = oilDist < 0.2 ? (1 - oilDist / 0.2) * 0.25 : 0;

        // 裂縫 (Cracks)
        const crackNoise = Math.abs(this.smoothNoise(u * 24, v * 24) - 0.5);
        const crack = crackNoise < 0.03 ? 0.35 : 0;

        const combinedDarken = tire + oilStain + crack - patch * 0.5;
        const lum = (macro * 0.3 + micro * 0.7) * 0.25 - combinedDarken;

        const r = Math.min(255, Math.max(20, Math.floor(baseR * (1 + lum))));
        const g = Math.min(255, Math.max(20, Math.floor(baseG * (1 + lum))));
        const b = Math.min(255, Math.max(20, Math.floor(baseB * (1 + lum))));

        const idx = (y * size + x) * 4;
        albedoImg.data[idx] = r;
        albedoImg.data[idx + 1] = g;
        albedoImg.data[idx + 2] = b;
        albedoImg.data[idx + 3] = 255;

        // 高度值供 NormalMap
        heightData[y * size + x] = micro * 0.7 - crack * 0.8;

        // 粗糙度：一般柏油 0.88，油漬 0.35，若是濕潤模式整體降到 0.18~0.35
        let roughnessVal: number;
        if (isWet) {
          // 濕潤模式水窪反光
          roughnessVal = 0.12 + macro * 0.2 - oilStain * 0.1;
        } else {
          roughnessVal = 0.85 + micro * 0.12 - oilStain * 0.55 - tire * 0.2;
        }

        const rByte = Math.min(255, Math.max(0, Math.floor(roughnessVal * 255)));
        roughImg.data[idx] = rByte;
        roughImg.data[idx + 1] = rByte;
        roughImg.data[idx + 2] = rByte;
        roughImg.data[idx + 3] = 255;
      }
    }

    aCtx.putImageData(albedoImg, 0, 0);
    rCtx.putImageData(roughImg, 0, 0);

    const normalCanvas = this.createNormalMapFromHeight(heightData, size, size, 2.8);

    const mapTex = new THREE.CanvasTexture(albedoCanvas);
    mapTex.wrapS = THREE.RepeatWrapping;
    mapTex.wrapT = THREE.RepeatWrapping;
    mapTex.repeat.set(6, 6);
    mapTex.colorSpace = THREE.SRGBColorSpace;

    const normTex = new THREE.CanvasTexture(normalCanvas);
    normTex.wrapS = THREE.RepeatWrapping;
    normTex.wrapT = THREE.RepeatWrapping;
    normTex.repeat.set(6, 6);

    const roughTex = new THREE.CanvasTexture(roughCanvas);
    roughTex.wrapS = THREE.RepeatWrapping;
    roughTex.wrapT = THREE.RepeatWrapping;
    roughTex.repeat.set(6, 6);

    const set: PbrTextureSet = { map: mapTex, normalMap: normTex, roughnessMap: roughTex };
    if (isWet) this.wetAsphaltTextures = set;
    else this.asphaltTextures = set;
    return set;
  }

  /**
   * 2. 人行道地磚 PBR 貼圖 (方格地磚縫、水泥微粒、污漬)
   */
  public static getSidewalkTextures(): PbrTextureSet {
    if (this.sidewalkTextures) return this.sidewalkTextures;

    const size = 512;
    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = size;
    albedoCanvas.height = size;
    const aCtx = albedoCanvas.getContext('2d')!;

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = size;
    roughCanvas.height = size;
    const rCtx = roughCanvas.getContext('2d')!;

    const heightData = new Float32Array(size * size);
    const albedoImg = aCtx.createImageData(size, size);
    const roughImg = rCtx.createImageData(size, size);

    const tileSize = 64; // 8x8 格地磚
    const seamWidth = 3;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        const tileX = x % tileSize;
        const tileY = y % tileSize;
        const isSeam = tileX < seamWidth || tileY < seamWidth;

        // 磁磚微噪點
        const micro = this.fbm(u * 32, v * 32, 3);
        const dirt = this.fbm(u * 8, v * 8, 2) * 0.25;

        let r = 216 - Math.floor(dirt * 60) + Math.floor(micro * 20);
        let g = 210 - Math.floor(dirt * 60) + Math.floor(micro * 20);
        let b = 198 - Math.floor(dirt * 60) + Math.floor(micro * 20);

        let h = 0.5 + micro * 0.2;
        let rough = 0.82 + micro * 0.1;

        if (isSeam) {
          // 磁磚縫：深色、凹陷、粗糙
          r = Math.floor(r * 0.45);
          g = Math.floor(g * 0.45);
          b = Math.floor(b * 0.45);
          h = 0.05;
          rough = 0.95;
        }

        const idx = (y * size + x) * 4;
        albedoImg.data[idx] = Math.max(0, Math.min(255, r));
        albedoImg.data[idx + 1] = Math.max(0, Math.min(255, g));
        albedoImg.data[idx + 2] = Math.max(0, Math.min(255, b));
        albedoImg.data[idx + 3] = 255;

        heightData[y * size + x] = h;

        const rByte = Math.floor(rough * 255);
        roughImg.data[idx] = rByte;
        roughImg.data[idx + 1] = rByte;
        roughImg.data[idx + 2] = rByte;
        roughImg.data[idx + 3] = 255;
      }
    }

    aCtx.putImageData(albedoImg, 0, 0);
    rCtx.putImageData(roughImg, 0, 0);

    const normalCanvas = this.createNormalMapFromHeight(heightData, size, size, 2.2);

    const mapTex = new THREE.CanvasTexture(albedoCanvas);
    mapTex.wrapS = THREE.RepeatWrapping;
    mapTex.wrapT = THREE.RepeatWrapping;
    mapTex.repeat.set(4, 4);
    mapTex.colorSpace = THREE.SRGBColorSpace;

    const normTex = new THREE.CanvasTexture(normalCanvas);
    normTex.wrapS = THREE.RepeatWrapping;
    normTex.wrapT = THREE.RepeatWrapping;
    normTex.repeat.set(4, 4);

    const roughTex = new THREE.CanvasTexture(roughCanvas);
    roughTex.wrapS = THREE.RepeatWrapping;
    roughTex.wrapT = THREE.RepeatWrapping;
    roughTex.repeat.set(4, 4);

    this.sidewalkTextures = { map: mapTex, normalMap: normTex, roughnessMap: roughTex };
    return this.sidewalkTextures;
  }

  /**
   * 3. 標線磨損與褪色遮罩 (透明度與缺損紋理)
   */
  public static getMarkingWearTexture(): THREE.CanvasTexture {
    if (this.markingWearTexture) return this.markingWearTexture;

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        // 剝落與輪胎磨損 (Flaking noise)
        const n1 = this.fbm(u * 20, v * 20, 3);
        const scratches = Math.abs(this.smoothNoise(u * 40, v * 4) - 0.5) < 0.1 ? 0.35 : 0;
        const wear = Math.max(0, n1 - scratches);

        // 邊緣磨損
        const edge = Math.sin(v * Math.PI);
        const alpha = Math.min(255, Math.max(80, Math.floor((wear * 0.7 + 0.3) * edge * 255)));

        const idx = (y * size + x) * 4;
        imgData.data[idx] = 255;
        imgData.data[idx + 1] = 255;
        imgData.data[idx + 2] = 255;
        imgData.data[idx + 3] = alpha;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 1);
    this.markingWearTexture = tex;
    return tex;
  }

  /**
   * 4. 建築外牆 PBR 貼圖 (依老舊程度產生雨水流痕、下緣泥漬漸層、水泥補丁)
   */
  public static getBuildingWallTextures(ageLevel: 'new' | 'medium' | 'old' = 'medium', baseHex = 0xe5dec9): PbrTextureSet {
    const key = `${ageLevel}_${baseHex.toString(16)}`;
    if (this.wallTextures[key]) return this.wallTextures[key];

    const size = 512;
    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = size;
    albedoCanvas.height = size;
    const aCtx = albedoCanvas.getContext('2d')!;

    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = size;
    roughCanvas.height = size;
    const rCtx = roughCanvas.getContext('2d')!;

    const heightData = new Float32Array(size * size);
    const albedoImg = aCtx.createImageData(size, size);
    const roughImg = rCtx.createImageData(size, size);

    const col = new THREE.Color(baseHex);
    const baseR = Math.floor(col.r * 255);
    const baseG = Math.floor(col.g * 255);
    const baseB = Math.floor(col.b * 255);

    const ageMultiplier = ageLevel === 'new' ? 0.3 : ageLevel === 'medium' ? 1.0 : 1.8;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size; // 0 是頂部, 1 是底部

        // A. 水泥砂漿微噪點
        const micro = this.fbm(u * 48, v * 48, 3);

        // B. 由下往上的地面泥沙髒污漸層 (Ground Dirt Gradient, v 越接近 1 越髒)
        const groundDirt = Math.pow(Math.max(0, v - 0.45) / 0.55, 1.8) * 0.45 * ageMultiplier;

        // C. 窗台/屋簷下方的直向雨水污痕 (Rain Streaks / Water Runoff)
        const streakX = this.smoothNoise(u * 22, 1.5);
        const streakMask = streakX > 0.65 ? Math.pow((streakX - 0.65) / 0.35, 2) : 0;
        const rainStreak = streakMask * Math.min(1.0, v * 1.5) * 0.35 * ageMultiplier;

        // D. 脫落油漆與泥灰補丁
        const patch = (this.smoothNoise(u * 8, v * 8) > 0.68) ? 0.18 * ageMultiplier : 0;

        const totalDarken = groundDirt + rainStreak + patch;
        const lum = micro * 0.15 - totalDarken;

        const r = Math.min(255, Math.max(25, Math.floor(baseR * (1 + lum))));
        const g = Math.min(255, Math.max(25, Math.floor(baseG * (1 + lum))));
        const b = Math.min(255, Math.max(25, Math.floor(baseB * (1 + lum))));

        const idx = (y * size + x) * 4;
        albedoImg.data[idx] = r;
        albedoImg.data[idx + 1] = g;
        albedoImg.data[idx + 2] = b;
        albedoImg.data[idx + 3] = 255;

        // 凹凸高度
        heightData[y * size + x] = micro * 0.5 - patch * 0.4;

        // 粗糙度
        const rough = 0.78 + micro * 0.12 + totalDarken * 0.2;
        const rByte = Math.min(255, Math.max(0, Math.floor(rough * 255)));
        roughImg.data[idx] = rByte;
        roughImg.data[idx + 1] = rByte;
        roughImg.data[idx + 2] = rByte;
        roughImg.data[idx + 3] = 255;
      }
    }

    aCtx.putImageData(albedoImg, 0, 0);
    rCtx.putImageData(roughImg, 0, 0);

    const normalCanvas = this.createNormalMapFromHeight(heightData, size, size, 2.0);

    const mapTex = new THREE.CanvasTexture(albedoCanvas);
    mapTex.wrapS = THREE.RepeatWrapping;
    mapTex.wrapT = THREE.RepeatWrapping;
    mapTex.repeat.set(1, 1);
    mapTex.colorSpace = THREE.SRGBColorSpace;

    const normTex = new THREE.CanvasTexture(normalCanvas);
    normTex.wrapS = THREE.RepeatWrapping;
    normTex.wrapT = THREE.RepeatWrapping;
    normTex.repeat.set(1, 1);

    const roughTex = new THREE.CanvasTexture(roughCanvas);
    roughTex.wrapS = THREE.RepeatWrapping;
    roughTex.wrapT = THREE.RepeatWrapping;
    roughTex.repeat.set(1, 1);

    const set: PbrTextureSet = { map: mapTex, normalMap: normTex, roughnessMap: roughTex };
    this.wallTextures[key] = set;
    return set;
  }

  /**
   * 5. 窗戶貼圖 (玻璃金屬質感、深藍反光、部分亮暖燈、窗簾)
   */
  public static getWindowAtlasTexture(): THREE.CanvasTexture {
    if (this.windowTexture) return this.windowTexture;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    // 4 個窗格變體 (2x2 格)
    // 0,0: 亮燈 (暖黃光)
    // 1,0: 拉廉 (白色百葉窗)
    // 0,1: 暗夜深藍反光玻璃
    // 1,1: 破損/貼紙

    // 格 0,0: 暖燈開窗
    ctx.fillStyle = '#ffdf80';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(10, 10, 108, 108);

    // 格 1,0: 遮光窗簾
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(128, 0, 128, 128);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(138, 10, 108, 108);
    // 百葉窗條紋
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    for (let y = 18; y < 118; y += 10) {
      ctx.beginPath();
      ctx.moveTo(138, y);
      ctx.lineTo(246, y);
      ctx.stroke();
    }

    // 格 0,1: 深色反光玻璃
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 128, 128, 128);
    const grad = ctx.createLinearGradient(0, 128, 128, 256);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(0.5, '#334155');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(10, 138, 108, 108);

    // 格 1,1: 台灣特色窗花/公告貼紙
    ctx.fillStyle = '#111827';
    ctx.fillRect(128, 128, 128, 128);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(138, 138, 108, 108);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(150, 150, 24, 32); // 小紅色警語貼紙
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(180, 170, 36, 20);

    // 窗框邊界
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 124, 124);
    ctx.strokeRect(130, 2, 124, 124);
    ctx.strokeRect(2, 130, 124, 124);
    ctx.strokeRect(130, 130, 124, 124);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.windowTexture = tex;
    return tex;
  }

  /**
   * 6. 圓形鑄鐵人孔蓋貼圖 (Manhole)
   */
  public static getManholeTexture(): THREE.CanvasTexture {
    if (this.manholeTexture) return this.manholeTexture;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // 鑄鐵底色
    ctx.fillStyle = '#26292d';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    ctx.fill();

    // 外環
    ctx.strokeStyle = '#4a5058';
    ctx.lineWidth = 8;
    ctx.stroke();

    // 內同心圓
    ctx.strokeStyle = '#3a3f47';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.35, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.2, 0, Math.PI * 2);
    ctx.stroke();

    // 放射狀防滑菱形凹槽
    const spokes = 16;
    for (let i = 0; i < spokes; i++) {
      const angle = (i / spokes) * Math.PI * 2;
      const x1 = size / 2 + Math.cos(angle) * (size * 0.22);
      const y1 = size / 2 + Math.sin(angle) * (size * 0.22);
      const x2 = size / 2 + Math.cos(angle) * (size * 0.44);
      const y2 = size / 2 + Math.sin(angle) * (size * 0.44);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // 中心雨水標示標誌 (抽象幾何，非商標)
    ctx.fillStyle = '#5c636e';
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('雨', size / 2, size / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.manholeTexture = tex;
    return tex;
  }

  /**
   * 7. 隨機程序海報與街頭抽象塗鴉貼花 (嚴格禁止真實品牌與版權資產，只使用抽象幾何與虛構字樣)
   */
  public static getGraffitiTexture(index = 0): THREE.CanvasTexture {
    if (this.graffitiTextures[index]) return this.graffitiTextures[index];

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, 256, 256);

    const designs = [
      // 海報 1：音樂祭/藝文展抽象海報
      () => {
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(20, 20, 216, 216);
        ctx.fillStyle = '#1e1e24';
        ctx.fillRect(35, 35, 186, 120);
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(128, 95, 42, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('2026 LIVE', 128, 102);
        ctx.fillStyle = '#111827';
        ctx.font = 'bold 16px sans-serif';
        ctx.fillText('HOT SPRINGS MUSIC', 128, 185);
        ctx.font = '12px sans-serif';
        ctx.fillText('JIAOXI CULTURE HALL', 128, 210);
      },
      // 海報 2：傳統水電通水管小廣告 (台灣常見電桿貼紙)
      () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(30, 40, 196, 176);
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 4;
        ctx.strokeRect(34, 44, 188, 168);
        ctx.fillStyle = '#dc2626';
        ctx.font = 'bold 26px "Microsoft JhengHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('專業水電', 128, 85);
        ctx.fillStyle = '#1d4ed8';
        ctx.font = 'bold 20px "Microsoft JhengHei", sans-serif';
        ctx.fillText('通水管‧抽水肥', 128, 125);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 22px monospace';
        ctx.fillText('0988-XXX-XXX', 128, 170);
      },
      // 塗鴉 3：街頭 Spray Paint 抽象字體
      () => {
        ctx.save();
        ctx.translate(128, 128);
        ctx.rotate(-0.1);
        ctx.fillStyle = '#ec4899';
        ctx.font = '900 48px Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = '#000000';
        ctx.shadowBlur = 12;
        ctx.fillText('URBAN', 0, -10);
        ctx.fillStyle = '#38bdf8';
        ctx.font = '900 40px Impact, sans-serif';
        ctx.fillText('VIBES', 0, 35);
        ctx.restore();
      }
    ];

    const pick = designs[index % designs.length];
    pick();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.graffitiTextures[index] = tex;
    return tex;
  }
}
