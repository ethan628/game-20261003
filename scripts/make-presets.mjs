import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const presetsDir = path.resolve(__dirname, '../public/presets');

// 1. jiaoxi_approx.json (複製自真實礁溪資料)
const jiaoxiPath = path.join(presetsDir, 'jiaoxi.json');
const jiaoxiData = JSON.parse(fs.readFileSync(jiaoxiPath, 'utf-8'));
fs.writeFileSync(path.join(presetsDir, 'jiaoxi_approx.json'), JSON.stringify(jiaoxiData));
console.log('Saved jiaoxi_approx.json');

// 2. 台北 101 信義商圈 (taipei101.json)
// 中心：25.0339, 121.5644
const t101Lat = 25.0339;
const t101Lon = 121.5644;
const degPerMeter = 1 / 111320;
const degLonPerMeter = 1 / (111320 * Math.cos(t101Lat * Math.PI / 180));

const elements101 = [];
let idCounter = 100000;

// 台北 101 主樓 (508m, 101層)
const r101 = 45; // 半徑公尺
const poly101 = [
  { lat: t101Lat - r101 * degPerMeter, lon: t101Lon - r101 * degLonPerMeter },
  { lat: t101Lat - r101 * degPerMeter, lon: t101Lon + r101 * degLonPerMeter },
  { lat: t101Lat + r101 * degPerMeter, lon: t101Lon + r101 * degLonPerMeter },
  { lat: t101Lat + r101 * degPerMeter, lon: t101Lon - r101 * degLonPerMeter },
  { lat: t101Lat - r101 * degPerMeter, lon: t101Lon - r101 * degLonPerMeter }
];
elements101.push({
  type: 'way',
  id: idCounter++,
  geometry: poly101,
  tags: {
    building: 'commercial',
    name: '台北 101 (Taipei 101)',
    height: '508',
    'building:levels': '101'
  }
});

// 信義計畫區大道 (信義路五段、市府路、松智路、松高路)
const roads101 = [
  {
    name: '信義路五段',
    type: 'primary',
    pts: [
      { lat: t101Lat - 80 * degPerMeter, lon: t101Lon - 400 * degLonPerMeter },
      { lat: t101Lat - 80 * degPerMeter, lon: t101Lon + 400 * degLonPerMeter }
    ]
  },
  {
    name: '松智路',
    type: 'primary',
    pts: [
      { lat: t101Lat - 350 * degPerMeter, lon: t101Lon + 90 * degLonPerMeter },
      { lat: t101Lat + 350 * degPerMeter, lon: t101Lon + 90 * degLonPerMeter }
    ]
  },
  {
    name: '市府路',
    type: 'primary',
    pts: [
      { lat: t101Lat - 350 * degPerMeter, lon: t101Lon - 90 * degLonPerMeter },
      { lat: t101Lat + 350 * degPerMeter, lon: t101Lon - 90 * degLonPerMeter }
    ]
  },
  {
    name: '松壽路',
    type: 'secondary',
    pts: [
      { lat: t101Lat + 180 * degPerMeter, lon: t101Lon - 400 * degLonPerMeter },
      { lat: t101Lat + 180 * degPerMeter, lon: t101Lon + 400 * degLonPerMeter }
    ]
  }
];

roads101.forEach(r => {
  elements101.push({
    type: 'way',
    id: idCounter++,
    geometry: r.pts,
    tags: { highway: r.type, name: r.name }
  });
});

// 周邊百貨與辦公大樓 (微風南山、新光三越、世貿一館、台北市政府)
const bldgs101 = [
  { name: '微風南山 (Breeze Nanshan)', lat: t101Lat + 100 * degPerMeter, lon: t101Lon + 180 * degLonPerMeter, w: 70, h: 272 },
  { name: '台北世貿一館', lat: t101Lat - 10 * degPerMeter, lon: t101Lon - 200 * degLonPerMeter, w: 90, h: 45 },
  { name: '新光三越 A9', lat: t101Lat + 240 * degPerMeter, lon: t101Lon + 120 * degLonPerMeter, w: 60, h: 55 },
  { name: '新光三越 A11', lat: t101Lat + 240 * degPerMeter, lon: t101Lon - 20 * degLonPerMeter, w: 65, h: 58 },
  { name: '台北市政府大樓', lat: t101Lat + 330 * degPerMeter, lon: t101Lon - 100 * degLonPerMeter, w: 85, h: 65 },
  { name: '君悅酒店', lat: t101Lat + 80 * degPerMeter, lon: t101Lon - 200 * degLonPerMeter, w: 75, h: 88 },
  { name: '遠百信義 A13', lat: t101Lat + 320 * degPerMeter, lon: t101Lon + 130 * degLonPerMeter, w: 60, h: 62 },
  { name: '南山廣場大樓', lat: t101Lat + 90 * degPerMeter, lon: t101Lon + 260 * degLonPerMeter, w: 55, h: 120 }
];

