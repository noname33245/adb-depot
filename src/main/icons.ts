import { nativeImage } from "electron";
import type { DeviceManager } from "./devices";
import type { TransferGate } from "./transfer";

/** 图标最终边长（像素）。列表里显示 28px 左右，留 2 倍给高分屏。 */
const ICON_SIZE = 72;

/**
 * 应用图标。
 *
 * 不下载 APK —— 一个包动辄几十上百 MB，纯属自残。
 * 设备上本来就有 unzip，直接在里面把图标那一个条目解到 stdout，
 * 只有几 KB；超过 512KB 的条目直接放弃（那是被误选的图，不是图标）。
 */
export class AppIcons {
  #cache = new Map<string, string | null>();

  constructor(
    private readonly devices: DeviceManager,
    private readonly gate: TransferGate,
  ) {}

  async get(serial: string, pkg: string): Promise<string> {
    const key = `${serial}|${pkg}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined) return hit ?? "";

    const url = await this.gate.run(serial, () => this.#load(serial, pkg)).catch(() => "");
    if (this.#cache.size > 600) {
      const first = this.#cache.keys().next().value;
      if (first) this.#cache.delete(first);
    }
    this.#cache.set(key, url || null);
    return url;
  }

  async #load(serial: string, pkg: string): Promise<string> {
    const pathOut = await this.devices.shell(serial, `pm path ${pkg}`, 15_000);
    const apk = /package:(.+\.apk)/.exec(pathOut)?.[1]?.trim();
    if (!apk) throw new Error("找不到 APK 路径");

    const list = await this.devices.shell(serial, `unzip -l "${apk}"`, 30_000);
    const entry = pickIconEntry(list);
    if (!entry) throw new Error("APK 里没有可用的图标");

    const adb = await this.devices.getTransferAdb(serial);
    const bytes = await adb.subprocess.noneProtocol.spawnWait(`unzip -p "${apk}" "${entry}"`);
    if (!bytes || bytes.length === 0 || bytes.length > 512 * 1024) throw new Error("图标数据异常");

    const img = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (img.isEmpty()) throw new Error("图标解码失败");
    const { width } = img.getSize();
    const out = width > ICON_SIZE ? img.resize({ width: ICON_SIZE, quality: "good" }) : img;
    return `data:image/png;base64,${out.toPNG().toString("base64")}`;
  }


}

/**
 * 从 `unzip -l` 的输出里挑一个图标条目。
 *
 * 优先级：名字带 launcher 的 > 路径在 mipmap/drawable 下的；
 * 同优先级里取文件最大的那张（通常就是最高分辨率的）。
 * 只认 png/webp —— 自适应图标是 xml，解出来没法直接显示。
 */
function pickIconEntry(list: string): string | undefined {
  const rows: { name: string; size: number }[] = [];
  for (const line of list.split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[2]!.trim();
    if (!/\.(png|webp)$/i.test(name)) continue;
    if (!/^res\//.test(name)) continue;
    rows.push({ name, size: Number(m[1]) });
  }
  if (rows.length === 0) return undefined;

  const scored = rows
    .map((r) => {
      const n = r.name.toLowerCase();
      let score = 0;
      if (n.includes("ic_launcher")) score += 100;
      else if (n.includes("launcher")) score += 80;
      else if (n.includes("icon")) score += 40;
      if (/\/(mipmap|drawable)-/.test(n)) score += 10;
      if (n.includes("round")) score -= 5;
      if (n.includes("foreground") || n.includes("background")) score -= 30;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score || b.size - a.size);

  return scored[0]!.name;
}
