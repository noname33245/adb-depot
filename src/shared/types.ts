import type { Lang } from "./i18n";

export type DeviceState = "device" | "unauthorized" | "offline";

export interface DeviceInfo {
  serial: string;
  state: DeviceState;
  model?: string;
  brand?: string;
  androidVersion?: string;
  battery?: number;
  /** `settings get global http_proxy`; empty when no proxy is set. */
  proxy?: string;
}

export interface DeviceResult {
  serial: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface GeoFix {
  provider: string;
  lat: number;
  lon: number;
  /** 水平精度，米。 */
  accuracy?: number;
  /** 距现在多久（设备给的原始串，如 +1h2m3s）。 */
  elapsed?: string;
  /** 距今多少秒（用设备 uptime 减出来的，更直观）。 */
  ageSeconds?: number;
}

export interface LocationInfo {
  enabled: boolean;
  mode: number;
  fix: GeoFix | null;
}

export interface ContactEntry {
  name: string;
  number: string;
  /** 号码类型（手机 / 住宅 / 工作…），拿不到就是空串。 */
  type: string;
}

export interface PhotoPage {
  items: PhotoEntry[];
  /** 设备上一共多少张，用来显示进度和判断还有没有下一页。 */
  total: number;
}

export interface PhotoEntry {
  /** 设备上的完整路径。 */
  path: string;
  name: string;
  /** 毫秒时间戳。 */
  time: number;
  /** 原图字节数（拿不到就是 undefined）。 */
  size?: number;
  /** 所在目录（去掉 /sdcard/ 前缀），用来做分组提示。 */
  dir: string;
}

export interface Proxy {
  type: string;
  host: string;
  port: string;
  login: string;
  password: string;
  source: "file" | "cyberyozh";
}

export interface ProxyState {
  proxies: Proxy[];
  hasCyberyozhToken: boolean;
  encryptionAvailable: boolean;
}

export interface MirrorStarted {
  success: boolean;
  width?: number;
  height?: number;
  error?: string;
}

export interface VideoPacket {
  type: "configuration" | "data";
  keyframe?: boolean;
  data: Uint8Array;
}

export type TouchAction = "down" | "move" | "up";

/** Normalized to 0..1 so one touch can be broadcast to devices with different resolutions. */
export interface TouchEvent {
  action: TouchAction;
  x: number;
  y: number;
}

export type NavKey = "back" | "home" | "recents" | "power" | "volume_up" | "volume_down";

/** `t` is milliseconds since touch down. */
export interface GesturePoint {
  t: number;
  action: TouchAction;
  x: number;
  y: number;
}

export interface StepBase {
  id: string;
  enabled: boolean;
  /** Run only on iterations 1, N+1, 2N+1…; unset or 1 means every time. */
  everyNth?: number;
}

export type StepBody =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; duration: number }
  | { type: "gesture"; points: GesturePoint[] }
  | { type: "key"; key: NavKey }
  | { type: "text"; text: string }
  /** Polls `uiautomator dump` for a node whose text or description contains `text`. */
  | { type: "waitText"; text: string; timeoutMs: number }
  | { type: "tapText"; text: string; timeoutMs: number }
  | { type: "wait"; ms: number; maxMs?: number }
  | { type: "launchApp"; package: string }
  | { type: "stopApp"; package: string }
  | { type: "clearAppData"; package: string }
  | { type: "proxyNext" }
  | { type: "proxyClear" }
  | { type: "shell"; command: string }
  | { type: "runScenario"; scenarioId: string };

export type Step = StepBase & StepBody;
export type StepType = StepBody["type"];

export interface Scenario {
  id: string;
  name: string;
  steps: Step[];
  /** 0 repeats until stopped. */
  repeat: number;
  pauseMs: number;
  continueOnError: boolean;
  updatedAt: number;
}

export type RunState = "running" | "done" | "failed" | "stopped";

export interface RunStatus {
  runId: string;
  scenarioId: string;
  scenarioName: string;
  serial: string;
  state: RunState;
  /** 1-based. */
  iteration: number;
  stepIndex: number;
  stepCount: number;
  error?: string;
  startedAt: number;
}

export interface RecordingStatus {
  serial: string;
  startedAt: number;
  events: number;
  /** Whether getevent attached, so touches on the phone itself are recorded too. */
  physical: boolean;
  physicalError?: string;
}

export interface StreamSettings {
  /** Long side of the video, px. */
  maxSize: number;
  /** Mbit/s. */
  bitRate: number;
  maxFps: number;
  stayAwake: boolean;
}

