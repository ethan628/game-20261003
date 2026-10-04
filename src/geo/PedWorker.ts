/**
 * PedWorker.ts - 行人路網拓撲圖背景計算 Web Worker
 * 於獨立 Worker 線程計算人行道雙側偏移、交叉口斑馬線與密度分佈，保證 0 Jank
 */

import { PedestrianNetworkBuilder } from './PedestrianNetworkBuilder.ts';

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'BUILD_NETWORK') {
    try {
      const { roads, buildings, shops } = payload;
      const network = PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops);
      self.postMessage({ type: 'NETWORK_READY', data: network });
    } catch (err: any) {
      self.postMessage({ type: 'NETWORK_ERROR', error: err.message || 'Worker build failed' });
    }
  }
};
