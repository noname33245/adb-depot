import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { ReadableStream } from "@yume-chan/stream-extra";
import { langForLocale, t } from "@shared/i18n";
import { isInvalidScenario, NAV_KEYS, PACKAGE_RE } from "@shared/scenario";
import type { CacheCleanResult, DeviceResult, NavKey, ProxyState, TouchEvent } from "@shared/types";
import { DeviceManager, shellCommand } from "./devices";
import { cleanCache, measureCache } from "./cache";
import { ConnHistory } from "./connhistory";
import { MirrorManager } from "./mirror";
import { isValidHostPort, ProxyStore } from "./proxies";
import { Recorder } from "./recorder";
import { ScenarioRunner } from "./runner";
import { ScenarioStore } from "./scenarios";
import { SettingsStore } from "./settings";
import { AdbTools } from "./tools";
import { Updater } from "./updater";

/**
 * 改名后首次启动：把旧目录「ADB Studio」里的配置搬过来。
 * 只搬配置和记录，不搬 Chromium 缓存（换名字正好清一次）。
 */
async function migrateUserData(): Promise<void> {
  const next = app.getPath("userData");
  const prev = join(app.getPath("appData"), "ADB Studio");
  if (prev === next) return;
  try {
    await stat(join(next, "settings.json"));
    return; // 新目录已有配置，不覆盖
  } catch {
    // 新目录还没有配置，继续
  }
  try {
    await stat(prev);
  } catch {
    return; // 没有旧目录
  }
  await mkdir(next, { recursive: true });
  for (const f of ["settings.json", "scenarios.json", "conn-history.json", "proxy-settings.json"]) {
    try {
      await copyFile(join(prev, f), join(next, f));
    } catch {
      // 旧版本没有这个文件，跳过
    }
  }
  console.log("[migrate] 已把配置从 ADB Studio 迁到 AdbDepot");
}

const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
const devices = new DeviceManager(() => settings.get().adbPath);
const tools = new AdbTools(() => settings.get().adbPath);
const proxies = new ProxyStore(join(app.getPath("userData"), "proxy-settings.json"));
const scenarios = new ScenarioStore(join(app.getPath("userData"), "scenarios.json"));
const connHistory = new ConnHistory(join(app.getPath("userData"), "conn-history.json"));
const recorder = new Recorder(devices);
let win: BrowserWindow | undefined;
/** 托盘图标：有它在，关窗口只是隐藏，进程继续跑。 */
let tray: Tray | undefined;
/** 真正退出（区别于「收进托盘」），关闭事件要靠它放行。 */
let quitting = false;
let balloonShown = false;
/** 只在启动时生效一次：勾了「驻留托盘」就不弹窗口。 */
let startHiddenOnce = false;
const updater = new Updater(() => win);

const mirror = new MirrorManager(
  devices,
  join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "resources", "scrcpy-server"),
  {
    packet: (serial, packet) => win?.webContents.send("mirror:packet", serial, packet),
    size: (serial, w, h) => win?.webContents.send("mirror:size", serial, w, h),
    stopped: (serial, reason) => win?.webContents.send("mirror:stopped", serial, reason),
  },
  () => settings.get().stream,
  () => settings.get().syncClipboard,
);

function proxyChanged(): ProxyState {
  const state = proxies.state();
  win?.webContents.send("proxy:changed", state);
  return state;
}

let yozhTimer: NodeJS.Timeout | undefined;

function scheduleYozhRefresh(): void {
  clearInterval(yozhTimer);
  yozhTimer = undefined;
  const minutes = settings.get().cyberyozhRefreshMin;
  if (minutes <= 0) return;
  yozhTimer = setInterval(() => {
    if (!proxies.state().hasCyberyozhToken) return;
    proxies.refreshCyberyozh().then(proxyChanged, (e) => console.warn("[proxy] автообновление CyberYozh:", e));
  }, minutes * 60_000);
}

async function assignNextProxy(serial: string): Promise<string> {
  const p = proxies.next();
  if (!p) throw new Error(t("err.noProxies"));
  if (!/^https?$/.test(p.type)) throw new Error(t("err.proxyHttpOnly", { type: p.type }));
  if (!isValidHostPort(p.host, p.port)) throw new Error(t("err.proxyBadAddress"));
  const hostPort = `${p.host}:${p.port}`;
  if (!(await devices.setProxy(serial, hostPort))) throw new Error(t("err.proxyNotApplied"));
  void devices.refresh(serial);
  return p.login ? t("err.proxyAuthWarning", { hostPort }) : hostPort;
}

