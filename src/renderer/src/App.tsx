import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceInfo, DeviceResult, RecordingStatus, RunStatus, Scenario } from "@shared/types";
import { DeviceTile } from "./components/DeviceTile";
import { ActionsPanel } from "./components/ActionsPanel";
import { ProxyPanel } from "./components/ProxyPanel";
import { LogPanel, type LogEntry } from "./components/LogPanel";
import { ScenarioEditor } from "./components/ScenarioEditor";
import { ScenariosPanel } from "./components/ScenariosPanel";
import { SettingsModal } from "./components/SettingsModal";
import { useSettings, useT } from "./settings";
import { UpdateBadge } from "./components/UpdateBadge";
import { AppsPanel, DevicePanel, FilesPanel } from "./components/ToolsPanels";
import { ConnectionCenter } from "./components/ConnectionCenter";

type Tab = "actions" | "apps" | "files" | "device" | "scenarios" | "proxy";

const TILE_WIDTH_KEY = "evelin.tileWidth";
const TILE_SIZES_KEY = "adb.tileSizes";
/** 磁贴宽度范围：拖动和顶栏滑块共用同一套边界。 */
const TILE_MIN_W = 160;
const TILE_MAX_W = 640;

function savedTileWidth(): number {
  try {
    const n = Number(localStorage.getItem(TILE_WIDTH_KEY));
    return n >= TILE_MIN_W && n <= TILE_MAX_W ? n : 240;
  } catch {
    return 240;
  }
}