/** 界面主题：固定深色 / 固定浅色 / 跟随 Windows 深色模式。 */
export type ThemeMode = "dark" | "light" | "system";

export interface ThemeState {
  mode: ThemeMode;
  /** Windows 当前是否处于深色模式（只在 mode=system 时决定界面）。 */
  systemDark: boolean;
}

export interface AppSettings {
  language: Lang;
  /** 界面主题，默认深色（保持老版本外观）。 */
  theme: ThemeMode;
  /** False until the user picks a language on first run. */
  languageChosen: boolean;
  /** Ask before reboot and delete. */
  confirmDanger: boolean;
  stream: StreamSettings;
  /** URL fetched with curl on the device to test the proxy. */
  proxyTestUrl: string;
  /** Minutes; 0 disables. */
  cyberyozhRefreshMin: number;
  /** Empty means auto-detect. */
  adbPath: string;
  /** 点窗口关闭按钮时收进任务栏托盘，而不是退出。 */
  closeToTray: boolean;
  /** 点最小化时直接收进托盘。 */
  minimizeToTray: boolean;
  /** 开机自动启动。 */
  autoLaunch: boolean;
  /** 启动后不弹窗口，直接驻留托盘。 */
  /** 启动时自动清理过期缓存。 */
  cacheAutoClean: boolean;
  /** 相册 / 图标同时并发几路取图（1–12）。 */
  transferSlots: number;
  /** 传输限速，单位 KB/s；0 表示不限。 */
  transferLimitKbps: number;
  /** 链路用途：视频优先 / 文件优先（后者会停掉视频流）。 */
  linkMode: "video" | "files";
  /** 缓存保留天数（1–365），超过这个天数的缓存文件会被删掉。 */
  cacheDays: number;
  /** 电脑与手机剪贴板自动互相同步。 */
  syncClipboard: boolean;
}

export interface CacheStat {
  files: number;
  bytes: number;
}

export interface CacheCleanResult extends CacheStat {
  /** 删掉的文件数。 */
  removed: number;
  /** 释放的字节数。 */
  freed: number;
  /** 删不掉的数量（正被占用是正常的）。 */
  failed: number;
}

export interface AppInfo {
  version: string;
  dataDir: string;
}

export type UpdateState = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";

export interface UpdateStatus {
  state: UpdateState;
  current: string;
  latest?: string;
  /** GitHub release page. */
  url?: string;
  /** 0..1 while downloading. */
  progress?: number;
  /** False for dev builds, the portable zip or a read-only install location; the release page is offered instead. */
  canInstall: boolean;
  error?: string;
}