bldgs101.forEach(b => {
  const hw = b.w * 0.5;
  elements101.push({
    type: 'way',
    id: idCounter++,
    geometry: [
      { lat: b.lat - hw * degPerMeter, lon: b.lon - hw * degLonPerMeter },
      { lat: b.lat - hw * degPerMeter, lon: b.lon + hw * degLonPerMeter },
      { lat: b.lat + hw * degPerMeter, lon: b.lon + hw * degLonPerMeter },
      { lat: b.lat + hw * degPerMeter, lon: b.lon - hw * degLonPerMeter },
      { lat: b.lat - hw * degPerMeter, lon: b.lon - hw * degLonPerMeter }
    ],
    tags: {
      building: 'commercial',
      name: b.name,
      height: b.h.toString()
    }
  });
});

// 市民廣場綠地公園
elements101.push({
  type: 'way',
  id: idCounter++,
  geometry: [
    { lat: t101Lat + 180 * degPerMeter, lon: t101Lon - 180 * degLonPerMeter },
    { lat: t101Lat + 180 * degPerMeter, lon: t101Lon - 20 * degLonPerMeter },
    { lat: t101Lat + 280 * degPerMeter, lon: t101Lon - 20 * degLonPerMeter },
    { lat: t101Lat + 280 * degPerMeter, lon: t101Lon - 180 * degLonPerMeter },
    { lat: t101Lat + 180 * degPerMeter, lon: t101Lon - 180 * degLonPerMeter }
  ],
  tags: {
    leisure: 'park',
    name: '信義市民廣場'
  }
});

fs.writeFileSync(path.join(presetsDir, 'taipei101.json'), JSON.stringify({ elements: elements101 }));
console.log('Saved taipei101.json with', elements101.length, 'elements');

// 3. 宜蘭市區 (yilan.json)
const yilanLat = 24.7554;
const yilanLon = 121.7538;
const elementsYilan = [];
// 宜蘭火車站、幾米廣場、舊城街道
const roadsYilan = [
  { name: '宜興路一段', type: 'primary', pts: [{ lat: yilanLat - 300 * degPerMeter, lon: yilanLon }, { lat: yilanLat + 300 * degPerMeter, lon: yilanLon }] },
  { name: '光復路', type: 'secondary', pts: [{ lat: yilanLat, lon: yilanLon - 300 * degLonPerMeter }, { lat: yilanLat, lon: yilanLon + 300 * degLonPerMeter }] },
  { name: '民權路一段', type: 'secondary', pts: [{ lat: yilanLat + 120 * degPerMeter, lon: yilanLon - 250 * degLonPerMeter }, { lat: yilanLat + 120 * degPerMeter, lon: yilanLon + 250 * degLonPerMeter }] },
  { name: '舊城南路', type: 'secondary', pts: [{ lat: yilanLat - 120 * degPerMeter, lon: yilanLon - 250 * degLonPerMeter }, { lat: yilanLat - 120 * degPerMeter, lon: yilanLon + 250 * degLonPerMeter }] }
];
roadsYilan.forEach(r => {
  elementsYilan.push({ type: 'way', id: idCounter++, geometry: r.pts, tags: { highway: r.type, name: r.name } });
});

// 幾米公園綠地
elementsYilan.push({
  type: 'way',
  id: idCounter++,
  geometry: [
    { lat: yilanLat - 80 * degPerMeter, lon: yilanLon + 30 * degLonPerMeter },
    { lat: yilanLat - 80 * degPerMeter, lon: yilanLon + 120 * degLonPerMeter },
    { lat: yilanLat + 40 * degPerMeter, lon: yilanLon + 120 * degLonPerMeter },
    { lat: yilanLat + 40 * degPerMeter, lon: yilanLon + 30 * degLonPerMeter },
    { lat: yilanLat - 80 * degPerMeter, lon: yilanLon + 30 * degLonPerMeter }
  ],
  tags: { leisure: 'park', name: '幾米廣場公園' }
});