/** 每台设备单独记住拖出来的宽度，换设备不会互相干扰。 */
function savedTileSizes(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(TILE_SIZES_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && v >= 160 && v <= 900) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function App() {
  const t = useT();
  const { settings } = useSettings();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | undefined>();
  const [broadcast, setBroadcast] = useState(false);
  const [tileWidth, setTileWidth] = useState(savedTileWidth);
  const [tileSizes, setTileSizes] = useState<Record<string, number>>(savedTileSizes);
  const preFocusWidth = useRef<Record<string, number>>({});
  const [tab, setTab] = useState<Tab>("actions");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<RunStatus[]>([]);
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
  const [editing, setEditing] = useState<Scenario | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  // Changing stream quality reconnects every tile.
  const streamKey = JSON.stringify(settings.stream);

  useEffect(() => {
    try {
      localStorage.setItem(TILE_WIDTH_KEY, String(tileWidth));
    } catch {
      // storage unavailable; the size just won't persist
    }
  }, [tileWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(TILE_SIZES_KEY, JSON.stringify(tileSizes));
    } catch {
      // 同上
    }
  }, [tileSizes]);

  const widthOf = useCallback(
    (serial: string): number => tileSizes[serial] ?? tileWidth,
    [tileSizes, tileWidth],
  );

  const resizeTile = useCallback((serial: string, width: number) => {
    setTileSizes((prev) => (prev[serial] === width ? prev : { ...prev, [serial]: width }));
  }, []);

  /** 放大镜按钮：在「默认宽度」和「两倍宽度」之间切换，手动拖过之后就以拖动值为准。 */
  const toggleFocus = useCallback(
    (serial: string) => {
      if (focused === serial) {
        const back = preFocusWidth.current[serial];
        if (back) resizeTile(serial, back);
        setFocused(undefined);
        return;
      }
      const cur = widthOf(serial);
      preFocusWidth.current[serial] = cur;
      resizeTile(serial, Math.max(520, Math.min(900, Math.round(cur * 2))));
      setFocused(serial);
    },
    [focused, resizeTile, widthOf],
  );

  useEffect(() => {
    void window.farm.devices.list().then(setDevices);
    void window.farm.scenarios.list().then(setScenarios);
    void window.farm.scenarios.runs().then(setRuns);
    const offs = [window.farm.devices.onChange(setDevices), window.farm.scenarios.onRuns(setRuns), window.farm.recorder.onStatus(setRecording)];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    const present = new Set(devices.map((d) => d.serial));
    setSelected((prev) => {
      const next = new Set([...prev].filter((s) => present.has(s)));
      return next.size === prev.size ? prev : next;
    });
    if (focused && !present.has(focused)) setFocused(undefined);
  }, [devices, focused]);

  // Tiles read selection through a ref so their handlers aren't recreated on every change.
  const stateRef = useRef({ broadcast, selected });
  stateRef.current = { broadcast, selected };

  const targetsFor = useCallback((serial: string) => {
    const { broadcast, selected } = stateRef.current;
    return broadcast && selected.has(serial) ? [...selected] : [serial];
  }, []);

  const online = useMemo(() => devices.filter((d) => d.state === "device"), [devices]);
  const activeSerial = focused ?? [...selected][0] ?? online[0]?.serial;
  const activeIp = activeSerial?.includes(":") ? activeSerial.split(":")[0] : undefined;
  const actionTargets = useMemo(
    () => (selected.size > 0 ? [...selected] : online.map((d) => d.serial)),
    [selected, online],
  );

  const toggle = (serial: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(serial)) next.delete(serial);
      else next.add(serial);
      return next;
    });

  const nameOf = useCallback(
    (serial: string) => {
      const d = devices.find((x) => x.serial === serial);
      return d?.model ? `${d.model} (${serial})` : serial;
    },
    [devices],
  );

  const report = useCallback(
    (title: string, results: DeviceResult[]) => {
      if (results.length === 0) return;
      const entry: LogEntry = {
        id: crypto.randomUUID(),
        time: new Date(),
        title,
        results: results.map((r) => ({ ...r, name: nameOf(r.serial) })),
      };
      setLog((prev) => [entry, ...prev].slice(0, 100));
    },
    [nameOf],
  );

  const run = useCallback(
    async (title: string, action: (serials: string[]) => Promise<DeviceResult[]>) => {
      if (actionTargets.length === 0) return;
      try {
        report(title, await action(actionTargets));
      } catch (e) {
        report(title, [{ serial: "—", success: false, error: e instanceof Error ? e.message : String(e) }]);
      }
    },
    [actionTargets, report],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">AdbDepot</div>
        <button className="btn primary conn-open" onClick={() => setConnOpen(true)} title="无线扫描 / 配对 / USB 转无线">
          连接设备
        </button>
        <UpdateBadge />
        <div className="topbar-stats">
          <span>
            {t("top.devices")} <b>{online.length}</b>
            {devices.length > online.length && <span className="muted"> / {devices.length}</span>}
          </span>
          <span>
            {t("top.selected")} <b>{selected.size}</b>
          </span>
        </div>
        <div className="topbar-controls">
          <button className="btn" onClick={() => setSelected(new Set(online.map((d) => d.serial)))}>
            {t("top.selectAll")}
          </button>
          <button className="btn" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            {t("top.deselect")}
          </button>
          <label className={`toggle${broadcast ? " on" : ""}`} title={t("top.broadcastHint")}>
            <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} />
            {t("top.broadcast")}
          </label>
          <label className="slider" title={`${t("top.tileSize")} · ${tileWidth}px（统一调整全部投屏，单独拖动可覆盖）`}>
            <input
              type="range"
              min={160}
              max={640}
              step={10}
              value={tileWidth}
              onChange={(e) => {
                // 拖动过单块磁贴后，那台设备存了自己的宽度，会把全局值盖住，
                // 看起来就是「滑块没反应」。所以动滑块时清掉单独设置，全部一起变。
                setTileWidth(Number(e.target.value));
                setTileSizes({});
              }}
            />
          </label>
          <button className="icon-btn settings-btn" title={t("top.settings")} onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </header>

      <main className="content">
        {devices.length === 0 ? (
          <div className="empty">
            <h2>{t("empty.title")}</h2>
            <p>{t("empty.text")}</p>
            <button className="btn primary empty-conn" onClick={() => setConnOpen(true)}>
              扫描并连接设备
            </button>
          </div>
        ) : (
          <div className="grid">
            {devices.map((d) => (
              <DeviceTile
                key={d.serial}
                device={d}
                selected={selected.has(d.serial)}
                focused={focused === d.serial}
                recording={recording?.serial === d.serial}
                run={runs.find((r) => r.serial === d.serial && r.state === "running")}
                streamKey={streamKey}
                width={widthOf(d.serial)}
                targets={() => targetsFor(d.serial)}
                onResize={(w) => resizeTile(d.serial, w)}
                onToggleSelect={() => toggle(d.serial)}
                onToggleFocus={() => toggleFocus(d.serial)}
              />
            ))}
          </div>
        )}
      </main>

      <aside className="sidebar">
        <nav className="tabs">
          <button className={tab === "actions" ? "active" : ""} onClick={() => setTab("actions")}>
            {t("tab.actions")}
          </button>
          <button className={tab === "apps" ? "active" : ""} onClick={() => setTab("apps")}>
            应用
          </button>
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
            文件
          </button>
          <button className={tab === "device" ? "active" : ""} onClick={() => setTab("device")}>
            设备
          </button>
          <button className={tab === "scenarios" ? "active" : ""} onClick={() => setTab("scenarios")}>
            {t("tab.scenarios")}
            {runs.some((r) => r.state === "running") && <span className="tab-dot" />}
          </button>
          <button className={tab === "proxy" ? "active" : ""} onClick={() => setTab("proxy")}>
            {t("tab.proxy")}
          </button>
        </nav>
        <div className="targets-hint">
          {selected.size > 0 ? t("targets.selected", { n: selected.size }) : t("targets.all", { n: online.length })}
        </div>
        <div className="sidebar-body">
          {tab === "actions" && <ActionsPanel targets={actionTargets} run={run} />}
          {tab === "apps" && <AppsPanel serial={activeSerial} />}
          {tab === "files" && <FilesPanel serial={activeSerial} />}
          {tab === "device" && <DevicePanel serial={activeSerial} deviceIp={activeIp} onOpenConnection={() => setConnOpen(true)} />}
          {tab === "scenarios" && (
            <ScenariosPanel
              devices={devices}
              targets={actionTargets}
              preferredSerial={focused ?? [...selected][0]}
              scenarios={scenarios}
              setScenarios={setScenarios}
              runs={runs}
              recording={recording}
              onEdit={setEditing}
            />
          )}
          {tab === "proxy" && <ProxyPanel targets={actionTargets} run={run} onOpenSettings={() => setSettingsOpen(true)} />}
        </div>
        <LogPanel entries={log} onClear={() => setLog([])} />
      </aside>

      {editing && <ScenarioEditor key={editing.id} scenario={editing} scenarios={scenarios} onSaved={setScenarios} onClose={() => setEditing(undefined)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {connOpen && <ConnectionCenter onClose={() => setConnOpen(false)} />}
    </div>
  );
}
