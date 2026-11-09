import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
import { GalleryPanel } from "./components/GalleryPanel";
import { MonitorPanel } from "./components/MonitorPanel";
import { ConnectionCenter } from "./components/ConnectionCenter";
import { ThemeMenu } from "./components/ThemeMenu";

type Tab = "actions" | "apps" | "gallery" | "files" | "device" | "monitor" | "scenarios" | "proxy";

const TILE_WIDTH_KEY = "evelin.tileWidth";
const TILE_SIZES_KEY = "adb.tileSizes";
/** 磁贴宽度范围：拖动和顶栏滑块共用同一套边界。 */
const TILE_MIN_W = 160;
const TILE_MAX_W = 640;

/** 右侧操作栏宽度，拖动分隔条调整。 */
const SIDE_WIDTH_KEY = "adb.sideWidth";
const SIDE_MIN_W = 300;
const SIDE_MAX_W = 900;

function savedSideWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return n >= SIDE_MIN_W && n <= SIDE_MAX_W ? n : 340;
  } catch {
    return 340;
  }
}

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
  const { settings, update } = useSettings();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | undefined>();
  const [broadcast, setBroadcast] = useState(false);
  /** 链路专供文件时视频流是停的，磁贴只显示占位。 */
  const [videoOff, setVideoOff] = useState(settings.linkMode === "files");
  /** 加一就重建全部磁贴：切链路要按新参数重新建流。 */
  const [linkEpoch, setLinkEpoch] = useState(0);
  const [tileWidth, setTileWidth] = useState(savedTileWidth);
  const [tileSizes, setTileSizes] = useState<Record<string, number>>(savedTileSizes);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [stack, setStack] = useState<string[]>([]);
  const desktopRef = useRef<HTMLDivElement>(null);
  const [desktopHeight, setDesktopHeight] = useState(600);
  const raiseTile = (serial: string) => setStack((prev) => [...prev.filter((s) => s !== serial), serial]);
  const [sideWidth, setSideWidth] = useState(savedSideWidth);
  const sideDrag = useRef<{ x: number; w: number } | null>(null);
  const preFocusWidth = useRef<Record<string, number>>({});
  const [tab, setTab] = useState<Tab>("actions");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logHeight, setLogHeight] = useState(() => {
    const v = Number(localStorage.getItem("adbdepot.logHeight"));
    return Number.isFinite(v) && v >= 90 ? Math.min(620, v) : 200;
  });
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

  useEffect(() => {
    try {
      localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth));
    } catch {
      // 同上
    }
  }, [sideWidth]);

  /** 拖右侧分隔条调整操作栏宽度；右侧最多留 420px 给投屏区。 */
  const startSideDrag = (e: ReactPointerEvent): void => {
    e.preventDefault();
    sideDrag.current = { x: e.clientX, w: sideWidth };
    document.body.classList.add("side-resizing");
    const move = (ev: PointerEvent): void => {
      const d = sideDrag.current;
      if (!d) return;
      const max = Math.max(SIDE_MIN_W, Math.min(SIDE_MAX_W, window.innerWidth - 420));
      setSideWidth(Math.round(Math.min(max, Math.max(SIDE_MIN_W, d.w - (ev.clientX - d.x)))));
    };
    const up = (): void => {
      sideDrag.current = null;
      document.body.classList.remove("side-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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

  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop) return;
    const measure = () => setDesktopHeight(Math.max(600, ...Array.from(desktop.children, (child) => {
      const el = child as HTMLElement;
      return el.offsetTop + el.offsetHeight + 24;
    })));
    const observer = new ResizeObserver(measure);
    Array.from(desktop.children).forEach((child) => observer.observe(child));
    measure();
    return () => observer.disconnect();
  }, [devices, positions]);

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
    <div className="app" style={{ gridTemplateColumns: `minmax(0, 1fr) ${sideWidth}px` }}>
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
          {/* 链路用途：一键把带宽让给投屏或文件 */}
          <label className="xfer" title="专用视频：720p/4Mbps 高清投屏，文件传输被压到 512KB/s；专用文件：停掉视频流，链路全部给文件">
            <span>链路</span>
            <select
              value={settings.linkMode}
              onChange={async (e) => {
                const mode = e.target.value as "video" | "files";
                // 必须先走 update()：界面上的值来自渲染层的设置副本，
                // 只通知主进程的话下拉会一直弹回旧值，看着像「点了没用」。
                await update({ linkMode: mode });
                await window.farm.link.set(mode);
                setVideoOff(mode === "files");
                setLinkEpoch((n) => n + 1);
              }}
            >
              <option value="video">视频优先</option>
              <option value="files">文件优先</option>
            </select>
          </label>

          {/* 传输参数：并发路数 + 速率上限，放在全选左边，改了立刻生效 */}
          <label className="xfer" title="相册缩略图 / 应用图标同时取几路。越大越快，但会和投屏抢带宽">
            <span>并发</span>
            <select
              value={settings.transferSlots}
              onChange={(e) => void update({ transferSlots: Number(e.target.value) })}
            >
              {[2, 4, 6, 8, 10, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="xfer" title="传输速率上限。不限 = 跑满链路；限速可让投屏不掉帧">
            <span>限速</span>
            <select
              value={settings.transferLimitKbps}
              onChange={(e) => void update({ transferLimitKbps: Number(e.target.value) })}
            >
              <option value={0}>不限</option>
              <option value={512}>512 KB/s</option>
              <option value={1024}>1 MB/s</option>
              <option value={2048}>2 MB/s</option>
              <option value={4096}>4 MB/s</option>
              <option value={8192}>8 MB/s</option>
            </select>
          </label>
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
          <ThemeMenu />
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
          <div className="device-desktop" ref={desktopRef} style={{ height: desktopHeight }}>
            {devices.map((d, index) => (
              <div key={d.serial} className="device-window" style={{ left: positions[d.serial]?.x ?? index * 36, top: positions[d.serial]?.y ?? index * 36, zIndex: stack.indexOf(d.serial) + 1 }} onPointerDownCapture={() => raiseTile(d.serial)}>
              <DeviceTile
                key={d.serial}
                device={d}
                selected={selected.has(d.serial)}
                focused={focused === d.serial}
                recording={recording?.serial === d.serial}
                run={runs.find((r) => r.serial === d.serial && r.state === "running")}
                streamKey={`${streamKey}#${linkEpoch}`}
                paused={videoOff}
                width={widthOf(d.serial)}
                targets={() => targetsFor(d.serial)}
                position={positions[d.serial] ?? { x: index * 36, y: index * 36 }}
                onMove={(position) => setPositions((prev) => ({ ...prev, [d.serial]: position }))}
                onResize={(w) => resizeTile(d.serial, w)}
                onToggleSelect={() => toggle(d.serial)}
                onToggleFocus={() => toggleFocus(d.serial)}
              />
              </div>
            ))}
          </div>
        )}
      </main>

      <aside className="sidebar">
        {/* 拖这条改宽度，双击回到默认 340 */}
        <div
          className="side-grip"
          title="拖动调整操作栏宽度（双击恢复默认）"
          onPointerDown={startSideDrag}
          onDoubleClick={() => setSideWidth(340)}
        />
        <nav className="tabs">
          <button className={tab === "actions" ? "active" : ""} onClick={() => setTab("actions")}>
            {t("tab.actions")}
          </button>
          <button className={tab === "apps" ? "active" : ""} onClick={() => setTab("apps")}>
            应用
          </button>
          <button className={tab === "gallery" ? "active" : ""} onClick={() => setTab("gallery")}>
            相册
          </button>
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
            文件
          </button>
          <button className={tab === "device" ? "active" : ""} onClick={() => setTab("device")}>
            设备
          </button>
          <button className={tab === "monitor" ? "active" : ""} onClick={() => setTab("monitor")}>
            监控
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
          {/* 相册按需挂载：切到这个标签才会去拉列表和缩略图 */}
          {tab === "gallery" && <GalleryPanel serial={activeSerial} />}
          {tab === "files" && <FilesPanel serial={activeSerial} />}
          {tab === "device" && <DevicePanel serial={activeSerial} deviceIp={activeIp} onOpenConnection={() => setConnOpen(true)} />}
          {tab === "monitor" && <MonitorPanel serial={activeSerial} devices={devices} />}
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
        <LogPanel
          entries={log}
          onClear={() => setLog([])}
          height={logHeight}
          onHeight={(h) => {
            setLogHeight(h);
            localStorage.setItem("adbdepot.logHeight", String(h));
          }}
        />
      </aside>

      {editing && <ScenarioEditor key={editing.id} scenario={editing} scenarios={scenarios} onSaved={setScenarios} onClose={() => setEditing(undefined)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {connOpen && <ConnectionCenter onClose={() => setConnOpen(false)} />}
    </div>
  );
}