// 宜蘭火車站與街廓建物
for (let bx = -2; bx <= 2; bx++) {
  for (let bz = -2; bz <= 2; bz++) {
    if (bx === 0 && bz === 0) continue;
    const clat = yilanLat + bz * 70 * degPerMeter;
    const clon = yilanLon + bx * 70 * degLonPerMeter;
    elementsYilan.push({
      type: 'way',
      id: idCounter++,
      geometry: [
        { lat: clat - 20 * degPerMeter, lon: clon - 20 * degLonPerMeter },
        { lat: clat - 20 * degPerMeter, lon: clon + 20 * degLonPerMeter },
        { lat: clat + 20 * degPerMeter, lon: clon + 20 * degLonPerMeter },
        { lat: clat + 20 * degPerMeter, lon: clon - 20 * degLonPerMeter },
        { lat: clat - 20 * degPerMeter, lon: clon - 20 * degLonPerMeter }
      ],
      tags: { building: 'residential', height: (12 + (Math.abs(bx + bz) * 5)).toString() }
    });
  }
}
fs.writeFileSync(path.join(presetsDir, 'yilan.json'), JSON.stringify({ elements: elementsYilan }));
console.log('Saved yilan.json with', elementsYilan.length, 'elements');

// 4. 高雄駁二特區 (pier2.json)
const p2Lat = 22.6198;
const p2Lon = 120.2818;
const elementsP2 = [];

// 駁二大勇倉庫群、大義倉庫群
for (let i = 0; i < 6; i++) {
  const wLat = p2Lat + (i * 35 - 90) * degPerMeter;
  elementsP2.push({
    type: 'way',
    id: idCounter++,
    geometry: [
      { lat: wLat - 12 * degPerMeter, lon: p2Lon - 40 * degLonPerMeter },
      { lat: wLat - 12 * degPerMeter, lon: p2Lon + 40 * degLonPerMeter },
      { lat: wLat + 12 * degPerMeter, lon: p2Lon + 40 * degLonPerMeter },
      { lat: wLat + 12 * degPerMeter, lon: p2Lon - 40 * degLonPerMeter },
      { lat: wLat - 12 * degPerMeter, lon: p2Lon - 40 * degLonPerMeter }
    ],
    tags: { building: 'warehouse', name: `駁二倉庫 C${i + 1}`, height: '11' }
  });
}

// 高雄港水域
elementsP2.push({
  type: 'way',
  id: idCounter++,
  geometry: [
    { lat: p2Lat - 250 * degPerMeter, lon: p2Lon - 250 * degLonPerMeter },
    { lat: p2Lat - 250 * degPerMeter, lon: p2Lon + 250 * degLonPerMeter },
    { lat: p2Lat - 90 * degPerMeter, lon: p2Lon + 250 * degLonPerMeter },
    { lat: p2Lat - 90 * degPerMeter, lon: p2Lon - 250 * degLonPerMeter },
    { lat: p2Lat - 250 * degPerMeter, lon: p2Lon - 250 * degLonPerMeter }
  ],
  tags: { natural: 'water', name: '高雄港灣' }
});

// 臨港道路與輕軌
elementsP2.push({
  type: 'way',
  id: idCounter++,
  geometry: [
    { lat: p2Lat + 120 * degPerMeter, lon: p2Lon - 300 * degLonPerMeter },
    { lat: p2Lat + 120 * degPerMeter, lon: p2Lon + 300 * degLonPerMeter }
  ],
  tags: { highway: 'primary', name: '五福四路' }
});
elementsP2.push({
  type: 'way',
  id: idCounter++,
  geometry: [
    { lat: p2Lat - 40 * degPerMeter, lon: p2Lon - 300 * degLonPerMeter },
    { lat: p2Lat - 40 * degPerMeter, lon: p2Lon + 300 * degLonPerMeter }
  ],
  tags: { highway: 'pedestrian', name: '駁二鐵道文化園區步道' }
});

fs.writeFileSync(path.join(presetsDir, 'pier2.json'), JSON.stringify({ elements: elementsP2 }));
console.log('Saved pier2.json with', elementsP2.length, 'elements');
