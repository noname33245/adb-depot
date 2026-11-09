import { isLang, t, type Lang } from "./i18n";
import type { AppSettings, StreamSettings } from "./types";

export const STREAM_SIZES: readonly number[] = [480, 720, 1080, 1440];
export const STREAM_FPS: readonly number[] = [15, 24, 30, 45, 60];
const ADB_NAME_RE = /(^|[\\/])adb(\.exe)?$/i;
export const DEFAULT_TEST_URL = "http://httpbin.org/ip";

export const DEFAULT_STREAM: StreamSettings = { maxSize: 480, bitRate: 2, maxFps: 30, stayAwake: true };

export function defaultSettings(language: Lang): AppSettings {
  return {
    language,
    languageChosen: false,
    theme: "dark",
    confirmDanger: true,
    stream: { ...DEFAULT_STREAM },
    proxyTestUrl: DEFAULT_TEST_URL,
    cyberyozhRefreshMin: 0,
    adbPath: "",
    closeToTray: true,
    minimizeToTray: false,
    autoLaunch: false,
    cacheAutoClean: true,
    transferSlots: 4,
    transferLimitKbps: 2048,
    linkMode: "video",
    cacheDays: 7,
    syncClipboard: true,
  };
}

function bad(what: string): never {
  throw new Error(t("err.badSettings", { what }));
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") bad(what);
  return v;
}

function oneOf(v: unknown, list: readonly number[], what: string): number {
  if (typeof v !== "number" || !list.includes(v)) bad(what);
  return v;
}

function range(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) bad(what);
  return v;
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Validates every field of `patch`; unknown fields are dropped. */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  if (!patch || typeof patch !== "object") bad("object");
  const p = patch as Record<string, unknown>;
  const next: AppSettings = { ...base, stream: { ...base.stream } };

  if (p.language !== undefined) {
    if (!isLang(p.language)) bad("language");
    next.language = p.language;
  }
  if (p.languageChosen !== undefined) next.languageChosen = bool(p.languageChosen, "languageChosen");
  if (p.theme !== undefined) {
    if (p.theme !== "dark" && p.theme !== "light" && p.theme !== "system") bad("theme");
    next.theme = p.theme;
  }
  if (p.confirmDanger !== undefined) next.confirmDanger = bool(p.confirmDanger, "confirmDanger");
  if (p.stream !== undefined) {
    if (!p.stream || typeof p.stream !== "object") bad("stream");
    const s = p.stream as Record<string, unknown>;
    if (s.maxSize !== undefined) next.stream.maxSize = oneOf(s.maxSize, STREAM_SIZES, "maxSize");
    if (s.bitRate !== undefined) next.stream.bitRate = Math.round(range(s.bitRate, 0.5, 20, "bitRate") * 10) / 10;
    if (s.maxFps !== undefined) next.stream.maxFps = oneOf(s.maxFps, STREAM_FPS, "maxFps");
    if (s.stayAwake !== undefined) next.stream.stayAwake = bool(s.stayAwake, "stayAwake");
  }
  if (p.proxyTestUrl !== undefined) {
    if (typeof p.proxyTestUrl !== "string" || p.proxyTestUrl.length > 500) bad("proxyTestUrl");
    const url = p.proxyTestUrl.trim() || DEFAULT_TEST_URL;
    if (!isHttpUrl(url)) throw new Error(t("err.badUrl"));
    next.proxyTestUrl = url;
  }
  if (p.cyberyozhRefreshMin !== undefined) next.cyberyozhRefreshMin = Math.round(range(p.cyberyozhRefreshMin, 0, 1440, "cyberyozhRefreshMin"));
  if (p.adbPath !== undefined) {
    if (typeof p.adbPath !== "string" || p.adbPath.length > 1024 || /[\0\r\n]/.test(p.adbPath)) bad("adbPath");
    const path = p.adbPath.trim();
    // The path gets executed, so it has to at least be an adb binary rather than any program.
    if (path && !ADB_NAME_RE.test(path)) throw new Error(t("err.badAdbPath"));
    next.adbPath = path;
  }
  if (p.closeToTray !== undefined) next.closeToTray = bool(p.closeToTray, "closeToTray");
  if (p.minimizeToTray !== undefined) next.minimizeToTray = bool(p.minimizeToTray, "minimizeToTray");
  if (p.autoLaunch !== undefined) next.autoLaunch = bool(p.autoLaunch, "autoLaunch");
  if (p.transferSlots !== undefined) next.transferSlots = range(p.transferSlots, 1, 12, "transferSlots");
  // 旧的「均衡」统一归到视频优先，只保留两档
  if (p.linkMode === "video" || p.linkMode === "files") next.linkMode = p.linkMode;
  else if (p.linkMode === "balanced") next.linkMode = "video";
  if (p.transferLimitKbps !== undefined)
    next.transferLimitKbps = range(p.transferLimitKbps, 0, 102_400, "transferLimitKbps");
  if (p.cacheAutoClean !== undefined) next.cacheAutoClean = bool(p.cacheAutoClean, "cacheAutoClean");
  if (p.cacheDays !== undefined) next.cacheDays = Math.round(range(p.cacheDays, 0, 365, "cacheDays"));
  if (p.syncClipboard !== undefined) next.syncClipboard = bool(p.syncClipboard, "syncClipboard");
  return next;
}

/** Corrupted fields silently fall back to defaults. */
export function loadSettings(raw: unknown, defaults: AppSettings): AppSettings {
  let result = defaults;
  if (!raw || typeof raw !== "object") return result;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof AppSettings)[]) {
    if (o[key] === undefined) continue;
    if (key === "stream" && o.stream && typeof o.stream === "object") {
      for (const [k, v] of Object.entries(o.stream)) {
        try {
          result = mergeSettings(result, { stream: { [k]: v } });
        } catch {
          // keep the default
        }
      }
      continue;
    }
    try {
      result = mergeSettings(result, { [key]: o[key] });
    } catch {
      // keep the default
    }
  }
  return result;
}
