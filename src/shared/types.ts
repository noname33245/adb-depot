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

export interface AppSettings {
  language: Lang;
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
  startMinimized: boolean;
  /** 启动时自动清理过期缓存。 */
  cacheAutoClean: boolean;
  /** 缓存保留天数（1–365），超过这个天数的缓存文件会被删掉。 */
  cacheDays: number;
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
  mirror: {
    start(serial: string): Promise<MirrorStarted>;
    stop(serial: string): Promise<void>;
    onPacket(listener: (serial: string, packet: VideoPacket) => void): () => void;
    onSize(listener: (serial: string, width: number, height: number) => void): () => void;
    onStopped(listener: (serial: string, reason: string) => void): () => void;
  };
  control: {
    touch(serials: string[], event: TouchEvent): void;
    scroll(serials: string[], x: number, y: number, dx: number, dy: number): void;
    key(serials: string[], key: NavKey): void;
    text(serials: string[], text: string): void;
  };
  batch: {
    shell(serials: string[], command: string): Promise<DeviceResult[]>;
    launchApp(serials: string[], pkg: string): Promise<DeviceResult[]>;
    installApk(serials: string[]): Promise<DeviceResult[]>;
    screenshot(serials: string[]): Promise<DeviceResult[]>;
    reboot(serials: string[]): Promise<DeviceResult[]>;
    wake(serials: string[]): Promise<DeviceResult[]>;
  };
  apps: {
    list(serial: string): Promise<AppEntry[]>;
    detail(serial: string, pkg: string): Promise<{ versionName?: string; versionCode?: string; enabled: boolean }>;
    uninstall(serial: string, pkg: string): Promise<string>;
    setEnabled(serial: string, pkg: string, enable: boolean): Promise<string>;
    clearData(serial: string, pkg: string): Promise<string>;
    forceStop(serial: string, pkg: string): Promise<string>;
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
    makeDir(serial: string, target: string): Promise<string>;
    scanMedia(serial: string, target: string): Promise<string>;
  };
  wireless: {
    /** 本机所有 IPv4 网卡与网段，用于选扫描范围。 */
    networks(): Promise<NetworkInfo[]>;
    mdns(): Promise<WirelessTarget[]>;
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

export interface ScanRequest {
  /** 要扫的网段，`a.b.c.0/24` 形式。 */
  cidrs: string[];
  ports: number[];
  timeoutMs?: number;
  concurrency?: number;
}

export interface ScanProgress {
  done: number;
  total: number;
  found: number;
  running: boolean;
  /** 本次新命中的地址，让界面边扫边出，不用等整轮结束。 */
  targets?: WirelessTarget[];
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
