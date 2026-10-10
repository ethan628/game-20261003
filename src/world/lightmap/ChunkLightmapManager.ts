/**
 * ChunkLightmapManager.ts - 全域區塊光照圖管理器
 *
 * 職責：
 * 1. 管理 256m 區塊分割、外擴 20m 平滑光場
 * 2. 透過 Web Worker (LightmapWorker) 背景預先計算，並快取到 IndexedDB (LightmapCache)
 * 3. 合成為 1024x1024 RGBA8 世界座標光照圖 (DataTexture, LinearFilter 雙線性取樣，記憶體僅 4MB <= 8MB)
 * 4. 統一向各材質注入 Uniforms (uLightmap, uLightmapBounds, uNightTurnOnRatio, uHeatmapMode 等)
 * 5. 支援 K 面板即時調參重算與進度反饋，F16 光照覆蓋熱圖
 */

import * as THREE from 'three';
import { LightSource, OcclusionSegment, LightmapChunkRequest, LightmapChunkResult } from './LightmapTypes.ts';
import { LightmapComputer } from './LightmapComputer.ts';
import { LightmapCache } from './LightmapCache.ts';

export interface LightmapManagerOptions {
  worldExtent?: number; // 預設 1024 (涵蓋 -512 ~ +512m)
  chunkSize?: number;   // 預設 256m
  padding?: number;     // 預設 20m
}

export class ChunkLightmapManager {
  private static instance: ChunkLightmapManager | null = null;

  public static getInstance(): ChunkLightmapManager {
    if (!ChunkLightmapManager.instance) {
      ChunkLightmapManager.instance = new ChunkLightmapManager();
    }
    return ChunkLightmapManager.instance;
  }

  private worldExtent = 1024; // 1024m (覆蓋 -512m 到 +512m)
  private chunkSize = 256;
  private padding = 20;

  // 主光照貼圖 (1024 x 1024, RGBA8, 雙線性硬體插值, 4 MB 貼圖記憶體)
  private masterTexture: THREE.DataTexture;
  private masterData: Uint8Array;
  private cache: LightmapCache;
  private worker: Worker | null = null;

  // 全域 Uniforms
  public uniforms: {
    uLightmap: { value: THREE.DataTexture };
    uLightmapBounds: { value: THREE.Vector4 }; // minX, minZ, sizeX, sizeZ
    uNightFactor: { value: number };
    uNightTurnOnRatio: { value: number };
    uGroundVisibility: { value: number };
    uBaseNightBrightness: { value: number };
    uHeatmapMode: { value: number };
  };

  private currentLocationName = 'default';
  private allLights: LightSource[] = [];
  private occluders: OcclusionSegment[] = [];
  private isComputing = false;
  private onProgressCallback?: (progress: number, statusText: string) => void;

