import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const presetsDir = path.resolve(__dirname, '../public/presets');

if (!fs.existsSync(presetsDir)) {
  fs.mkdirSync(presetsDir, { recursive: true });
}

const PRESETS = [
  { id: 'jiaoxi', name: '宜蘭礁溪鄉', lat: 24.8278, lon: 121.7725 },
  { id: 'jiaoxi_approx', name: '礁溪鄉（廣域）', lat: 24.667, lon: 121.772 },
  { id: 'yilan', name: '宜蘭市區', lat: 24.7554, lon: 121.7538 },
  { id: 'taipei101', name: '台北 101 周邊', lat: 25.0339, lon: 121.5644 },
  { id: 'pier2', name: '高雄駁二特區', lat: 22.6198, lon: 120.2818 }
];

const EARTH_RADIUS = 6378137.0;

async function fetchPreset(preset) {
  const filePath = path.join(presetsDir, `${preset.id}.json`);
  if (fs.existsSync(filePath)) {
    console.log(`[Cache exists] ${preset.id}`);
    return;
  }

  const radius = 500;
  const dLat = (radius / EARTH_RADIUS) * (180.0 / Math.PI);
  const dLon = (radius / (EARTH_RADIUS * Math.cos(preset.lat * Math.PI / 180.0))) * (180.0 / Math.PI);

  const s = preset.lat - dLat;
  const w = preset.lon - dLon;
  const n = preset.lat + dLat;
  const e = preset.lon + dLon;

  const query = `
    [out:json][timeout:30];
    (
      way["highway"](${s},${w},${n},${e});
      way["building"](${s},${w},${n},${e});
      way["natural"="water"](${s},${w},${n},${e});
      way["waterway"](${s},${w},${n},${e});
      way["water"](${s},${w},${n},${e});
      way["leisure"="park"](${s},${w},${n},${e});
      way["landuse"~"grass|forest|meadow|village_green"](${s},${w},${n},${e});
    );
    out geom;
  `;

  console.log(`Fetching ${preset.name} (${preset.id})...`);
  const endpoint = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    fs.writeFileSync(filePath, JSON.stringify(json));
    console.log(`Saved ${preset.id}.json with ${json.elements?.length} elements!`);
  } catch (err) {
    console.warn(`Failed to fetch ${preset.id}: ${err.message}`);
  }
}

async function main() {
  for (const p of PRESETS) {
    await fetchPreset(p);
  }
  console.log('Finished prefetching presets.');
}

main();
