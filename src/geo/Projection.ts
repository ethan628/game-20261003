/**
 * Projection.ts - 經緯度與局部 3D 世界座標（公尺）投影轉換
 * 採用標準局部等距圓柱投影 (Local Equirectangular Projection)，保證在數公里範圍內長度與角度極高精確度
 * 慣例：東向為 +X，北向為 -Z，天頂為 +Y
 */

import { Point2D } from './OsmTypes.ts';

const EARTH_RADIUS = 6378137.0; // WGS84 長半軸 (公尺)

export class GeoProjection {
  private originLat: number;
  private originLon: number;
  private originLatRad: number;
  private cosOriginLat: number;

  constructor(originLat: number, originLon: number) {
    this.originLat = originLat;
    this.originLon = originLon;
    this.originLatRad = (originLat * Math.PI) / 180.0;
    this.cosOriginLat = Math.cos(this.originLatRad);
  }

  /**
   * 將經緯度轉換為相對於世界原點的 (x, z) 局部座標 (公尺)
   */
  public project(lat: number, lon: number): Point2D {
    const latRad = (lat * Math.PI) / 180.0;
    const lonRad = (lon * Math.PI) / 180.0;
    const originLonRad = (this.originLon * Math.PI) / 180.0;

    const x = (lonRad - originLonRad) * EARTH_RADIUS * this.cosOriginLat;
    const z = -(latRad - this.originLatRad) * EARTH_RADIUS;

    return { x, z };
  }

  /**
   * 將局部 (x, z) 座標逆向換算為 (lat, lon) 經緯度
   */
  public unproject(x: number, z: number): { lat: number; lon: number } {
    const dLatRad = -z / EARTH_RADIUS;
    const dLonRad = x / (EARTH_RADIUS * this.cosOriginLat);

    const lat = ((this.originLatRad + dLatRad) * 180.0) / Math.PI;
    const lon = this.originLon + (dLonRad * 180.0) / Math.PI;

    return { lat, lon };
  }

  /**
   * 計算給定半徑 (公尺) 之經緯度邊界框 (Bounding Box: south, west, north, east)
   */
  public getBoundingBox(radiusMeters: number): {
    south: number;
    west: number;
    north: number;
    east: number;
  } {
    const dLat = (radiusMeters / EARTH_RADIUS) * (180.0 / Math.PI);
    const dLon = (radiusMeters / (EARTH_RADIUS * Math.max(0.01, this.cosOriginLat))) * (180.0 / Math.PI);

    return {
      south: this.originLat - dLat,
      west: this.originLon - dLon,
      north: this.originLat + dLat,
      east: this.originLon + dLon
    };
  }

  public getOrigin(): { lat: number; lon: number } {
    return { lat: this.originLat, lon: this.originLon };
  }
}
