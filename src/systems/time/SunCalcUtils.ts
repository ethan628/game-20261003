/**
 * SunCalcUtils.ts - 天文日月位置、天體座標、月相與暮光判定
 * 遵循 RULES.md：純演算法與數學計算，無外部重型依賴
 * 座標轉換：東向 +X，北向 -Z，天頂 +Y
 */

import { CONFIG } from '../../config.ts';
import { CelestialCoordinates, SunMoonInfo, TwilightPhase } from '../../geo/WeatherTypes.ts';

const DEG2RAD = Math.PI / 180.0;
const RAD2DEG = 180.0 / Math.PI;

function normalizeDeg(deg: number): number {
  let val = deg % 360;
  if (val < 0) val += 360;
  return val;
}

function normalizeRad(rad: number): number {
  let val = rad % (Math.PI * 2);
  if (val < 0) val += Math.PI * 2;
  return val;
}

/**
 * 計算太陽位置 (精確天體演算法 Jean Meeus / NOAA)
 */
export function calculateSunPosition(
  latDeg: number,
  lonDeg: number,
  timestampMs: number
): { coords: CelestialCoordinates; hourAngleDeg: number } {
  // 儒略日 Julian Day (JD) 與 J2000 起算天數 d
  const jd = timestampMs / 86400000.0 + 2440587.5;
  const d = jd - 2451545.0;

  // 太陽平近點角 M
  const M = normalizeDeg(357.5291 + 0.98560028 * d) * DEG2RAD;

  // 中心差 C
  const C =
    (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * DEG2RAD;

  // 太陽黃經 lambda
  const lambda = normalizeRad(M + C + 180 * DEG2RAD + 102.9372 * DEG2RAD);

  // 黃赤交角 epsilon
  const epsilon = (23.4397 - 0.00000036 * d) * DEG2RAD;

  // 赤緯 delta
  const sinDelta = Math.sin(epsilon) * Math.sin(lambda);
  const delta = Math.asin(sinDelta);

  // 赤經 alpha
  const alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));

  // 格林威治平恆星時 GMST
  const gmst = normalizeDeg(280.16 + 360.9856235 * d) * DEG2RAD;

  // 地方恆星時 LST
  const lst = normalizeRad(gmst + lonDeg * DEG2RAD);

  // 時角 H (normalize to -PI ~ +PI)
  let H = lst - alpha;
  while (H < -Math.PI) H += Math.PI * 2;
  while (H > Math.PI) H -= Math.PI * 2;

  const latRad = latDeg * DEG2RAD;

  // 高度角 (Altitude / Elevation)
  const sinAlt =
    Math.sin(latRad) * Math.sin(delta) + Math.cos(latRad) * Math.cos(delta) * Math.cos(H);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const altDeg = altRad * RAD2DEG;

  // 方位角 (Azimuth, 北為0度, 東為90度, 南為180度, 西為270度)
  // atan2(sin(H), cos(H)*sin(lat) - tan(delta)*cos(lat))
  const yAz = -Math.cos(delta) * Math.sin(H);
  const xAz = Math.sin(delta) * Math.cos(latRad) - Math.cos(delta) * Math.sin(latRad) * Math.cos(H);
  let azRad = Math.atan2(yAz, xAz);
  if (azRad < 0) azRad += Math.PI * 2;
  const azDeg = azRad * RAD2DEG;

  // 投影到 Three.js 世界座標向量：+X 為東, -Z 為北, +Y 為天頂
  // 太陽方向向量 (指向天空中的太陽)
  const cosAlt = Math.cos(altRad);
  const dirX = cosAlt * Math.sin(azRad);
  const dirY = Math.sin(altRad);
  const dirZ = -cosAlt * Math.cos(azRad);

  return {
    coords: {
      altitudeRad: altRad,
      altitudeDeg: altDeg,
      azimuthRad: azRad,
      azimuthDeg: azDeg,
      directionVector: [dirX, dirY, dirZ]
    },
    hourAngleDeg: H * RAD2DEG
  };
}

/**
 * 計算月球位置與月相
 */
