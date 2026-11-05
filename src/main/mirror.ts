import { readFile } from "node:fs/promises";
import { clipboard } from "electron";
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import {
  AndroidKeyCode,
  AndroidScreenPowerMode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  DefaultServerPath,
  ScrcpyInstanceId,
  ScrcpyPointerId,
} from "@yume-chan/scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";
import { t } from "@shared/i18n";
import { DEFAULT_STREAM } from "@shared/settings";
import type { DeviceResult, NavKey, StreamSettings, TouchEvent, VideoPacket } from "@shared/types";
import type { DeviceManager } from "./devices";


const KEYS: Record<NavKey, AndroidKeyCode> = {
  back: AndroidKeyCode.AndroidBack,
  home: AndroidKeyCode.AndroidHome,
  recents: AndroidKeyCode.AndroidAppSwitch,
  power: AndroidKeyCode.Power,
  volume_up: AndroidKeyCode.VolumeUp,
  volume_down: AndroidKeyCode.VolumeDown,
};

/** KEYCODE_WAKEUP，库里的 AndroidKeyCode 没导出，只能直接用数值。 */
const WAKEUP_KEY = 224;

const TOUCH_ACTIONS = {
  down: AndroidMotionEventAction.Down,
  move: AndroidMotionEventAction.Move,
  up: AndroidMotionEventAction.Up,
} as const;

type Client = AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>;
// The video stream class isn't exported, so derive its type from the client.
type VideoStream = NonNullable<Awaited<Client["videoStream"]>>;

interface Session {
  client: Client;
  video: VideoStream;
}

export interface MirrorSink {
  packet(serial: string, packet: VideoPacket): void;
  size(serial: string, width: number, height: number): void;
  stopped(serial: string, reason: string): void;
}

export class MirrorManager {
  #sessions = new Map<string, Promise<Session>>();
  #pushed = new Map<string, Promise<void>>();
  #server: Promise<Uint8Array>;

  constructor(
    private readonly devices: DeviceManager,
    serverPath: string,
    private readonly sink: MirrorSink,
    /** Read on every session start, so settings changes apply on reconnect. */
    private readonly stream: () => StreamSettings = () => DEFAULT_STREAM,
    /** 手机剪贴板 → 电脑，实时读设置，关掉立刻停。 */
    private readonly syncClipboard: () => boolean = () => false,
  ) {
    this.#server = readFile(serverPath);
  }

  isRunning(serial: string): boolean {
    return this.#sessions.has(serial);
  }

  /** Starts a session if needed, without restarting one that is already running. */
  async ensure(serial: string): Promise<void> {
    const pending = this.#sessions.get(serial);
    if (pending && (await pending.then(() => true, () => false))) return;
    await this.start(serial);
  }

