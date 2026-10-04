/**
 * BlipManager.ts - 地圖標記（Blip）系統
 * 負責地圖標記註冊、分類管理、圖示快取、程序化幾何圖示繪製與空間密度精簡
 * 嚴格禁止使用或重製任何第三方商標或 Rockstar 素材，所有圖示均為純向量程序幾何
 */

import { Point2D, ShopFeature, IntersectionFeature } from '../geo/OsmTypes.ts';

export type BlipCategory =
  | 'convenience'
  | 'restaurant'
  | 'cafe'
  | 'pharmacy'
  | 'gas_station'
  | 'hotel'
  | 'station'
  | 'temple'
  | 'parking'
  | 'destination'
  | 'mission'
  | 'vehicle'
  | 'police'
  | 'traffic_signal';

export interface BlipCategoryMeta {
  id: BlipCategory;
  name: string;
  color: string;
  bgColor: string;
  priority: number; // 數字越大優先級越高
  defaultVisible: boolean;
}

export interface Blip {
  id: string;
  position: Point2D;
  category: BlipCategory;
  label: string;
  color?: string;
  priority: number;
  visible: boolean;
  extra?: Record<string, any>;
}

export const BLIP_CATEGORIES: Record<BlipCategory, BlipCategoryMeta> = {
  destination: {
    id: 'destination',
    name: '導航目標',
    color: '#f43f5e',
    bgColor: 'rgba(244, 63, 94, 0.25)',
    priority: 100,
    defaultVisible: true
  },
  mission: {
    id: 'mission',
    name: '任務點',
    color: '#eab308',
    bgColor: 'rgba(234, 179, 8, 0.25)',
    priority: 90,
    defaultVisible: true
  },
  station: {
    id: 'station',
    name: '車站/交通',
    color: '#6366f1',
    bgColor: 'rgba(99, 102, 241, 0.25)',
    priority: 80,
    defaultVisible: true
  },
  police: {
    id: 'police',
    name: '治安/警察',
    color: '#3b82f6',
    bgColor: 'rgba(59, 130, 246, 0.25)',
    priority: 75,
    defaultVisible: true
  },
  vehicle: {
    id: 'vehicle',
    name: '載具',
    color: '#06b6d4',
    bgColor: 'rgba(6, 182, 212, 0.25)',
    priority: 70,
    defaultVisible: true
  },
  convenience: {
    id: 'convenience',
    name: '便利商店',
    color: '#0284c7',
    bgColor: 'rgba(2, 132, 199, 0.25)',
    priority: 60,
    defaultVisible: true
  },
  gas_station: {
    id: 'gas_station',
    name: '加油站',
    color: '#0ea5e9',
    bgColor: 'rgba(14, 165, 233, 0.25)',
    priority: 55,
    defaultVisible: true
  },
  pharmacy: {
    id: 'pharmacy',
    name: '藥局/醫療',
    color: '#10b981',
    bgColor: 'rgba(16, 185, 129, 0.25)',
    priority: 50,
    defaultVisible: true
  },
  restaurant: {
    id: 'restaurant',
    name: '美食餐廳',
    color: '#f97316',
    bgColor: 'rgba(249, 115, 22, 0.25)',
    priority: 45,
    defaultVisible: true
  },
  cafe: {
    id: 'cafe',
    name: '咖啡烘焙',
    color: '#d97706',
    bgColor: 'rgba(217, 119, 6, 0.25)',
    priority: 40,
    defaultVisible: true
  },
  hotel: {
    id: 'hotel',
    name: '溫泉旅宿',
    color: '#a855f7',
    bgColor: 'rgba(168, 85, 247, 0.25)',
    priority: 35,
    defaultVisible: true
  },
  temple: {
    id: 'temple',
    name: '廟宇寺院',
    color: '#eab308',
    bgColor: 'rgba(234, 179, 8, 0.25)',
    priority: 30,
    defaultVisible: true
  },
  parking: {
    id: 'parking',
    name: '停車場',
    color: '#38bdf8',
    bgColor: 'rgba(56, 189, 248, 0.25)',
    priority: 25,
    defaultVisible: true
  },
  traffic_signal: {
    id: 'traffic_signal',
    name: '交通號誌',
    color: '#10b981',
    bgColor: 'rgba(16, 185, 129, 0.25)',
    priority: 20,
    defaultVisible: true
  }
};

export class BlipManager {
  private blips: Map<string, Blip> = new Map();
  private categoryVisibility: Map<BlipCategory, boolean> = new Map();
  private destinationBlip: Blip | null = null;
  private iconSpriteCache: Map<string, HTMLCanvasElement> = new Map();