export interface FarmApi {
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    /** undefined when cancelled. */
    pickAdbPath(): Promise<string | undefined>;
    info(): Promise<AppInfo>;
    openDataDir(): Promise<void>;
  };
  theme: {
    state(): Promise<ThemeState>;
    /** 系统深浅色变化（或用户在别处改了主题）时推送。 */
    onChange(listener: (state: ThemeState) => void): () => void;
  };
  cache: {
    /** 当前缓存占用。 */
    stat(): Promise<CacheStat>;
    /** 按设置的天数立即清理一次。 */
    clean(): Promise<CacheCleanResult>;
  };
  devices: {
    list(): Promise<DeviceInfo[]>;
    refresh(serial: string): Promise<DeviceInfo | undefined>;
    onChange(listener: (devices: DeviceInfo[]) => void): () => void;
  };
  link: {
    /** 切换链路用途，会立刻停/起投屏会话。 */
    set(mode: "video" | "files"): Promise<void>;
  };
  mirror: {
    start(serial: string): Promise<MirrorStarted>;
    stop(serial: string): Promise<void>;
    /** 暂停/恢复投屏通道时保持轻量通路（保活，不会让设备掉线）。 */
    setPaused(serials: string[], paused: boolean): Promise<void>;
    onPacket(listener: (serial: string, packet: VideoPacket) => void): () => void;
    onSize(listener: (serial: string, width: number, height: number) => void): () => void;
    onStopped(listener: (serial: string, reason: string) => void): () => void;
    /** 每 2 秒一次的实时帧率与码率。 */
    onStats(listener: (serial: string, stats: { fps: number; kbps: number }) => void): () => void;
  };
  control: {
    touch(serials: string[], event: TouchEvent): void;
    scroll(serials: string[], x: number, y: number, dx: number, dy: number): void;
    key(serials: string[], key: NavKey): void;
    text(serials: string[], text: string): void;
    /** 开启隐私屏（手机黑屏，电脑照常操作）。单向操作。 */
    privacy(serials: string[]): Promise<DeviceResult[]>;
    privacyOff(serials: string[]): Promise<DeviceResult[]>;
  };
  batch: {
    shell(serials: string[], command: string): Promise<DeviceResult[]>;
    launchApp(serials: string[], pkg: string): Promise<DeviceResult[]>;
    installApk(serials: string[]): Promise<DeviceResult[]>;
    screenshot(serials: string[]): Promise<DeviceResult[]>;
    reboot(serials: string[]): Promise<DeviceResult[]>;
    wake(serials: string[]): Promise<DeviceResult[]>;
  };
  contacts: {
    /** 读取整本通讯录（只读，不改动手机数据）。 */
    list(serial: string): Promise<ContactEntry[]>;
  };
  clipboard: {
    /** 写系统剪贴板（渲染层的 clipboard API 被权限策略挡住，走主进程）。 */
    write(text: string): Promise<void>;
  };
  gps: {
    /** 读手机最近一次定位（系统缓存，可能为空）。 */
    get(serial: string): Promise<LocationInfo>;
  };
  gallery: {
    /** 分页列出照片（只读元数据，不下载图片）。refresh 为 true 时丢弃缓存重新扫。 */
    list(
      serial: string,
      offset?: number,
      limit?: number,
      refresh?: boolean,
      opts?: { dir?: string; q?: string },
    ): Promise<PhotoPage>;
    /** 按目录分组（相册下拉用）。 */
    dirs(serial: string): Promise<{ dir: string; count: number }[]>;
    /** 把选中的原图下载到本地目录（弹目录选择框）。 */
    download(serial: string, paths: string[]): Promise<{ dir: string; saved: number; failed: number }>;
    /** 丢弃这台设备排队中的缩略图请求（翻页时用）。 */
    cancel(serial: string): Promise<void>;
    /** 批量缩略图：一条命令取多张，返回拿到的那部分。 */
    thumbs(serial: string, paths: string[]): Promise<{ path: string; data: Uint8Array }[]>;
    /** 单张缩略图（缓存未命中时兜底，会读原图）。 */
    thumb(serial: string, path: string, full?: boolean): Promise<Uint8Array>;
    /** 大图预览，返回 dataURL。 */
    preview(serial: string, path: string): Promise<Uint8Array>;
  };
  apps: {
    /** 应用图标（dataURL），按需取，不下载 APK。 */
    icon(serial: string, pkg: string): Promise<string>;
    /** 把应用 APK 拉到电脑，弹目录选择框。 */
    extract(serial: string, pkg: string, label?: string): Promise<{ ok: boolean; dir?: string; error?: string }>;
    list(serial: string): Promise<AppEntry[]>;
    detail(serial: string, pkg: string): Promise<{ versionName?: string; versionCode?: string; enabled: boolean }>;
    uninstall(serial: string, pkg: string): Promise<string>;
    setEnabled(serial: string, pkg: string, enable: boolean): Promise<string>;
    clearData(serial: string, pkg: string): Promise<string>;
    forceStop(serial: string, pkg: string): Promise<string>;
    /** 启动应用，返回启动了哪个组件。 */
    launch(serial: string, pkg: string): Promise<string>;
    /** 先让用户选 APK，再推给设备安装，返回 adb 输出。 */
    installFile(serial: string): Promise<string | undefined>;
  };
  files: {
    list(serial: string, dir: string): Promise<FileEntry[]>;
    /** 选本地目录，把设备文件拉过去，返回结束提示。 */
    pull(serial: string, remote: string): Promise<string | undefined>;
    /** 选本地文件，推到设备当前目录。 */
    push(serial: string, remoteDir: string): Promise<string | undefined>;
    remove(serial: string, target: string): Promise<string>;
    /** 重命名或移动到新路径。 */
    rename(serial: string, from: string, to: string): Promise<string>;
    /** 复制到新路径。 */
    copy(serial: string, from: string, to: string): Promise<string>;
    makeDir(serial: string, target: string): Promise<string>;
    scanMedia(serial: string, target: string): Promise<string>;
  };
  wireless: {
    /** 本机所有 IPv4 网卡与网段，用于选扫描范围。 */
    networks(): Promise<NetworkInfo[]>;
    /** 电脑移动热点的 SSID / 网段，跨 VLAN 连不上时给引导用。 */
    hotspot(): Promise<HotspotInfo>;
    mdns(): Promise<WirelessTarget[]>;
    /** 发现 IPv6 链路本地可达的 adbd（跨 VLAN 时的直连通道）。 */
    ipv6(ports: number[]): Promise<WirelessTarget[]>;
    scan(req: ScanRequest): Promise<WirelessTarget[]>;
    cancelScan(): Promise<void>;
    onProgress(listener: (p: ScanProgress) => void): () => void;
    /** 连接并轮询到状态落定，返回真实结果（不是 adb 的 "connected" 就算成功）。 */
    connect(ip: string, port: number): Promise<ConnectResult>;
    /** 配对后自动接着连。 */
    pair(ip: string, pairPort: number, code: string, connectPort?: number): Promise<ConnectResult>;
    disconnect(addr: string): Promise<string>;
    disconnectAll(): Promise<string>;
    /** USB 设备切成 TCP 模式并立即连上。 */
    toTcpip(serial: string, port: number): Promise<ConnectResult>;
    /** 切回 USB 模式。 */
    toUsb(serial: string): Promise<string>;
    deviceIp(serial: string): Promise<string>;
    /** `adb devices -l` 原始表，含 offline / unauthorized。 */
    devices(): Promise<AdbDeviceRow[]>;
    /** 端口探活 + ADB 协议指纹 + 同网段判断。 */
    diagnose(ip: string, port: number): Promise<DiagnoseResult>;
    history(): Promise<ConnHistoryItem[]>;
    forget(addr: string): Promise<ConnHistoryItem[]>;
    clearHistory(): Promise<ConnHistoryItem[]>;
  };
  system: {
    props(serial: string): Promise<DeviceProps>;
    stats(serial: string): Promise<DeviceStats>;
    /** 控制通路的往返延迟（ms），用来判断卡顿在链路还是解码。 */
    ping(serial: string): Promise<number>;
  };
  /** 相册 / 文件的后台下载队列。 */
  downloads: {
    /** 弹目录选择框后入队，立即返回加入的条数，不阻塞界面。 */
    enqueue(serial: string, paths: string[]): Promise<{ dir: string; added: number }>;
    list(): Promise<DownloadTask[]>;
    /** 不传 id 就取消全部未开始的任务。 */
    cancel(id?: string): Promise<void>;
    clear(): Promise<void>;
    onChange(listener: (tasks: DownloadTask[]) => void): () => void;
  };
  /** 手机通知同步（dumpsys 轮询，无需手机端授权）。 */
  notifications: {
    /** popup=false 时只在列表里显示，不弹系统通知。 */
    start(serial: string, popup?: boolean): Promise<void>;
    stop(): Promise<void>;
    list(): Promise<PhoneNotification[]>;
    clear(): Promise<void>;
    serial(): Promise<string | undefined>;
    onChange(listener: (items: PhoneNotification[]) => void): () => void;
  };
  /** 屏幕录制：渲染层逐秒把视频分片交给主进程追加写盘。 */
  screenrec: {
    create(serial: string, ext: string): Promise<{ id: string; path: string } | undefined>;
    append(id: string, bytes: Uint8Array): Promise<void>;
    finish(id: string): Promise<string>;
    abort(id: string): Promise<void>;
    reveal(path: string): Promise<void>;
  };
  proxy: {
    state(): Promise<ProxyState>;
    importFile(): Promise<ProxyState>;
    clearFileProxies(): Promise<ProxyState>;
    setCyberyozhToken(token: string): Promise<ProxyState>;
    refreshCyberyozh(): Promise<{ state: ProxyState; error?: string }>;
    assign(serials: string[]): Promise<DeviceResult[]>;
    clear(serials: string[]): Promise<DeviceResult[]>;
    test(serials: string[]): Promise<DeviceResult[]>;
    /** Fires when main changes the list, e.g. on CyberYozh auto-refresh. */
    onChange(listener: (state: ProxyState) => void): () => void;
  };
  scenarios: {
    list(): Promise<Scenario[]>;
    save(scenario: Scenario): Promise<Scenario[]>;
    remove(id: string): Promise<Scenario[]>;
    exportFile(id: string): Promise<boolean>;
    /** `withShell` counts imported scenarios containing shell steps, which deserve a review before running. */
    importFile(): Promise<{ scenarios: Scenario[]; imported: number; withShell: number }>;
    run(id: string, serials: string[]): Promise<void>;
    /** Stops everything when called without arguments. */
    stop(serials?: string[]): Promise<void>;
    runs(): Promise<RunStatus[]>;
    onRuns(listener: (runs: RunStatus[]) => void): () => void;
  };
  recorder: {
    start(serial: string): Promise<RecordingStatus>;
    /** Saves the recording as a new scenario. */
    stop(): Promise<Scenario | undefined>;
    cancel(): Promise<void>;
    onStatus(listener: (status: RecordingStatus | null) => void): () => void;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<void>;
    /** Quits, installs the downloaded update and relaunches. */
    install(): Promise<void>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}