  async start(serial: string): Promise<{ width: number; height: number }> {
    // Restart so a freshly created decoder receives the codec configuration again.
    if (this.#sessions.has(serial)) await this.stop(serial);

    const pending = this.#open(serial);
    this.#sessions.set(serial, pending);
    try {
      const { video } = await pending;
      return { width: video.width, height: video.height };
    } catch (e) {
      if (this.#sessions.get(serial) === pending) this.#sessions.delete(serial);
      throw e;
    }
  }

  async #open(serial: string): Promise<Session> {
    const adb = await this.devices.getAdb(serial);

    let pushed = this.#pushed.get(serial);
    if (!pushed) {
      pushed = this.#server.then((bytes) =>
        AdbScrcpyClient.pushServer(
          adb,
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        ),
      );
      this.#pushed.set(serial, pushed);
      pushed.catch(() => this.#pushed.delete(serial));
    }
    await pushed;

    const quality = this.stream();
    const options = new AdbScrcpyOptions3_3_3({
      audio: false,
      control: true,
      videoCodec: "h264",
      maxSize: quality.maxSize,
      videoBitRate: Math.round(quality.bitRate * 1_000_000),
      maxFps: quality.maxFps,
      stayAwake: quality.stayAwake,
      tunnelForward: true,
      // 必须开启：中文等非 ASCII 字符只能靠「写剪贴板 + 粘贴」输入，
      // 关掉后服务端会直接忽略 SET_CLIPBOARD，表现就是打字没反应。
      clipboardAutosync: true,
      scid: ScrcpyInstanceId.random(),
    });

    const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
    const video = await client.videoStream;
    if (!video) {
      await client.close();
      throw new Error(t("err.noVideo"));
    }
    const session: Session = { client, video };

    video.sizeChanged(({ width, height }) => this.sink.size(serial, width, height));
    void this.#pump(serial, session);

    // 手机 → 电脑：服务端在剪贴板变化时推送内容
    const clip = client.clipboard;
    if (clip) void this.#drainClipboard(serial, clip);

    // 电脑 → 手机：本地剪贴板没有变更事件，只能轮询
    this.#startClipboardWatch();



    // Server logs must be drained, otherwise the stream can stall.
    void drainLog(serial, client.output);

    return session;
  }

  /** 双向同步用的「上一次内容」，两个方向共用，避免自己把自己推回去变成死循环。 */
  #lastClipboard = "";
  #clipTimer: NodeJS.Timeout | undefined;

  #startClipboardWatch(): void {
    if (this.#clipTimer) return;
    this.#clipTimer = setInterval(() => void this.#pullClipboard(), 1200);
    this.#clipTimer.unref();
  }

  /** 电脑剪贴板 → 手机。Electron 44 起剪贴板 API 是异步的。 */
  async #pullClipboard(): Promise<void> {
    if (!this.syncClipboard() || this.#sessions.size === 0) return;
    let text = "";
    try {
      text = await clipboard.readText();
    } catch {
      return;
    }
    if (!text || text === this.#lastClipboard) return;
    this.#lastClipboard = text;
    await this.#pushClipboard(text);
  }

  /** 把电脑剪贴板写进每台在线手机的剪贴板（不触发粘贴）。 */
  async #pushClipboard(text: string): Promise<void> {
    for (const pending of this.#sessions.values()) {
      try {
        const session = await pending;
        const ctl = session.client.controller;
        if (!ctl) continue;
        await ctl.setClipboard({ sequence: 0n, paste: false, content: text });
      } catch {
        // 设备刚断开，跳过
      }
    }
  }

  /** 手机剪贴板变化 → 写到电脑剪贴板。 */
  async #drainClipboard(serial: string, stream: ReadableStream<string>): Promise<void> {
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (!value || !this.syncClipboard() || value === this.#lastClipboard) continue;
        this.#lastClipboard = value;
        try {
          await clipboard.writeText(value);
        } catch {
          // 剪贴板被别的程序占用，忽略
        }
        console.log(`[clipboard ${serial}] 已同步到电脑`);
      }
    } catch {
      // 会话结束时流被关闭
    }
  }

  async #pump(serial: string, session: Session): Promise<void> {
    let reason = t("err.mirrorEnded");
    try {
      const reader = session.video.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.sink.packet(
          serial,
          value.type === "configuration"
            ? { type: "configuration", data: value.data }
            : { type: "data", keyframe: value.keyframe, data: value.data },
        );
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    // Don't report if the session has already been replaced by a new one.
    const current = this.#sessions.get(serial);
    if (current && (await current.catch(() => undefined)) === session) {
      this.#sessions.delete(serial);
      this.sink.stopped(serial, reason);
    }
  }

  async stop(serial: string): Promise<void> {
    const pending = this.#sessions.get(serial);
    if (!pending) return;
    this.#sessions.delete(serial);
    try {
      const { client } = await pending;
      // 会话结束前把显示电源还原：隐私屏是手动的，不能关掉软件后手机还黑着
      await client.controller?.setScreenPowerMode(AndroidScreenPowerMode.Normal).catch(() => {});
      await client.close();
    } catch {
      // already closed or never opened
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((s) => this.stop(s)));
  }

  forgetDevice(serial: string): void {
    this.#pushed.delete(serial);
    void this.stop(serial);
  }

  async #ready(serial: string): Promise<Session | undefined> {
    try {
      return await this.#sessions.get(serial);
    } catch {
      return undefined;
    }
  }

  async #controlled(serial: string): Promise<{ session: Session; ctl: NonNullable<Client["controller"]> }> {
    const session = await this.#ready(serial);
    const ctl = session?.client.controller;
    if (!session || !ctl) throw new Error(t("err.mirrorEnded"));
    return { session, ctl };
  }

  // The *One methods throw, so scenario steps fail instead of silently doing nothing on a dead session.
  // The broadcast methods swallow per-device errors so one dropped device doesn't break input to the rest.

  async touchOne(serial: string, event: TouchEvent): Promise<void> {
    const { session, ctl } = await this.#controlled(serial);
    const { width, height } = session.video;
    await ctl.injectTouch({
      action: TOUCH_ACTIONS[event.action],
      pointerId: ScrcpyPointerId.Finger,
      pointerX: clamp01(event.x) * width,
      pointerY: clamp01(event.y) * height,
      videoWidth: width,
      videoHeight: height,
      pressure: event.action === "up" ? 0 : 1,
      actionButton: 0,
      buttons: 0,
    });
  }

  async keyOne(serial: string, key: NavKey): Promise<void> {
    const { ctl } = await this.#controlled(serial);
    for (const action of [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up]) {
      await ctl.injectKeyCode({ action, keyCode: KEYS[key], repeat: 0, metaState: 0 });
    }
  }

  async textOne(serial: string, text: string): Promise<void> {
    const { ctl } = await this.#controlled(serial);
    // injectText 走键盘字符映射表，非法字符会被静默丢掉（中文、表情都不行）；
    // 剪贴板粘贴对任何文字都有效，所以中文走剪贴板。
    if (/^[\x20-\x7e\t\n]*$/.test(text)) {
      try {
        await ctl.injectText(text);
        return;
      } catch {
        // 没有输入焦点时 injectText 会失败，退回剪贴板
      }
    }
    await ctl.setClipboard({ sequence: 0n, paste: true, content: text });
  }

  async touch(serials: string[], event: TouchEvent): Promise<void> {
    await Promise.all(serials.map((serial) => this.touchOne(serial, event).catch(() => {})));
  }

  async scroll(serials: string[], x: number, y: number, dx: number, dy: number): Promise<void> {
    await Promise.allSettled(
      serials.map(async (serial) => {
        const { session, ctl } = await this.#controlled(serial);
        const { width, height } = session.video;
        await ctl.injectScroll({
          pointerX: clamp01(x) * width,
          pointerY: clamp01(y) * height,
          videoWidth: width,
          videoHeight: height,
          scrollX: clamp(dx, -1, 1),
          scrollY: clamp(dy, -1, 1),
          buttons: 0,
        });
      }),
    );
  }

  async key(serials: string[], key: NavKey): Promise<void> {
    await Promise.all(serials.map((serial) => this.keyOne(serial, key).catch(() => {})));
  }

  async text(serials: string[], text: string): Promise<void> {
    await Promise.all(
      serials.map((serial) =>
        this.textOne(serial, text).catch((e: unknown) => {
          // 别静默吞掉：文字输入失败时至少要能在控制台看到原因
          console.warn(`[mirror ${serial}] 文字输入失败:`, e instanceof Error ? e.message : e);
        }),
      ),
    );
  }

  /**
   * 开关手机自己的屏幕。
   *
   * 走 scrcpy 的 SET_SCREEN_POWER_MODE 控制消息（就是官方 --turn-screen-off 的实现）：
   * 只把显示器电源关掉，不锁屏、不中断编码，所以电脑上的画面和触控都还在。
   */
  /**
   * 隐私屏：把手机自己的显示器电源关掉，电脑上的画面和触控照旧。
   *
   * 部分 ROM 需要完整的休眠、唤醒周期才能恢复物理显示器。
   */
  async setScreenOn(serials: string[]): Promise<DeviceResult[]> {
    return this.devices.forEach(serials, async (serial) => {
      const { ctl } = await this.#controlled(serial);
      await restorePhysicalScreen(
        () => ctl.setScreenPowerMode(AndroidScreenPowerMode.Normal),
        (command) => this.devices.shell(serial, command, 5000),
      );
      return "已执行：恢复屏幕电源 → 锁屏 → 唤醒；如显示锁屏界面，请解锁手机";
    });
  }

  async setScreenOff(): Promise<DeviceResult[]> {
    const out: DeviceResult[] = [];
    for (const serial of [...this.#sessions.keys()]) {
      try {
        const { ctl } = await this.#controlled(serial);
        await ctl.setScreenPowerMode(AndroidScreenPowerMode.Off);
        out.push({ serial, success: true, output: "已开启隐私屏" });
      } catch (e) {
        out.push({ serial, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

}

async function drainLog(serial: string, output: ReadableStream<string>): Promise<void> {
  try {
    const reader = output.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (/ERROR|WARN/.test(value)) console.warn(`[scrcpy ${serial}] ${value}`);
    }
  } catch {
    // closed together with the session
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Cycle logical sleep/wake: WAKEUP alone is ignored while Android is awake. */
export async function restorePhysicalScreen(normal: () => Promise<void>, shell: (command: string) => Promise<unknown>): Promise<void> {
  await normal();
  await shell("input keyevent 223");
  await sleep(600);
  await shell("input keyevent 224");
  await sleep(600);
  await normal();
}
