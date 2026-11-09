/**
 * 手机通知同步。
 *
 * 走 `dumpsys notification --noredact` 轮询，不需要在手机上装 APK、
 * 不用申请「通知使用权」，也不会打开任何手机界面。
 * 输出先在设备端 grep 过一遍，一次只回几 KB，不会和投屏抢带宽。
 */

import { Notification } from "electron";
import type { DeviceManager } from "./devices";
import type { PhoneNotification } from "@shared/types";
import { notificationKey, parseNotifications } from "./notification-parse";

const POLL_MS = 5_000;
const MAX_ITEMS = 80;

export class NotificationSync {
  #timer: NodeJS.Timeout | undefined;
  #serial: string | undefined;
  #busy = false;
  #primed = false;
  #items: PhoneNotification[] = [];
  #seen = new Set<string>();

  constructor(
    private readonly devices: DeviceManager,
    private readonly onChange: (items: PhoneNotification[]) => void,
    private readonly onNew: (item: PhoneNotification) => void,
  ) {}

  get serial(): string | undefined {
    return this.#serial;
  }

  list(): PhoneNotification[] {
    return [...this.#items];
  }

  /** 换设备或关掉同步时，把上一次的「已读」状态一起清掉。 */
  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#serial = undefined;
    this.#primed = false;
    this.#seen.clear();
  }

  clear(): void {
    this.#items = [];
    this.onChange(this.list());
  }

  start(serial: string): void {
    if (this.#serial === serial && this.#timer) return;
    this.stop();
    this.#serial = serial;
    // 第一轮只建立基线：手机上现存的历史通知不该在打开开关的瞬间集体弹窗
    void this.#poll(true);
    this.#timer = setInterval(() => void this.#poll(false), POLL_MS);
  }

  async #poll(first: boolean): Promise<void> {
    const serial = this.#serial;
    if (!serial || this.#busy) return;
    this.#busy = true;
    try {
      const cmd =
        `dumpsys notification --noredact 2>/dev/null | ` +
        `grep -aE 'NotificationRecord|pkg=|android\\.title=|android\\.text=|android\\.bigText=|android\\.subText=' | ` +
        `head -n 400`;
      let out = await this.devices.shell(serial, cmd, 15_000);
      if (!out.trim()) out = await this.devices.shell(serial, cmd.replace(" --noredact", ""), 15_000);

      const fresh: PhoneNotification[] = [];
      for (const n of parseNotifications(out, serial)) {
        const key = notificationKey(n);
        if (this.#seen.has(key)) continue;
        this.#seen.add(key);
        fresh.push({ ...n, id: `${Date.now()}-${fresh.length}`, at: Date.now() });
      }

      if (this.#serial !== serial) return; // 期间关掉了或换了设备
      if (fresh.length > 0) {
        this.#items = [...fresh.reverse(), ...this.#items].slice(0, MAX_ITEMS);
        this.onChange(this.list());
        // 第一轮只记基线，不弹窗
        if (!first && this.#primed) {
          for (const n of fresh.slice(0, 3)) this.onNew(n);
        }
      }
      if (first) this.#primed = true;
    } catch {
      // 设备暂时不可达时静默跳过，下一轮再来
    } finally {
      this.#busy = false;
    }
  }
}

/** 在电脑上弹一条系统通知。Windows 上要 setAppUserModelId 才能正常显示。 */
export function showPhoneNotification(item: PhoneNotification): void {
  try {
    new Notification({
      title: item.title || item.pkg,
      body: [item.text, item.pkg].filter(Boolean).join("\n").slice(0, 400),
      silent: false,
    }).show();
  } catch {
    // 某些系统禁止通知，忽略即可，列表里仍然看得到
  }
}
