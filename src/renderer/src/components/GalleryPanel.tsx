import { useEffect, useRef, useState } from "react";
import type { DownloadTask, PhotoEntry } from "@shared/types";
import { useSettings, useT } from "../settings";
import { Empty } from "./ToolsPanels";

/** JPEG 字节直接变成可显示的 URL，绕开 base64 的 33% 膨胀。 */
const toObjectUrl = (bytes: Uint8Array): string =>
  URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" }));

/** 每页张数，和主进程保持一致。 */
const PAGE_SIZE = 120;

/**
 * 相册。
 *
 * 只有在侧栏切到「相册」时这个组件才会挂载，所以列表请求也只在这一刻发出。
 * 缩略图进一步做了懒加载：格子滚到视口附近才去设备上取那一张，
 * 主进程再限流到每设备 2 路 —— 打开相册不会把整本相册都拉下来。
 */
export function GalleryPanel({ serial }: { serial?: string }) {
  const t = useT();
  const { settings } = useSettings();
  /** 文件优先：带宽充裕，整页预取 + 允许读原图；视频优先：只取看得见的。 */
  const bulk = settings.linkMode === "files";
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [openIndex, setOpenIndex] = useState<number>();
  /** 多选：Ctrl 点选、Shift 连选。 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchorRef = useRef<number | undefined>(undefined);
  /** 已加载的缩略图 URL，点开大图时直接顶上用，省一次 IPC。 */
  const thumbUrls = useRef<Map<string, string>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; paths: string[] } | undefined>();
  /** 后台下载队列，主进程每完成一张就推一次。 */
  const [queue, setQueue] = useState<DownloadTask[]>([]);
  useEffect(() => {
    void window.farm.downloads.list().then(setQueue);
    return window.farm.downloads.onChange(setQueue);
  }, []);
  /**
   * 缩略图批量聚合器。
   *
   * 每张单独请求要走一次 adb 往返（30–60ms），几十张同时滚进视口时
   * 时间全耗在握手上。这里把 60ms 内到达的请求攒成一批（主进程再按 8 张
   * 一条命令取），往返次数直接降到 1/8，数据量不变。
   */
  const pendingThumbs = useRef<Map<string, { ok: (b: Uint8Array) => void; fail: (e: unknown) => void }>>(new Map());
  const flushTimer = useRef<number | undefined>(undefined);

  const flushThumbs = async (): Promise<void> => {
    flushTimer.current = undefined;
    const waiters = pendingThumbs.current;
    pendingThumbs.current = new Map();
    if (!serial || waiters.size === 0) return;

    const paths = [...waiters.keys()];
    let got: { path: string; data: Uint8Array }[] = [];
    try {
      got = await window.farm.gallery.thumbs(serial, paths);
    } catch {
      // 批量失败就让每张各走各的，别整页废掉
    }

    const hit = new Map(got.map((g) => [g.path, g.data]));
    const missing: string[] = [];
    for (const p of paths) {
      const data = hit.get(p);
      if (data) waiters.get(p)?.ok(data);
      else missing.push(p);
    }

    // 系统缓存没命中的：退回单张（会读原图并缩放）
    for (const p of missing) {
      const w = waiters.get(p);
      if (!w) continue;
      window.farm.gallery
        .thumb(serial, p, bulk)
        .then((b) => w.ok(b))
        .catch((e) => w.fail(e));
    }
  };

  /** 请求一张缩略图，同批的一起发。 */
  const requestThumb = (path: string): Promise<Uint8Array> =>
    new Promise((ok, fail) => {
      pendingThumbs.current.set(path, { ok, fail });
      if (flushTimer.current !== undefined) return;
      flushTimer.current = window.setTimeout(() => void flushThumbs(), 60);
    });

  /** 目录筛选与文件名搜索，都在主进程的全量列表上过滤。 */
  const [dirFilter, setDirFilter] = useState("");
  const [query, setQuery] = useState("");
  const [dirs, setDirs] = useState<{ dir: string; count: number }[]>([]);

  /** 每次翻页自增：只有最后一次翻页的结果才算数。 */
  const seq = useRef(0);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** 取某一页。refresh=true 时让主进程丢掉缓存重新扫设备。 */
  const load = async (target: number, refresh = false): Promise<void> => {
    if (!serial) return;
    const mine = ++seq.current;
    setBusy(true);
    try {
      // 必须先等「清队列」返回，再取列表。
      // 以前这是 fire-and-forget：新一页的缩略图请求先到、取消命令后到，
      // 结果把刚排队的新请求全清掉，连着翻几次就整面图都不加载。
      await window.farm.gallery.cancel(serial);
      if (mine !== seq.current) return;

      // 上一页还没发出去的缩略图请求直接作废
      pendingThumbs.current.clear();
      if (flushTimer.current !== undefined) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = undefined;
      }

      // 清掉上一页的 Blob URL，别一直占内存
      for (const url of thumbUrls.current.values()) URL.revokeObjectURL(url);
      thumbUrls.current.clear();

      const res = await window.farm.gallery.list(serial, (target - 1) * PAGE_SIZE, PAGE_SIZE, refresh, {
        dir: dirFilter || undefined,
        q: query.trim() || undefined,
      });
      if (mine !== seq.current) return; // 期间又翻了页，这份结果作废

      setPhotos(res.items);
      setTotal(res.total);
      setPage(target);
      setOpenIndex(undefined);
      setPicked(new Set());
      setMenu(undefined);
      setMsg("");
    } catch (e) {
      if (mine === seq.current) setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  // 首次进入 / 刷新后拉一次目录分组
  useEffect(() => {
    if (!serial) return;
    void window.farm.gallery.dirs(serial).then(setDirs).catch(() => setDirs([]));
  }, [serial]);

  // 搜索框防抖：停手 300ms 再查，避免每敲一个字就扫一遍
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (serial) void load(1, true);
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, dirFilter]);

  // 翻完这一页，空闲时预取下一页的头几张，翻页就不会干等
  useEffect(() => {
    if (!serial) return;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await window.farm.gallery.list(serial, page * PAGE_SIZE, bulk ? 12 : 6, false, {
            dir: dirFilter || undefined,
            q: query.trim() || undefined,
          });
          for (const p of next.items) void requestThumb(p.path).catch(() => {});
        } catch {
          // 预取失败不影响正常浏览
        }
      })();
    }, 2500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, serial, dirFilter, query, bulk]);

  // 页码变了就把列表滚回顶部。放在渲染之后做，否则新格子还没铺开，设了也白设。
  useEffect(() => {
    const grid = document.querySelector(".gallery-grid");
    if (!grid) return;
    requestAnimationFrame(() => requestAnimationFrame(() => (grid.scrollTop = 0)));
  }, [page]);

  // 页码变了要把输入框同步过来（翻页/刷新都会改它）
  useEffect(() => {
    setPageInput(String(page));
  }, [page, pages]);

  useEffect(() => {
    setPhotos([]);
    setTotal(0);
    setPage(1);
    void load(1, true);
    // 离开相册（切标签/换设备）时清掉残留请求和 Blob URL
    return () => {
      if (serial) void window.farm.gallery.cancel(serial);
      for (const url of thumbUrls.current.values()) URL.revokeObjectURL(url);
      thumbUrls.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  /** 普通点击看大图；Ctrl 点选、Shift 连选。 */
  const onCellClick = (e: React.MouseEvent, index: number): void => {
    const photo = photos[index];
    if (!photo) return;
    if (e.ctrlKey || e.metaKey) {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(photo.path)) next.delete(photo.path);
        else next.add(photo.path);
        return next;
      });
      anchorRef.current = index;
      return;
    }
    if (e.shiftKey && anchorRef.current !== undefined) {
      const from = Math.min(anchorRef.current, index);
      const to = Math.max(anchorRef.current, index);
      setPicked(new Set(photos.slice(from, to + 1).map((p) => p.path)));
      return;
    }
    setOpenIndex(index);
  };

  /** 右键：已经在选中集合里就下载整批，否则只下载这一张。 */
  const onCellMenu = (e: React.MouseEvent, index: number): void => {
    e.preventDefault();
    const photo = photos[index];
    if (!photo) return;
    const paths = picked.has(photo.path) ? [...picked] : [photo.path];
    setMenu({ x: e.clientX, y: e.clientY, paths });
  };

  /** 加入后台队列就返回，边下边翻页，可随时取消剩下的。 */
  const download = async (paths: string[]): Promise<void> => {
    if (!serial) return;
    setMenu(undefined);
    try {
      const r = await window.farm.downloads.enqueue(serial, paths);
      setMsg(!r.dir ? "已取消" : `已加入下载队列 ${r.added} 张 → ${r.dir}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  /** 跳到输入框里的那一页（越界自动收敛）。 */
  const jumpTo = (raw: string): void => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setPageInput(String(page));
      return;
    }
    const target = Math.min(pages, Math.max(1, Math.round(n)));
    if (target !== page) void load(target);
    else setPageInput(String(page));
  };

  if (!serial) return <Empty text="先在左侧勾选一台设备" />;

  return (
    <div className="tool-panel">
      <div className="tool-bar gallery-filter">
        <select
          className="input"
          value={dirFilter}
          onChange={(e) => {
            setDirFilter(e.target.value);
            void load(1, true);
          }}
          title="按目录筛选"
        >
          <option value="">全部目录</option>
          {dirs.map((d) => (
            <option key={d.dir} value={d.dir}>
              {d.dir}（{d.count}）
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="搜文件名"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {queue.length > 0 && (() => {
        const active = queue.filter((x) => x.state === "queued" || x.state === "running");
        const totalTasks = queue.filter((x) => x.state !== "cancelled").length;
        const finished = queue.filter((x) => x.state === "done" || x.state === "failed").length;
        const failed = queue.filter((x) => x.state === "failed").length;
        const now = queue.find((x) => x.state === "running");
        return (
          <div className="download-queue">
            <div className="dq-head">
              <span>
                下载队列 {finished}/{totalTasks}
                {failed > 0 && ` · 失败 ${failed}`}
                {active.length === 0 && " · 已完成"}
              </span>
              <div className="dq-actions">
                {active.length > 0 && (
                  <button className="btn" onClick={() => void window.farm.downloads.cancel()} title="取消还没开始的（正在传的这一张会传完）">
                    取消剩余
                  </button>
                )}
                <button className="btn" onClick={() => void window.farm.downloads.clear()}>清空记录</button>
              </div>
            </div>
            <div className="dq-bar"><i style={{ width: `${totalTasks ? (finished / totalTasks) * 100 : 0}%` }} /></div>
            {now && <div className="dq-now" title={now.path}>正在下载：{now.name}</div>}
          </div>
        );
      })()}

      <div className="tool-bar gallery-bar">
        <button className="btn" disabled={busy} onClick={() => void load(1, true)}>
          {busy && photos.length === 0 ? t("gallery.loading") : t("gallery.refresh")}
        </button>
        {picked.size > 0 && (
          <>
            <button className="btn primary" disabled={busy} onClick={() => void download([...picked])}>
              下载 {picked.size} 张
            </button>
            <button className="btn" onClick={() => setPicked(new Set())} title="取消选择">
              ✕
            </button>
          </>
        )}
        <button className="btn" disabled={page <= 1} onClick={() => void load(1)} title="第一页">
          «
        </button>
        <button className="btn" disabled={page <= 1} onClick={() => void load(page - 1)} title={t("gallery.prev")}>
          ‹
        </button>
        {total > 0 ? (
          <span className="page-jump">
            <input
              className="input page-input"
              type="number"
              min={1}
              max={pages}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={(e) => jumpTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  jumpTo((e.target as HTMLInputElement).value);
                }
              }}
              title="输入页码，回车跳转"
            />
            <span className="tool-hint">/ {pages} 页 · 共 {total} 张</span>
          </span>
        ) : (
          <span className="tool-hint">{busy ? "正在读取照片列表…" : ""}</span>
        )}
        <button className="btn" disabled={page >= pages} onClick={() => void load(page + 1)} title={t("gallery.next")}>
          ›
        </button>
        <button className="btn" disabled={page >= pages} onClick={() => void load(pages)} title="最后一页">
          »
        </button>
        {msg ? <span className="tool-hint">· {msg}</span> : null}
      </div>

      {photos.length === 0 && !busy ? (
        <Empty text={msg || t("gallery.empty")} />
      ) : (
        <div className="gallery-grid">
          {photos.map((p, i) => (
            <Thumb
              key={p.path}
              serial={serial}
              photo={p}
              selected={picked.has(p.path)}
              onClick={(e) => onCellClick(e, i)}
              onContextMenu={(e) => onCellMenu(e, i)}
              onReady={(url) => thumbUrls.current.set(p.path, url)}
              request={requestThumb}
              bulk={bulk}
            />
          ))}
        </div>
      )}

      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setMenu(undefined)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(undefined);
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button className="ctx-item" onClick={() => void download(menu.paths)}>
              下载{menu.paths.length > 1 ? `这 ${menu.paths.length} 张` : "这张"}
            </button>
            {menu.paths.length > 1 && (
              <button className="ctx-item" onClick={() => { setPicked(new Set(menu.paths)); setMenu(undefined); }}>
                仅选中这些
              </button>
            )}
            <button className="ctx-item" onClick={() => { setPicked(new Set([menu.paths[0]!])); setMenu(undefined); }}>
              只选这一张
            </button>
          </div>
        </>
      )}

      {openIndex !== undefined && photos[openIndex] && (
        <Lightbox
          serial={serial}
          photo={photos[openIndex]!}
          onClose={() => setOpenIndex(undefined)}
          lowUrl={thumbUrls.current.get(photos[openIndex]!.path)}
          onPrev={openIndex > 0 ? () => setOpenIndex(openIndex - 1) : undefined}
          onNext={openIndex < photos.length - 1 ? () => setOpenIndex(openIndex + 1) : undefined}
        />
      )}
    </div>
  );
}

/** 单张缩略图：滚到附近才请求，取到之前是占位块。 */
function Thumb({
  serial,
  photo,
  selected,
  onClick,
  onContextMenu,
  onReady,
  request,
  bulk,
}: {
  serial: string;
  photo: PhotoEntry;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onReady: (url: string) => void;
  /** 取图入口：面板会把同时到达的请求合并成一批。 */
  request: (path: string) => Promise<Uint8Array>;
  bulk: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const urlRef = useRef<string | undefined>(undefined);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let timer: number | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        // 停 120ms 再取：滑过去的图不白传
        timer = window.setTimeout(() => {
          request(photo.path)
          .then((bytes) => {
            if (cancelled) return;
            if (bytes.byteLength === 0) {
              setFailed(true);
              return;
            }
            const url = toObjectUrl(bytes);
            urlRef.current = url;
            setSrc(url);
            onReady(url);
          })
            .catch(() => {
              if (!cancelled) setFailed(true);
            });
        }, 120);
      },
      // root 用滚动容器；预取范围收窄到 0。
      // 系统缓存命中的图几乎瞬时，但没命中的要读 3–8MB 原图 ——
      // 一旦把预取范围放大，快速滑动会触发几十个原图下载，整页卡住。
      {
        root: (el.closest(".gallery-grid") as HTMLElement | null) ?? null,
        // 文件优先：整页铺开，滚到哪都是现成的；视频优先：只取看得见的，省带宽给投屏
        rootMargin: bulk ? "4000px" : "200px",
      },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      io.disconnect();
      // Blob URL 由面板统一释放（大图还要复用它）
    };
  }, [serial, photo.path, bulk]);

  return (
    <button
      ref={ref}
      className={`gallery-cell${src ? " ready" : ""}${selected ? " selected" : ""}`}
      title={`${photo.path}${photo.size ? ` · ${(photo.size / 1048576).toFixed(0)} MB` : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {src ? (
        <img src={src} alt={photo.name} loading="lazy" />
      ) : (
        // 没有现成缩略图的（老照片、截图）不自动拉原图，点开再看
        <span className="gallery-ph">{failed ? "点开" : ""}</span>
      )}
    </button>
  );
}

/** 大图预览：点开才取，取的是压到 1600px 的版本。 */
function Lightbox({
  serial,
  photo,
  lowUrl,
  onClose,
  onPrev,
  onNext,
}: {
  serial: string;
  photo: PhotoEntry;
  lowUrl?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const urlRef = useRef<string | undefined>(undefined);
  const lowRef = useRef<string | undefined>(undefined);
  const [src, setSrc] = useState<string>();
  const [low, setLow] = useState<string>();
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    setLow(undefined);
    setErr("");

    // 1) 网格里已经加载过就直接用（0 延迟）；没加载过才去要缩略图
    if (lowUrl) {
      setLow(lowUrl);
    } else {
      window.farm.gallery
        .thumb(serial, photo.path)
        .then((bytes) => {
          if (cancelled) return;
          const url = toObjectUrl(bytes);
          lowRef.current = url;
          setLow(url);
        })
        .catch(() => {});
    }

    // 2) 大图在后台取，到了直接替换
    window.farm.gallery
      .preview(serial, photo.path)
      .then((bytes) => {
        if (cancelled) return;
        const url = toObjectUrl(bytes);
        urlRef.current = url;
        setSrc(url);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      for (const ref of [urlRef, lowRef]) {
        if (ref.current) {
          URL.revokeObjectURL(ref.current);
          ref.current = undefined;
        }
      }
    };
  }, [serial, photo.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev?.();
      if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        {src || low ? (
          <img src={src ?? low} alt={photo.name} className={src ? undefined : "soft"} />
        ) : (
          <p className="muted">{err || "加载中…"}</p>
        )}
        <div className="lightbox-bar">
          <span className="lightbox-name">
            {photo.name}
            {!src && low
              ? ` · 清晰版加载中${photo.size ? `（原图 ${(photo.size / 1048576).toFixed(1)} MB）` : ""}…`
              : ""}
          </span>
          {onPrev && (
            <button className="btn" onClick={onPrev}>
              ‹
            </button>
          )}
          {onNext && (
            <button className="btn" onClick={onNext}>
              ›
            </button>
          )}
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
