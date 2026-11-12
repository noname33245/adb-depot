import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppEntry, ContactEntry, DeviceProps, DeviceStats, FileEntry, LocationInfo } from "@shared/types";
import { wgs84ToGcj02 } from "@shared/coord";
import { useT } from "../settings";

/** 按水平精度给个说法：GPS 和网络定位差着数量级，得让用户看得出来。 */
const accLabel = (acc?: number): string => {
  if (acc === undefined) return "";
  if (acc <= 20) return "GPS";
  if (acc <= 60) return "WiFi / 基站";
  return "粗略";
};

/** 把「距今多少秒」说成人话。 */
const fmtAge = (sec: number): string => {
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
};

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

export function Empty({ text }: { text: string }) {
  return <div className="tool-empty">{text}</div>;
}

/**
 * 应用图标：滚到可视区域才去取，取到之前显示包名首字母。
 *
 * 主进程用设备上的 unzip 直接从 APK 里解出图标那一张（几 KB），
 * 不下载整个 APK —— 一个包几十上百 MB，那样纯属自残。
 */
function AppIcon({ serial, pkg }: { serial: string; pkg: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        window.farm.apps
          .icon(serial, pkg)
          .then((url) => {
            if (!cancelled && url) setSrc(url);
          })
          .catch(() => {
            // 取不到就算了，保留首字母占位
          });
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [serial, pkg]);

  return (
    <span ref={ref} className="app-icon" title={pkg}>
      {src ? <img src={src} alt="" loading="lazy" /> : <span className="app-icon-ph">{(pkg.split(".").pop() ?? "?").charAt(0).toUpperCase()}</span>}
    </span>
  );
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
            <AppIcon serial={serial} pkg={a.packageName} />
            <div className="tool-row-main">
              <button
                className="tool-name tool-link"
                title={`启动 ${a.packageName}`}
                disabled={busy}
                onClick={() => void act("启动", () => window.farm.apps.launch(serial, a.packageName))}
              >
                {a.packageName}
              </button>
              <span className="tool-sub">{a.system ? "系统" : "用户"}</span>
            </div>
            <div className="tool-actions">
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void act("启动", () => window.farm.apps.launch(serial, a.packageName))}
              >
                启动
              </button>
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
                className="btn"
                disabled={busy}
                title="把这个应用的安装包拉到电脑"
                onClick={() => void act("提取 APK", async () => {
                  const r = await window.farm.apps.extract(serial, a.packageName, a.label);
                  return r.ok ? `已保存到 ${r.dir}` : r.error || "已取消";
                })}
              >
                取APK
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
  const listRef = useRef<HTMLDivElement>(null);
  const dirRef = useRef(dir);
  dirRef.current = dir;
  /** 每个目录的滚动位置，返回时还原，不用重新从顶上找。 */
  const scrollMemo = useRef<Map<string, number>>(new Map());
  /** 刚加载完要滚到哪（渲染后再执行）。 */
  const pendingScroll = useRef<number | null>(null);
  /** 勾选的文件，批量操作用。 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 正在填参数的操作：重命名 / 复制 / 移动。 */
  const [op, setOp] = useState<{ kind: "rename" | "copy" | "move"; value: string }>();

  const load = useCallback(
    async (target: string) => {
      if (!serial) return;
      setBusy(true);
      try {
        // 先取到结果再切目录，避免读失败后路径和内容对不上
        const list = await window.farm.files.list(serial, target);
        // 进哪个目录就恢复哪个目录的滚动位置
        pendingScroll.current = scrollMemo.current.get(target) ?? 0;
        setEntries(list);
        setPicked(new Set());
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

  // 列表渲染完再滚，否则元素还没铺开、scrollTop 设不进去
  useEffect(() => {
    if (pendingScroll.current === null) return;
    const top = pendingScroll.current;
    pendingScroll.current = null;
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = top;
    });
  }, [entries]);

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

  const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p;

  const togglePick = (path: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** 把对话框里填的内容落到设备上。 */
  const runOp = async (): Promise<void> => {
    if (!serial || !op) return;
    const list = [...picked];
    const target = op.value.trim().replace(/\/+$/, "");
    if (list.length === 0 || !target) return;
    setOp(undefined);
    setBusy(true);
    let done = 0;
    let fail = 0;
    try {
      for (const from of list) {
        try {
          if (op.kind === "rename") await window.farm.files.rename(serial, from, `${dir}/${target}`);
          else {
            const dest = `${target}/${baseName(from)}`;
            if (op.kind === "move") await window.farm.files.rename(serial, from, dest);
            else await window.farm.files.copy(serial, from, dest);
          }
          done++;
        } catch {
          fail++;
        }
      }
      setMsg(`${op.kind === "rename" ? "重命名" : op.kind === "move" ? "移动" : "复制"} ${done} 项${fail ? `，${fail} 项失败` : ""}`);
      setFailed(fail > 0);
      setPicked(new Set());
      await load(dir);
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
      {picked.size > 0 && (
        <div className="tool-bar file-ops">
          <span className="tool-hint">已选 {picked.size} 项</span>
          {picked.size === 1 && (
            <button className="btn" disabled={busy} onClick={() => setOp({ kind: "rename", value: "" })}>
              重命名
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => setOp({ kind: "move", value: dir })}>
            移动到
          </button>
          <button className="btn" disabled={busy} onClick={() => setOp({ kind: "copy", value: dir })}>
            复制到
          </button>
          <button className="btn" onClick={() => setPicked(new Set())}>
            取消
          </button>
        </div>
      )}
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
      {op && (
        <div className="op-dialog">
          <div className="op-title">
            {op.kind === "rename" ? `重命名「${baseName([...picked][0] ?? "")}」` : op.kind === "move" ? "移动到目录" : "复制到目录"}
          </div>
          <input
            className="input"
            autoFocus
            value={op.value}
            placeholder={op.kind === "rename" ? "新文件名" : "/sdcard/目标目录"}
            onChange={(e) => setOp({ ...op, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runOp();
              if (e.key === "Escape") setOp(undefined);
            }}
          />
          <div className="op-actions">
            <button className="btn primary" onClick={() => void runOp()}>
              确定
            </button>
            <button className="btn" onClick={() => setOp(undefined)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div
        className="tool-list"
        ref={listRef}
        onScroll={(e) => scrollMemo.current.set(dirRef.current, e.currentTarget.scrollTop)}
      >
        {entries.length === 0 && !failed && <div className="tool-empty">这个目录是空的</div>}
        {entries.map((f) => {
          const canEnter = f.isDir || Boolean(f.link?.startsWith("/"));
          return (
            <div className={`tool-row${picked.has(f.path) ? " picked" : ""}`} key={f.path}>
              <input
                type="checkbox"
                className="file-check"
                checked={picked.has(f.path)}
                onChange={() => togglePick(f.path)}
                title="勾选后可批量操作"
              />
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

  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactQ, setContactQ] = useState("");
  const [contactMsg, setContactMsg] = useState("");

  const loadContacts = useCallback(async () => {
    if (!serial) return;
    setContactBusy(true);
    setContactMsg("");
    try {
      const list = await window.farm.contacts.list(serial);
      setContacts(list);
      if (list.length === 0) setContactMsg("手机通讯录是空的，或者系统不允许读取");
    } catch (e) {
      setContactMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setContactBusy(false);
    }
  }, [serial]);

  const shownContacts = useMemo(() => {
    const q = contactQ.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q) || c.number.includes(q));
  }, [contacts, contactQ]);

  const [loc, setLoc] = useState<LocationInfo | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [locMsg, setLocMsg] = useState("");

  const readLoc = useCallback(async () => {
    if (!serial) return;
    setLocBusy(true);
    try {
      setLoc(await window.farm.gps.get(serial));
      setLocMsg("");
    } catch (e) {
      setLocMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLocBusy(false);
    }
  }, [serial]);

  useEffect(() => {
    void readLoc();
  }, [readLoc]);

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

      <div className="geo-card">
        <div className="geo-head">
          <span className="geo-title">定位</span>
          <button className="btn" disabled={locBusy} onClick={() => void readLoc()}>
            {locBusy ? "读取中…" : "读取定位"}
          </button>
        </div>

        {locMsg && <p className="hint error">{locMsg}</p>}

        {loc && !loc.enabled && (
          <>
            <p className="hint">手机定位总开关是关闭的，读不到任何位置。</p>
            <div className="geo-actions">
              <button
                className="btn"
                onClick={() =>
                  void window.farm.batch
                    .shell([serial], "settings put secure location_mode 3")
                    .then(() => readLoc())
                }
              >
                打开手机定位
              </button>
            </div>
          </>
        )}

        {loc && loc.enabled && !loc.fix && (
          <p className="hint">
            手机最近没有定位记录。系统只在有应用请求定位时才更新缓存，本工具只在后台读取、不会打开任何软件；
            需要时自己先打开一次地图，再回来读。
          </p>
        )}

        {loc?.fix && (() => {
          const gcj = wgs84ToGcj02(loc.fix.lat, loc.fix.lon);
          const lon = gcj.lon.toFixed(6);
          const lat = gcj.lat.toFixed(6);
          const copy = (text: string): void => {
            void window.farm.clipboard.write(text);
          };
          return (
            <>
              <div className="geo-pair">
                <div className="geo-cell">
                  <span className="geo-label">经度 E</span>
                  <span className="geo-num">{lon}</span>
                </div>
                <div className="geo-cell">
                  <span className="geo-label">纬度 N</span>
                  <span className="geo-num">{lat}</span>
                </div>
              </div>
              <div className="tool-sub">
                GCJ-02（高德 / 腾讯） · 原始 WGS84：{loc.fix.lon.toFixed(6)}, {loc.fix.lat.toFixed(6)}（经度, 纬度）
              </div>
              <div className="tool-sub">
                {loc.fix.provider}
                {loc.fix.accuracy !== undefined
                  ? ` · ${Math.round(loc.fix.accuracy)} m（${accLabel(loc.fix.accuracy)}）`
                  : ""}
                {loc.fix.ageSeconds !== undefined ? ` · ${fmtAge(loc.fix.ageSeconds)}` : ""}
              </div>
              <div className="geo-actions">
                <button className="btn" onClick={() => copy(lon)}>
                  复制经度
                </button>
                <button className="btn" onClick={() => copy(lat)}>
                  复制纬度
                </button>
                <button className="btn" onClick={() => copy(`${lon}, ${lat}`)}>
                  复制一对
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    void window.farm.batch.shell(
                      [serial],
                      `am start -a android.intent.action.VIEW -d "geo:${gcj.lat},${gcj.lon}?q=${gcj.lat},${gcj.lon}"`,
                    )
                  }
                >
                  手机地图打开
                </button>
              </div>
            </>
          );
        })()}
      </div>

      <div className="geo-card">
        <div className="geo-head">
          <span className="geo-title">通讯录</span>
          <button className="btn" disabled={contactBusy} onClick={() => void loadContacts()}>
            {contactBusy ? "读取中…" : "读取通讯录"}
          </button>
        </div>

        {contactMsg && <p className="hint">{contactMsg}</p>}

        {contacts.length > 0 && (
          <>
            <input
              className="input"
              placeholder="搜索姓名或号码"
              value={contactQ}
              onChange={(e) => setContactQ(e.target.value)}
            />
            <div className="tool-hint">
              {shownContacts.length} / {contacts.length} 条
            </div>
            <div className="contact-list">
              {shownContacts.map((c) => (
                <div className="contact-row" key={`${c.name}|${c.number}`}>
                  <span className="contact-name" title={c.name}>
                    {c.name}
                  </span>
                  <span className="contact-num">{c.number}</span>
                  <button
                    className="btn tiny"
                    onClick={() => void window.farm.clipboard.write(c.number)}
                    title="复制号码"
                  >
                    {c.type || "复制"}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
