import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, nativeImage } from "electron";
import type { PhotoEntry, PhotoPage } from "@shared/types";
import type { DeviceManager } from "./devices";
import { exifThumb, looksLikeJpeg } from "./exif";
import { pngTopStrip } from "./png";
import { TransferGate } from "./transfer";

/** 相册扫描目录：相机、截图、下载、微信/QQ 常见落盘位置。 */
const DIRS = ["/sdcard/DCIM", "/sdcard/Pictures", "/sdcard/Screenshots", "/sdcard/Download"];

/** 一页多少张。滚动到底再取下一页，不一次拉全部。 */
const PAGE_SIZE = 120;

/** 全量列表的安全上限，防止某些设备上有几万张把内存吃光。 */
const MAX_PHOTOS = 5000;

/** 列表缓存有效期：这段时间内翻页不再重复查询设备。 */
const LIST_TTL = 60_000;

/** 缩略图宽度。再大就没意义了，网格一格才 100 多像素。 */
const THUMB_WIDTH = 160;

/** 一次 shell 命令取几张缩略图。8 张能把 8 次 adb 往返压成 1 次。 */
const BATCH = 6;

/** 预览图最长边，太大在 Electron 里解码也慢。 */
const PREVIEW_MAX = 1200;

/** 超大 PNG 只读开头这么多 KB 解顶部条带，不再整张 3MB 硬读。 */
const STRIP_KB = 800;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Photo {
  path: string;
  name: string;
  /** 秒级时间戳。 */
  time: number;
  /** MediaStore 的 _id，用来找系统缩略图缓存。 */
  id?: string;
  /** 原图字节数，用来告诉用户还要传多久。 */
  size?: number;
}

export class Gallery {
  /** 缩略图缓存（体积小，可以多存）。 */
  #thumbs = new Map<string, Uint8Array>();
  /** 预览缓存（单张几百 KB，只留最近几张，避免吃内存）。 */
  #previews = new Map<string, Uint8Array>();
  /** 预览的磁盘缓存目录：原图几 MB，重开一次不值得再传一遍。 */
  #dir?: string;
  /** 读原图的兜底通道，固定 2 路：一张 3–8MB，并发高了直接把链路占满。 */
  #fallback = new TransferGate(() => 2);
  /** 批量取图同时最多 2 组：一组 6 张约 150KB，再多容易把 adb 连接顶断。 */
  #batchGate = new TransferGate(() => 2);

  constructor(
    private readonly devices: DeviceManager,
    private readonly gate: TransferGate,
  ) {}

  /**
   * 列出最近的照片。
   *
   * 一次 shell 拿到「时间|路径」，不逐张 adb pull：几千张图那样做直接卡死。
   * 注意这里只读目录元数据，不下图片，所以点开相册本身几乎不占带宽。
   */
  /** path → MediaStore _id，缩略图命中系统缓存时直接用。 */
  #ids = new Map<string, string>();

  /** 全量列表缓存，按设备分开，避免每次翻页都重扫一遍。 */
  #lists = new Map<string, { at: number; photos: PhotoEntry[] }>();