async function clearProxy(serial: string): Promise<void> {
  if (!(await devices.clearProxy(serial))) throw new Error(t("err.proxyNotCleared"));
  void devices.refresh(serial);
}

const runner = new ScenarioRunner({ devices, mirror, scenarios, assignNextProxy, clearProxy });

const PRELOAD = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const RENDERER_HTML = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        { label: "打开数据目录", click: () => void shell.openPath(app.getPath("userData")) },
        { type: "separator" },
        { label: "退出", accelerator: "Alt+F4", role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "重做", accelerator: "CmdOrCtrl+Shift+Z", role: "redo" },
        { type: "separator" },
        { label: "剪切", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "复制", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "粘贴", accelerator: "CmdOrCtrl+V", role: "paste" },
        { label: "全选", accelerator: "CmdOrCtrl+A", role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", role: "reload" },
        { label: "强制重新加载", accelerator: "CmdOrCtrl+Shift+R", role: "forceReload" },
        { label: "开发者工具", accelerator: "F12", role: "toggleDevTools" },
        { type: "separator" },
        { label: "实际大小", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
        { label: "放大", accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
        { label: "缩小", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
        { type: "separator" },
        { label: "全屏", accelerator: "F11", role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", role: "minimize" },
        { label: "关闭", accelerator: "CmdOrCtrl+W", role: "close" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 AdbDepot",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "关于 AdbDepot",
              message: `AdbDepot ${app.getVersion()}`,
              detail: "Android 设备管理工具\n投屏 · 应用 · 文件 · 调试\n\n底层基于 scrcpy 与 Evelin（MIT 协议）",
              buttons: ["好"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  buildMenu();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "AdbDepot",
    backgroundColor: "#0f1115",
    // 先不显示：启动时若勾了「驻留托盘」，直接不弹窗口，避免闪一下。
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    if (startHiddenOnce) {
      startHiddenOnce = false;
      return;
    }
    win?.show();
  });

  // 关窗口 = 收进托盘（可在设置或托盘菜单里关掉）
  win.on("close", (e) => {
    if (quitting || !settings.get().closeToTray) return;
    e.preventDefault();
    hideToTray();
  });

  win.on("minimize", () => {
    if (settings.get().minimizeToTray) hideToTray();
  });

  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (!app.isPackaged) {
    win.webContents.on("console-message", (e) => {
      if (e.level === "warning" || e.level === "error") console.log(`[renderer:${e.level}] ${e.message}`);
    });
  }

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(RENDERER_HTML);

  win.on("closed", () => {
    win = undefined;
    void mirror.stopAll();
  });
}

// ---------- 任务栏驻留 ----------

function trayIcon(): Electron.NativeImage {
  const path = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "build", "icon.png");
  const img = nativeImage.createFromPath(path);
  // 托盘只需要 16px；打包时带的是 512px 大图，缩小省内存也清晰。
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideToTray(): void {
  win?.hide();
  if (balloonShown || !tray) return;
  balloonShown = true;
  // 只提示一次，之后安静待在托盘里。
  tray.displayBalloon({ title: t("tray.balloonTitle"), content: t("tray.balloonBody") });
}

function buildTrayMenu(): void {
  if (!tray) return;
  const s = settings.get();
  const toggle = (key: "closeToTray" | "minimizeToTray" | "autoLaunch" | "startMinimized") => () =>
    void settings.update({ [key]: !settings.get()[key] });

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("tray.show"), click: showWindow },
      { type: "separator" },
      { label: t("set.closeToTray"), type: "checkbox", checked: s.closeToTray, click: toggle("closeToTray") },
      { label: t("set.minimizeToTray"), type: "checkbox", checked: s.minimizeToTray, click: toggle("minimizeToTray") },
      { label: t("set.autoLaunch"), type: "checkbox", checked: s.autoLaunch, click: toggle("autoLaunch") },
      { label: t("set.startMinimized"), type: "checkbox", checked: s.startMinimized, click: toggle("startMinimized") },
      { type: "separator" },
      {
        label: t("tray.quit"),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.setToolTip(t("tray.tooltip"));
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
  } catch (e) {
    // 没有托盘图标不该让应用起不来
    console.warn("[tray] 创建失败:", e);
    return;
  }
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  buildTrayMenu();
}

/** 开机自启。只有打包后的 exe 才注册，否则会把 electron.exe 写进启动项。 */
function applyAutoLaunch(enabled: boolean): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath("exe") });
  } catch (e) {
    console.warn("[tray] 设置开机启动失败:", e);
  }
}

