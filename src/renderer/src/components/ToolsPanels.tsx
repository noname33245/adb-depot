import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppEntry, DeviceProps, DeviceStats, FileEntry } from "@shared/types";
import { useT } from "../settings";

const fmtSize = (n: number): string => {
  if (n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const fmtTime = (ms: number): string => (ms ? new Date(ms).toLocaleString() : "—");

function Empty({ text }: { text: string }) {
  return <div className="tool-empty">{text}</div>;
}

export function AppsPanel({ serial }: { serial?: string }) {
  const t = useT();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [query, setQuery] = useState("");
  const [onlyUser, setOnlyUser] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!serial) return;
    setBusy(true);
    try {
      setApps(await window.farm.apps.list(serial));
      setMsg("");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [serial]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps.filter((a) => (!onlyUser || !a.system) && (!q || a.packageName.toLowerCase().includes(q)));
  }, [apps, query, onlyUser]);

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      const out = await fn();
      setMsg(`${label} 完成${typeof out === "string" && out ? `：${out.split("\n")[0]}` : ""}`);
    } catch (e) {
      setMsg(`${label} 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!serial) return <Empty text="先在左侧选择一台设备" />;

  return (
    <div className="tool-panel">
      <div className="tool-bar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索包名" />
        <button className="btn" onClick={() => setOnlyUser((v) => !v)}>
          {onlyUser ? "仅用户" : "全部"}
        </button>
        <button className="btn" disabled={busy} onClick={() => void load()}>
          刷新
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void act("安装", () => window.farm.apps.installFile(serial))}>
          {t("actions.install")}
        </button>
      </div>
      <div className="tool-hint">
        {shown.length} 个应用 · 共 {apps.length} 个{msg ? ` · ${msg}` : ""}
      </div>
      <div className="tool-list">
        {shown.map((a) => (
          <div className="tool-row" key={a.packageName}>
            <div className="tool-row-main">
              <span className="tool-name" title={a.packageName}>
                {a.packageName}
              </span>
              <span className="tool-sub">{a.system ? "系统" : "用户"}</span>
            </div>
            <div className="tool-actions">
              <button className="btn" disabled={busy} onClick={() => void act("停用", () => window.farm.apps.setEnabled(serial, a.packageName, false))}>
                停用
              </button>
              <button className="btn" disabled={busy} onClick={() => void act("启用", () => window.farm.apps.setEnabled(serial, a.packageName, true))}>
                启用
              </button>
              <button className="btn" disabled={busy} onClick={() => void act("清数据", () => window.farm.apps.clearData(serial, a.packageName))}>
                清数据
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => void act("卸载", async () => {
                  const out = await window.farm.apps.uninstall(serial, a.packageName);
                  await load();
                  return out;
                })}
              >
                卸载
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const cleanErr = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return text
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
};

const SHORTCUTS: Array<[string, string]> = [
  ["内部存储", "/sdcard"],
  ["相册", "/sdcard/DCIM/Camera"],
  ["下载", "/sdcard/Download"],
  ["截图", "/sdcard/Pictures/Screenshots"],
  ["文档", "/sdcard/Documents"],
  ["根目录", "/"],
];

export function FilesPanel({ serial }: { serial?: string }) {
  const [dir, setDir] = useState("/sdcard");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (target: string) => {
      if (!serial) return;
      setBusy(true);
      try {
        // 先取到结果再切目录，避免读失败后路径和内容对不上
        const list = await window.farm.files.list(serial, target);
        setEntries(list);
        setDir(target);
        setMsg("");
        setFailed(false);
      } catch (e) {
        setEntries([]);
        setDir(target);
        setMsg(cleanErr(e));
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [serial],
  );

  useEffect(() => {
    void load("/sdcard");
  }, [load]);

  const up = (): void => {
    const parent = dir.replace(/\/[^/]+$/, "") || "/";
    void load(parent);
  };

  /** 软链接指向目录时按目录进去。 */
  const enter = (f: FileEntry): void => {
    if (f.isDir) void load(f.path);
    else if (f.link?.startsWith("/")) void load(f.link);
  };

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      const out = await fn();
      setMsg(`${label} 完成${typeof out === "string" && out ? `：${out.split("\n")[0]}` : ""}`);
      setFailed(false);
      await load(dir);
    } catch (e) {
      setMsg(`${label} 失败：${cleanErr(e)}`);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (!serial) return <Empty text="先在左侧选择一台设备" />;

  return (
    <div className="tool-panel">
      <div className="tool-bar">
        <button className="btn" onClick={up} disabled={dir === "/" || busy}>
          上级
        </button>
        <input value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load(dir)} />
        <button className="btn" disabled={busy} onClick={() => void load(dir)}>
          打开
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void act("上传", () => window.farm.files.push(serial, dir))}>
          上传
        </button>
      </div>
      <div className="file-jumps">
        {SHORTCUTS.map(([label, path]) => (
          <button key={path} className={`file-jump${dir === path ? " active" : ""}`} onClick={() => void load(path)} disabled={busy}>
            {label}
          </button>
        ))}
      </div>
      <div className={`tool-hint${failed ? " tool-error" : ""}`}>
        {failed ? msg : `${entries.length} 项${msg ? ` · ${msg}` : ""}`}
      </div>
      <div className="tool-list">
        {entries.length === 0 && !failed && <div className="tool-empty">这个目录是空的</div>}
        {entries.map((f) => {
          const canEnter = f.isDir || Boolean(f.link?.startsWith("/"));
          return (
            <div className="tool-row" key={f.path}>
              <button className="tool-row-main tool-link" onClick={() => enter(f)} disabled={!canEnter} title={f.link ? `${f.path} → ${f.link}` : f.path}>
                <span className="tool-name">
                  {canEnter ? "▸ " : ""}
                  {f.name}
                  {f.link && <span className="tool-sub"> → {f.link}</span>}
                </span>
                <span className="tool-sub">{f.isDir ? "文件夹" : f.link ? "链接" : fmtSize(f.size)}</span>
              </button>
              <div className="tool-actions">
                <span className="tool-sub">{fmtTime(f.mtime)}</span>
                <button
                  className="btn"
                  disabled={busy || f.isDir || Boolean(f.link)}
                  onClick={() => void act("下载", () => window.farm.files.pull(serial, f.path))}
                >
                  下载
                </button>
                <button className="btn danger" disabled={busy} onClick={() => void act("删除", () => window.farm.files.remove(serial, f.path))}>
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DevicePanel({ serial, deviceIp, onOpenConnection }: { serial?: string; deviceIp?: string; onOpenConnection: () => void }) {
  const [props, setProps] = useState<DeviceProps | null>(null);
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    if (!serial) return;
    try {
      const [p, s] = await Promise.all([window.farm.system.props(serial), window.farm.system.stats(serial)]);
      setProps(p);
      setStats(s);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [serial]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!serial) return <Empty text="先在左侧选择一台设备" />;

  const rows: Array<[string, string | number | undefined]> = props
    ? [
        ["型号", props.model],
        ["品牌", props.brand ?? props.manufacturer],
        ["Android", props.androidVersion ? `${props.androidVersion} (SDK ${props.sdk ?? "?"})` : undefined],
        ["分辨率", props.resolution],
        ["DPI", props.density],
        ["架构", props.abi],
        ["芯片", props.cpu],
        ["序列号", props.serial],
        ["存储", props.storageTotal ? `共 ${props.storageTotal} · 已用 ${props.storageUsed} · 可用 ${props.storageFree}` : undefined],
        ["开机", props.uptime],
      ]
    : [];

  return (
    <div className="tool-panel">
      <div className="tool-bar">
        <button className="btn" disabled={busy} onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)); }}>
          刷新信息
        </button>
        <button className="btn primary" onClick={onOpenConnection}>
          连接中心
        </button>
      </div>
      <div className="tool-hint">
        {deviceIp ? `当前地址 ${deviceIp}` : "USB 连接"}
        {msg ? ` · ${msg}` : ""}
      </div>

      <div className="tool-cards">
        <div className="tool-card">
          <span className="tool-card-label">CPU</span>
          <span className="tool-card-value">{stats?.cpuUsage !== undefined ? `${stats.cpuUsage.toFixed(0)}%` : "—"}</span>
        </div>
        <div className="tool-card">
          <span className="tool-card-label">内存</span>
          <span className="tool-card-value">
            {stats?.memUsed !== undefined && stats.memTotal ? `${stats.memUsed}/${stats.memTotal} MB` : "—"}
          </span>
        </div>
        <div className="tool-card">
          <span className="tool-card-label">电量</span>
          <span className="tool-card-value">{stats?.batteryLevel !== undefined ? `${stats.batteryLevel}%` : "—"}</span>
        </div>
        <div className="tool-card">
          <span className="tool-card-label">温度</span>
          <span className="tool-card-value">{stats?.batteryTemp !== undefined ? `${stats.batteryTemp.toFixed(1)} ℃` : "—"}</span>
        </div>
      </div>

      <div className="tool-kv">
        {rows.map(([k, v]) => (
          <div className="tool-kv-row" key={k}>
            <span className="tool-kv-key">{k}</span>
            <span className="tool-kv-value">{v ?? "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
