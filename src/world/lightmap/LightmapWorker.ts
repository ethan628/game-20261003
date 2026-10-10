/**
 * LightmapWorker.ts - 區塊光照圖 Web Worker 背景線程
 * 執行空間遮擋測試與物理光場累加，單一區塊計算耗時嚴格控制在 80ms 以內
 */

import { LightmapComputer } from './LightmapComputer.ts';
import { LightmapChunkRequest } from './LightmapTypes.ts';

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'COMPUTE_CHUNK') {
    try {
      const request = payload as LightmapChunkRequest;
      const result = LightmapComputer.computeChunk(request);
      // 以 Transferable ArrayBuffer 轉移，0 拷貝消耗
      (self as any).postMessage(
        { type: 'CHUNK_READY', data: result },
        [result.pixels.buffer]
      );
    } catch (err: any) {
      self.postMessage({
        type: 'CHUNK_ERROR',
        error: err?.message || 'Lightmap chunk calculation failed'
      });
    }
  }
};