  async list(
    serial: string,
    offset = 0,
    limit = PAGE_SIZE,
    refresh = false,
    opts: { dir?: string; q?: string } = {},
  ): Promise<PhotoPage> {
    const cached = this.#lists.get(serial);
    let all: PhotoEntry[];
    if (!refresh && cached && Date.now() - cached.at < LIST_TTL) {
      all = cached.photos;
    } else {
      const indexed = await this.#fromMediaStore(serial).catch(() => [] as Photo[]);
      const raw = indexed.length > 0 ? indexed : await this.#fromDirs(serial);
      for (const p of raw) {
        if (p.id) this.#ids.set(`${serial}|${p.path}`, p.id);
      }
      all = raw.slice(0, MAX_PHOTOS).map((p) => ({
        path: p.path,
        name: p.path.split("/").pop() ?? p.path,
        time: p.time > 1e12 ? p.time : p.time * 1000,
        size: p.size,
        dir: p.path.replace(/^\/(storage\/emulated\/0|sdcard)\//, "").split("/").slice(0, -1).join("/"),
      }));
      this.#lists.set(serial, { at: Date.now(), photos: all });
    }
    // 分组和搜索都在全量列表上过滤，不能只筛当前页
    let view = all;
    if (opts.dir) view = view.filter((p) => p.dir === opts.dir);
    const q = opts.q?.trim().toLowerCase();
    if (q) view = view.filter((p) => p.name.toLowerCase().includes(q));

    return { items: view.slice(offset, offset + limit), total: view.length };
  }

  /** 按目录分组，给相册的下拉用。 */
  async dirs(serial: string): Promise<{ dir: string; count: number }[]> {
    await this.list(serial, 0, 1).catch(() => undefined);
    const all = this.#lists.get(serial)?.photos ?? [];
    const map = new Map<string, number>();
    for (const p of all) {
      const key = p.dir || "(根目录)";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 媒体库索引查询：`Row: 0 _data=/…/a.jpg, date_added=1793972066`。 */
  async #fromMediaStore(serial: string): Promise<Photo[]> {
    const out = await this.devices.shell(
      serial,
      'content query --uri content://media/external/images/media --projection _id:_data:date_added:_size --sort "date_added DESC" 2>/dev/null',
      45_000,
    );
    const photos: Photo[] = [];
    for (const line of out.split("\n")) {
      const data = /_id=(\d+), _data=(.+?), date_added=(\d+)(?:, _size=(\d+))?/.exec(line);
      if (!data) continue;
      const path = data[2]!.trim();
      if (!/\.(jpe?g|png|webp)$/i.test(path)) continue;
      photos.push({
        path,
        name: path.split("/").pop() ?? path,
        time: Number(data[3]),
        id: data[1],
        size: data[4] ? Number(data[4]) : undefined,
      });
      if (photos.length >= MAX_PHOTOS * 2) break;
    }
    return photos;
  }

  /** 兜底：直接扫目录。逐文件 stat 慢，只在媒体库查不到时用。 */
  async #fromDirs(serial: string): Promise<Photo[]> {
    const dirs = DIRS.join(" ");
    const cmd =
      `for d in ${dirs}; do [ -d "$d" ] && find "$d" -type f ` +
      `\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \\) -not -path '*/.*' 2>/dev/null; done | ` +
      `while read -r f; do stat -c '%Y|%n' "$f" 2>/dev/null; done | sort -rn | head -n ${MAX_PHOTOS}`;

    const out = await this.devices.shell(serial, cmd, 90_000);
    const photos: Photo[] = [];
    for (const line of out.split("\n")) {
      const idx = line.indexOf("|");
      if (idx <= 0) continue;
      const time = Number(line.slice(0, idx));
      const path = line.slice(idx + 1).trim();
      if (!path || !Number.isFinite(time)) continue;
      photos.push({ path, name: path.split("/").pop() ?? path, time });
    }
    return photos;
  }

  /** 翻页/关面板时调用：把还没轮到的缩略图请求丢掉，别挡住新一页。 */
  cancel(serial: string): void {
    this.gate.cancelQueued(serial);
  }

  /**
   * 缩略图。
   *
   * 关键优化：优先读系统生成好的缩略图（`/sdcard/Pictures/.thumbnails/<id>.jpg`，
   * 20–40KB），拿不到才退回读原图（3–8MB）。实测命中率 80%，
   * 单张流量差两个数量级，这比调并发有用得多。
   */
  /**
   * 批量缩略图。
   *
   * 单张取一次要走一次 adb 往返（30–60ms），120 张就是几百次往返，
   * 时间全耗在握手而不是数据上。这里把 8 张拼成一条 shell 命令，
   * 只读系统缩略图缓存（20–40KB/张），命中不了的交给单张路径去读原图。
   */
  async thumbs(serial: string, paths: string[]): Promise<{ path: string; data: Uint8Array }[]> {
    const out: { path: string; data: Uint8Array }[] = [];
    const todo: string[] = [];

    for (const path of paths) {
      const hit = this.#thumbs.get(`${serial}|${path}|thumb`);
      if (hit) out.push({ path, data: hit });
      else if (this.#ids.has(`${serial}|${path}`)) todo.push(path);
    }

    for (let i = 0; i < todo.length; i += BATCH) {
      const group = todo.slice(i, i + BATCH);
      try {
        const got = await this.#batchGate.run(serial, () => this.#loadBatch(serial, group));
        let bytes = 0;
        for (const [, data] of got) bytes += data.byteLength;
        await this.gate.pace(serial, bytes);
        for (const [path, data] of got) {
          out.push({ path, data });
          this.#thumbs.set(`${serial}|${path}|thumb`, data);
        }
      } catch {
        // 整批失败就让调用方走单张兜底
      }
    }
    return out;
  }

  /**
   * 一条命令取一组：先输出「id 字节数」清单，再原样吐出图片字节。
   *
   * 不再走 base64 —— 那会凭空多 33% 体积和两次编解码。
   * 头和数据之间用 @@DATA@@ 分界，本地按清单里的长度切分。
   */
  async #loadBatch(serial: string, group: string[]): Promise<[string, Uint8Array][]> {
    const adb = await this.devices.getTransferAdb(serial);
    const ids = group.map((path) => this.#ids.get(`${serial}|${path}`)!);
    const dirs = "/sdcard/Pictures/.thumbnails /sdcard/DCIM/.thumbnails /sdcard/.thumbnails";
    const idList = ids.join(" ");

    const cmd =
      `for id in ${idList}; do for d in ${dirs}; do ` +
      `[ -f "$d/$id.jpg" ] && { echo "$id $(stat -c %s "$d/$id.jpg" 2>/dev/null)"; break; }; ` +
      `done; done\n` +
      `echo "@@DATA@@"\n` +
      `for id in ${idList}; do for d in ${dirs}; do ` +
      `[ -f "$d/$id.jpg" ] && { cat "$d/$id.jpg"; break; }; ` +
      `done; done`;

    const raw = await Promise.race([
      adb.subprocess.noneProtocol.spawnWait(cmd),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取超时")), 30_000)),
    ]);

    const buf = Buffer.from(raw);
    const marker = Buffer.from("@@DATA@@\n");
    const cut = buf.indexOf(marker);
    if (cut < 0) return [];

    const head = buf.subarray(0, cut).toString("latin1");
    let off = cut + marker.length;
    const byId = new Map(group.map((path) => [this.#ids.get(`${serial}|${path}`)!, path]));
    const result: [string, Uint8Array][] = [];

    for (const line of head.split("\n")) {
      const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
      if (!m) continue;
      const path = byId.get(m[1]!);
      const size = Number(m[2]);
      const slice = buf.subarray(off, off + size);
      off += size;
      if (!path || slice.length < size) continue;

      // 系统缓存那张 20–40KB，再压一道才到 5KB 量级
      const img = nativeImage.createFromBuffer(slice);
      if (img.isEmpty()) continue;
      const { width: w } = img.getSize();
      const small = w > THUMB_WIDTH ? img.resize({ width: THUMB_WIDTH, quality: "good" }) : img;
      const out = new Uint8Array(small.toJPEG(52));
      result.push([path, out]);
      void this.#diskWrite(serial, `t:${path}`, out);
    }

    return result;
  }

  /**
   * @param full 允许整张读原图。默认 false ——
   *   一页里几十张「系统没缓存、又没有 EXIF 缩略图」的老照片，
   *   每张 3–8MB，全量拉就是上百 MB，等于把链路锁死。
   *   这类图先显示占位，用户点开看大图时再按需取。
   */
  async thumb(serial: string, path: string, full = false): Promise<Uint8Array> {
    return this.#image(serial, path, "thumb", THUMB_WIDTH, false, full);
  }

  /**
   * 大图预览。
   *
   * 走「直达」通道：缩略图队列里可能堆着上百个请求，预览排进去要等好几秒。
   * 一次只会点开一张，超发一个并发不会压垮链路。
   */
  async preview(serial: string, path: string): Promise<Uint8Array> {
    return this.#image(serial, path, "preview", PREVIEW_MAX, true);
  }

  async #cacheDir(): Promise<string> {
    if (!this.#dir) {
      const dir = join(app.getPath("userData"), "preview-cache");
      await mkdir(dir, { recursive: true }).catch(() => {});
      this.#dir = dir;
    }
    return this.#dir;
  }

  /** 文件名用路径哈希，原图改名就自然失效。 */
  #diskKey(serial: string, path: string): string {
    return createHash("sha1").update(`${serial}|${path}`).digest("hex") + ".jpg";
  }

  async #diskRead(serial: string, path: string): Promise<Uint8Array | undefined> {
    try {
      const dir = await this.#cacheDir();
      return new Uint8Array(await readFile(join(dir, this.#diskKey(serial, path))));
    } catch {
      return undefined;
    }
  }

  async #diskWrite(serial: string, path: string, bytes: Uint8Array): Promise<void> {
    try {
      const dir = await this.#cacheDir();
      await writeFile(join(dir, this.#diskKey(serial, path)), bytes);
      void this.#trimDisk(dir);
    } catch {
      // 磁盘写不进去不影响显示
    }
  }

  /** 缩略图 5KB、预览几百 KB，统一保留最近 2000 个文件。 */
  async #trimDisk(dir: string): Promise<void> {
    try {
      const names = await readdir(dir);
      if (names.length <= 2000) return;
      const stats = await Promise.all(
        names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })),
      );
      stats.sort((a, b) => a.t - b.t);
      for (const { n } of stats.slice(0, stats.length - 2000)) await unlink(join(dir, n)).catch(() => {});
    } catch {
      // 清不掉就算了
    }
  }

  async #image(
    serial: string,
    path: string,
    kind: string,
    width: number,
    immediate = false,
    allowFull = true,
  ): Promise<Uint8Array> {
    const key = `${serial}|${path}|${kind}`;
    const store = kind === "thumb" ? this.#thumbs : this.#previews;
    const hit = store.get(key);
    if (hit) return hit;

    // 缩略图和预览都看磁盘：翻回看过的页等于本地读图，0 传输
    if (kind === "thumb") {
      const cached = await this.#diskRead(serial, `t:${path}`);
      if (cached) {
        store.set(key, cached);
        return cached;
      }
    }

    // 预览先看磁盘：同一张图第二次打开（甚至重启软件后）就不用再传几 MB
    if (kind === "preview") {
      const cached = await this.#diskRead(serial, path);
      if (cached) {
        store.set(key, cached);
        return cached;
      }
    }

    /** 解码 → 缩放 → 编码，统一出口。 */
    const encode = (img: Electron.NativeImage): Uint8Array => {
      if (img.isEmpty()) throw new Error("这个格式解不出来（HEIC 之类暂不支持）");
      const { width: w } = img.getSize();
      const small = w > width ? img.resize({ width, quality: "good" }) : img;
      return new Uint8Array(small.toJPEG(kind === "thumb" ? 52 : 65));
    };

    const adb = await this.devices.getTransferAdb(serial);
    const quoted = path.replace(/"/g, '\\"');
    const id = kind === "thumb" ? this.#ids.get(`${serial}|${path}`) : undefined;

    /**
     * 轻量尝试：系统缩略图缓存，或者原图头 64KB 里的 EXIF 缩略图。
     * 两种情况传的都是几十 KB，可以放心跑满并发。
     */
    const light = async (): Promise<Uint8Array | undefined> => {
      /**
       * 超大 PNG 走「部分解压」：先花几十字节探一下头部，确认是 PNG 且 >1.5MB，
       * 再只读前 800KB 解出顶部条带当缩略图。原来每张都要硬读 3MB，
       * 一页 30 张就是 90MB，慢的根源在这里。
       */
      if (kind === "thumb") {
        const probe = await Promise.race([
          adb.subprocess.noneProtocol.spawnWait(
            `sz=$(stat -c %s "${quoted}" 2>/dev/null)\necho "@@S@@$sz"\ndd if="${quoted}" bs=8 count=1 2>/dev/null`,
          ),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取超时")), 10_000)),
        ]).catch(() => new Uint8Array(0));
        const head = Buffer.from(probe);
        const nl = head.indexOf(0x0a);
        const size = nl > 5 && head.subarray(0, 5).toString("latin1") === "@@S@@"
          ? Number(head.subarray(5, nl).toString("latin1")) || 0
          : 0;
        if (size > 1_500_000 && head.subarray(nl + 1, nl + 9).equals(PNG_MAGIC)) {
          const part = await Promise.race([
            adb.subprocess.noneProtocol.spawnWait(`dd if="${quoted}" bs=1024 count=${STRIP_KB} 2>/dev/null`),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取超时")), 20_000)),
          ]).catch(() => new Uint8Array(0));
          const strip = part.length > 64 ? pngTopStrip(new Uint8Array(part)) : undefined;
          if (strip) {
            const img = nativeImage.createFromBuffer(Buffer.from(strip));
            if (!img.isEmpty()) {
              // 条带本身很扁，等比缩到 160 宽只剩一条线，拉成 4:3 更容易辨认
              return new Uint8Array(
                img.resize({ width, height: Math.round(width * 0.75), quality: "good" }).toJPEG(52),
              );
            }
          }
        }
      }

      // 注意引号：stat 单独一行取变量，不能塞进 echo "$(...)" 里 ——
      // 路径本身带双引号，嵌套会让 shell 解析错乱，导致大小读不出来、整张图被判成「没缩略图」。
      const cmd =
        `if [ -n "${id ?? ""}" ]; then ` +
        `for d in /sdcard/Pictures/.thumbnails /sdcard/DCIM/.thumbnails /sdcard/.thumbnails; ` +
        `do f="$d/${id}.jpg"; [ -f "$f" ] && { echo "@@C@@"; cat "$f"; exit 0; }; done; fi\n` +
        `sz=$(stat -c %s "${quoted}" 2>/dev/null)\n` +
        `echo "@@S@@$sz"\n` +
        `dd if="${quoted}" bs=1024 count=3072 2>/dev/null`;

      const raw = await Promise.race([
        adb.subprocess.noneProtocol.spawnWait(cmd),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取超时")), 20_000)),
      ]);
      const got = Buffer.from(raw);
      if (!got.length) return undefined;

      // 命中系统缩略图缓存：直接就是一张能用的图
      const cacheMark = Buffer.from("@@C@@\n");
      if (got.subarray(0, cacheMark.length).equals(cacheMark)) {
        const img = nativeImage.createFromBuffer(got.subarray(cacheMark.length));
        return img.isEmpty() ? undefined : encode(img);
      }

      // 原图：先读出真实大小，小图直接整张拉（截图、微信图多是几百 KB）
      const sizeMark = Buffer.from("@@S@@");
      let body = got;
      let size = 0;
      if (got.subarray(0, sizeMark.length).equals(sizeMark)) {
        const nl = got.indexOf(0x0a);
        size = Number(got.subarray(sizeMark.length, nl).toString("latin1")) || 0;
        body = got.subarray(nl + 1);
      }

      if (size > 0 && size <= 1_500_000) {
        const whole = await adb.subprocess.noneProtocol.spawnWait(`cat "${quoted}"`);
        const img = nativeImage.createFromBuffer(Buffer.from(whole));
        return img.isEmpty() ? undefined : encode(img);
      }

      const exif = exifThumb(body);
      if (exif) return encode(nativeImage.createFromBuffer(exif));

      // PNG（含 APNG 动图）：首帧通常就在前 2MB 内，能完整解出来。
      // 这类素材图动辄几十上百 MB，整张拉不现实，取首帧正好当缩略图。
      if (body.length > 8 && body[0] === 0x89 && body[1] === 0x50 && body[4] === 0x0d) {
        // 找真正的 IEND 块（长度字段为 0），避免撞上压缩数据里的同名字节
        const iend = body.indexOf(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]));
        if (iend > 0) {
          const img = nativeImage.createFromBuffer(body);
          if (!img.isEmpty()) return encode(img);
        }
        return undefined;
      }

      // JPEG：dd 已经把整张读完了（文件小于 2MB）
      if (looksLikeJpeg(body) && body.length < 3 * 1024 * 1024 - 1) {
        const img = nativeImage.createFromBuffer(body);
        if (!img.isEmpty()) return encode(img);
      }
      return undefined;
    };

    /** 兜底：整张读。一张 3–8MB，只在真的没有缩略图时才走，并且限制 2 路。 */
    const full = async (): Promise<Uint8Array> => {
      const raw = await Promise.race([
        adb.subprocess.noneProtocol.spawnWait(`cat "${quoted}"`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取超时")), 60_000)),
      ]);
      return encode(nativeImage.createFromBuffer(Buffer.from(raw)));
    };

    const quick = await this.gate.run(serial, light).catch(() => undefined);
    if (quick) return this.#store(serial, path, kind, store, key, quick);
    if (!allowFull) return new Uint8Array(0);

    const bytes = await this.#fallback.run(serial, full);

    return this.#store(serial, path, kind, store, key, bytes);
  }

  /** 落缓存 + 限速，返回给调用方。 */
  async #store(
    serial: string,
    path: string,
    kind: string,
    store: Map<string, Uint8Array>,
    key: string,
    bytes: Uint8Array,
  ): Promise<Uint8Array> {
    await this.gate.pace(serial, bytes.byteLength);
    void this.#diskWrite(serial, kind === "thumb" ? `t:${path}` : path, bytes);

    // 看过大图就顺手做一张缩略图存起来：下次回到列表不用再显示「点开」
    if (kind === "preview") {
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (!img.isEmpty()) {
        const { width: w } = img.getSize();
        const small = w > THUMB_WIDTH ? img.resize({ width: THUMB_WIDTH, quality: "good" }) : img;
        const thumb = new Uint8Array(small.toJPEG(52));
        this.#thumbs.set(`${serial}|${path}|thumb`, thumb);
        void this.#diskWrite(serial, `t:${path}`, thumb);
      }
    }

    const cap = kind === "thumb" ? 1000 : 120;
    if (store.size > cap) {
      const first = store.keys().next().value;
      if (first) store.delete(first);
    }
    store.set(key, bytes);
    return bytes;
  }
}