export function calculateMoonPosition(
  latDeg: number,
  lonDeg: number,
  timestampMs: number
): { coords: CelestialCoordinates; phase: number; illumination: number } {
  const jd = timestampMs / 86400000.0 + 2440587.5;
  const d = jd - 2451545.0;
  const T = d / 36525.0; // 儒略世紀數

  // 月球平黃經 L'
  const Lp = normalizeDeg(218.316 + 481267.8813 * T) * DEG2RAD;
  // 月球平近點角 M'
  const Mp = normalizeDeg(134.963 + 477198.8676 * T) * DEG2RAD;
  // 太陽平近點角 M
  const M = normalizeDeg(357.529 + 35999.0503 * T) * DEG2RAD;
  // 月球平距角 D
  const D = normalizeDeg(297.85 + 445267.1115 * T) * DEG2RAD;
  // 緯度引數 F
  const F = normalizeDeg(93.272 + 483202.0175 * T) * DEG2RAD;

  // 簡化攝動修正
  const l =
    Lp +
    6.289 * DEG2RAD * Math.sin(Mp) -
    1.274 * DEG2RAD * Math.sin(Mp - 2 * D) +
    0.658 * DEG2RAD * Math.sin(2 * D) -
    0.186 * DEG2RAD * Math.sin(M);

  const b =
    5.128 * DEG2RAD * Math.sin(F) +
    0.281 * DEG2RAD * Math.sin(Mp + F) -
    0.278 * DEG2RAD * Math.sin(Mp - F);

  // 黃道轉赤道
  const epsilon = 23.4397 * DEG2RAD;
  const sinDelta =
    Math.sin(b) * Math.cos(epsilon) + Math.cos(b) * Math.sin(epsilon) * Math.sin(l);
  const delta = Math.asin(Math.max(-1, Math.min(1, sinDelta)));

  const yAlpha =
    Math.sin(l) * Math.cos(epsilon) - Math.tan(b) * Math.sin(epsilon);
  const xAlpha = Math.cos(l);
  const alpha = Math.atan2(yAlpha, xAlpha);

  // 地方恆星時
  const gmst = normalizeDeg(280.16 + 360.9856235 * d) * DEG2RAD;
  const lst = normalizeRad(gmst + lonDeg * DEG2RAD);

  let H = lst - alpha;
  while (H < -Math.PI) H += Math.PI * 2;
  while (H > Math.PI) H -= Math.PI * 2;

  const latRad = latDeg * DEG2RAD;
  const sinAlt =
    Math.sin(latRad) * Math.sin(delta) + Math.cos(latRad) * Math.cos(delta) * Math.cos(H);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const altDeg = altRad * RAD2DEG;

  const yAz = -Math.cos(delta) * Math.sin(H);
  const xAz = Math.sin(delta) * Math.cos(latRad) - Math.cos(delta) * Math.sin(latRad) * Math.cos(H);
  let azRad = Math.atan2(yAz, xAz);
  if (azRad < 0) azRad += Math.PI * 2;
  const azDeg = azRad * RAD2DEG;

  const cosAlt = Math.cos(altRad);
  const dirX = cosAlt * Math.sin(azRad);
  const dirY = Math.sin(altRad);
  const dirZ = -cosAlt * Math.cos(azRad);

  // 月相計算 (0.0 新月, 0.25 上弦, 0.5 滿月, 0.75 下弦)
  // 月球與太陽平黃經差
  const elongation = normalizeDeg((l - Lp + D) * RAD2DEG);
  const phase = elongation / 360.0;
  const illumination = 0.5 * (1 - Math.cos(elongation * DEG2RAD));

  return {
    coords: {
      altitudeRad: altRad,
      altitudeDeg: altDeg,
      azimuthRad: azRad,
      azimuthDeg: azDeg,
      directionVector: [dirX, dirY, dirZ]
    },
    phase,
    illumination
  };
}

/**
 * 依太陽高度角判定暮光時段
 */
export function determineTwilightPhase(
  altDeg: number,
  hourAngleDeg: number
): TwilightPhase {
  const { NIGHT, DAWN_DUSK, SUNRISE_SUNSET } = CONFIG.TIME.SOLAR_THRESHOLDS;
  const isMorning = hourAngleDeg < 0;

  if (altDeg < NIGHT) {
    return 'night';
  } else if (altDeg < DAWN_DUSK) {
    return isMorning ? 'dawn' : 'dusk';
  } else if (altDeg < SUNRISE_SUNSET) {
    return isMorning ? 'sunrise' : 'sunset';
  } else {
    return 'day';
  }
}

/**
 * 組合完整的日月與暮光資訊
 */
export function getSunMoonInfo(
  latDeg: number,
  lonDeg: number,
  timestampMs: number
): SunMoonInfo {
  const sunData = calculateSunPosition(latDeg, lonDeg, timestampMs);
  const moonData = calculateMoonPosition(latDeg, lonDeg, timestampMs);
  const twilight = determineTwilightPhase(sunData.coords.altitudeDeg, sunData.hourAngleDeg);

  return {
    sun: sunData.coords,
    moon: moonData.coords,
    moonPhase: moonData.phase,
    moonIllumination: moonData.illumination,
    twilightPhase: twilight,
    isSunAboveHorizon: sunData.coords.altitudeDeg > -0.833,
    isNight: twilight === 'night' || twilight === 'dusk' || twilight === 'dawn'
  };
}
