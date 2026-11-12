import type { GeoFix } from "@shared/types";
import type { DeviceManager } from "./devices";

export interface LocationInfo {
  /** 系统定位总开关是否打开（location_mode 0 表示关闭）。 */
  enabled: boolean;
  mode: number;
  /** 最近一次定位，没有就是 null。 */
  fix: GeoFix | null;
}

/** 把 `+3d4h5m6s789ms` 解析成秒。 */
function parseElapsed(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^\+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(raw.trim());
  if (!m) return undefined;
  const [, d, h, min, s, ms] = m;
  return (
    Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0) + Number(ms ?? 0) / 1000
  );
}

/** 同一份 dumpsys 里可能有好几个 provider 的记录，按可信度排序取一个。 */
const PRIORITY = ["gps", "fused", "network", "passive"];

/**
 * 读手机最近一次定位。
 *
 * 只能读系统缓存的「最后一次位置」——没有 App 主动请求定位时它就是 null，
 * 这是 Android 的机制，不是我们没实现。
 */
export async function readLocation(devices: DeviceManager, serial: string): Promise<LocationInfo> {
  const [dump, modeRaw, uptimeRaw] = await Promise.all([
    devices.shell(serial, "dumpsys location", 45_000),
    devices.shell(serial, "settings get secure location_mode", 15_000).catch(() => "3"),
    devices.shell(serial, "cat /proc/uptime", 10_000).catch(() => ""),
  ]);

  const mode = Number(modeRaw.trim());
  const fix = parseLastLocation(dump);
  if (fix) {
    // et= 是开机以来的毫秒数，不是「多久以前」。拿 uptime 减一下才是年龄。
    const uptime = Number(uptimeRaw.trim().split(/\s+/)[0]);
    const et = parseElapsed(fix.elapsed);
    if (Number.isFinite(uptime) && et !== undefined) {
      fix.ageSeconds = Math.max(0, Math.round(uptime - et));
    }
  }
  return {
    enabled: !Number.isFinite(mode) || mode !== 0,
    mode: Number.isFinite(mode) ? mode : -1,
    fix,
  };
}

/**
 * 从 `dumpsys location` 里挑出最新的定位。
 *
 * 行格式形如：
 *   last location=Location[gps 31.2345,121.4567 hAcc=20 et=+1h2m3s]
 * 有的 ROM 会带 alt=、vel=、bear=，所以只按需取 lat/lon。
 */
export function parseLastLocation(dump: string): GeoFix | null {
  const found: GeoFix[] = [];
  const re = /Location\[(\w+)\s+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)([^\]]*)\]/g;
  for (;;) {
    const m = re.exec(dump);
    if (!m) break;
    const provider = m[1]!;
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rest = m[4] ?? "";
    const acc = /hAcc=([\d.]+)/.exec(rest)?.[1];
    const et = /et=([^\s\]]+)/.exec(rest)?.[1];
    found.push({
      provider,
      lat,
      lon,
      accuracy: acc ? Number(acc) : undefined,
      elapsed: et,
    });
  }
  if (found.length === 0) return null;

  found.sort((a, b) => {
    const pa = PRIORITY.indexOf(a.provider);
    const pb = PRIORITY.indexOf(b.provider);
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
  });
  return found[0]!;
}
