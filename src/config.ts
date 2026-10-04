/**
 * config.ts - 全域可調數值與遊戲配置中心
 * 依據 RULES.md，所有魔術數字與設定值皆集中於此
 */

export interface PresetLocation {
  id: string;
  name: string;
  desc: string;
  lat: number;
  lon: number;
  presetFile?: string;
}

const BASE_URL = import.meta.env.BASE_URL || '/';

export const PRESET_LOCATIONS: PresetLocation[] = [
  {
    id: 'jiaoxi',
    name: '宜蘭礁溪溫泉市區（礁溪火車站）',
    desc: '真實核心街區 (24.828, 121.772) 湯圍溝溫泉公園、飯店群與溫泉街',
    lat: 24.828,
    lon: 121.772,
    presetFile: `${BASE_URL}presets/jiaoxi.json`
  },
  {
    id: 'jiaoxi_south',
    name: '宜蘭南側參考點 (24.667, 121.772)',
    desc: '原規格書座標標註點 (地理位於羅東/冬山段)',
    lat: 24.667,
    lon: 121.772
  },
  {
    id: 'yilan',
    name: '宜蘭市區（宜蘭火車站）',
    desc: '宜蘭市中心幾米廣場與舊城街廓 (24.755, 121.754)',
    lat: 24.7554,
    lon: 121.7538,
    presetFile: `${BASE_URL}presets/yilan.json`
  },
  {
    id: 'taipei101',
    name: '台北 101 周邊（信義商圈）',
    desc: '台北信義計畫區、摩天高樓群與寬廣大道 (25.034, 121.564)',
    lat: 25.0339,
    lon: 121.5644,
    presetFile: `${BASE_URL}presets/taipei101.json`
  },
  {
    id: 'pier2',
    name: '高雄駁二特區',
    desc: '高雄港灣、倉庫聚落、水岸與輕軌景觀 (22.620, 120.282)',
    lat: 22.6198,
    lon: 120.2818,
    presetFile: `${BASE_URL}presets/pier2.json`
  }
];