  constructor() {
    // 預設全類別可見
    for (const key of Object.keys(BLIP_CATEGORIES) as BlipCategory[]) {
      this.categoryVisibility.set(key, BLIP_CATEGORIES[key].defaultVisible);
    }
  }

  /**
   * 註冊或更新標記
   */
  public registerBlip(blip: Blip): void {
    this.blips.set(blip.id, blip);
  }

  public removeBlip(id: string): void {
    this.blips.delete(id);
    if (this.destinationBlip && this.destinationBlip.id === id) {
      this.destinationBlip = null;
    }
  }

  public clear(): void {
    this.blips.clear();
    this.destinationBlip = null;
  }

  /**
   * 設定導航目的地標記
   */
  public setDestination(pos: Point2D | null, label: string = '導航目標'): void {
    if (!pos) {
      if (this.destinationBlip) {
        this.blips.delete(this.destinationBlip.id);
        this.destinationBlip = null;
      }
      return;
    }

    const blip: Blip = {
      id: 'blip_nav_destination',
      position: { x: pos.x, z: pos.z },
      category: 'destination',
      label,
      color: BLIP_CATEGORIES.destination.color,
      priority: BLIP_CATEGORIES.destination.priority,
      visible: true
    };

    this.destinationBlip = blip;
    this.blips.set(blip.id, blip);
  }

  public getDestination(): Blip | null {
    return this.destinationBlip;
  }

  /**
   * 類別可見度切換
   */
  public setCategoryVisible(category: BlipCategory, visible: boolean): void {
    this.categoryVisibility.set(category, visible);
  }

  public isCategoryVisible(category: BlipCategory): boolean {
    return this.categoryVisibility.get(category) ?? true;
  }

  public getAllCategories(): BlipCategoryMeta[] {
    return Object.values(BLIP_CATEGORIES);
  }

  public getAllBlips(): Blip[] {
    return Array.from(this.blips.values());
  }

  /**
   * 根據標準化 ShopFeature[] 自動轉換並註冊 POI 標記
   */
  public populateFromShops(shops: ShopFeature[]): void {
    // 清除舊的非目的地標記
    const dest = this.destinationBlip;
    this.blips.clear();
    if (dest) {
      this.blips.set(dest.id, dest);
    }

    for (const shop of shops) {
      const category = this.mapShopToCategory(shop);
      if (!category) continue;

      const meta = BLIP_CATEGORIES[category];
      const blip: Blip = {
        id: `blip_${shop.id}`,
        position: { x: shop.point.x, z: shop.point.z },
        category,
        label: shop.name,
        color: meta.color,
        priority: meta.priority,
        visible: true,
        extra: {
          subCategory: shop.subCategory,
          lat: shop.lat,
          lon: shop.lon
        }
      };

      this.blips.set(blip.id, blip);
    }
  }

  /**
   * 根據標準化 IntersectionFeature[] 自動轉換並註冊號誌路口標記
   */
  public populateTrafficSignals(intersections: IntersectionFeature[]): void {
    for (const inter of intersections) {
      if (!inter.hasSignals) continue;
      const meta = BLIP_CATEGORIES.traffic_signal;
      const blip: Blip = {
        id: `blip_signal_${inter.id}`,
        position: { x: inter.center.x, z: inter.center.z },
        category: 'traffic_signal',
        label: `交通號誌 (${inter.source === 'osm' ? 'OSM' : '自動'})`,
        color: meta.color,
        priority: meta.priority,
        visible: true,
        extra: {
          intersectionId: inter.id,
          source: inter.source
        }
      };
      this.blips.set(blip.id, blip);
    }
  }

