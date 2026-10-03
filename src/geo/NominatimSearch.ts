/**
 * NominatimSearch.ts - OpenStreetMap Nominatim 地點搜尋 API
 */

import { CONFIG } from '../config.ts';

export interface SearchResult {
  displayName: string;
  lat: number;
  lon: number;
  type: string;
}

export class NominatimSearch {
  private abortController: AbortController | null = null;

  public async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const url = new URL(CONFIG.GEO.NOMINATIM_URL);
    url.searchParams.set('format', 'json');
    url.searchParams.set('q', trimmed);
    url.searchParams.set('limit', '6');
    url.searchParams.set('addressdetails', '1');

    try {
      const response = await fetch(url.toString(), {
        signal: this.abortController.signal,
        headers: {
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        }
      });

      if (!response.ok) {
        throw new Error(`搜尋失敗 HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) return [];

      return data.map((item: any) => ({
        displayName: item.display_name,
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
        type: item.type || item.class || '地點'
      }));
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return [];
      }
      console.warn('[NominatimSearch] 搜尋發生錯誤', err);
      throw err;
    }
  }
}
