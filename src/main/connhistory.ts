import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConnHistoryItem } from "@shared/types";

const MAX_ITEMS = 40;

/**
 * 连过的无线地址，按最近使用排序。
 * IP 会随 DHCP 变，所以只当快捷方式用，不做自动重连的依据。
 */
export class ConnHistory {
  #items: ConnHistoryItem[] = [];
  #saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (Array.isArray(raw)) {
        this.#items = raw
          .filter((x): x is ConnHistoryItem => !!x && typeof x === "object" && typeof (x as ConnHistoryItem).addr === "string")
          .slice(0, MAX_ITEMS);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[conn] 读取连接历史失败:", e);
    }
  }

  list(): ConnHistoryItem[] {
    return [...this.#items];
  }

  async add(addr: string, label?: string): Promise<ConnHistoryItem[]> {
    const now = Date.now();
    const existing = this.#items.find((x) => x.addr === addr);
    if (existing) {
      existing.lastSeen = now;
      existing.count += 1;
      if (label) existing.label = label;
    } else {
      this.#items.unshift({ addr, label, lastSeen: now, count: 1 });
    }
    this.#items.sort((a, b) => b.lastSeen - a.lastSeen);
    this.#items = this.#items.slice(0, MAX_ITEMS);
    await this.#persist();
    return this.list();
  }

  async forget(addr: string): Promise<ConnHistoryItem[]> {
    this.#items = this.#items.filter((x) => x.addr !== addr);
    await this.#persist();
    return this.list();
  }

  async clear(): Promise<ConnHistoryItem[]> {
    this.#items = [];
    await this.#persist();
    return this.list();
  }

  #persist(): Promise<void> {
    this.#saving = this.#saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#items, null, 2));
      await rename(tmp, this.path);
    });
    return this.#saving;
  }
}
