import { useEffect, useRef, useState, type ReactNode } from "react";
import { LANG_NAMES, LANGS, type Lang } from "@shared/i18n";
import { DEFAULT_TEST_URL, STREAM_FPS, STREAM_SIZES } from "@shared/settings";
import type { AppInfo, AppSettings, ProxyState, StreamSettings } from "@shared/types";
import { errorText } from "../errors";
import { useSettings, useT } from "../settings";

const BIT_RATES = [1, 2, 4, 6, 8, 12, 16];
const REFRESH_MINUTES = [0, 5, 15, 30, 60, 180];
/** 缓存保留天数的快捷选项；0 = 全部清空。超出这个范围就切到「自定义」 */
const CACHE_DAYS = [0, 1, 2, 3, 4, 5, 6, 7];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { settings, update } = useSettings();
  const [proxy, setProxy] = useState<ProxyState | undefined>();
  const [info, setInfo] = useState<AppInfo | undefined>();
  const [token, setToken] = useState("");
  const [testUrl, setTestUrl] = useState(settings.proxyTestUrl);
  const [adbPath, setAdbPath] = useState(settings.adbPath);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [cacheSize, setCacheSize] = useState<number | undefined>();
  const [cacheMsg, setCacheMsg] = useState("");
  const [daysText, setDaysText] = useState(String(settings.cacheDays));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    void window.farm.proxy.state().then(setProxy);
    void window.farm.settings.info().then(setInfo);
    void window.farm.cache.stat().then((s) => setCacheSize(s.bytes));
    const off = window.farm.proxy.onChange(setProxy);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function guard(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<AppSettings>) => guard(() => update(patch));
  const setStream = (patch: Partial<StreamSettings>) => set({ stream: { ...settings.stream, ...patch } });

  // Text fields save on blur or Enter and revert to the saved value on error.
  const commitTestUrl = () =>
    testUrl !== settings.proxyTestUrl &&
    guard(async () => {
      try {
        await update({ proxyTestUrl: testUrl });
      } catch (e) {
        setTestUrl(settings.proxyTestUrl);
        throw e;
      }
    });
  const commitAdbPath = (value: string) => value !== settings.adbPath && set({ adbPath: value });

  useEffect(() => setTestUrl(settings.proxyTestUrl), [settings.proxyTestUrl]);
  useEffect(() => setAdbPath(settings.adbPath), [settings.adbPath]);
  useEffect(() => setDaysText(String(settings.cacheDays)), [settings.cacheDays]);

  const commitDays = () => {
    const n = Math.max(1, Math.min(365, Math.round(Number(daysText) || settings.cacheDays)));
    setDaysText(String(n));
    if (n !== settings.cacheDays) set({ cacheDays: n });
  };

  const doClean = () => {
    setCacheMsg("");
    void guard(async () => {
      // 手动清理＝全清，天数只约束自动清理
      const r = await window.farm.cache.clean();
      setCacheSize(r.bytes);
      if (r.removed > 0) setCacheMsg(t("set.cleaned", { n: r.removed, size: fmtBytes(r.freed) }));
      else if (r.failed > 0) setCacheMsg(t("set.cleanLocked", { n: r.failed }));
      else setCacheMsg(t("set.cleanEmpty"));
    });
  };

  const yozhCount = proxy?.proxies.filter((p) => p.source === "cyberyozh").length ?? 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <header className="modal-header">
          <h2 className="modal-title">{t("set.title")}</h2>
          <button className="icon-btn" onClick={onClose} title={t("common.close")}>
            ✕
          </button>
        </header>

        <div className="settings-body">
          {error && <p className="hint error">{error}</p>}

          <Group title={t("set.general")}>
            <Row label={t("set.language")}>
              <select className="input" value={settings.language} onChange={(e) => set({ language: e.target.value as Lang })}>
                {LANGS.map((l) => (
                  <option key={l} value={l}>
                    {LANG_NAMES[l]}
                  </option>
                ))}
              </select>
            </Row>
            <label className="check">
              <input type="checkbox" checked={settings.confirmDanger} onChange={(e) => set({ confirmDanger: e.target.checked })} />
              {t("set.confirmDanger")}
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.syncClipboard} onChange={(e) => set({ syncClipboard: e.target.checked })} />
              {t("set.syncClipboard")}
            </label>
          </Group>

          <Group title={t("set.tray")} hint={t("set.trayHint")}>
            <label className="check">
              <input type="checkbox" checked={settings.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} />
              {t("set.closeToTray")}
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => set({ minimizeToTray: e.target.checked })} />
              {t("set.minimizeToTray")}
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.startMinimized} onChange={(e) => set({ startMinimized: e.target.checked })} />
              {t("set.startMinimized")}
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.autoLaunch} onChange={(e) => set({ autoLaunch: e.target.checked })} />
              {t("set.autoLaunch")}
            </label>
          </Group>

          <Group title={t("set.cache")} hint={t("set.cacheHint")}>
            <label className="check">
              <input type="checkbox" checked={settings.cacheAutoClean} onChange={(e) => set({ cacheAutoClean: e.target.checked })} />
              {t("set.autoClean")}
            </label>
            <Row label={t("set.keepDays")} hint={t("set.keepAuto")}>
              <select
                className="input"
                value={CACHE_DAYS.includes(settings.cacheDays) ? String(settings.cacheDays) : "custom"}
                onChange={(e) => {
                  if (e.target.value === "custom") set({ cacheDays: CACHE_DAYS.includes(settings.cacheDays) ? 14 : settings.cacheDays });
                  else set({ cacheDays: Number(e.target.value) });
                }}
              >
                {CACHE_DAYS.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? t("set.daysAll") : `${n} ${t("set.daysUnit")}`}
                  </option>
                ))}
                <option value="custom">{t("set.customDays")}</option>
              </select>
              {!CACHE_DAYS.includes(settings.cacheDays) && (
                <input
                  className="input cache-days"
                  type="number"
                  min={1}
                  max={365}
                  value={daysText}
                  onChange={(e) => setDaysText(e.target.value)}
                  onBlur={commitDays}
                  onKeyDown={(e) => e.key === "Enter" && commitDays()}
                />
              )}
            </Row>
            <Row label={t("set.cacheUsed")}>
              <span className="muted">{cacheSize === undefined ? "—" : fmtBytes(cacheSize)}</span>
              <button className="btn" type="button" disabled={busy} onClick={doClean}>
                {t("set.cleanNow")}
              </button>
            </Row>
            {cacheMsg && <p className="hint">{cacheMsg}</p>}
          </Group>

          <Group title={t("set.stream")} hint={t("set.streamHint")}>
            <Row label={t("set.maxSize")}>
              <select className="input" value={settings.stream.maxSize} onChange={(e) => setStream({ maxSize: Number(e.target.value) })}>
                {STREAM_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}px
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("set.bitRate")}>
              <select className="input" value={settings.stream.bitRate} onChange={(e) => setStream({ bitRate: Number(e.target.value) })}>
                {withCurrent(BIT_RATES, settings.stream.bitRate).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("set.maxFps")}>
              <select className="input" value={settings.stream.maxFps} onChange={(e) => setStream({ maxFps: Number(e.target.value) })}>
                {STREAM_FPS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Row>
            <label className="check">
              <input type="checkbox" checked={settings.stream.stayAwake} onChange={(e) => setStream({ stayAwake: e.target.checked })} />
              {t("set.stayAwake")}
            </label>
          </Group>

          <Group title={t("set.cyberyozh")} hint={t("set.cyberyozhHint")}>
            {proxy && !proxy.encryptionAvailable && <p className="hint error">{t("set.encryptionOff")}</p>}
            <p className="hint">{proxy?.hasCyberyozhToken ? t("set.tokenStatus", { n: yozhCount }) : t("set.tokenNone")}</p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void guard(async () => {
                  setProxy(await window.farm.proxy.setCyberyozhToken(token));
                  setToken("");
                });
              }}
            >
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder={proxy?.hasCyberyozhToken ? t("set.tokenSaved") : t("set.tokenPlaceholder")}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="btn" disabled={busy || (!token && !proxy?.hasCyberyozhToken)}>
                {token || !proxy?.hasCyberyozhToken ? t("common.save") : t("common.delete")}
              </button>
            </form>
            <Row label={t("set.autoRefresh")} hint={t("set.autoRefreshHint")}>
              <select className="input" value={settings.cyberyozhRefreshMin} onChange={(e) => set({ cyberyozhRefreshMin: Number(e.target.value) })}>
                {withCurrent(REFRESH_MINUTES, settings.cyberyozhRefreshMin).map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "—" : n}
                  </option>
                ))}
              </select>
            </Row>
          </Group>

          <Group title={t("set.proxy")}>
            <label className="field">
              <span className="muted">{t("set.testUrl")}</span>
              <input
                className="input mono"
                value={testUrl}
                placeholder={DEFAULT_TEST_URL}
                onChange={(e) => setTestUrl(e.target.value)}
                onBlur={commitTestUrl}
                onKeyDown={(e) => e.key === "Enter" && commitTestUrl()}
              />
              <span className="hint">{t("set.testUrlHint")}</span>
            </label>
          </Group>

          <Group title={t("set.adb")}>
            <label className="field">
              <span className="muted">{t("set.adbPath")}</span>
              <div className="row">
                <input
                  className="input mono"
                  value={adbPath}
                  placeholder={t("set.adbAuto")}
                  onChange={(e) => setAdbPath(e.target.value)}
                  onBlur={() => commitAdbPath(adbPath.trim())}
                  onKeyDown={(e) => e.key === "Enter" && commitAdbPath(adbPath.trim())}
                />
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    guard(async () => {
                      const picked = await window.farm.settings.pickAdbPath();
                      if (picked) await update({ adbPath: picked });
                    })
                  }
                >
                  {t("common.browse")}
                </button>
                {settings.adbPath && (
                  <button className="btn" type="button" disabled={busy} onClick={() => set({ adbPath: "" })}>
                    {t("common.reset")}
                  </button>
                )}
              </div>
              <span className="hint">{t("set.adbPathHint")}</span>
            </label>
          </Group>

          <Group title={t("set.about")}>
            <div className="about-row">
              <span>AdbDepot · {info ? t("set.version", { version: info.version }) : "…"}</span>
              <a href="https://github.com/asykixd/Evelin" target="_blank" rel="noreferrer">
                基座 Evelin (MIT)
              </a>
            </div>
            <Row label={t("set.dataDir")}>
              <button className="btn" onClick={() => void window.farm.settings.openDataDir()}>
                {t("set.openDataDir")}
              </button>
            </Row>
            {info && <p className="hint mono">{info.dataDir}</p>}
          </Group>
        </div>
      </div>
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <span>
        {label}
        {hint && <span className="hint"> · {hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** Keeps a hand-edited value selectable even if it's not among the presets. */
function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}