export interface AppEntry {
  packageName: string;
  label: string;
  system: boolean;
  enabled: boolean;
  versionName?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  /** 软链接指向的目标，比如 sdcard0 -> /sdcard。 */
  link?: string;
}

export interface DeviceProps {
  model?: string;
  brand?: string;
  manufacturer?: string;
  androidVersion?: string;
  sdk?: number;
  abi?: string;
  cpu?: string;
  serial?: string;
  resolution?: string;
  density?: string;
  storageTotal?: string;
  storageUsed?: string;
  storageFree?: string;
  uptime?: string;
}

export interface DeviceStats {
  batteryLevel?: number;
  batteryTemp?: number;
  batteryCharging?: boolean;
  memTotal?: number;
  memUsed?: number;
  cpuUsage?: number;
  netRx?: number;
  netTx?: number;
}

export interface WirelessTarget {
  ip: string;
  port: number;
  kind: "mdns" | "scan" | "manual";
  /** mDNS 服务类型，如 `_adb-tls-connect._tcp`。 */
  service?: string;
  /** mDNS 服务名，通常是设备型号。 */
  name?: string;
  /** 明文 adbd 端口可直接连；TLS 端口要先配对。 */
  ready?: boolean;
  /** 该端口是要配对的那个（`_adb-tls-pairing._tcp`）。 */
  pairing?: boolean;
  /** 协议指纹：明文 adbd / TLS 无线调试 / adb 服务端 / 认不出的假响应；
   *  `host` 表示「这台机器在线，但没有任何 ADB 端口开着」（adbd 退回了 USB 模式）。 */
  protocol?: "adbd" | "tls" | "adb-server" | "unknown" | "closed" | "host";
  /** IPv6 链路本地直连条目：`ip` 形如 `[fe80::…%8]`，能绕过 VLAN 隔离。 */
  via6?: boolean;
}