  /**
   * 將 OSM 店家標籤正規化為內部標記類別
   */
  private mapShopToCategory(shop: ShopFeature): BlipCategory | null {
    const sub = (shop.subCategory || '').toLowerCase();
    const cat = (shop.category || '').toLowerCase();
    const name = shop.name || '';

    // 車站與公共運輸
    if (sub.includes('station') || sub === 'train_station' || cat === 'railway' || name.includes('車站') || name.includes('轉運站')) {
      return 'station';
    }
    // 便利商店
    if (sub === 'convenience' || name.includes('7-ELEVEN') || name.includes('全家') || name.includes('萊爾富') || name.includes('OK便利')) {
      return 'convenience';
    }
    // 加油站
    if (sub === 'fuel' || name.includes('加油站') || name.includes('中油')) {
      return 'gas_station';
    }
    // 藥局與診所
    if (sub === 'pharmacy' || sub === 'clinic' || sub === 'hospital' || name.includes('藥局') || name.includes('診所')) {
      return 'pharmacy';
    }
    // 咖啡與茶飲
    if (sub === 'cafe' || sub === 'coffee' || sub === 'tea' || name.includes('咖啡') || name.includes('茶')) {
      return 'cafe';
    }
    // 飯店、旅館、溫泉民宿
    if (
      sub === 'hotel' ||
      sub === 'motel' ||
      sub === 'guest_house' ||
      sub === 'hostel' ||
      sub === 'spa' ||
      name.includes('飯店') ||
      name.includes('溫泉') ||
      name.includes('旅店') ||
      name.includes('會館')
    ) {
      return 'hotel';
    }
    // 廟宇寺院
    if (sub === 'place_of_worship' || name.includes('廟') || name.includes('寺') || name.includes('宮')) {
      return 'temple';
    }
    // 停車場
    if (sub === 'parking' || name.includes('停車場')) {
      return 'parking';
    }
    // 餐廳與小吃
    if (
      sub === 'restaurant' ||
      sub === 'fast_food' ||
      sub === 'food_court' ||
      sub === 'bakery' ||
      name.includes('餐廳') ||
      name.includes('小吃') ||
      name.includes('麵') ||
      name.includes('飯')
    ) {
      return 'restaurant';
    }

    // 其它一般商店歸為便利/購物
    if (cat === 'shop') {
      return 'convenience';
    }

    return null;
  }

  /**
   * 小地圖動態可見標記查詢（含半徑過濾、類別過濾與過密篩選 culling）
   */
  public getMinimapBlips(center: Point2D, radiusMeters: number, minDistanceMeters = 18): Blip[] {
    const candidates: { blip: Blip; dist: number }[] = [];

    for (const blip of this.blips.values()) {
      if (!blip.visible) continue;
      if (!this.isCategoryVisible(blip.category)) continue;

      const dx = blip.position.x - center.x;
      const dz = blip.position.z - center.z;
      const dist = Math.hypot(dx, dz);

      // 目的地標記不論距離一律保留（即使超出半徑也會釘在邊緣）
      if (blip.category === 'destination') {
        candidates.push({ blip, dist });
        continue;
      }

      if (dist <= radiusMeters * 1.05) {
        candidates.push({ blip, dist });
      }
    }

    // 依優先級降序排序（優先級高者優先保留）
    candidates.sort((a, b) => {
      if (b.blip.priority !== a.blip.priority) {
        return b.blip.priority - a.blip.priority;
      }
      return a.dist - b.dist;
    });

    // 空間密度抑制 (防止標記擠成一團)：若與已保留標記距離小於 minDistanceMeters 則剔除
    const result: Blip[] = [];
    const minSq = minDistanceMeters * minDistanceMeters;

    for (const item of candidates) {
      if (item.blip.category === 'destination') {
        result.push(item.blip);
        continue;
      }

      let tooClose = false;
      for (const accepted of result) {
        if (accepted.category === 'destination') continue;
        const dx = item.blip.position.x - accepted.position.x;
        const dz = item.blip.position.z - accepted.position.z;
        if (dx * dx + dz * dz < minSq) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        result.push(item.blip);
      }
    }

    return result;
  }

  /**
   * 程序化幾何圖示 Sprite 取得（使用 OffscreenCanvas 快取，極速 drawImage）
   */
  public getIconSprite(category: BlipCategory, size = 20): HTMLCanvasElement {
    const key = `${category}_${size}`;
    const cached = this.iconSpriteCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const meta = BLIP_CATEGORIES[category] || BLIP_CATEGORIES.convenience;
    this.drawProceduralIcon(ctx, category, size / 2, size / 2, size, meta.color, meta.bgColor);

    this.iconSpriteCache.set(key, canvas);
    return canvas;
  }

