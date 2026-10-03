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

export const PRESET_LOCATIONS: PresetLocation[] = [
  {
    id: 'jiaoxi',
    name: '宜蘭礁溪溫泉市區（礁溪火車站）',
    desc: '真實核心街區 (24.828, 121.772) 湯圍溝溫泉公園、飯店群與溫泉街',
    lat: 24.828,
    lon: 121.772,
    presetFile: '/presets/jiaoxi.json'
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
    presetFile: '/presets/yilan.json'
  },
  {
    id: 'taipei101',
    name: '台北 101 周邊（信義商圈）',
    desc: '台北信義計畫區、摩天高樓群與寬廣大道 (25.034, 121.564)',
    lat: 25.0339,
    lon: 121.5644,
    presetFile: '/presets/taipei101.json'
  },
  {
    id: 'pier2',
    name: '高雄駁二特區',
    desc: '高雄港灣、倉庫聚落、水岸與輕軌景觀 (22.620, 120.282)',
    lat: 22.6198,
    lon: 120.2818,
    presetFile: '/presets/pier2.json'
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
    CACHE_VERSION: 'v4_building_fix',
    CACHE_DB_NAME: 'GTA_OSM_Cache_v4',
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

  // 世界視覺風格 (漸層天空、光影、地平線霧氣)
  WORLD: {
    GROUND_SIZE: 2200,         // 地面平面邊長 (m)
    GROUND_COLOR: 0xe5dec9,    // 偏暖的米色/淺草大地基底
    SKY_GRADIENT: {
      TOP: '#1e3c72',          // 天頂深藍
      MIDDLE: '#2a5298',       // 中層藍
      HORIZON: '#d8e5f5'       // 地平線淡藍暖白
    },
    FOG_COLOR: 0xd8e5f5,       // 霧氣顏色與天空地平線 100% 一致
    FOG_NEAR: 140,             // 霧氣起始距離 (m)
    FOG_FAR: 560,              // 霧氣完全淡出距離 (m)
    SUN_COLOR: 0xfffbee,       // 溫和暖陽金白
    SUN_INTENSITY: 2.6,        // 陽光強度
    HEMI_SKY_COLOR: 0xa4c8f0,  // 半球光天空天藍
    HEMI_GROUND_COLOR: 0xded2be,// 半球光地面暖土色
    HEMI_INTENSITY: 1.15,      // 環境光強度
    SHADOW_MAP_SIZE: 2048,     // 陰影貼圖解析度
    SHADOW_CAMERA_RADIUS: 140  // 陰影跟隨玩家覆蓋半徑 (m)
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
    ROAD_COLOR: 0x323842,      // 柏油路：深灰帶一點藍，絕非純黑
    SIDEWALK_COLOR: 0xd8d2c6,  // 人行道：偏暖的淺灰
    CURB_COLOR: 0xb5ad9e,      // 路緣石立體面顏色
    MARKING_WHITE: 0xf4f7fa,   // 車道白色虛線與斑馬線
    MARKING_YELLOW: 0xf5b041,  // 雙黃實線
    ELEVATION: {
      ROAD: 0.02,              // 柏油路高程 (m)
      MARKING: 0.028,          // 標線略高於路面
      SIDEWALK: 0.17           // 人行道比路面高約 0.15 公尺 (0.17 - 0.02)
    }
  },

  // 建築細節、配色與樓層窗戶
  BUILDINGS: {
    LEVEL_HEIGHT: 3.5,         // 每層預設 3.5 公尺
    DEFAULT_HEIGHT_MIN: 7.0,   // 無資料時隨機高度下限
    DEFAULT_HEIGHT_MAX: 20.0,  // 無資料時隨機高度上限
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
    WATER_COLOR: 0x4aa8db,     // 帶透明感的清澈青藍色
    WATER_ROUGHNESS: 0.15,
    WATER_OPACITY: 0.88,
    WATER_ELEVATION: 0.018,
    GREEN_COLOR: 0x66a85e,     // 柔和草綠
    FOREST_COLOR: 0x4a8c44,    // 深林翠綠
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

  // 渲染與後處理開關
  RENDER: {
    TONE_MAPPING_EXPOSURE: 1.15,
    SHADOWS_ENABLED: true,
    POST_PROCESSING_ENABLED: false // 預留後處理一鍵開關
  },

  // 即時實境地圖與衛星航照圖對照視窗配置 (100% 免金鑰、免註冊，開箱即用)
  MAP_REFERENCE: {
    DEFAULT_WIDTH: 400,                  // 預設小視窗寬度 (px)
    DEFAULT_HEIGHT: 260,                 // 預設小視窗高度 (px)
    DEFAULT_ZOOM: 17,                    // 預設縮放層級 (17 級適合市區與街廓細節)
    THROTTLE_INTERVAL_MS: 100,           // 地圖同步更新頻率 (毫秒)
    LAYERS: {
      OSM: {
        NAME: '🗺️ 街道',
        URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        ATTRIBUTION: '&copy; OpenStreetMap contributors'
      },
      SATELLITE: {
        NAME: '🛰️ 衛星',
        URL: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ATTRIBUTION: 'Tiles &copy; Esri'
      }
    }
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
  }
};