  constructor(options?: LightmapManagerOptions) {
    if (options?.worldExtent) this.worldExtent = options.worldExtent;
    if (options?.chunkSize) this.chunkSize = options.chunkSize;
    if (options?.padding) this.padding = options.padding;

    // 初始化 1024x1024 貼圖記憶體 (每像素 1 公尺)
    const size = this.worldExtent;
    this.masterData = new Uint8Array(size * size * 4);
    // 預設為全黑環境光底色
    this.masterData.fill(0);

    this.masterTexture = new THREE.DataTexture(
      this.masterData as unknown as BufferSource,
      size,
      size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this.masterTexture.minFilter = THREE.LinearFilter;
    this.masterTexture.magFilter = THREE.LinearFilter;
    this.masterTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.masterTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.masterTexture.generateMipmaps = false;
    this.masterTexture.needsUpdate = true;

    const minCoord = -this.worldExtent * 0.5;
    this.uniforms = {
      uLightmap: { value: this.masterTexture },
      uLightmapBounds: { value: new THREE.Vector4(minCoord, minCoord, this.worldExtent, this.worldExtent) },
      uNightFactor: { value: 0.0 },
      uNightTurnOnRatio: { value: 0.0 },
      uGroundVisibility: { value: 1.0 },
      uBaseNightBrightness: { value: 1.0 },
      uHeatmapMode: { value: 0.0 }
    };

    this.cache = new LightmapCache();
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(
        new URL('./LightmapWorker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      console.warn('[ChunkLightmapManager] Web Worker 初始化失敗，改用本線程計算', e);
      this.worker = null;
    }
  }

  public setProgressCallback(cb?: (progress: number, statusText: string) => void): void {
    this.onProgressCallback = cb;
  }

  public setLocation(name: string): void {
    if (this.currentLocationName !== name) {
      console.log(`[ChunkLightmapManager] 切換地點至 ${name}，清除舊地點快取`);
      this.cache.clearLocation(this.currentLocationName);
      this.currentLocationName = name;
      // 重設貼圖為黑色
      this.masterData.fill(0);
      this.masterTexture.needsUpdate = true;
    }
  }

  public setHeatmapMode(enabled: boolean): void {
    this.uniforms.uHeatmapMode.value = enabled ? 1.0 : 0.0;
  }

  public getHeatmapMode(): boolean {
    return this.uniforms.uHeatmapMode.value > 0.5;
  }

  public updateNightUniforms(
    nightFactor: number,
    turnOnRatio: number,
    groundVisibility: number,
    baseBrightness: number
  ): void {
    this.uniforms.uNightFactor.value = nightFactor;
    this.uniforms.uNightTurnOnRatio.value = turnOnRatio;
    this.uniforms.uGroundVisibility.value = groundVisibility;
    this.uniforms.uBaseNightBrightness.value = baseBrightness;
  }

  /**
   * 設定所有光源與建築遮擋線段並觸發多區塊計算
   */
  public async rebuildLightmaps(
    lights: LightSource[],
    occluders: OcclusionSegment[],
    configVersion = 'v1'
  ): Promise<void> {
    if (this.isComputing) {
      console.warn('[ChunkLightmapManager] 光照圖正在計算中，略過重疊請求');
      return;
    }
    this.isComputing = true;
    this.allLights = lights;
    this.occluders = occluders;

    const tStart = performance.now();
    const halfExtent = this.worldExtent * 0.5;
    const chunksPerAxis = Math.ceil(this.worldExtent / this.chunkSize);
    const totalChunks = chunksPerAxis * chunksPerAxis;
    let completedChunks = 0;

    // 清空當前主光照圖像素
    this.masterData.fill(0);

    const chunkRequests: LightmapChunkRequest[] = [];

    for (let cz = 0; cz < chunksPerAxis; cz++) {
      for (let cx = 0; cx < chunksPerAxis; cx++) {
        const coreMinX = -halfExtent + cx * this.chunkSize;
        const coreMinZ = -halfExtent + cz * this.chunkSize;
        const coreMaxX = coreMinX + this.chunkSize;
        const coreMaxZ = coreMinZ + this.chunkSize;

        // 外擴 20m 覆蓋
        const chunkMinX = coreMinX - this.padding;
        const chunkMinZ = coreMinZ - this.padding;
        const chunkMaxX = coreMaxX + this.padding;
        const chunkMaxZ = coreMaxZ + this.padding;

        const chunkId = `chunk_${cx}_${cz}`;
        chunkRequests.push({
          chunkId,
          minX: chunkMinX,
          minZ: chunkMinZ,
          maxX: chunkMaxX,
          maxZ: chunkMaxZ,
          resolution: 1.0,
          lights: this.allLights,
          occluders: this.occluders
        });
      }
    }

    this.onProgressCallback?.(0.05, `開始計算光照圖 (0/${totalChunks})...`);

    // 逐區塊處理 (優先檢查 IndexedDB 快取)
    for (let i = 0; i < chunkRequests.length; i++) {
      const req = chunkRequests[i];
      const cacheKey = `${this.currentLocationName}_${configVersion}_${req.chunkId}`;

      let chunkResult: LightmapChunkResult | null = null;
      const cached = await this.cache.getChunk(cacheKey);

      if (cached) {
        chunkResult = {
          chunkId: req.chunkId,
          minX: req.minX,
          minZ: req.minZ,
          maxX: req.maxX,
          maxZ: req.maxZ,
          width: cached.width,
          height: cached.height,
          pixels: cached.pixels,
          computeTimeMs: 0
        };
      } else {
        // 使用 Worker 計算或本線程計算
        if (this.worker) {
          chunkResult = await this.computeWithWorker(req);
        } else {
          chunkResult = LightmapComputer.computeChunk(req);
        }
        // 寫入 IndexedDB 快取
        if (chunkResult) {
          this.cache.setChunk(cacheKey, chunkResult.width, chunkResult.height, chunkResult.pixels);
        }
      }

      if (chunkResult) {
        this.blitChunkToMaster(chunkResult);
      }

      completedChunks++;
      const progress = completedChunks / totalChunks;
      this.onProgressCallback?.(progress, `正在生成區塊光照圖 (${completedChunks}/${totalChunks})...`);
    }

    this.masterTexture.needsUpdate = true;
    this.isComputing = false;
    const totalTimeMs = (performance.now() - tStart).toFixed(1);
    console.log(
      `[ChunkLightmapManager] 全部 ${totalChunks} 個區塊光照圖計算與快取完成！總耗時: ${totalTimeMs} ms`
    );
    this.onProgressCallback?.(1.0, `光照圖計算完成 (${totalTimeMs} ms)`);
  }

  private computeWithWorker(req: LightmapChunkRequest): Promise<LightmapChunkResult> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve(LightmapComputer.computeChunk(req));
        return;
      }

      const handler = (e: MessageEvent) => {
        if (e.data.type === 'CHUNK_READY' && e.data.data.chunkId === req.chunkId) {
          this.worker?.removeEventListener('message', handler);
          resolve(e.data.data as LightmapChunkResult);
        } else if (e.data.type === 'CHUNK_ERROR') {
          this.worker?.removeEventListener('message', handler);
          console.warn('[ChunkLightmapManager] Worker 計算錯誤，回退到主線程', e.data.error);
          resolve(LightmapComputer.computeChunk(req));
        }
      };

      this.worker.addEventListener('message', handler);
      this.worker.postMessage({ type: 'COMPUTE_CHUNK', payload: req });
    });
  }

  /**
   * 將計算好的區塊像素貼圖 Blit 寫入全域 1024x1024 Master 貼圖
   */
  private blitChunkToMaster(chunk: LightmapChunkResult): void {
    const halfExtent = this.worldExtent * 0.5;
    const masterSize = this.worldExtent;

    const cMinX = Math.round(chunk.minX);
    const cMinZ = Math.round(chunk.minZ);
    const cW = chunk.width;
    const cH = chunk.height;

    for (let py = 0; py < cH; py++) {
      const wz = cMinZ + py;
      const my = wz + halfExtent;
      if (my < 0 || my >= masterSize) continue;

      const chunkRowOffset = py * cW * 4;
      const masterRowOffset = my * masterSize * 4;

      for (let px = 0; px < cW; px++) {
        const wx = cMinX + px;
        const mx = wx + halfExtent;
        if (mx < 0 || mx >= masterSize) continue;

        const cIdx = chunkRowOffset + px * 4;
        const mIdx = masterRowOffset + mx * 4;

        const srcR = chunk.pixels[cIdx];
        const srcG = chunk.pixels[cIdx + 1];
        const srcB = chunk.pixels[cIdx + 2];
        const srcA = chunk.pixels[cIdx + 3];

        // 若主貼圖已有值 (交疊 padding 區域)，取最大值保留光照
        this.masterData[mIdx] = Math.max(this.masterData[mIdx], srcR);
        this.masterData[mIdx + 1] = Math.max(this.masterData[mIdx + 1], srcG);
        this.masterData[mIdx + 2] = Math.max(this.masterData[mIdx + 2], srcB);
        this.masterData[mIdx + 3] = srcA > 0 ? (this.masterData[mIdx + 3] > 0 ? Math.round((this.masterData[mIdx + 3] + srcA) * 0.5) : srcA) : this.masterData[mIdx + 3];
      }
    }
  }

  public getMasterTexture(): THREE.DataTexture {
    return this.masterTexture;
  }

  public dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.masterTexture.dispose();
  }
}