  /**
   * 繪製純向量幾何標記圖示（無外部圖片依賴，100% 自行程式化繪製）
   */
  public drawProceduralIcon(
    ctx: CanvasRenderingContext2D,
    category: BlipCategory,
    cx: number,
    cy: number,
    size: number,
    color: string,
    bgColor: string
  ): void {
    const r = size * 0.45;

    ctx.save();

    // 1. 底圈光暈與背景圓形
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = bgColor;
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();

    // 2. 幾何向量符號 (純幾何繪製)
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const s = size * 0.22;

    switch (category) {
      case 'destination': {
        // 旗標與圖釘
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.4, cy + s * 1.1);
        ctx.lineTo(cx - s * 0.4, cy - s * 1.1);
        ctx.lineTo(cx + s * 1.1, cy - s * 0.5);
        ctx.lineTo(cx - s * 0.4, cy);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.stroke();
        break;
      }

      case 'station': {
        // 列車幾何外框與雙車燈
        ctx.beginPath();
        ctx.roundRect(cx - s * 0.7, cy - s * 0.9, s * 1.4, s * 1.8, 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.5, cy - s * 0.3);
        ctx.lineTo(cx + s * 0.5, cy - s * 0.3);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx - s * 0.35, cy + s * 0.4, 1.2, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.35, cy + s * 0.4, 1.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'convenience': {
        // 購物籃幾何框
        ctx.beginPath();
        ctx.rect(cx - s * 0.8, cy - s * 0.3, s * 1.6, s * 1.1);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy - s * 0.3, s * 0.5, Math.PI, 0);
        ctx.stroke();
        break;
      }

      case 'restaurant': {
        // 叉匙交叉
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.8, cy - s * 0.8);
        ctx.lineTo(cx + s * 0.8, cy + s * 0.8);
        ctx.moveTo(cx + s * 0.8, cy - s * 0.8);
        ctx.lineTo(cx - s * 0.8, cy + s * 0.8);
        ctx.stroke();
        break;
      }

      case 'cafe': {
        // 咖啡杯幾何弧
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.7, cy - s * 0.5);
        ctx.lineTo(cx - s * 0.5, cy + s * 0.7);
        ctx.lineTo(cx + s * 0.5, cy + s * 0.7);
        ctx.lineTo(cx + s * 0.7, cy - s * 0.5);
        ctx.closePath();
        ctx.stroke();
        // 杯把手
        ctx.beginPath();
        ctx.arc(cx + s * 0.7, cy, s * 0.3, -Math.PI * 0.5, Math.PI * 0.5);
        ctx.stroke();
        break;
      }

      case 'pharmacy': {
        // 醫療十字符號
        ctx.beginPath();
        ctx.moveTo(cx, cy - s * 0.8);
        ctx.lineTo(cx, cy + s * 0.8);
        ctx.moveTo(cx - s * 0.8, cy);
        ctx.lineTo(cx + s * 0.8, cy);
        ctx.lineWidth = 2.4;
        ctx.stroke();
        break;
      }

      case 'gas_station': {
        // 加油槍與方箱
        ctx.beginPath();
        ctx.rect(cx - s * 0.8, cy - s * 0.7, s * 1.1, s * 1.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.3, cy - s * 0.3);
        ctx.lineTo(cx + s * 0.7, cy - s * 0.5);
        ctx.lineTo(cx + s * 0.7, cy + s * 0.5);
        ctx.stroke();
        break;
      }

      case 'hotel': {
        // 溫泉三道熱氣曲線
        ctx.beginPath();
        ctx.arc(cx - s * 0.45, cy, s * 0.4, -0.6, 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.4, -0.6, 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + s * 0.45, cy, s * 0.4, -0.6, 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.8, cy + s * 0.7);
        ctx.lineTo(cx + s * 0.8, cy + s * 0.7);
        ctx.stroke();
        break;
      }

      case 'temple': {
        // 廟宇重簷屋頂幾何剪影
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.9, cy - s * 0.1);
        ctx.lineTo(cx, cy - s * 0.9);
        ctx.lineTo(cx + s * 0.9, cy - s * 0.1);
        ctx.stroke();
        ctx.beginPath();
        ctx.rect(cx - s * 0.5, cy - s * 0.1, s * 1.0, s * 0.9);
        ctx.stroke();
        break;
      }

      case 'parking': {
        // 字母 P
        ctx.font = `bold ${Math.round(size * 0.5)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('P', cx, cy);
        break;
      }

      case 'traffic_signal': {
        // 直立小號誌箱 (3個小圓點: 紅、黃、綠)
        const bw = s * 0.7;
        const bh = s * 1.5;
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(cx - bw * 0.5, cy - bh * 0.5, bw, bh);
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - bw * 0.5, cy - bh * 0.5, bw, bh);
        const r = bw * 0.22;
        // 紅
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(cx, cy - bh * 0.3, r, 0, Math.PI * 2);
        ctx.fill();
        // 黃
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        // 綠
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.arc(cx, cy + bh * 0.3, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      default: {
        // 默認幾何菱形點
        ctx.beginPath();
        ctx.moveTo(cx, cy - s * 0.7);
        ctx.lineTo(cx + s * 0.7, cy);
        ctx.lineTo(cx, cy + s * 0.7);
        ctx.lineTo(cx - s * 0.7, cy);
        ctx.closePath();
        ctx.fill();
        break;
      }
    }

    ctx.restore();
  }
}
