import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DeviceInfo, FarmApi, ProxyState, RecordingStatus, RunStatus, ScanProgress, UpdateStatus, VideoPacket } from "@shared/types";

function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api: FarmApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    pickAdbPath: () => ipcRenderer.invoke("settings:pickAdb"),
    info: () => ipcRenderer.invoke("settings:info"),
    openDataDir: () => ipcRenderer.invoke("settings:openDataDir"),
  },
  cache: {
    stat: () => ipcRenderer.invoke("cache:stat"),
    clean: () => ipcRenderer.invoke("cache:clean"),
  },
  devices: {
    list: () => ipcRenderer.invoke("devices:list"),
    refresh: (serial) => ipcRenderer.invoke("devices:refresh", serial),
    onChange: (listener) => subscribe<[DeviceInfo[]]>("devices:changed", listener),
  },
  mirror: {
    start: (serial) => ipcRenderer.invoke("mirror:start", serial),
    stop: (serial) => ipcRenderer.invoke("mirror:stop", serial),
    onPacket: (listener) => subscribe<[string, VideoPacket]>("mirror:packet", listener),
    onSize: (listener) => subscribe<[string, number, number]>("mirror:size", listener),
    onStopped: (listener) => subscribe<[string, string]>("mirror:stopped", listener),
  },
  control: {
    touch: (serials, event) => ipcRenderer.send("control:touch", serials, event),
    scroll: (serials, x, y, dx, dy) => ipcRenderer.send("control:scroll", serials, x, y, dx, dy),
    key: (serials, key) => ipcRenderer.send("control:key", serials, key),
    text: (serials, text) => ipcRenderer.send("control:text", serials, text),
    privacyOff: (serials) => ipcRenderer.invoke("control:privacyOff", serials),
    privacy: (serials) => ipcRenderer.invoke("control:privacy", serials),
  },
  batch: {
    shell: (serials, command) => ipcRenderer.invoke("batch:shell", serials, command),
    launchApp: (serials, pkg) => ipcRenderer.invoke("batch:launchApp", serials, pkg),
    installApk: (serials) => ipcRenderer.invoke("batch:installApk", serials),
    screenshot: (serials) => ipcRenderer.invoke("batch:screenshot", serials),
    reboot: (serials) => ipcRenderer.invoke("batch:reboot", serials),
    wake: (serials) => ipcRenderer.invoke("batch:wake", serials),
  },
  apps: {
    list: (serial) => ipcRenderer.invoke("apps:list", serial),
    detail: (serial, pkg) => ipcRenderer.invoke("apps:detail", serial, pkg),
    uninstall: (serial, pkg) => ipcRenderer.invoke("apps:uninstall", serial, pkg),
    setEnabled: (serial, pkg, enable) => ipcRenderer.invoke("apps:setEnabled", serial, pkg, enable),
    clearData: (serial, pkg) => ipcRenderer.invoke("apps:clearData", serial, pkg),
    forceStop: (serial, pkg) => ipcRenderer.invoke("apps:forceStop", serial, pkg),
    launch: (serial, pkg) => ipcRenderer.invoke("apps:launch", serial, pkg),
    installFile: (serial) => ipcRenderer.invoke("apps:installFile", serial),
  },
  files: {
    list: (serial, dir) => ipcRenderer.invoke("files:list", serial, dir),
    pull: (serial, remote) => ipcRenderer.invoke("files:pull", serial, remote),
    push: (serial, remoteDir) => ipcRenderer.invoke("files:push", serial, remoteDir),
    remove: (serial, target) => ipcRenderer.invoke("files:remove", serial, target),
    makeDir: (serial, target) => ipcRenderer.invoke("files:makeDir", serial, target),
    scanMedia: (serial, target) => ipcRenderer.invoke("files:scanMedia", serial, target),
  },
  wireless: {
    networks: () => ipcRenderer.invoke("wireless:networks"),
    mdns: () => ipcRenderer.invoke("wireless:mdns"),
    scan: (req) => ipcRenderer.invoke("wireless:scan", req),
    cancelScan: () => ipcRenderer.invoke("wireless:cancelScan"),
    onProgress: (listener) => subscribe<[ScanProgress]>("wireless:progress", listener),
    connect: (ip, port) => ipcRenderer.invoke("wireless:connect", ip, port),
    pair: (ip, port, code, connectPort) => ipcRenderer.invoke("wireless:pair", ip, port, code, connectPort),
    disconnect: (addr) => ipcRenderer.invoke("wireless:disconnect", addr),
    disconnectAll: () => ipcRenderer.invoke("wireless:disconnectAll"),
    toTcpip: (serial, port) => ipcRenderer.invoke("wireless:toTcpip", serial, port),
    toUsb: (serial) => ipcRenderer.invoke("wireless:toUsb", serial),
    deviceIp: (serial) => ipcRenderer.invoke("wireless:deviceIp", serial),
    devices: () => ipcRenderer.invoke("wireless:devices"),
    diagnose: (ip, port) => ipcRenderer.invoke("wireless:diagnose", ip, port),
    history: () => ipcRenderer.invoke("wireless:history"),
    forget: (addr) => ipcRenderer.invoke("wireless:forget", addr),
    clearHistory: () => ipcRenderer.invoke("wireless:clearHistory"),
  },
  system: {
    props: (serial) => ipcRenderer.invoke("system:props", serial),
    stats: (serial) => ipcRenderer.invoke("system:stats", serial),
  },
  proxy: {
    state: () => ipcRenderer.invoke("proxy:state"),
    importFile: () => ipcRenderer.invoke("proxy:importFile"),
    clearFileProxies: () => ipcRenderer.invoke("proxy:clearFile"),
    setCyberyozhToken: (token) => ipcRenderer.invoke("proxy:setToken", token),
    refreshCyberyozh: () => ipcRenderer.invoke("proxy:refreshCyberyozh"),
    assign: (serials) => ipcRenderer.invoke("proxy:assign", serials),
    clear: (serials) => ipcRenderer.invoke("proxy:clear", serials),
    test: (serials) => ipcRenderer.invoke("proxy:test", serials),
    onChange: (listener) => subscribe<[ProxyState]>("proxy:changed", listener),
  },
  scenarios: {
    list: () => ipcRenderer.invoke("scenarios:list"),
    save: (scenario) => ipcRenderer.invoke("scenarios:save", scenario),
    remove: (id) => ipcRenderer.invoke("scenarios:remove", id),
    exportFile: (id) => ipcRenderer.invoke("scenarios:export", id),
    importFile: () => ipcRenderer.invoke("scenarios:import"),
    run: (id, serials) => ipcRenderer.invoke("scenarios:run", id, serials),
    stop: (serials) => ipcRenderer.invoke("scenarios:stop", serials),
    runs: () => ipcRenderer.invoke("scenarios:runs"),
    onRuns: (listener) => subscribe<[RunStatus[]]>("scenarios:runs", listener),
  },
  recorder: {
    start: (serial) => ipcRenderer.invoke("recorder:start", serial),
    stop: () => ipcRenderer.invoke("recorder:stop"),
    cancel: () => ipcRenderer.invoke("recorder:cancel"),
    onStatus: (listener) => subscribe<[RecordingStatus | null]>("recorder:status", listener),
  },
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    onStatus: (listener) => subscribe<[UpdateStatus]>("updates:status", listener),
  },
};

contextBridge.exposeInMainWorld("farm", api);