export interface NetworkInfo {
  /** 适配器名，如「WLAN 2」。 */
  name: string;
  address: string;
  /** 网段，如 `172.29.214.0/24`。 */
  cidr: string;
  /** 虚拟机 / VPN / 虚拟网卡，默认不扫。 */
  virtual: boolean;
}

/** Windows 移动热点信息：跨 VLAN 被隔离时，引导手机切到同一二层网络。 */
export interface HotspotInfo {
  ssid?: string;
  on: boolean;
  cidr?: string;
  address?: string;
}

export interface ScanRequest {
  /** 要扫的网段，`a.b.c.0/24` 形式。 */
  cidrs: string[];
  ports: number[];
  timeoutMs?: number;
  concurrency?: number;
  /** 扫完本网段后继续扩扫同一 /16 的相邻网段，默认开。 */
  expandNearby?: boolean;
}

export interface ScanProgress {
  done: number;
  total: number;
  found: number;
  running: boolean;
  /** 本次新命中的地址，让界面边扫边出，不用等整轮结束。 */
  targets?: WirelessTarget[];
  /** `nearby` 时 total 会变大、进度条回退，界面要说明原因。 */
  phase?: "primary" | "nearby";
}

export interface ConnectResult {
  ok: boolean;
  addr: string;
  state: string;
  message: string;
  hint?: string;
}

export interface DiagnoseResult {
  ip: string;
  port: number;
  portOpen: boolean;
  /** `adbd` 明文 / `tls` 无线调试 / `adb-server` / `unknown` 中间盒假响应 / `closed`。 */
  protocol: "adbd" | "tls" | "adb-server" | "unknown" | "closed";
  /** 与指定本机地址是否同网段。 */
  sameSubnet: boolean;
  localAddress?: string;
  verdict: string;
  hint?: string;
}

export interface AdbDeviceRow {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  wireless: boolean;
}

export interface ConnHistoryItem {
  addr: string;
  label?: string;
  lastSeen: number;
  count: number;
}

/** 下载队列里的一项。dir 是本次选的保存目录。 */
export interface DownloadTask {
  id: string;
  serial: string;
  path: string;
  name: string;
  dir: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  error?: string;
  saved?: string;
}

/** 从手机通知栏读出来的一条通知（只读，不改动手机）。 */
export interface PhoneNotification {
  id: string;
  serial: string;
  pkg: string;
  title: string;
  text: string;
  at: number;
}
