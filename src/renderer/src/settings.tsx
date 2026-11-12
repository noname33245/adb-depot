import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { setLang, t } from "@shared/i18n";
import type { AppSettings, ThemeMode } from "@shared/types";

const THEME_MODE_KEY = "adb.themeMode";
const THEME_SYS_KEY = "adb.systemDark";

function applyThemeDom(mode: ThemeMode, systemDark: boolean): void {
  const effective = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  const root = document.documentElement;
  root.dataset.theme = effective;
  // 让原生滚动条、下拉框、输入框跟着主题走
  root.style.colorScheme = effective;
}

/**
 * 首屏同步跑一次：设置是从主进程异步取的，先按上次缓存的主题给 html 打标记，
 * 否则浅色模式每次启动都会先闪一帧深色。
 */
export function bootTheme(): void {
  let mode: ThemeMode = "dark";
  let systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  try {
    const m = localStorage.getItem(THEME_MODE_KEY);
    if (m === "dark" || m === "light" || m === "system") mode = m;
    const s = localStorage.getItem(THEME_SYS_KEY);
    if (s === "1" || s === "0") systemDark = s === "1";
  } catch {
    // localStorage 不可用就用默认深色
  }
  applyThemeDom(mode, systemDark);
}

interface SettingsContextValue {
  settings: AppSettings;
  /** Throws if main rejects the patch. */
  update(patch: Partial<AppSettings>): Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ initial, children }: { initial: AppSettings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  // Set before children render so t() returns the right language immediately.
  setLang(settings.language);

  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);

  // 系统深色模式切换由主进程的 nativeTheme 推送，渲染层不自己轮询。
  useEffect(() => {
    void window.farm.theme.state().then((s) => setSystemDark(s.systemDark)).catch(() => {});
    return window.farm.theme.onChange((s) => setSystemDark(s.systemDark));
  }, []);

  useLayoutEffect(() => {
    applyThemeDom(settings.theme, systemDark);
    try {
      localStorage.setItem(THEME_MODE_KEY, settings.theme);
      localStorage.setItem(THEME_SYS_KEY, systemDark ? "1" : "0");
    } catch {
      // 忽略隐私模式下的写入失败
    }
  }, [settings.theme, systemDark]);

  const update = useCallback(async (patch: Partial<AppSettings>) => setSettings(await window.farm.settings.update(patch)), []);
  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("SettingsProvider is missing");
  return ctx;
}

/** Returns `t` and re-renders the component when the language changes. */
export function useT(): typeof t {
  useSettings();
  return t;
}