// ---------- 缓存清理 ----------

let cacheTimer: NodeJS.Timeout | undefined;

/**
 * 清一次缓存。
 * @param days 不传就用设置里的保留天数（自动清理）；传 0 表示立刻全清（手动按钮）
 */
async function cleanNow(days?: number): Promise<CacheCleanResult> {
  const d = days ?? settings.get().cacheDays;
  const r = await cleanCache(app.getPath("userData"), d);
  if (r.removed > 0) console.log(`[cache] 清掉 ${r.removed} 个文件，释放 ${(r.freed / 1048576).toFixed(1)} MB`);
  return r;
}

function scheduleCacheClean(): void {
  clearInterval(cacheTimer);
  cacheTimer = setInterval(() => {
    if (settings.get().cacheAutoClean) void cleanNow().catch(() => {});
  }, 12 * 60 * 60 * 1000);
  cacheTimer.unref();
}

function isTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? "";
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  return url.startsWith("file://") && fileURLToPath(url.split("#")[0]!.split("?")[0]!) === RENDERER_HTML;
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isTrustedSender(e)) throw new Error(t("err.untrusted"));
    return fn(...(args as A));
  });
}

function on<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!isTrustedSender(e)) return;
    try {
      const result = fn(...(args as A));
      // 异步失败以前会被 try/catch 漏掉，变成静默无反应（文字输入就是这样）
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((err: unknown) => console.warn(`[ipc] ${channel}:`, err));
      }
    } catch (err) {
      console.warn(`[ipc] ${channel}:`, err);
    }
  });
}

function serials(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(t("err.deviceList"));
  return [...new Set(value.filter((s): s is string => typeof s === "string" && devices.has(s)))];
}

function serial(value: unknown): string {
  if (typeof value !== "string" || !devices.has(value)) throw new Error(t("err.unknownDevice"));
  return value;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(t("err.number"));
  return value;
}

