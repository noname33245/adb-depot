/**
 * 坐标转换。
 *
 * 安卓 Location 给的一律是 WGS84（国际标准，GPS 原始值）；
 * 国内地图（高德、腾讯）用的是 GCJ-02，百度用 BD-09。
 * 直接把 WGS84 粘进高德会偏四五百米，所以展示时要换算。
 */

const PI = Math.PI;
const A = 6378245.0; // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方

export interface LatLon {
  lat: number;
  lon: number;
}

/** 国外不需要偏移，算法只在国境内生效。 */
function outOfChina(lat: number, lon: number): boolean {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}

function transformLon(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}

/** WGS84 → GCJ-02（高德 / 腾讯 / 谷歌中国）。 */
export function wgs84ToGcj02(lat: number, lon: number): LatLon {
  if (outOfChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

/** WGS84 → BD-09（百度地图）。 */
export function wgs84ToBd09(lat: number, lon: number): LatLon {
  const gcj = wgs84ToGcj02(lat, lon);
  const x = gcj.lon;
  const y = gcj.lat;
  const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * PI * 3000 / 180);
  const theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * PI * 3000 / 180);
  return { lat: z * Math.sin(theta) + 0.006, lon: z * Math.cos(theta) + 0.0065 };
}

/** 六位小数，够到分米级。 */
export const fmtCoord = (v: number): string => v.toFixed(6);