export const CONFIG = {
  // 遊戲迴圈與時間
  PHYSICS: {
    FIXED_DELTA: 1 / 60,       // 60Hz 固定時間步長 (秒)
    MAX_SUB_STEPS: 5           // 每幀最多追趕子步數，防巨幅掉幀螺旋
  },

  // 玩家實體
  PLAYER: {
    WALK_SPEED: 5.5,           // 走速 (m/s)
    RUN_SPEED: 11.0,           // 奔跑速度 (m/s)
    JUMP_VELOCITY: 8.5,        // 跳躍初速 (m/s)
    GRAVITY: 24.0,             // 重力加速度 (m/s^2)
    COLLISION_RADIUS: 0.45,    // 角色水平碰撞半徑 (m)
    HEIGHT: 1.8,               // 角色身高 (m)
    ROTATION_SPEED: 14.0,      // 轉向平滑速度
    COLORS: {
      SKIN: 0xffdbac,
      HAIR: 0x2d1d12,
      SHIRT: 0x1e5a8a,
      PANTS: 0x2b3947,
      SHOES: 0x1c1e22
    }
  },

  // 鏡頭控制 (視覺升級：拉遠、仰角約 28 度、FOV 60、加入鏡頭平滑跟隨)
  CAMERA: {
    FOV: 60,                   // 視野角 (度)
    DEFAULT_DISTANCE: 9.0,     // 預設鏡頭距離 (m) (拉遠，能綜觀街道建物)
    MIN_DISTANCE: 2.5,         // 最小縮放距離
    MAX_DISTANCE: 24.0,        // 最大縮放距離
    TARGET_HEIGHT: 1.5,        // 鏡頭焦點高度 (m)
    DEFAULT_PITCH: 28 * (Math.PI / 180), // 預設仰角約 28 度 (約 0.488 弧度)
    PITCH_MIN: -65 * (Math.PI / 180),    // 最低俯仰角
    PITCH_MAX: 72 * (Math.PI / 180),     // 最高俯仰角
    MOUSE_SENSITIVITY: 0.0022, // 滑鼠靈敏度
    ZOOM_SPEED: 0.8,           // 滾輪縮放速度
    COLLISION_MARGIN: 0.35,    // 鏡頭防穿牆邊界保留距離 (m)
    LERP_SPEED: 10.0           // 鏡頭平滑跟隨係數
  },

  // 地理資訊與 Overpass 查詢
  GEO: {
    FETCH_RADIUS_METERS: 500,  // 抓取半徑約 500 公尺 (直徑 1000m 範圍)
    CACHE_VERSION: 'v5_traffic_signals',
    CACHE_DB_NAME: 'GTA_OSM_Cache_v5',
    CACHE_STORE_NAME: 'regions',
    REQUEST_TIMEOUT_MS: 9000,  // 逾時 9 秒，防長期卡住
    MAX_RETRIES: 3,            // 伺服器失敗重試次數
    OVERPASS_ENDPOINTS: [
      '/api/overpass', // 本地 Vite 伺服器轉發代理（無跨域、極速轉發）
      'https://lz4.overpass-api.de/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter'
    ],
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/search'
  },

  // 店家招牌系統配置 (RULES.md 規範集中化)
  SIGNBOARD: {
    MATCH_MAX_DISTANCE: 30.0,   // 配對建築物最大距離門檻 (公尺，放寬至 30m)
    DEFAULT_HEIGHT: 3.2,        // 臨街牆面招牌一樓上緣高度 (公尺)
    WALL_SIGN_WIDTH: 2.8,       // 橫式牆面招牌寬度 (m)
    WALL_SIGN_HEIGHT: 0.8,      // 橫式牆面招牌高度 (m)
    WALL_SIGN_MAX_WIDTH: 4.0,   // 橫式招牌寬度上限 (m)
    WALL_SIGN_MAX_HEIGHT: 0.8,  // 橫式招牌高度上限 (m)
    PROJECTING_SIGN_MAX_WIDTH: 0.8, // 直式突出招牌寬度上限 (m)
    PROJECTING_SIGN_MAX_HEIGHT: 3.0,// 直式突出招牌高度上限 (m)
    WALL_SIGN_DEPTH: 0.15,      // 橫式招牌厚度 (m)
    WALL_OFFSET: 0.12,          // 沿法線外推距離 (避免與牆面 Z-fighting)
    STANDALONE_POLE_HEIGHT: 3.5,// 獨立立柱高度 (m)
    STANDALONE_SIGN_WIDTH: 0.8, // 直式立柱招牌寬度 (m)
    STANDALONE_SIGN_HEIGHT: 2.4,// 直式立柱招牌高度 (m)
    EMISSIVE_INTENSITY: 0.35,   // 材質自發光強度 (夜間與背光依然清晰可辨)
    PROCEDURAL_MIN_SHOPS: 30,   // 區域店家少於此數時自動以虛構招牌補足臨街一樓
    FICTIONAL_SHOPS: [
      { name: '礁溪溫泉拉麵', category: 'amenity', subCategory: 'restaurant', color: '#dc2626' },
      { name: '奕順軒宜蘭名產', category: 'shop', subCategory: 'bakery', color: '#ea580c' },
      { name: '阿公宜蘭蔥油餅', category: 'amenity', subCategory: 'fast_food', color: '#d97706' },
      { name: '湯圍溝大眾湯屋', category: 'tourism', subCategory: 'attraction', color: '#0284c7' },
      { name: '7-ELEVEn 礁溪門市', category: 'shop', subCategory: 'convenience', color: '#059669' },
      { name: '全家便利商店 溫泉店', category: 'shop', subCategory: 'convenience', color: '#0284c7' },
      { name: '清心福全冷飲站', category: 'amenity', subCategory: 'cafe', color: '#16a34a' },
      { name: '50嵐 礁溪旗艦店', category: 'amenity', subCategory: 'cafe', color: '#eab308' },
      { name: '礁溪五金水電百貨', category: 'shop', subCategory: 'hardware', color: '#4b5563' },
      { name: '日式炭火居酒屋', category: 'amenity', subCategory: 'restaurant', color: '#991b1b' },
      { name: '宜蘭名產鴨賞專賣', category: 'shop', subCategory: 'specialty', color: '#b91c1c' },
      { name: '康是美 藥妝生活館', category: 'shop', subCategory: 'chemist', color: '#f97316' },
      { name: '屈臣氏 礁溪店', category: 'shop', subCategory: 'chemist', color: '#0d9488' },
      { name: '麥當勞 礁溪得來速', category: 'amenity', subCategory: 'fast_food', color: '#dc2626' },
      { name: '摩斯漢堡 礁溪店', category: 'amenity', subCategory: 'fast_food', color: '#b91c1c' },
      { name: '台式傳統牛肉麵館', category: 'amenity', subCategory: 'restaurant', color: '#7c2d12' },
      { name: '溫泉足湯咖啡廳', category: 'amenity', subCategory: 'cafe', color: '#854d0e' },
      { name: '三代古早味冰果室', category: 'amenity', subCategory: 'ice_cream', color: '#db2777' },
      { name: '全聯福利中心 礁溪店', category: 'shop', subCategory: 'supermarket', color: '#1d4ed8' },
      { name: '川湯溫泉養生館', category: 'tourism', subCategory: 'hotel', color: '#0891b2' }
    ]
  },

  // 世界視覺風格 (GTA 寫實氛圍：黃昏暖橘太陽、橘粉地平線、青藍天頂、指數霧氣)
  WORLD: {
    GROUND_SIZE: 2200,         // 地面平面邊長 (m)
    GROUND_COLOR: 0x1e232a,    // 現代城市深板岩灰基底 (與柏油路及人行道自然銜接，夜間不反白)
    SKY_GRADIENT: {
      TOP: '#153250',          // 天頂深青藍
      MIDDLE: '#784c68',       // 中層紫橘粉
      HORIZON: '#f8a768'       // 地平線暖橘金
    },
    FOG_COLOR: 0x8a9bb5,       // 中性大氣透視霧色 (夜間由 WeatherRenderer 接管為 #141c33)
    FOG_DENSITY: 0.0016,       // 指數霧濃度 (遠景呈現藍灰/暖灰空氣透視)
    FOG_NEAR: 120,             // 備用線性霧近端
    FOG_FAR: 520,              // 備用線性霧遠端
    SUN_COLOR: 0xffb066,       // 黃昏金橘暖陽 (約 #ffb066)
    SUN_INTENSITY: 2.5,        // 陽光強度
    SUN_ELEVATION_DEG: 24,     // 太陽高度角約 24 度 (黃昏金黃魔幻時刻感)
    SUN_AZIMUTH_DEG: 215,      // 太陽水平方位角
    HEMI_SKY_COLOR: 0x8cc4f0,  // 半球光天空天青色
    HEMI_GROUND_COLOR: 0x6e523e,// 半球光地面暖棕色
    HEMI_INTENSITY: 1.15,      // 環境光強度
    SHADOW_MAP_SIZE: 2048,     // 陰影貼圖解析度
    SHADOW_CAMERA_RADIUS: 130  // 陰影跟隨玩家覆蓋半徑 (m)
  },

  // 道路寬度與細節配置 (公尺)
  ROADS: {
    WIDTHS: {
      motorway: { road: 14, sidewalk: 2.2 },
      trunk: { road: 12, sidewalk: 2.0 },
      primary: { road: 11, sidewalk: 1.8 },
      secondary: { road: 9, sidewalk: 1.6 },
      tertiary: { road: 7.5, sidewalk: 1.4 },
      residential: { road: 6.0, sidewalk: 1.2 },
      service: { road: 4.5, sidewalk: 0.9 },
      unclassified: { road: 5.5, sidewalk: 1.2 },
      living_street: { road: 4.5, sidewalk: 1.0 },
      pedestrian: { road: 3.8, sidewalk: 0.0 },
      footway: { road: 2.5, sidewalk: 0.0 },
      path: { road: 2.0, sidewalk: 0.0 },
      cycleway: { road: 2.5, sidewalk: 0.0 },
      default: { road: 6.0, sidewalk: 1.2 }
    } as Record<string, { road: number; sidewalk: number }>,
    ROAD_COLOR: 0x2e384b,      // 柏油路：深藍灰，基底色提高至不低於 #2a3144，夜間可辨識
    SIDEWALK_COLOR: 0x4a5568,  // 人行道：中性都會中暖灰地磚，與柏油有清晰明度反差
    CURB_COLOR: 0x3d4756,      // 路緣石立體面顏色
    MARKING_WHITE: 0xf4f7fa,   // 車道白色虛線與斑馬線
    MARKING_YELLOW: 0xf5b041,  // 雙黃實線
    SIDEWALK_HEIGHT: 0.15,     // 人行道高度 (m)
    ELEVATION: {
      ROAD: 0.02,              // 柏油路高程 (m)
      MARKING: 0.028,          // 標線略高於路面
      SIDEWALK: 0.17           // 人行道比路面高約 0.15 公尺 (0.17 - 0.02)
    }
  },

  // 建築細節、樓層規則與資料可信度管線
  BUILDINGS: {
    // 樓高標準規範：一樓 3.6m、其餘每層 3.1m、頂樓加蓋 2.8m
    FIRST_FLOOR_HEIGHT: 3.6,
    TYPICAL_FLOOR_HEIGHT: 3.1,
    ROOFTOP_ADDON_HEIGHT: 2.8,
    LEVEL_HEIGHT: 3.1,         // 基準層高 (相容舊引用)
    DEFAULT_HEIGHT_MIN: 6.7,   // 無資料最低高度 (約 2 層)
    DEFAULT_HEIGHT_MAX: 22.0,  // 無資料隨機上限

    // 連棟透天厝分戶設定 (依戶寬約 4 到 6 公尺沿臨街面切分)
    SUBDIVIDE_ROW_HOUSES: true,
    UNIT_WIDTH_MIN: 4.2,       // 戶寬下限 (m)
    UNIT_WIDTH_MAX: 5.6,       // 戶寬上限 (m)

    // 多邊形化簡容差 (不可超過 0.3m)
    SIMPLIFY_TOLERANCE: 0.25,

    // 資料來源色彩規範 (F5 輪廓線與 F7 標籤使用)
    SOURCE_COLORS: {
      osm: 0x22c55e,       // 綠色：OSM 實測 (height 或 building:levels)
      external: 0x3b82f6,  // 藍色：外部資料 (NLSC 國土測繪三維建物)
      override: 0xa855f7,  // 紫色：人工校正 (data/overrides.json)
      estimated: 0xf97316  // 橘色：推測補值
    },

    // 樓層標籤配置 (F7 切換)
    FLOOR_LABEL: {
      ENABLED: false,       // 預設關閉，按 F7 開啟
      MAX_DISTANCE: 160.0,  // 最大可視距離 (m)
      OFFSET_Y: 2.2         // 浮動於建物頂部之高度 (m)
    },

    TYPE_HEIGHTS: {
      commercial: [14, 40],
      retail: [8, 18],
      apartments: [15, 34],
      hotel: [18, 48],
      office: [22, 55],
      residential: [7, 16],
      house: [6, 12],
      industrial: [6, 12],
      school: [10, 18],
      civic: [12, 24]
    } as Record<string, [number, number]>,
    // 低多邊形城市 8 色調色盤 (美觀和諧)
    PALETTE: [
      0xf5f3ea, // 暖米白
      0xe7ded0, // 淺沙駝
      0xde886d, // 柔和瓦橘
      0x7890a4, // 石板灰藍
      0x6f9678, // 鼠尾草綠
      0xc78a60, // 陶土赭橘
      0x969fa8, // 現代冷灰
      0xf0e5cf  // 奶油淡黃
    ],
    // 屋頂調色盤 (與牆面不同色)
    ROOF_PALETTE: [
      0x4a5460, // 深石板灰
      0x564f47, // 深暖灰
      0x3c424a, // 墨黑灰
      0x685d54  // 灰褐色
    ],
    PARAPET_HEIGHT: 0.6,       // 屋頂女兒牆高度 (m)
    MIN_AREA: 10.0,            // 建物最小底面積門檻 (m²)，過小判定為無效或雜訊
    WINDOW: {
      WIDTH: 1.2,              // 窗戶寬度 (m)
      HEIGHT: 1.5,             // 窗戶高度 (m)
      COLOR: 0x223040,         // 深藍灰玻璃反射色
      FRAME_COLOR: 0xd8d2c6    // 窗框米灰
    },
    // 步驟 4：招牌未配對時補生成之台灣風格小型店面透天厝
    PROCEDURAL_SHOP: {
      WIDTH_MIN: 6.0,          // 店面寬度下限 (m)
      WIDTH_MAX: 8.0,          // 店面寬度上限 (m)
      DEPTH: 8.5,              // 店面街屋深度 (m)
      LEVELS_MIN: 2,           // 樓層下限
      LEVELS_MAX: 3,           // 樓層上限
      LEVEL_HEIGHT: 3.2,       // 樓層高度 (m)
      PALETTE: [
        0xe8ded1, // 暖米白
        0xc4c0b8, // 水泥洗石子灰
        0xa85d48, // 傳統紅磚/二丁掛
        0xbda188, // 淺褐抿石
        0x9ca3af, // 質感淺灰
        0xc29b64, // 復古黃褐
        0xdfd5c6  // 象牙米黃
      ],
      ROOF_PALETTE: [
        0x4a5460, // 深石板灰
        0x564f47, // 深暖灰
        0x3c424a  // 墨黑灰
      ]
    }
  },

  // 自然景觀與地貌 (水域、綠地)
  FEATURES: {
    WATER_COLOR: 0x22557c,     // 水域：沉穩深青藍，夜間可辨識水面
    WATER_ROUGHNESS: 0.15,
    WATER_OPACITY: 0.88,
    WATER_ELEVATION: 0.018,
    GREEN_COLOR: 0x255234,     // 綠地草地：自然暗綠，夜間與柏油人行道明確區隔
    FOREST_COLOR: 0x1a4025,    // 深林濃綠
    GREEN_ELEVATION: 0.012
  },

  // 環境裝飾物 (行道樹、路燈 InstancedMesh)
  PROPS: {
    ENABLED: true,
    TREE_SPACING: 24,          // 行道樹間隔 (m)
    LAMP_SPACING: 32,          // 路燈間隔 (m)
    TREE_TRUNK_COLOR: 0x6d4c41,// 樹幹棕褐色
    TREE_FOLIAGE_COLORS: [     // 低多邊形樹冠綠色變化
      0x43a047,
      0x388e3c,
      0x558b2f
    ],
    LAMP_POLE_COLOR: 0x475569, // 路燈金屬深灰桿
    LAMP_LIGHT_COLOR: 0xfff6c2  // 燈罩柔和微光色
  },

  // 渲染配置
  RENDER: {
    TONE_MAPPING_EXPOSURE: 1.10,
    SHADOWS_ENABLED: true
  },

  // GTA 風格後處理管線配置 (EffectComposer 一鍵開關與品質預設)
  POST_PROCESSING: {
    ENABLED: true,
    QUALITY: 'high' as 'low' | 'medium' | 'high',
    BLOOM_STRENGTH: 0.32,      // 柔和光暈強度 (只對高亮自發光招牌/車燈/夕陽)
    BLOOM_RADIUS: 0.45,
    BLOOM_THRESHOLD: 0.82,     // 閾值高，避免全螢幕泛白
    TEAL_ORANGE_STRENGTH: 0.46,// 橘青對比分級強度
    CONTRAST: 1.08,            // S-Curve 寫實對比度
    SATURATION: 0.90,          // 稍微壓低飽和度，增添真實電影質感
    VIGNETTE: 0.48,            // 邊角微暗角
    GRAIN: 0.022               // 輕微膠片微顆粒
  },

  // 動態天候與時段模式 (按 R 切換濕潤模式，按 T 切換夜間模式)
  MODES: {
    IS_WET: false,             // 濕潤路面模式 (水窪、倒影、低 roughness)
    IS_NIGHT: false            // 夜間模式 (招牌霓虹 Bloom、路燈大亮)
  },

  // 街道雜物配置 (依密度隨機擺放，全部用 InstancedMesh)
  STREET_DEBRIS: {
    ENABLED: true,
    MAX_TRASH_CANS: 60,
    MAX_HYDRANTS: 40,
    MAX_CONES: 80,
    MAX_BARRICADES: 30,
    MAX_BOXES: 70,
    MAX_SCOOTERS: 90,
    MAX_POLES: 80,
    MAX_VENDING_MACHINES: 35,
    MAX_CARS: 45,
    MAX_MANHOLES: 120
  },

  // 自繪 GTA 風格小地圖配置 (2D Canvas)
  MINIMAP: {
    SHAPE: 'rounded_rect' as 'rounded_rect' | 'round',
    BORDER_RADIUS: 16,                    // 圓角半徑
    SIZES: {
      normal: { width: 230, height: 230 },
      compact: { width: 170, height: 170 },
      large: { width: 300, height: 300 },
      xlarge: { width: 380, height: 380 }
    },
    DEFAULT_SIZE: 'normal' as 'normal' | 'compact' | 'large' | 'xlarge',
    DEFAULT_RADIUS_METERS: 250,           // 預設可視半徑 (m)
    MIN_RADIUS_METERS: 80,                // 最小縮放半徑 (m，可放大細看街區)
    MAX_RADIUS_METERS: 1000,              // 最大縮放半徑 (m，可縮小鳥瞰全區)
    FOLLOW_PLAYER_YAW: true,              // 預設隨玩家鏡頭朝向旋轉
    SHOW_NORTH_INDICATOR: true,           // 邊緣顯示北方指示
    SHOW_STREET_NAME: true,               // 顯示當前道路名稱
    TILE_SIZE_METERS: 256,                // 靜態底圖快取區塊大小 (m)
    ATTRIBUTION: '© OpenStreetMap contributors'
  },

  // 地圖配色系統 (集中管理，深藍灰底、冷冽科技、GTA風格)
  MAP_PALETTE: {
    background: '#131822',                // 底圖背景 (深藍灰)
    water: '#1e3a5f',                     // 水域
    waterStroke: '#2563eb',               // 水域邊緣
    green: '#142920',                     // 綠地/草地
    forest: '#0f2018',                    // 森林/樹林
    building: '#1e293b',                  // 建築填充
    buildingStroke: '#2b394d',            // 建築輪廓
    roadDefault: '#334155',               // 一般道路 (巷弄/次要)
    roadMajor: '#475569',                 // 次要幹道
    roadPrimary: '#64748b',               // 主要幹道
    roadHighway: '#94a3b8',               // 快速道路/省道
    railway: '#64748b',                   // 鐵路 (虛線)
    route: '#38bdf8',                     // 導航路線 (亮青色)
    routeGlow: 'rgba(56, 189, 248, 0.45)', // 路線光暈
    playerArrow: '#38bdf8',               // 玩家箭頭
    playerCone: 'rgba(56, 189, 248, 0.18)', // 視野扇形
    destination: '#f43f5e',               // 導航目的地 (玫瑰紅)
    northMark: '#ef4444'                  // 北方標記 (紅色 N)
  },

  // 導航與路網尋路配置
  NAVIGATION: {
    SHOW_3D_GUIDE_LINE: true,             // 3D 世界地面導航引導線開關
    RECALC_DEVIATION_METERS: 20,          // 偏離路線超過 20 公尺自動重算
    ARRIVAL_DISTANCE_METERS: 5,           // 到達目的地判定半徑 (m)
    WALK_SPEED_MPS: 1.4,                  // 步行估計速度 (m/s)
    DRIVE_SPEED_MPS: 11.0,                // 車行估計速度 (m/s)
    GUIDE_LINE_COLOR: 0x38bdf8,           // 3D 引導線顏色
    GUIDE_LINE_HEIGHT: 0.15               // 離地高度 (避免破面)
  },

  // 全螢幕地圖配置 (Tab 鍵)
  FULLSCREEN_MAP: {
    DEFAULT_SCALE: 0.7,                   // 初始縮放 (px/m)
    MIN_SCALE: 0.2,
    MAX_SCALE: 3.5,
    ATTRIBUTION: '© OpenStreetMap contributors'
  },

  // Mapillary 真實街景對照視窗配置（官方 Graph API & MapillaryJS）
  MAPILLARY: {
    API_URL: 'https://graph.mapillary.com/images',
    INITIAL_SEARCH_RADIUS: 30,         // 初始查詢半徑 30 公尺
    EXTENDED_SEARCH_RADIUS: 100,       // 找不到時放寬至 100 公尺
    THROTTLE_INTERVAL_MS: 1000,        // 玩家移動節流更新 (每 1 秒最多一次)
    MIN_DISTANCE_FOR_NEW_IMAGE: 6,     // 玩家位移達 6 公尺才嘗試切換更近的影像
    DEFAULT_WIDTH: 400,                // 預設小視窗寬度 (px)
    DEFAULT_HEIGHT: 260                // 預設小視窗高度 (px)
  },

  // 行人系統配置 (RULES.md 規範集中化)
  PEDESTRIAN: {
    ENABLED: true,
    MAX_COUNT: 150,                     // 行人上限預設 150 人
    SPAWN_MIN_RADIUS: 8.0,              // 生成最小半徑 (m，街道兩側開始有人)
    SPAWN_MAX_RADIUS: 100.0,            // 生成最大半徑 (m)
    DESPAWN_RADIUS: 135.0,              // 回收半徑 (m)
    MIN_SPEED_MPS: 1.1,                 // 最低行走速度 (m/s)
    MAX_SPEED_MPS: 1.6,                 // 最高行走速度 (m/s)
    PANIC_SPEED_MPS: 3.5,               // 受驚狂奔速度 (m/s)
    SPATIAL_GRID_SIZE: 2.0,             // 空間雜湊網格尺寸 (m)
    AVOID_PLAYER_RADIUS: 2.2,           // 避讓玩家半徑 (m)
    AVOID_PEDESTRIAN_RADIUS: 0.8,       // 行人相互避讓半徑 (m)
    CROSSWALK_GREEN_SEC: 15,            // 斑馬線綠燈秒數
    CROSSWALK_RED_SEC: 20,              // 斑馬線紅燈秒數
    CROSSWALK_JAYWALK_CHANCE: 0.03,     // 3% 機率遊客斜穿馬路
    IDLE_CHANCE_AT_INTERSECTION: 0.12,  // 遇到路口停下機率
    ENTER_SHOP_CHANCE: 0.08,            // 經過騎樓/店家進入機率
    SHADOW_MAX_DISTANCE: 40.0,          // 陰影最大距離 (m)
    LOD_HIGH_DISTANCE: 65.0,            // 高精度 LOD 距離 (m)
    LOD_LOW_DISTANCE: 120.0,            // 低精度 LOD 距離 (m)
    SHOW_ON_MINIMAP: true,              // 小地圖顯示為淡色小點 (可在 config.ts 關閉)
    TIME_SLICED_UPDATES: 2,             // AI 更新分批數 (每幀更新 1/2)
    // 密度權重倍率
    DENSITY: {
      STATION_RADIUS: 150.0,
      STATION_FACTOR: 2.5,
      HOT_SPRING_FACTOR: 2.0,
      COMMERCIAL_FACTOR: 1.8,
      RESIDENTIAL_FACTOR: 1.0,
      RURAL_FACTOR: 0.25
    },
    // 外觀與隨機服飾調色盤
    COLORS: {
      SKINS: ['#f8d5b8', '#e8b894', '#f1c27d', '#e0ac69', '#d19864', '#b37748'],
      HAIRS: ['#1e1b18', '#2b2118', '#3d2e24', '#151515', '#4a3b32', '#6b4c35'],
      SHIRTS: [
        '#f8fafc', '#e2e8f0', '#94a3b8', '#38bdf8', '#0284c7',
        '#ef4444', '#f59e0b', '#10b981', '#6366f1', '#ec4899',
        '#fef08a', '#fdba74', '#c084fc', '#475569', '#334155'
      ],
      PANTS: [
        '#1e293b', '#334155', '#475569', '#1e3a5f', '#1e40af',
        '#374151', '#4b5563', '#d97706', '#52525b', '#262626'
      ],
      HOT_SPRING_SHIRTS: ['#fef3c7', '#fed7aa', '#fbcfe8', '#e0e7ff', '#ccfbf1']
    }
  },

  // 交通號誌系統配置 (RULES.md 規範集中化)
  TRAFFIC_SIGNALS: {
    ENABLED: true,
    UPDATE_RADIUS: 200.0,              // 僅更新玩家 200 公尺內路口的外觀，遠處僅計算邏輯
    INTERSECTION_CLUSTER_RADIUS: 30.0, // 30 公尺內多個號誌點與節點歸為同一路口
    INTERSECTION_MIN_DEGREE: 3,        // 路口辨識最低道路度數
    // 相位預設時間表 (秒)
    TIMING: {
      DEFAULT_GREEN_A: 25.0,           // 方向群組 A 綠燈 25 秒
      DEFAULT_YELLOW_A: 3.0,           // 方向群組 A 黃燈 3 秒
      ALL_RED_1: 2.0,                  // 全紅清空 2 秒
      DEFAULT_GREEN_B: 25.0,           // 方向群組 B 綠燈 25 秒
      DEFAULT_YELLOW_B: 3.0,           // 方向群組 B 黃燈 3 秒
      ALL_RED_2: 2.0,                  // 全紅清空 2 秒
      MAJOR_ROAD_BONUS: 5.0,           // 主要道路綠燈加時 (秒)
      PED_FLASH_DURATION: 5.0,         // 行人綠燈結束前最後 5 秒閃爍
      PED_CLEARANCE_SEC: 3.0           // 行人清空保障時間 (秒)
    },
    // 深夜離峰模式
    NIGHT_MODE: {
      ENABLED: false,                  // 深夜模式開關 (可由日夜系統控制)
      FLASH_INTERVAL_SEC: 0.8          // 閃黃/閃紅頻率 (秒)
    },
    // 外觀與幾何規格 (台灣懸臂式號誌桿風格)
    VISUAL: {
      POLE_COLOR: '#1e293b',           // 深灰藍底號誌桿
      HOUSING_COLOR: '#111827',        // 黑色霧面燈箱外殼
      VISOR_COLOR: '#030712',          // 遮光罩深黑
      POLE_HEIGHT: 7.2,                // 燈桿立柱高度 (m)
      POLE_RADIUS: 0.16,               // 燈桿直徑加粗 (m)
      ARM_LENGTH: 5.8,                 // 伸向車道上方橫臂長度 (m)
      ARM_HEIGHT: 6.0,                 // 橫臂離地高度 (m)
      SIGNAL_HEAD_WIDTH: 0.95,         // 車輛橫式三燈箱寬度 (m)
      SIGNAL_HEAD_HEIGHT: 0.38,        // 車輛燈箱高度 (m)
      SIGNAL_LENS_RADIUS: 0.14,        // 燈面圓盤半徑 (m) (單燈直徑 0.28m)
      PED_HEAD_HEIGHT: 2.8,            // 行人專用號誌離地高度 (m)
      PED_HEAD_SIZE: 0.40,             // 行人號誌箱寬度 (m) (約 0.4m)
      COUNTDOWN_HEIGHT: 2.8,           // 倒數計時器離地高度 (m)
      COUNTDOWN_SIZE: 0.40,            // 倒數計時箱尺寸 (m) (約 0.4m)
      EMISSIVE_INTENSITY: 3.5,         // 號誌亮燈自發光強度
      DIM_INTENSITY: 0.15,             // 滅燈時微弱環境反射
      COLORS: {
        RED: '#ff2222',
        YELLOW: '#ffbb00',
        GREEN: '#00ee66',
        PED_WALK: '#00ff77',
        PED_DONT_WALK: '#ff2222',
        OFF_RED: '#2a0a0a',
        OFF_YELLOW: '#2a220a',
        OFF_GREEN: '#0a2612'
      }
    },
    // 路面標線搭配 (停止線與機車待轉格)
    ROAD_MARKINGS: {
      STOP_LINE_WIDTH: 0.40,           // 停止線寬度 (m)
      STOP_LINE_OFFSET: 3.5,           // 距離路口中心的向外偏移 (m)
      WAITING_BOX_WIDTH: 2.6,          // 機車待轉格寬度 (m)
      WAITING_BOX_LENGTH: 2.4,         // 機車待轉格長度 (m)
      MARKING_COLOR: '#f4f7fa'
    },
    // 停止線與斑馬線規範 (單一資料來源)
    STOP_LINE_RULES: {
      CROSSWALK_DISTANCE: 1.8,         // 斑馬線外緣前 1.5~2.0m (設為 1.8m)
      NO_CROSSWALK_DISTANCE: 2.0,      // 無斑馬線時路口邊界前 2.0m
      SCOOTER_BOX_THRESHOLD: 4.0,      // 斑馬線與汽車停止線大於 4m 設置機慢車停等區
      SCOOTER_BOX_CAR_DISTANCE: 4.5,   // 有停等區時汽車停止線距斑馬線外緣 4.5m
      SCOOTER_BOX_SCOOTER_DISTANCE: 1.5// 有停等區時機車停止線距斑馬線外緣 1.5m
    },
    // 預留通緝系統違規判定
    RED_LIGHT_DETECTION: {
      CHECK_DISTANCE: 4.5,             // 停止線前後判定容許距離 (m)
      MIN_SPEED_MPS: 1.5               // 判定闖紅燈最低速度
    }
  },

  // NPC 交通車輛與駕駛系統配置 (RULES.md 規範集中化)
  TRAFFIC: {
    ENABLED: true,
    MAX_VEHICLES: 45,                  // 全域活躍車輛上限
    SPAWN_MIN_RADIUS: 25.0,            // 生成最小半徑 (m)
    SPAWN_MAX_RADIUS: 110.0,           // 生成最大半徑 (m)
    DESPAWN_RADIUS: 140.0,             // 回收半徑 (m)
    BASE_SPEED_MPS: 9.0,               // 基礎市區速限 (約 32 km/h)
    MAX_SPEED_MPS: 14.0,               // 主幹道最高速限 (約 50 km/h)
    SAFE_DISTANCE_BASE: 5.5,           // 基礎跟車安全距離 (m)
    STOP_DISTANCE_LIGHT: 4.5,          // 紅燈停止線預留距離 (m)
    TAXI_HAIL_RADIUS: 30.0,            // 計程車搜尋叫車行人半徑 (m)
    TAXI_RIDE_DURATION_SEC: 25.0,      // 計程車載客行駛時間 (s)
    HONK_BLOCKED_TIME_THRESHOLD: 3.0,  // 被前車擋住超過 3 秒考慮按喇叭
    LOGIC_UPDATE_RADIUS: 90.0,         // 僅更新玩家 90m 內的駕駛反應邏輯 (<=0.3ms 預算)
    LOD_NEAR_DISTANCE: 60.0,           // 0~60m 完整外觀與動作
    LOD_FAR_DISTANCE: 120.0,           // 60~120m 簡化色塊無動作，>120m 剔除
    LOD_NEAR_RADIUS: 60.0,
    LOD_FAR_RADIUS: 120.0,
    // 物理尺寸與煞車規劃 (RULES.md 規範)
    DIMENSIONS: {
      SEDAN_LENGTH: 4.4,               // 轎車車長 (m)
      SEDAN_HALF_LEN: 2.2,             // 轎車中心至車頭長 (m)
      SCOOTER_LENGTH: 1.7,             // 機車車長 (m)
      SCOOTER_HALF_LEN: 0.85           // 機車中心至車頭長 (m)
    },
    BRAKING: {
      COMFORTABLE_DECEL: 3.0,          // 舒適減速度 (m/s²)
      MAX_DECEL: 6.5,                  // 緊急減速度 (m/s²)
      BRAKE_BUFFER: 4.0,               // 煞車距離緩衝預留 (m)
      STOP_MARGIN_MIN: 0.5,            // 車頭距停止線最小間隙 (m)
      STOP_MARGIN_MAX: 1.0,            // 車頭距停止線最大間隙 (m)
      QUEUE_GAP_MIN: 1.5,              // 排隊前車車尾間距最小 (m)
      QUEUE_GAP_MAX: 2.5,              // 排隊前車車尾間距最大 (m)
      CLEARANCE_SPACE_REQUIRED: 6.5,   // 路口清空所需空間 (車長+2m)
      YELLOW_RUN_CHANCE_HURRIED: 0.15, // 趕時間型黃燈末尾搶行機率
      RED_RUN_FORBIDDEN_SEC: 1.0       // 紅燈亮起超過 1 秒絕對不得通過
    }
  },

  DRIVERS: {
    // 個性權重與參數 (集中管理)
    PERSONALITIES: {
      cautious: {
        id: 'cautious' as const,
        name: '謹慎型',
        tag: '謹',
        weight: 0.25,                  // 約 25%
        speedMult: 0.85,               // 速度 85%
        followDistMult: 1.4,           // 車距大
        reactionDelay: 0.45,           // 反應較慢
        runYellowChance: 0.0,          // 絕對不搶黃燈
        honkBaseChance: 0.10,          // 很少按喇叭
        stopForPedNear: true,          // 行人靠近就先停
        flashHighBeams: false
      },
      normal: {
        id: 'normal' as const,
        name: '一般型',
        tag: '普',
        weight: 0.40,                  // 約 40%
        speedMult: 1.0,                // 標準速度
        followDistMult: 1.0,           // 標準車距
        reactionDelay: 0.25,
        runYellowChance: 0.15,
        honkBaseChance: 0.35,
        stopForPedNear: false,
        flashHighBeams: false
      },
      hurried: {
        id: 'hurried' as const,
        name: '趕時間型',
        tag: '急',
        weight: 0.15,                  // 約 15%
        speedMult: 1.10,               // 速度 110%
        followDistMult: 0.70,          // 車距小緊貼
        reactionDelay: 0.15,           // 反應快
        runYellowChance: 0.40,         // 搶黃燈 40%
        honkBaseChance: 0.75,          // 頻繁按喇叭
        stopForPedNear: false,
        flashHighBeams: true           // 被擋時閃遠光燈
      },
      slow: {
        id: 'slow' as const,
        name: '慢吞吞型',
        tag: '慢',
        weight: 0.10,                  // 約 10%
        speedMult: 0.75,               // 速度 75%
        followDistMult: 1.25,
        reactionDelay: 0.55,           // 反應慢
        runYellowChance: 0.05,
        honkBaseChance: 0.15,
        stopForPedNear: true,
        flashHighBeams: false
      },
      taxi: {
        id: 'taxi' as const,
        name: '計程車司機',
        tag: '運',
        weight: 0.10,                  // 計程車專用
        speedMult: 1.05,               // 中高速度
        followDistMult: 0.90,
        reactionDelay: 0.20,
        runYellowChance: 0.25,
        honkBaseChance: 0.50,
        stopForPedNear: false,
        flashHighBeams: false
      }
    },
    // 心情門檻 (0~100)
    MOOD: {
      CALM_MAX: 33,
      ANNOYED_MAX: 66,
      ANNOYED_DECAY_RATE: 4.0,        // 正常行駛每秒恢復心情分
      WAIT_ANGER_RATE: 7.0            // 被擋住每秒增加煩躁分
    },
    // 車輛佔用機率
    OCCUPANCY: {
      SEDAN: [
        { count: 1, weight: 0.60 },    // 1人 60%
        { count: 2, weight: 0.25 },    // 2人 25%
        { count: 3, weight: 0.10 },    // 3人 10%
        { count: 4, weight: 0.05 }     // 4人 5%
      ],
      SCOOTER: [
        { count: 1, weight: 0.55 },    // 1人 55%
        { count: 2, weight: 0.45 }     // 2人 45% (含約 40%)
      ],
      TAXI_INITIAL_PASSENGER_CHANCE: 0.40 // 計程車初始載客機率 40%
    },
    // 安全帽、口罩、雨衣
    ACCESSORIES: {
      MASK_CHANCE: 0.35,              // 約 35% 戴口罩
      RAINCOAT_CLEAR_CHANCE: 0.10,    // 晴天穿雨衣機率 10%
      RAINCOAT_RAIN_CHANCE: 0.75,     // 雨天穿雨衣機率 75%
      RAINCOAT_COLORS: [
        '#fef08a', '#f43f5e', '#38bdf8', '#a855f7', '#34d399', '#fb923c' // 黃、粉、藍、紫、綠、橘
      ],
      HELMET_COLORS: [
        '#ffffff', '#1e293b', '#ef4444', '#3b82f6', '#f59e0b', '#ec4899', '#64748b'
      ]
    }
  },

  // 天氣與時間系統配置 (RULES.md 規範集中化)
  TIME: {
    DEFAULT_MODE: 'real' as 'real' | 'virtual',
    DEFAULT_VIRTUAL_HOUR: 17.5,        // 預設黃昏魔幻時刻 (17:30)
    DEFAULT_RATE: 1.0,                 // 預設時間流速 (1倍速)
    RATES: {
      PAUSED: 0,
      REALTIME: 1,
      FAST_10X: 10,
      FAST_60X: 60,
      DAY_24MIN: 60,                   // 遊戲內一天 = 24分鐘 (60倍速)
      DAY_60MIN: 24                    // 遊戲內一天 = 60分鐘 (24倍速)
    },
    // 太陽高度角門檻值 (度)
    SOLAR_THRESHOLDS: {
      NIGHT: -12.0,                    // 夜晚 (< -12°)
      DAWN_DUSK: -0.833,               // 暮光/黎明 (-12° ~ -0.833°)
      SUNRISE_SUNSET: 6.0,             // 日出/日落 (-0.833° ~ 6°)
      DAY: 6.0                         // 白天 (> 6°)
    }
  },

  WEATHER: {
    DEFAULT_MODE: 'real' as 'real' | 'virtual',
    DEFAULT_VIRTUAL_TYPE: 'clear' as 'clear' | 'cloudy' | 'overcast' | 'fog' | 'light_rain' | 'heavy_rain' | 'thunderstorm' | 'typhoon',
    CACHE_DB_NAME: 'GTA_Weather_Cache_v1',
    CACHE_STORE_NAME: 'forecast_cache',
    CACHE_TTL_MS: 10 * 60 * 1000,      // 10 分鐘本地快取有效期
    TRANSITION_DURATION_SEC: 28.0,     // 天氣狀態切換平滑漸變時間 (秒)
    ROAD_DRYING_DURATION_SEC: 80.0,    // 雨停後路面乾燥時間 (秒，符合 60~120 秒規範，晴天加速)
    OPEN_METEO_BASE: 'https://api.open-meteo.com/v1/forecast',
    // 畫質等級雨粒子上限
    PARTICLE_COUNTS: {
      low: 1200,                       // 低畫質 (< 1500)
      medium: 3200,                    // 中畫質
      high: 6500                       // 高畫質
    },
    SPLASH_COUNTS: {
      low: 0,                          // 低畫質無水花
      medium: 120,                     // 中畫質
      high: 280                        // 高畫質地面水花
    },
    // 閃電設定
    LIGHTNING: {
      MIN_INTERVAL_SEC: 9.0,
      MAX_INTERVAL_SEC: 22.0,
      FLASH_DURATION_SEC: 0.12,
      SURGE_LIGHT_INTENSITY: 4.8
    }
  },

  AUDIO: {
    MASTER_VOLUME: 0.8,
    WEATHER_VOLUME: 0.7,
    OCCLUSION_FILTER_FREQ: 550,        // 進入騎樓/室內時之低通濾波截止頻率 (Hz)
    OPEN_AIR_FILTER_FREQ: 20000        // 開放街道正常頻率 (Hz)
  },

  // GTA 風格城市夜景假光與氛圍系統配置 (RULES.md 規範集中化)
  NIGHT_LIGHTING: {
    ENABLED: true,
    DEFAULT_PRESET: 'ground_visible' as 'ground_visible' | 'gta_contrast' | 'soft' | 'dim',
    PRESETS: {
      ground_visible: {
        id: 'ground_visible',
        name: '地面可見（預設）',
        hemiIntensity: 0.22,     // 環境光 22% 白天，確保無路燈區域地板可見
        moonIntensity: 0.12,     // 虛擬/真實月光 12% 白天
        bounceIntensity: 0.06,   // 暖色反射補光 6% 白天
        exposure: 1.22,          // 曝光上限 1.22
        lightPollution: 0.50     // 天空光害
      },
      gta_contrast: {
        id: 'gta_contrast',
        name: 'GTA 對比',
        hemiIntensity: 0.20,     // 環境光 20% 白天
        moonIntensity: 0.10,     // 虛擬/真實月光 10% 白天
        bounceIntensity: 0.05,   // 暖色反射補光 5% 白天
        exposure: 1.20,          // 曝光上限 1.20
        lightPollution: 0.50     // 天空光害
      },
      soft: {
        id: 'soft',
        name: '柔和',
        hemiIntensity: 0.25,
        moonIntensity: 0.13,
        bounceIntensity: 0.06,
        exposure: 1.25,
        lightPollution: 0.70
      },
      dim: {
        id: 'dim',
        name: '昏暗',
        hemiIntensity: 0.16,
        moonIntensity: 0.08,
        bounceIntensity: 0.04,
        exposure: 1.15,
        lightPollution: 0.35
      }
    },
    BASE_NIGHT_BRIGHTNESS: 1.0,        // 夜晚亮度倍率 (僅調節月光與環境光強度，0.6 ~ 1.4，預設 1.0)
    GROUND_VISIBILITY: 1.0,            // 地面可見度倍率 (0.5 ~ 2.0，預設 1.0，驅動 Shader 地面補光)
    COLOR_GROUND_NIGHT_BOOST: '#3a4764', // 地面夜間冷藍灰補光項 (#3a4764，白天強度的 6~9%)
    STREETLIGHT_GROUND_DECAL_RADIUS: 7.2, // 路燈地面光斑半徑 (m) (6 ~ 9m)
    STREETLIGHT_GROUND_DECAL_INTENSITY: 1.0, // 光斑貼花強度 (0.0 ~ 2.0)
    STREETLIGHT_MAX_DISTANCE: 150.0,   // 路燈假光啟用範圍 (m)
    STREETLIGHT_FLICKER_CHANCE: 0.03,  // 3% 路燈接觸不良隨機閃爍
    WINDOW_LIGHT_RATIO: 0.50,          // 窗戶夜間亮燈基準比例 (0.0 ~ 1.0)
    URBAN_LIGHT_POLLUTION: 0.50,       // 天空穹頂城市光害強度 (0.0 ~ 2.0)
    COLOR_WARM_ORANGE: '#ff9e3b',      // 3000K 暖橘路燈色
    COLOR_WARM_WHITE: '#fff0d0',       // 4500K 暖白路燈色
    HEMI_SKY_COLOR: '#2a3d70',         // 環境光天空冷藍 (#2a3d70)
    HEMI_GROUND_COLOR: '#6b3f22',      // 環境光地面暖橘棕 (#6b3f22，街道鈉燈反彈)
    COLOR_MOON_BLUE: '#6f8cff',        // 虛擬月光冷藍 (#6f8cff)
    COLOR_BOUNCE_ORANGE: '#ff8844',    // 街道向上反射暖橘補光 (#ff8844)
    COLOR_NIGHT_FOG: '#141c33',        // 夜間近景暗藍霧色 (#141c33)
    COLOR_TARGET_MIN_SHADOW: '#0c1220',// 最暗處目標值 (#0c1220)
    EXPOSURE_BOOST_NIGHT: 1.25,        // 夜間眼睛適應曝光拉高上限 (1.25 倍)
    EXPOSURE_LERP_SPEED: 0.10,         // 曝光緩慢過渡 (約 10 秒)
    WET_REFLECTION_INTENSITY: 0.65,    // 雨夜長條倒影強度
    LIGHT_CONE_BOTTOM_RADIUS: 2.0,     // 光錐底部半徑 (寬度約 4.0m)
    LIGHT_CONE_OPACITY: 0.07           // 光錐低透明度
  },

  // NPC 行人與車輛行為規範配置 (RULES.md 集中化管理)
  NPC_BEHAVIOR: {
    // 違規全域開關與機率
    violationsEnabled: true,
    VIOLATIONS: {
      pedestrian: {
        totalRate: 0.06,           // 合計約占過街行人的 6%
        jaywalkRedLight: 0.03,      // 紅燈或閃爍時搶過斑馬線 (約 3%)
        crossNoZebra: 0.02,         // 無斑馬線處直接穿越馬路 (約 2%)
        walkOnRoadEdge: 0.01        // 貼著車流行走 (約 1%)
      },
      vehicle: {
        totalRate: 0.05,           // 合計約占車輛的 5%
        earlyRedRun: 0.02,          // 趕時間型紅燈初期 1.5s 內搶過 (約 2%)
        speeding: 0.02,             // 超速 15~30% (約 2%)
        pressCrosswalk: 0.01,       // 停等時壓到斑馬線 (約 1%)
        scooterSidewalkShortcut: 0.01 // 機車騎上人行道短暫繞行 (約 1%)
      }
    },
    // 車輛不可反方向規範
    VEHICLE: {
      RIGHT_HAND_TRAFFIC: true,     // 台灣靠右行駛
      NO_REVERSE_ALLOWED: true,     // NPC 車輛禁止倒車
      WRONG_WAY_MAX_SEC: 0.5,       // dot(車頭, 速度) < 0 超過 0.5s 判定逆向重新生成
      BLOCKED_TIMEOUT_SEC: 12.0     // 被完全堵塞超過 12 秒原地重新生成
    },
    // 行人聚集與個人空間
    PEDESTRIAN: {
      MIN_SPAWN_SPACING: 6.0,       // 同一人行道不相關行人生成點至少相距 6m
      GRID_DENSITY_LIMIT_NORMAL: 4, // 10x10m 格子上限 4 人
      GRID_DENSITY_LIMIT_HOTSPOT: 8,// 熱點 (火車站、溫泉廣場) 上限 8 人
      SEPARATION_RADIUS: 0.7,       // 個人空間半徑 0.7m
      SEPARATION_FORCE: 8.0,        // 分離力道 (保證身體不重疊)
      SPEED_VARIATION: 0.20,        // 速度 ±20% 隨機差異
      START_DELAY_MAX: 3.0,         // 0~3 秒隨機起步延遲
      // 結伴同行組
      COMPANION_GROUP_CHANCE: 0.08, // 結伴同行組比例約 8%
      COMPANION_SPACING_MIN: 0.8,   // 組內間距 0.8m
      COMPANION_SPACING_MAX: 1.2,   // 組內間距 1.2m
      // 等紅燈路緣站位
      CURB_WAITING_SLOT_SPACING: 0.8, // 路緣站位相距約 0.8m
      MAX_WAITING_SLOTS: 6,         // 最多 6 個站位
      // 聚集統計門檻
      CROWD_DISTANCE_THRESHOLD: 1.2,// 1.2 公尺內有 2 位以上非同伴
      CROWD_RATE_TARGET_PERCENT: 3.0// 目標低於 3%
    },
    // 行人只走斑馬線過街
    CROSSWALK: {
      MAX_LATERAL_OFFSET: 0.8,      // 沿斑馬線中心線橫向偏移不超過 0.8m
      MAX_DRIFT_PULLBACK: 1.0,      // 偏離超過 1.0m 自動拉回
      LONG_ROAD_THRESHOLD: 150.0    // 長路段 (>150m) 導航至最近斑馬線
    },
    // 行人不倒退走
    NO_WALK_BACKWARDS: {
      MAX_TURN_RATE_DEG_PER_SEC: 360, // 平滑轉向最大速度 360 度/秒
      TURN_AROUND_TIME_MIN: 0.3,      // 原地轉身時間 0.3~0.6s
      TURN_AROUND_TIME_MAX: 0.6,
      REVERSE_ANGLE_THRESHOLD_DEG: 70, // 夾角超過 70 度速度降為 0 先原地轉身
      WRONG_FACING_TIMEOUT_SEC: 0.3   // dot(面向, 速度) < 0 超過 0.3 秒強制修正轉向
    },
    // 效能自動降級
    PERFORMANCE: {
      FPS_DOWNGRADE_THRESHOLD: 30,    // 連續 3 秒 FPS < 30 觸發降級
      DOWNGRADE_CHECK_SECONDS: 3.0
    }
  }
};