const TOUCH_ACTIONS = new Set(["down", "move", "up"]);
/** The console has no cancel button, so endless commands like `logcat` must not block it forever. */
const SHELL_TIMEOUT = 60_000;

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function registerIpc(): void {
  handle("settings:get", () => settings.get());
  handle("settings:update", (patch: unknown) => settings.update(patch));
  handle("settings:pickAdb", async () => {
    if (!win) return undefined;
    const filters = process.platform === "win32" ? [{ name: "adb", extensions: ["exe"] }] : [];
    const pick = await dialog.showOpenDialog(win, { title: t("dialog.pickAdb"), filters, properties: ["openFile"] });
    return pick.canceled ? undefined : pick.filePaths[0];
  });
  handle("settings:info", () => ({ version: app.getVersion(), dataDir: app.getPath("userData") }));
  handle("settings:openDataDir", async () => {
    await shell.openPath(app.getPath("userData"));
  });
  handle("cache:stat", () => measureCache(app.getPath("userData")));
  // 手动点「立即清理」= 全清，不按天数筛
  handle("cache:clean", () => cleanNow(0));

  handle("devices:list", () => devices.list());
  handle("devices:refresh", (s: unknown) => devices.refresh(serial(s)));

  // ---- 应用管理 ----
  handle("apps:list", (s: unknown) => tools.listApps(serial(s)));
  handle("apps:detail", (s: unknown, pkg: unknown) => tools.appDetail(serial(s), String(pkg)));
  handle("apps:uninstall", (s: unknown, pkg: unknown) => tools.uninstall(serial(s), String(pkg)));
  handle("apps:setEnabled", (s: unknown, pkg: unknown, enable: unknown) =>
    tools.setEnabled(serial(s), String(pkg), enable === true),
  );
  handle("apps:clearData", (s: unknown, pkg: unknown) => tools.clearData(serial(s), String(pkg)));
  handle("apps:forceStop", (s: unknown, pkg: unknown) => tools.forceStop(serial(s), String(pkg)));
  handle("apps:launch", (s: unknown, pkg: unknown) => tools.launchApp(serial(s), String(pkg)));
  handle("apps:installFile", async (s: unknown) => {
    if (!win) return undefined;
    const pick = await dialog.showOpenDialog(win, {
      title: t("actions.installTitle"),
      filters: [{ name: "APK", extensions: ["apk"] }],
      properties: ["openFile"],
    });
    if (pick.canceled || !pick.filePaths[0]) return undefined;
    return tools.raw(["-s", serial(s), "install", "-r", pick.filePaths[0]], 600_000);
  });

  // ---- 文件管理 ----
  handle("files:list", (s: unknown, dir: unknown) => tools.listFiles(serial(s), String(dir || "/sdcard")));
  handle("files:pull", async (s: unknown, remote: unknown) => {
    if (!win) return undefined;
    const pick = await dialog.showOpenDialog(win, { title: t("common.browse"), properties: ["openDirectory", "createDirectory"] });
    if (pick.canceled || !pick.filePaths[0]) return undefined;
    return tools.pullFile(serial(s), String(remote), pick.filePaths[0]);
  });
  handle("files:push", async (s: unknown, remoteDir: unknown) => {
    if (!win) return undefined;
    const pick = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    if (pick.canceled || pick.filePaths.length === 0) return undefined;
    const target = serial(s);
    const out: string[] = [];
    for (const file of pick.filePaths) {
      out.push(await tools.pushFile(target, file, String(remoteDir || "/sdcard")));
    }
    return out.join("\n");
  });
  handle("files:remove", (s: unknown, target: unknown) => tools.removePath(serial(s), String(target)));
  handle("files:makeDir", (s: unknown, target: unknown) => tools.makeDir(serial(s), String(target)));
  handle("files:scanMedia", (s: unknown, target: unknown) => tools.scanMedia(serial(s), String(target)));

  // ---- 无线连接 ----
  handle("wireless:networks", () => tools.networks());
  handle("wireless:mdns", () => tools.mdnsTargets());
  handle("wireless:scan", async (req: unknown) => {
    const r = (req ?? {}) as { cidrs?: unknown; ports?: unknown; timeoutMs?: unknown; concurrency?: unknown };
    return tools.scanWireless(
      {
        cidrs: Array.isArray(r.cidrs) ? r.cidrs.filter((c): c is string => typeof c === "string") : [],
        ports: Array.isArray(r.ports) ? r.ports.filter((p): p is number => typeof p === "number") : [],
        timeoutMs: typeof r.timeoutMs === "number" ? r.timeoutMs : undefined,
        concurrency: typeof r.concurrency === "number" ? r.concurrency : undefined,
      },
      (p) => win?.webContents.send("wireless:progress", p),
    );
  });
  handle("wireless:cancelScan", () => tools.cancelScan());
  handle("wireless:connect", async (ip: unknown, port: unknown) => {
    const res = await tools.connectChecked(String(ip), Number(port) || 5555);
    if (res.ok) void connHistory.add(res.addr);
    return res;
  });
  handle("wireless:pair", async (ip: unknown, pairPort: unknown, code: unknown, connectPort: unknown) => {
    const res = await tools.pairDevice(
      String(ip),
      Number(pairPort),
      String(code),
      connectPort === undefined ? undefined : Number(connectPort),
    );
    if (res.ok && res.state === "device") void connHistory.add(res.addr);
    return res;
  });
  handle("wireless:disconnect", (addr: unknown) => tools.disconnect(String(addr)));
  handle("wireless:disconnectAll", () => tools.disconnectAll());
  handle("wireless:toTcpip", async (s: unknown, port: unknown) => {
    const res = await tools.toTcpip(serial(s), Number(port) || 5555);
    if (res.ok) void connHistory.add(res.addr);
    return res;
  });
  handle("wireless:toUsb", (s: unknown) => tools.toUsb(serial(s)));
  handle("wireless:deviceIp", (s: unknown) => tools.deviceIp(serial(s)));
  handle("wireless:devices", () => tools.adbDevices());
  handle("wireless:diagnose", (ip: unknown, port: unknown) =>
    tools.diagnose(String(ip), Number(port) || 5555),
  );
  handle("wireless:history", () => connHistory.list());
  handle("wireless:forget", (addr: unknown) => connHistory.forget(String(addr)));
  handle("wireless:clearHistory", () => connHistory.clear());

  // ---- 系统信息 ----
  handle("system:props", (s: unknown) => tools.props(serial(s)));
  handle("system:stats", (s: unknown) => tools.stats(serial(s)));

  handle("mirror:start", async (s: unknown) => {
    try {
      return { success: true, ...(await mirror.start(serial(s))) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  handle("mirror:stop", (s: unknown) => (typeof s === "string" ? mirror.stop(s) : undefined));

  // Fire-and-forget so latency doesn't pile up on every pointer move.
  on("control:touch", (list: unknown, ev: unknown) => {
    const e = ev as TouchEvent;
    if (!e || !TOUCH_ACTIONS.has(e.action)) return;
    const targets = serials(list);
    const event: TouchEvent = { action: e.action, x: finite(e.x), y: finite(e.y) };
    recorder.captureTouch(targets, event);
    return mirror.touch(targets, event);
  });
  on("control:scroll", (list: unknown, x: unknown, y: unknown, dx: unknown, dy: unknown) =>
    mirror.scroll(serials(list), finite(x), finite(y), finite(dx), finite(dy)),
  );
  on("control:key", (list: unknown, key: unknown) => {
    if (!NAV_KEYS.includes(key as NavKey)) return;
    const targets = serials(list);
    recorder.captureKey(targets, key as NavKey);
    return mirror.key(targets, key as NavKey);
  });
  // 单向操作：只负责把手机屏幕关掉，返回结果好让界面显示
  handle("control:privacy", () => mirror.setScreenOff());
  handle("control:privacyOff", (list: unknown) => mirror.setScreenOn(serials(list)));

  on("control:text", (list: unknown, text: unknown) => {
    if (typeof text !== "string" || text.length === 0 || text.length > 1000) return;
    const targets = serials(list);
    recorder.captureStep(targets, { type: "text", text });
    return mirror.text(targets, text);
  });

  handle("batch:shell", (list: unknown, command: unknown) => {
    if (typeof command !== "string" || !command.trim()) throw new Error(t("err.emptyCommand"));
    // Intentionally unescaped: an operator console that runs on the phone, not on the host.
    return devices.forEach(serials(list), (s) => devices.shell(s, command, SHELL_TIMEOUT));
  });

  handle("batch:launchApp", (list: unknown, pkg: unknown) => {
    if (typeof pkg !== "string" || !PACKAGE_RE.test(pkg)) throw new Error(t("err.badPackage"));
    const targets = serials(list);
    recorder.captureStep(targets, { type: "launchApp", package: pkg });
    return devices.forEach(targets, (s) => tools.launchApp(s, pkg));
  });

  handle("batch:installApk", async (list: unknown) => {
    const targets = serials(list);
    if (!win) return [];
    const pick = await dialog.showOpenDialog(win, { title: t("dialog.pickApk"), filters: [{ name: "APK", extensions: ["apk"] }], properties: ["openFile"] });
    const file = pick.filePaths[0];
    if (pick.canceled || !file) return [];
    const bytes = new Uint8Array(await readFile(file));
    return devices.forEach(targets, async (s) => {
      const adb = await devices.getAdb(s);
      const remote = `/data/local/tmp/farm-${randomUUID()}.apk`;
      const sync = await adb.sync();
      try {
        await sync.write({ filename: remote, file: streamOf(bytes) });
      } finally {
        await sync.dispose();
      }
      try {
        const out = await devices.shell(s, shellCommand("pm", "install", "-r", "-g", remote));
        if (!out.includes("Success")) throw new Error(out.trim() || t("err.installFailed"));
        return out.trim();
      } finally {
        await devices.shell(s, shellCommand("rm", "-f", remote)).catch(() => {});
      }
    });
  });

  handle("batch:screenshot", async (list: unknown) => {
    const targets = serials(list);
    if (!win) return [];
    const pick = await dialog.showOpenDialog(win, { title: t("dialog.screenshotDir"), properties: ["openDirectory", "createDirectory"] });
    const dir = pick.filePaths[0];
    if (pick.canceled || !dir) return [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return devices.forEach(targets, async (s) => {
      const adb = await devices.getAdb(s);
      const png = await adb.subprocess.noneProtocol.spawnWait("screencap -p");
      const path = join(dir, `${s.replace(/[^\w.-]/g, "_")}_${stamp}.png`);
      await writeFile(path, png);
      return path;
    });
  });

  handle("batch:reboot", (list: unknown) => devices.forEach(serials(list), (s) => devices.shell(s, "reboot").then(() => {})));
  handle("batch:wake", (list: unknown) =>
    devices.forEach(serials(list), (s) => devices.shell(s, "input keyevent KEYCODE_WAKEUP").then(() => {})),
  );

  handle("proxy:state", () => proxies.state());
  handle("proxy:importFile", async () => {
    if (!win) return proxies.state();
    const pick = await dialog.showOpenDialog(win, { title: t("dialog.proxyFile"), filters: [{ name: "Text", extensions: ["txt"] }], properties: ["openFile"] });
    const file = pick.filePaths[0];
    if (!pick.canceled && file) await proxies.importText(await readFile(file, "utf8"));
    return proxyChanged();
  });
  handle("proxy:clearFile", async () => {
    await proxies.clearFileProxies();
    return proxyChanged();
  });
  handle("proxy:setToken", async (token: unknown) => {
    if (typeof token !== "string" || token.length > 512) throw new Error(t("err.badToken"));
    await proxies.setCyberyozhToken(token);
    await proxies.refreshCyberyozh().catch(() => {});
    return proxyChanged();
  });
  handle("proxy:refreshCyberyozh", async () => {
    try {
      await proxies.refreshCyberyozh();
      return { state: proxyChanged() };
    } catch (e) {
      return { state: proxyChanged(), error: e instanceof Error ? e.message : String(e) };
    }
  });

  handle("proxy:assign", (list: unknown) => devices.forEach(serials(list), assignNextProxy));
  handle("proxy:clear", (list: unknown) => devices.forEach(serials(list), clearProxy));
  handle("proxy:test", (list: unknown): Promise<DeviceResult[]> =>
    devices.forEach(serials(list), async (s) => {
      const proxy = await devices.getProxy(s);
      if (!(await devices.shell(s, "command -v curl")).trim()) throw new Error(t("err.noCurl"));
      const args = ["curl", "-s", "-m", "15"];
      if (proxy) args.push("-x", proxy);
      args.push(settings.get().proxyTestUrl);
      const out = (await devices.shell(s, shellCommand(...args))).trim();
      if (!out) throw new Error(t("err.noResponse"));
      return proxy ? t("err.viaProxy", { proxy, out }) : t("err.noProxy", { out });
    }),
  );

  const scenarioError = (e: unknown) => {
    if (isInvalidScenario(e)) return new Error(t("val.invalid", { message: e.message }));
    return e;
  };
  handle("scenarios:list", () => scenarios.list());
  handle("scenarios:save", async (raw: unknown) => {
    try {
      await scenarios.save(raw);
    } catch (e) {
      throw scenarioError(e);
    }
    return scenarios.list();
  });
  handle("scenarios:remove", async (id: unknown) => {
    if (typeof id === "string") await scenarios.remove(id);
    return scenarios.list();
  });
  handle("scenarios:export", async (id: unknown) => {
    const scenario = typeof id === "string" ? scenarios.get(id) : undefined;
    if (!scenario || !win) return false;
    // Bundle nested scenarios so the exported file is self-contained.
    const bundle = new Map([[scenario.id, scenario]]);
    for (let added = true; added; ) {
      added = false;
      for (const s of [...bundle.values()])
        for (const step of s.steps)
          if (step.type === "runScenario" && !bundle.has(step.scenarioId)) {
            const nested = scenarios.get(step.scenarioId);
            if (nested) {
              bundle.set(nested.id, nested);
              added = true;
            }
          }
    }
    const safeName = scenario.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "scenario";
    const pick = await dialog.showSaveDialog(win, { title: t("dialog.exportScenario"), defaultPath: `${safeName}.adbdepot.json`, filters: [{ name: "AdbDepot", extensions: ["json"] }] });
    if (pick.canceled || !pick.filePath) return false;
    await writeFile(pick.filePath, JSON.stringify([...bundle.values()], null, 2));
    return true;
  });
  handle("scenarios:import", async () => {
    if (!win) return { scenarios: scenarios.list(), imported: 0, withShell: 0 };
    const pick = await dialog.showOpenDialog(win, { title: t("dialog.importScenarios"), filters: [{ name: "AdbDepot", extensions: ["json"] }], properties: ["openFile"] });
    const file = pick.filePaths[0];
    if (pick.canceled || !file) return { scenarios: scenarios.list(), imported: 0, withShell: 0 };
    let imported;
    try {
      imported = await scenarios.import(JSON.parse(await readFile(file, "utf8")));
    } catch (e) {
      throw scenarioError(e instanceof SyntaxError ? new Error(t("val.notJson")) : e);
    }
    const withShell = imported.filter((s) => s.steps.some((st) => st.type === "shell")).length;
    return { scenarios: scenarios.list(), imported: imported.length, withShell };
  });
  handle("scenarios:run", (id: unknown, list: unknown) => {
    if (typeof id !== "string") throw new Error(t("err.scenarioNotFound"));
    const targets = serials(list);
    if (recorder.serial && targets.includes(recorder.serial)) throw new Error(t("err.recordingOnDevice"));
    runner.start(id, targets);
  });
  handle("scenarios:stop", (list: unknown) => runner.stop(list === undefined ? undefined : (Array.isArray(list) ? list.filter((s) => typeof s === "string") : [])));
  handle("scenarios:runs", () => runner.list());

  handle("recorder:start", (s: unknown) => {
    const target = serial(s);
    if (runner.isBusy(target)) throw new Error(t("err.runningOnDevice"));
    return recorder.start(target);
  });
  handle("recorder:stop", async () => {
    const target = recorder.serial;
    const info = target ? devices.list().find((d) => d.serial === target) : undefined;
    const scenario = recorder.stop(info?.model ?? target ?? "");
    if (!scenario) return undefined;
    return scenarios.save(scenario);
  });
  handle("recorder:cancel", () => recorder.cancel());

  handle("updates:status", () => updater.status());
  handle("updates:check", () => updater.check(true));
  handle("updates:download", () => updater.download());
  handle("updates:install", () => updater.install());
}

// A second instance would fight over device sessions and the same data files.
if (!app.requestSingleInstanceLock()) app.exit(0);

app.on("second-instance", () => {
  showWindow();
});

app.whenReady().then(async () => {
  // Vite HMR needs inline scripts in dev.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = DEV_URL
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data: blob:"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  registerIpc();
  await migrateUserData();
  await settings.load(langForLocale(app.getLocale()));
  await Promise.all([proxies.load(), scenarios.load(), connHistory.load()]);
  scheduleYozhRefresh();
  settings.onChange((next, prev) => {
    if (next.cyberyozhRefreshMin !== prev.cyberyozhRefreshMin) scheduleYozhRefresh();
    if (
      next.closeToTray !== prev.closeToTray ||
      next.minimizeToTray !== prev.minimizeToTray ||
      next.autoLaunch !== prev.autoLaunch ||
      next.startMinimized !== prev.startMinimized
    ) {
      buildTrayMenu();
    }
    if (next.autoLaunch !== prev.autoLaunch) applyAutoLaunch(next.autoLaunch);
  });

  let known = new Set<string>();
  devices.onChange((list) => {
    const now = new Set(list.map((d) => d.serial));
    for (const s of known) {
      if (now.has(s)) continue;
      mirror.forgetDevice(s);
      runner.stop([s]);
      if (recorder.serial === s) recorder.cancel();
    }
    known = now;
    win?.webContents.send("devices:changed", list);
  });
  runner.onChange((runs) => win?.webContents.send("scenarios:runs", runs));
  recorder.onStatus((status) => win?.webContents.send("recorder:status", status));
  updater.onStatus((status) => win?.webContents.send("updates:status", status));

  createTray();
  applyAutoLaunch(settings.get().autoLaunch);
  // 启动先清一遍过期缓存，之后每 12 小时一次
  if (settings.get().cacheAutoClean) void cleanNow().catch(() => {});
  scheduleCacheClean();
  startHiddenOnce = settings.get().startMinimized;
  createWindow();
  updater.start();

  try {
    await devices.start();
  } catch (e) {
    dialog.showErrorBox("ADB", e instanceof Error ? e.message : String(e));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  clearInterval(yozhTimer);
  clearInterval(cacheTimer);
  runner.stop();
  recorder.cancel();
  void mirror.stopAll();
  void devices.stop();
  updater.installOnQuit();
});

app.on("window-all-closed", () => {
  // 有托盘时关窗口只是隐藏，不该走到这里；走到这里说明窗口真被销毁了。
  if (process.platform !== "darwin" && !tray) app.quit();
});
