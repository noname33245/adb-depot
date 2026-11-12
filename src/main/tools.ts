import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { linkLocalNeighbors, probeAdb6, v6Serial } from "./ipv6link";
import type {
  AdbDeviceRow,
  AppEntry,
  ConnectResult,
  DeviceProps,
  DeviceStats,
  DiagnoseResult,
  FileEntry,
  HotspotInfo,
  NetworkInfo,
  ScanProgress,
  ScanRequest,
  WirelessTarget,
} from "@shared/types";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;

/** 虚拟机 / VPN / 虚拟网卡，默认不扫。 */
const VIRTUAL_RE = /vmware|virtualbox|hyper-v|vethernet|loopback|bluetooth|npcap|tap-|wsl|docker|tailscale|zerotier|utun|vpn|radmin/i;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 探针能分辨的协议（不含 `host`，那是 ARP 补探测出来的在线主机）。 */
type ProbedProtocol = "adbd" | "tls" | "adb-server" | "unknown" | "closed";

function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return 0;
  let out = 0;
  for (const p of parts) out = ((out << 8) | (Number(p) & 255)) >>> 0;
  return out >>> 0;
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

/** 掩码位数：优先用 netmask，没有就从 CIDR 里取。 */
function prefixOf(netmask?: string, cidr?: string): number {
  if (cidr && cidr.includes("/")) return Number(cidr.split("/")[1]) || 24;
  if (!netmask) return 24;
  const mask = ipToInt(netmask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((mask >>> i) & 1) bits++;
    else break;
  }
  return bits || 24;
}

function inSameSubnet(a: string, b: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(a) & mask) >>> 0) === ((ipToInt(b) & mask) >>> 0);
}

/** 展开网段内可用主机地址，超过上限就截断，避免误填大网段时爆内存。 */
function expandCidr(cidr: string, maxHosts: number): string[] {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw ?? 24);
  if (!base || Number.isNaN(bits) || bits < 8 || bits > 32) return [];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ipToInt(base) & mask) >>> 0;
  const size = bits >= 31 ? 0 : 2 ** (32 - bits);
  const first = bits >= 31 ? net : net + 1;
  const last = bits >= 31 ? net + (bits === 32 ? 0 : 1) : net + size - 2;
  const out: string[] = [];
  for (let n = first; n <= last && out.length < maxHosts; n++) out.push(intToIp(n));
  return out;
}

/**
 * 同一 /16 内与给定网段相邻的块。
 *
 * 校园网 / 企业网经常把一个 /16 切成很多 /21，手机和电脑因此不在同一个广播域：
 * 直连能通（走三层路由），但按网卡网段展开永远扫不到。
 * 这里按同前缀大小向两侧扩几块，能把同一片地址里的设备捞出来。
 */
function neighborCidrs(cidrs: string[], span: number, budget: number): string[] {
  const out: string[] = [];
  const seen = new Set(cidrs);
  // 大块网段（/21 之类）先分配预算：热点 /24 要是排在前面，会先把额度吃光，
  // 结果真正要找的隔壁 /21 反而一块都扩不出去。
  const ordered = [...cidrs].sort((a, b) => Number(a.split("/")[1] ?? 24) - Number(b.split("/")[1] ?? 24));

  for (const cidr of ordered) {
    const [base, bitsRaw] = cidr.split("/");
    const bits = Number(bitsRaw ?? 24);
    if (!base || Number.isNaN(bits) || bits < 20 || bits > 30) continue;

    const mask = (0xffffffff << (32 - bits)) >>> 0;
    const net = (ipToInt(base) & mask) >>> 0;
    const size = 2 ** (32 - bits);

    for (let k = 1; k <= span; k++) {
      for (const dir of [1, -1]) {
        if (budget < size) break;
        const cand = net + dir * k * size;
        if (cand < 0 || cand > 0xffffffff) continue;
        // 只在同一个 /16 里扩，跨大段没意义
        if (cand >>> 16 !== net >>> 16) continue;
        const next = `${intToIp(cand >>> 0)}/${bits}`;
        if (seen.has(next)) continue;
        seen.add(next);
        out.push(next);
        budget -= size;
      }
    }
  }
  return out;
}

/** ADB 明文握手包（CNXN），用来从回包里认协议。 */
function cnxnPacket(): Buffer {
  const cmd = 0x4e584e43; // 'CNXN'
  const payload = Buffer.from("host::\0", "utf8");
  const buf = Buffer.alloc(24 + payload.length);
  buf.writeUInt32LE(cmd, 0);
  buf.writeUInt32LE(0x01000000, 4); // A_VERSION
  buf.writeUInt32LE(4096, 8); // A_MAXDATA
  buf.writeUInt32LE(payload.length, 12);
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  buf.writeUInt32LE(sum, 16);
  buf.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  payload.copy(buf, 24);
  return buf;
}

/** WinGet 装的 scrcpy 自带 adb，目录名带版本号，所以要扫一遍。 */
function wingetAdb(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const base = join(local, "Microsoft", "WinGet", "Packages", "Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .filter((name) => name.startsWith("scrcpy-win64"))
      .map((name) => join(base, name, "adb.exe"))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

function sdkAdb(): string[] {
  const local = process.env.LOCALAPPDATA;
  return local ? [join(local, "Android", "Sdk", "platform-tools", "adb.exe")] : [];
}

export class AdbTools {
  /** 空字符串表示自动探测。 */
  constructor(private readonly adbPath: () => string = () => "") {}

  #candidates(): string[] {
    const custom = this.adbPath();
    const list: string[] = [];
    if (custom) list.push(custom);
    list.push(...wingetAdb(), ...sdkAdb(), "adb.exe", "adb");
    return list;
  }

  bin(): string {
    for (const c of this.#candidates()) {
      if (c === "adb" || c === "adb.exe") return c;
      if (existsSync(c)) return c;
    }
    return "adb.exe";
  }

  async raw(args: string[], timeoutMs = 30_000): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(this.bin(), args, {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return `${stdout}${stderr}`.trim();
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const text = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      throw new Error(text || err.message || "adb 执行失败");
    }
  }

  async shell(serial: string, command: string, timeoutMs = 30_000): Promise<string> {
    return this.raw(["-s", serial, "shell", command], timeoutMs);
  }

  /** 不抛异常的执行，拿退出码和两路输出。列目录这种「部分失败」的场景要用它。 */
  async probeRaw(args: string[], timeoutMs = 30_000): Promise<{ out: string; err: string; code: number }> {
    try {
      const { stdout, stderr } = await execFileAsync(this.bin(), args, {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { out: stdout, err: stderr, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
      return { out: err.stdout ?? "", err: err.stderr ?? err.message ?? "", code: err.code ?? 1 };
    }
  }

  // ---------- 应用管理 ----------

  async listApps(serial: string): Promise<AppEntry[]> {
    const out = await this.shell(serial, "pm list packages -3; echo '---SYS---'; pm list packages -s", 60_000);
    const [userPart = "", sysPart = ""] = out.split("---SYS---");
    const parse = (text: string): string[] =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("package:"))
        .map((l) => l.slice("package:".length).trim())
        .filter(Boolean);
    const user = parse(userPart);
    const system = parse(sysPart);
    const seen = new Set<string>();
    const list: AppEntry[] = [];
    for (const pkg of user) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      list.push({ packageName: pkg, label: pkg, system: false, enabled: true });
    }
    for (const pkg of system) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      list.push({ packageName: pkg, label: pkg, system: true, enabled: true });
    }
    list.sort((a, b) => a.packageName.localeCompare(b.packageName));
    return list;
  }

  async appDetail(serial: string, pkg: string): Promise<{ versionName?: string; versionCode?: string; enabled: boolean }> {
    const out = await this.shell(
      serial,
      `dumpsys package ${pkg} | grep -E 'versionName|versionCode|enabled=' | head -5`,
    );
    const versionName = /versionName=(\S+)/.exec(out)?.[1];
    const versionCode = /versionCode=(\d+)/.exec(out)?.[1];
    const enabled = !/enabled=false/.test(out);
    return { versionName, versionCode, enabled };
  }

  async uninstall(serial: string, pkg: string): Promise<string> {
    const out = await this.raw(["-s", serial, "shell", "pm", "uninstall", "--user", "0", pkg]);
    if (!/Success/i.test(out)) throw new Error(out || "卸载失败");
    return out;
  }

  async setEnabled(serial: string, pkg: string, enable: boolean): Promise<string> {
    const action = enable ? "enable" : "disable-user";
    const out = await this.raw(["-s", serial, "shell", "pm", action, "--user", "0", pkg]);
    if (!/new state|Success/i.test(out)) throw new Error(out || "操作失败");
    return out;
  }

  async clearData(serial: string, pkg: string): Promise<string> {
    const out = await this.raw(["-s", serial, "shell", "pm", "clear", pkg]);
    if (!/Success/i.test(out)) throw new Error(out || "清除失败");
    return out;
  }

  async forceStop(serial: string, pkg: string): Promise<string> {
    return this.raw(["-s", serial, "shell", "am", "force-stop", pkg]);
  }

  // ---------- 文件管理 ----------

  async listFiles(serial: string, dir: string): Promise<FileEntry[]> {
    const safe = dir.replace(/"/g, "");
    // toybox 的 ls 遇到符号链接参数（/sdcard 就是链接）只打印链接行，不列内容；
    // 补一个结尾斜杠才会跟随进去。这是文件面板一直是空/只有一行链接的原因。
    const target = safe.endsWith("/") ? safe : `${safe}/`;
    // ls 在部分子项没权限时仍会输出能读的内容，但退出码非 0。
    // 直接 throw 会把「能看的目录」也判成失败，所以这里自己拿输出。
    const { out, err, code } = await this.probeRaw(["-s", serial, "shell", `ls -la "${target}"`], 30_000);
    const rows: FileEntry[] = [];
    // 兼容 toybox/busybox：类型+9 位权限、链接数、属主、属组、大小、日期、时间、名字
    const re = /^([dl-])[rwxsStT-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/;
    for (const line of out.split("\n")) {
      const m = re.exec(line.trim());
      if (!m) continue;
      const kind = m[1] ?? "-";
      const size = m[2] ?? "0";
      const date = m[3] ?? "";
      const time = m[4] ?? "";
      let name = (m[5] ?? "").trim();
      if (!name || name === "." || name === ".." || name.startsWith("total ")) continue;

      // 软链接形如 "sdcard0 -> /sdcard"，不要把它整个当成文件名
      let link: string | undefined;
      const arrow = name.indexOf(" -> ");
      if (kind === "l" && arrow > 0) {
        link = name.slice(arrow + 4).trim();
        name = name.slice(0, arrow).trim();
      }
      if (!name) continue;

      const mtime = Date.parse(`${date}T${time}:00`) || 0;
      rows.push({
        name,
        path: `${safe.replace(/\/$/, "")}/${name}`,
        isDir: kind === "d",
        // 链接指向目录时按目录处理，点进去才符合直觉
        link,
        size: Number(size) || 0,
        mtime,
      });
    }
    if (rows.length === 0) {
      const text = `${out}\n${err}`;
      if (/Permission denied/i.test(text)) {
        throw new Error(`没有权限访问 ${safe}（Android 11+ 屏蔽了 shell 用户对这个目录的读取）`);
      }
      if (/No such file or directory/i.test(text)) {
        throw new Error(`目录不存在：${safe}`);
      }
      if (/Not a directory/i.test(text)) {
        throw new Error(`这不是目录：${safe}`);
      }
      if (code !== 0 && err.trim()) throw new Error(err.trim().split("\n")[0] ?? "读取目录失败");
    }
    rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return rows;
  }

  /**
   * 下载文件到本地目录。
   *
   * Windows 版 adb.exe 是按系统 ANSI 码页建本地文件的，碰到中文文件名会直接
   * `cannot create ...: Illegal byte sequence`，等于带中文名的文件一个都存不下来。
   * 所以先拉到同目录下的纯 ASCII 临时文件，再用 Node 改名 —— Node 走 UTF-16，
   * 中文、日文、emoji 都没问题。
   */
  async pullFile(serial: string, remote: string, localDir: string): Promise<string> {
    const name = basename(remote.replace(/\/+$/, "")) || "file";
    const dest = join(localDir, name);
    // 临时文件放在系统临时目录：目标目录名本身也可能含中文，
    // 放在里面同样会触发 adb.exe 的码页问题。
    const tmp = join(tmpdir(), `adbpull-${randomUUID()}.tmp`);
    try {
      await this.raw(["-s", serial, "pull", remote, tmp], 300_000);
      try {
        await rename(tmp, dest);
      } catch {
        // 跨盘时 rename 会失败（EXDEV），退回复制再删
        await copyFile(tmp, dest);
      }
      return `已保存到 ${dest}`;
    } finally {
      // 失败时别留下半截临时文件
      await unlink(tmp).catch(() => {});
    }
  }

  /**
   * 上传本地文件到手机目录。同理：本地路径含中文时 adb.exe 读不了，
   * 先复制成 ASCII 临时文件再推，远程仍用原文件名。
   */
  async pushFile(serial: string, localPath: string, remoteDir: string): Promise<string> {
    const ascii = /^[\x20-\x7e]+$/.test(localPath);
    const remote = `${remoteDir.replace(/\/+$/, "")}/${basename(localPath)}`;
    if (ascii) return this.raw(["-s", serial, "push", localPath, remote], 300_000);
    const tmp = join(tmpdir(), `adbpull-${randomUUID()}${extname(localPath)}`);
    try {
      await copyFile(localPath, tmp);
      return await this.raw(["-s", serial, "push", tmp, remote], 300_000);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /**
   * 删除设备上的文件/目录。
   *
   * 不能直接 `shell rm -rf` 然后看退出码：/sdcard 是 FUSE 挂载，
   * 目录里只要有一个文件属于别的应用（或正被占用），rm 就会返回非 0，
   * 但其余内容其实已经删掉了。所以以「路径是否还存在」为准，并把真实原因带出来。
   */
  /**
   * 启动应用。
   *
   * 先解析启动组件再 `am start`，比 monkey 稳：monkey 在部分 ROM 上会直接 abort，
   * 而且不会说明是「包不存在」还是「没有启动入口」。
   */
  async launchApp(serial: string, pkg: string): Promise<string> {
    if (!/^[A-Za-z0-9._]+$/.test(pkg)) throw new Error(`包名不合法：${pkg}`);
    const resolved = await this.probeRaw(
      ["-s", serial, "shell", `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null | tail -n 1`],
      20_000,
    );
    const comp = resolved.out.trim().split(/\s+/).pop() ?? "";

    if (comp.includes("/")) {
      const r = await this.probeRaw(["-s", serial, "shell", `am start -W -n ${comp} 2>&1`], 30_000);
      const text = `${r.out}${r.err}`.trim();
      if (/Error|Exception|does not exist/i.test(text)) {
        throw new Error(`启动失败：${text.split("\n").map((l) => l.trim()).find(Boolean) ?? text}`);
      }
      return `已启动 ${comp}`;
    }

    // 兜底：个别 ROM 的 cmd package 输出不可用
    const m = await this.probeRaw(
      ["-s", serial, "shell", `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`],
      30_000,
    );
    const out = `${m.out}${m.err}`;
    if (/No activities found|monkey aborted/i.test(out)) {
      throw new Error(`包 ${pkg} 没有可用的启动入口（可能已被停用或没装）`);
    }
    return "已启动";
  }

  async removePath(serial: string, target: string): Promise<string> {
    const safe = target.replace(/"/g, "");
    const exists = async (): Promise<boolean> => {
      const r = await this.probeRaw(["-s", serial, "shell", `[ -e "${safe}" ] && echo yes || echo no`], 20_000);
      return /yes/.test(r.out);
    };

    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.probeRaw(["-s", serial, "shell", `rm -rf "${safe}" 2>&1`], 120_000);
      last = `${r.out}${r.err}`.trim();
      if (!(await exists())) return "已删除";
      // 第一次失败可能是文件刚被释放，重试一次
      if (attempt === 0) await sleep(400);
    }

    if (/Permission denied|Operation not permitted/i.test(last)) {
      throw new Error(`没有权限删除 ${safe}：目录里有属于其他应用的文件（Android 11+ 的存储限制），可以先在手机上停用那个应用再删`);
    }
    if (/Read-only file system/i.test(last)) throw new Error(`${safe} 是只读系统目录，删不了`);
    const first = last.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("rm:"));
    throw new Error(`删除失败：${first || last.split("\n")[0] || "未知原因"}`);
  }

  /** 重命名 / 移动到另一个路径（同一个 mv，目标可以带目录）。 */
  async renamePath(serial: string, from: string, to: string): Promise<string> {
    const a = from.replace(/"/g, "");
    const b = to.replace(/"/g, "");
    return this.shell(serial, `mv "${a}" "${b}" && echo ok`);
  }

  /** 复制到目标路径（目录要已存在，cp 不会自动建目录）。 */
  async copyPath(serial: string, from: string, to: string): Promise<string> {
    const a = from.replace(/"/g, "");
    const b = to.replace(/"/g, "");
    return this.shell(serial, `cp -r "${a}" "${b}" && echo ok`);
  }

  async makeDir(serial: string, target: string): Promise<string> {
    return this.shell(serial, `mkdir -p "${target.replace(/"/g, "")}"`);
  }

  /** 推完文件后触发媒体库扫描，相册里才能立刻看到。 */
  async scanMedia(serial: string, target: string): Promise<string> {
    return this.shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://"${target.replace(/"/g, "")}"`);
  }

  // ---------- 无线连接 ----------

  #scanSeq = 0;

  /** 本机所有 IPv4 网卡与网段。 */
  networks(): NetworkInfo[] {
    const out: NetworkInfo[] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.family !== "IPv4" || info.internal) continue;
        if (info.address === "0.0.0.0" || info.address.startsWith("169.254.")) continue;
        const bits = prefixOf(info.netmask);
        const net = intToIp((ipToInt(info.address) & (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)) >>> 0);
        out.push({ name, address: info.address, cidr: `${net}/${bits}`, virtual: VIRTUAL_RE.test(name) });
      }
    }
    return out;
  }

  /** mDNS 发现的无线调试服务，含明文端口与需要配对的端口。 */
  async mdnsTargets(): Promise<WirelessTarget[]> {
    let out = "";
    try {
      out = await this.raw(["mdns", "services"], 10_000);
    } catch {
      return [];
    }
    const targets: WirelessTarget[] = [];
    const seen = new Set<string>();
    for (const line of out.split("\n")) {
      const m = /^(\S+)\s+(_adb[-a-z]*\._tcp)\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(line.trim());
      // 老版本 adb 不带服务名，退一步只抓类型和地址
      const n = m ?? /^\s*(?:\S+\s+)?(_adb[-a-z]*\._tcp)\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(line.trim());
      if (!n) continue;
      const hasName = n.length === 5;
      const service = hasName ? n[2]! : n[1]!;
      const ip = hasName ? n[3]! : n[2]!;
      const port = Number(hasName ? n[4] : n[3]);
      const key = `${ip}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        ip,
        port,
        kind: "mdns",
        service,
        name: hasName ? n[1]! : undefined,
        pairing: service.includes("pairing"),
        ready: service === "_adb._tcp",
      });
    }
    return targets;
  }

  /**
   * Windows 移动热点信息。跨 VLAN 被隔离时，让手机切到这个热点就能回到同一二层网络。
   * SSID 走 WinRT 读，密码系统不给明文，界面只提示用户去系统设置里看。
   */
  async hotspotInfo(): Promise<HotspotInfo> {
    const nets = this.networks();
    const ap =
      nets.find((n) => /Wi-Fi Direct|本地连接\s*\*|Hosted Network|热点/i.test(n.name) && /^192\.168\./.test(n.address)) ??
      nets.find((n) => n.address.startsWith("192.168.137."));
    let ssid: string | undefined;
    let on = false;
    if (process.platform === "win32") {
      try {
        const script = [
          "[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]|Out-Null;",
          "[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]|Out-Null;",
          "$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();",
          "$t=[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($p);",
          "$c=$t.GetCurrentAccessPointConfiguration();",
          'Write-Output ("{0}|{1}" -f $c.Ssid,$t.TetheringOperationalState)',
        ].join("");
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          timeout: 8_000,
          windowsHide: true,
        });
        const last = stdout.trim().split(/\r?\n/).pop() ?? "";
        const [name, state] = last.split("|");
        if (name && name.trim() !== "undefined") ssid = name.trim();
        on = /^(on|1)$/i.test((state ?? "").trim());
      } catch {
        // 读不到 WinRT 不影响网段，界面仍可手动填
      }
    }
    return { ssid, on, cidr: ap?.cidr, address: ap?.address };
  }

  async cancelScan(): Promise<void> {
    this.#scanSeq++;
  }

  /** 扫指定网段的 ADB 端口，同时用协议指纹剔除网关的假响应。 */
  async scanWireless(req: ScanRequest, onProgress?: (p: ScanProgress) => void): Promise<WirelessTarget[]> {
    const seq = ++this.#scanSeq;
    const rawCidrs = req.cidrs.length > 0 ? req.cidrs : this.networks().filter((n) => !n.virtual).map((n) => n.cidr);
    // 小网段优先（热点是 /24，校园网常是 /21）：先扫完小的，结果出得快。
    const cidrs = [...rawCidrs].sort((a, b) => (Number(a.split("/")[1] ?? 24) < Number(b.split("/")[1] ?? 24) ? 1 : -1));
    const ports = [...new Set((req.ports.length > 0 ? req.ports : [5555]).filter((p) => p > 0 && p < 65536))];
    const timeout = Math.max(200, Math.min(4000, req.timeoutMs ?? 500));
    const concurrency = Math.max(4, Math.min(512, req.concurrency ?? 160));

    /** 按 CIDR 展开主机，去重。 */
    const expandAll = (list: string[]): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const cidr of list) {
        for (const h of expandCidr(cidr, 4096)) {
          if (seen.has(h)) continue;
          seen.add(h);
          out.push(h);
        }
      }
      return out;
    };

    const found: WirelessTarget[] = [];
    let done = 0;
    let total = 0;
    /** 本网段 / 扩扫相邻网段，界面据此解释「进度条为什么突然变短」。 */
    let phase: "primary" | "nearby" = "primary";
    /** 上次进度之后新命中的地址，随进度一起推给界面。 */
    let pending: WirelessTarget[] = [];

    /**
     * 扫一批主机，进度按累计值推进。
     * 扩展轮可以用更短的超时、更高的并发 —— 那些地址本来就不在本地广播域，
     * 慢试探没有意义，快速排除更划算。
     */
    const sweep = async (
      list: string[],
      opts: { timeoutMs?: number; concurrency?: number } = {},
    ): Promise<void> => {
      const t = opts.timeoutMs ?? timeout;
      const c = opts.concurrency ?? concurrency;
      const jobs: Array<{ ip: string; port: number }> = [];
      for (const ip of list) for (const port of ports) jobs.push({ ip, port });
      if (jobs.length === 0) return;
      total += jobs.length;

      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (this.#scanSeq !== seq) return;
          const index = cursor++;
          const job = jobs[index];
          if (!job) return;
          const probe = await this.#probeAdb(job.ip, job.port, t);
          done++;
          if (probe.open) {
            const hit: WirelessTarget = {
              ip: job.ip,
              port: job.port,
              kind: "scan",
              protocol: probe.protocol,
              ready: probe.protocol === "adbd",
            };
            found.push(hit);
            pending.push(hit);
          }
          if (pending.length > 0 || done % 40 === 0 || done === total) {
            onProgress?.({ done, total, found: found.length, running: done < total, targets: pending, phase });
            pending = [];
          }
        }
      };

      onProgress?.({ done, total, found: found.length, running: true, targets: [], phase });
      await Promise.all(Array.from({ length: Math.min(c, jobs.length) }, () => worker()));
    };

    // 手机 IPv4 被 VLAN 网关吞包时，端口扫描永远发现不了它；
    // 链路本地 IPv6 是二层直达，和端口扫描并行跑，谁先出来先显示谁。
    const v6Promise = this.ipv6Targets(ports).catch(() => [] as WirelessTarget[]);
    void v6Promise.then((list) => {
      if (this.#scanSeq !== seq || list.length === 0) return;
      const merged = list.filter((t) => !found.some((f) => f.ip === t.ip && f.port === t.port));
      if (merged.length === 0) return;
      found.push(...merged);
      pending.push(...merged);
      onProgress?.({ done, total, found: found.length, running: true, targets: pending, phase });
      pending = [];
    });

    const primary = expandAll(cidrs);
    if (primary.length === 0) return v6Promise;
    await sweep(primary);

    let cancelled = this.#scanSeq !== seq;
    if (cancelled) return found;

    // 扫完本网段，默认继续扩到同一 /16 的相邻网段。
    // 校园网把 172.29.0.0/16 切成很多 /21，手机常落在隔壁块里。
    // 以前是「本段一个真 adbd 都没有才扩」，结果本段随便有台别人的 adbd
    // 就把扩扫短路了 —— 本段命中并不能说明要找的设备也在本段。
    if (req.expandNearby !== false) {
      phase = "nearby";
      const near = neighborCidrs(cidrs, 3, 8192);
      const extra = expandAll(near.filter((c) => !cidrs.includes(c)));
      if (extra.length > 0) {
        onProgress?.({ done, total, found: found.length, running: true, targets: [], phase });
        await sweep(extra, { timeoutMs: 280, concurrency: 240 });
      }
    }

    cancelled = this.#scanSeq !== seq;
    onProgress?.({ done, total, found: found.length, running: false, targets: [], phase });
    if (cancelled) return found;

    // 端口扫描之外再补一轮在线主机探测：
    // 手机 adbd 退回 USB 模式后 5555 会关掉，纯端口扫描必然「一台都扫不到」，
    // 但它在二层还活着 —— ARP 表里就有它。不列出来用户会以为扫描坏了。
    // 已经有真实 ADB 的网段跳过，免得列表被一堆无关主机塞满。
    const quietCidrs = cidrs.filter((c) => {
      const [base, bitsRaw] = c.split("/");
      const bits = Number(bitsRaw ?? 24);
      if (!base) return false;
      return !found.some((f) => (f.protocol === "adbd" || f.protocol === "tls") && inSameSubnet(f.ip, base, bits));
    });
    if (quietCidrs.length > 0) {
      const seenIp = new Set(found.map((f) => f.ip));
      // 每个网段单独限额：校园网可能有上百台在线主机，
      // 不限的话热点上的手机就被挤出列表了。
      const perCidr = new Map<string, number>();
      for (const ip of await this.#arpHosts(quietCidrs)) {
        if (seenIp.has(ip)) continue;
        const owner = quietCidrs.find((c) => {
          const [base, bitsRaw] = c.split("/");
          return base ? inSameSubnet(ip, base, Number(bitsRaw ?? 24)) : false;
        });
        if (!owner) continue;
        const used = perCidr.get(owner) ?? 0;
        if (used >= 12) continue;
        perCidr.set(owner, used + 1);
        seenIp.add(ip);
        found.push({ ip, port: ports[0] ?? 5555, kind: "scan", protocol: "host" });
      }
    }
    // 兜底：IPv6 探测可能比扫尾慢一点，结束时再合一次（去重）。
    for (const t of await v6Promise) {
      if (!found.some((f) => f.ip === t.ip && f.port === t.port)) found.push(t);
    }
    return found;
  }

  /** 读本机 ARP 表，挑出指定网段内此刻在线的地址。 */
  async #arpHosts(cidrs: string[]): Promise<string[]> {
    let out = "";
    try {
      const { stdout } = await execFileAsync("arp", ["-a"], {
        timeout: 6000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      out = stdout;
    } catch {
      return [];
    }
    const ranges = cidrs
      .map((c) => {
        const [base, bitsRaw] = c.split("/");
        const bits = Number(bitsRaw ?? 24);
        if (!base || Number.isNaN(bits)) return undefined;
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return { net: (ipToInt(base) & mask) >>> 0, mask };
      })
      .filter((r): r is { net: number; mask: number } => r !== undefined);
    if (ranges.length === 0) return [];

    const own = new Set(this.networks().map((n) => n.address));
    const seen = new Set<string>();
    const hosts: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i.exec(line);
      if (!m) continue;
      const ip = m[1]!;
      const mac = m[2]!.toLowerCase().replace(/:/g, "-");
      if (mac === "ff-ff-ff-ff-ff-ff" || mac.startsWith("01-00-5e")) continue; // 广播 / 组播
      if (own.has(ip) || seen.has(ip)) continue;
      const n = ipToInt(ip);
      if (!ranges.some((r) => ((n & r.mask) >>> 0) === r.net)) continue;
      seen.add(ip);
      hosts.push(ip);
      if (hosts.length >= 400) break;
    }
    return hosts;
  }

  /** 发 ADB 明文握手包，从回包里认协议；认不出就是中间盒假响应。 */
  #probeAdb(ip: string, port: number, timeoutMs: number): Promise<{ open: boolean; protocol: ProbedProtocol }> {
    return new Promise((resolve) => {
      let connected = false;
      let settled = false;
      const sock = createConnection({ host: ip, port });
      const finish = (open: boolean, protocol: ProbedProtocol): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve({ open, protocol });
      };
      sock.setTimeout(timeoutMs, () => finish(connected, connected ? "unknown" : "closed"));
      sock.once("connect", () => {
        connected = true;
        try {
          sock.write(cnxnPacket());
        } catch {
          finish(true, "unknown");
        }
      });
      sock.once("data", (buf: Buffer) => {
        const head = buf.subarray(0, 4).toString("latin1");
        if (head === "STLS") finish(true, "tls");
        else if (head === "CNXN" || head === "AUTH") finish(true, "adbd");
        else if (head === "OKAY" || head === "FAIL") finish(true, "adb-server");
        else finish(true, "unknown");
      });
      sock.once("error", () => finish(connected, connected ? "unknown" : "closed"));
    });
  }

  /** IPv6 serial 不能当 IPv4 地址去诊断，给个固定说明就行。 */
  async #diagHint(ip: string, port: number, isV6: boolean): Promise<string | undefined> {
    if (isV6) return "IPv6 链路本地地址会随手机 WiFi 重连变化；重新扫描一次拿新地址即可。";
    return (await this.diagnose(ip, port)).hint;
  }

  /**
   * 连接入口：IPv4 走正常流程，一旦失败（尤其是 VLAN 隔离）就自动改走 IPv6 链路本地。
   * 这条回退对每台设备都一样，不需要用户切热点或碰手机。
   */
  async connectChecked(ip: string, port: number): Promise<ConnectResult> {
    const res = await this.#connectPlain(ip, port);
    // 只有「端口通但数据过不去」才值得绕 IPv6；端口不开 / 未授权没必要再探一遍。
    if (res.ok || ip.startsWith("[") || (res.state !== "offline" && res.state !== "unknown")) return res;
    const v6 = await this.connectViaIpv6(ip, port);
    if (v6) return v6;
    // 连 IPv6 候选都没有：把「已自动尝试」写进提示，避免文案让人以为程序没试。
    return { ...res, hint: `${res.hint ? `${res.hint} ` : ""}已自动尝试 IPv6 链路本地直连，邻居表里没有这台手机。` };
  }

  /**
   * 用 IPv6 链路本地绕过三层隔离，连上目标那台手机。
   *
   * 邻居表里可能有同宿舍其他人的手机，所以连上之后必须读一次手机的 IPv4 地址，
   * 只有和目标 IP 一致才保留，否则立刻断开 —— 保证只作用于用户点选的这一台。
   */
  async connectViaIpv6(targetIp: string, port: number): Promise<ConnectResult | undefined> {
    const neighbors = await linkLocalNeighbors();
    if (neighbors.length === 0) return undefined;
    const probed = await Promise.all(
      neighbors.map(async (n) => ({ n, kind: await probeAdb6(n.addr, n.zone, port, 1200) })),
    );
    const candidates = probed.filter((p) => p.kind === "adbd");
    if (candidates.length === 0) return undefined;

    let tried = 0;
    for (const { n } of candidates) {
      const serial = v6Serial(n.addr, n.zone, port);
      const drop = (): Promise<unknown> => this.raw(["disconnect", serial], 5_000).catch(() => "");
      await drop();
      try {
        await this.raw(["connect", serial], 15_000);
      } catch {
        continue;
      }
      let state = "";
      for (let i = 0; i < 15; i++) {
        const row = (await this.adbDevices()).find((r) => r.serial === serial);
        if (row) {
          state = row.state;
          if (state === "device" || state === "unauthorized") break;
        }
        await sleep(400);
      }
      if (state !== "device") {
        await drop();
        continue;
      }
      tried++;
      // 身份核对：这台 IPv6 设备的 WiFi IPv4 必须就是要连的那个目标。
      const info = await this.shell(
        serial,
        "ip -4 addr 2>/dev/null | grep -a 'inet '; getprop dhcp.wlan0.ipaddress 2>/dev/null",
        8_000,
      ).catch(() => "");
      if (!info.includes(targetIp)) {
        await drop();
        continue;
      }
      // IPv4 那条 offline transport 留着只会碍事。
      await this.raw(["disconnect", `${targetIp}:${port}`], 5_000).catch(() => "");
      return {
        ok: true,
        addr: serial,
        state: "device",
        message: "已通过 IPv6 链路本地直连（绕过 VLAN 隔离，无需切热点）",
      };
    }
    return tried > 0
      ? {
          ok: false,
          addr: `${targetIp}:${port}`,
          state: "offline",
          message: "IPv6 链路本地通道也试过了，没找到这台手机",
          hint: "手机和电脑需要在同一个 WiFi 广播域；确认手机 WiFi 没切到别的 SSID，然后重新扫描。",
        }
      : undefined;
  }

  /** 扫描时顺带发现 IPv6 链路本地可达的 adbd，作为独立候选列出来。 */
  async ipv6Targets(ports: number[]): Promise<WirelessTarget[]> {
    const neighbors = await linkLocalNeighbors();
    if (neighbors.length === 0) return [];
    const jobs: Array<Promise<WirelessTarget | undefined>> = [];
    for (const n of neighbors) {
      for (const port of ports) {
        jobs.push(
          probeAdb6(n.addr, n.zone, port, 1200).then((kind) =>
            kind === "none"
              ? undefined
              : {
                  ip: `[${n.addr}%${n.zone}]`,
                  port,
                  kind: "scan" as const,
                  name: "IPv6 直连",
                  protocol: kind === "tls" ? ("tls" as const) : ("adbd" as const),
                  ready: kind === "adbd",
                  via6: true,
                },
          ),
        );
      }
    }
    const out = await Promise.all(jobs);
    return out.filter((t): t is WirelessTarget => t !== undefined);
  }

  /** 连接并等状态落定 —— `adb connect` 说 connected 不代表能用。 */
  async #connectPlain(ip: string, port: number): Promise<ConnectResult> {
    const addr = `${ip}:${port}`;
    const isV6 = ip.startsWith("[");
    // 跨 VLAN 时 `adb connect` 会硬等十几秒：网关只代答 SYN、实际数据全丢。
    // 先花 1 秒看协议指纹，确认「端口通但不发 ADB 数据」就直接给结论，别让用户干等。
    const crossSubnet = !isV6 && !this.networks().some((n) => {
      const [base, bitsRaw] = n.cidr.split("/");
      return base && inSameSubnet(ip, base, Number(bitsRaw ?? 24));
    });
    if (crossSubnet) {
      const pre = await this.#probeAdb(ip, port, 1000);
      if (pre.open && pre.protocol !== "adbd" && pre.protocol !== "tls") {
        return {
          ok: false,
          addr,
          state: "offline",
          message: "端口通了但网关不放 ADB 数据（跨 VLAN 隔离）",
          hint: await this.#diagHint(ip, port, isV6),
        };
      }
    }
    // adb server 里残留的 offline transport 会顶住新连接：连多少次都是 offline。
    // 每台设备都先清一次，失败再清一次重试 —— 这是跨网段设备最常见的坑。
    const drop = (): Promise<unknown> => this.raw(["disconnect", addr], 5_000).catch(() => "");
    await drop();

    let out = "";
    let state = "unknown";
    for (let attempt = 0; attempt < 2; attempt++) {
      state = "unknown";
      try {
        out = await this.raw(["connect", addr], 15_000);
      } catch (e) {
        out = e instanceof Error ? e.message : String(e);
      }
      const lower = out.toLowerCase();
      if (lower.includes("failed to authenticate")) {
        return {
          ok: false,
          addr,
          state: "unauthorized",
          message: "手机拒绝了这台电脑的密钥",
          hint: "手机 → 开发者选项 → 撤销 USB 调试授权；或在「无线调试 → 已配对设备」里删掉本机，再重新配对。",
        };
      }
      if (lower.includes("cannot connect") || lower.includes("failed to connect")) {
        if (attempt === 0) {
          await drop();
          await sleep(600);
          continue;
        }
        return {
          ok: false,
          addr,
          state: "closed",
          message: out.split("\n")[0] ?? "连接失败",
          hint: await this.#diagHint(ip, port, isV6),
        };
      }

      for (let i = 0; i < 15; i++) {
        const row = (await this.adbDevices()).find((r) => r.serial === addr);
        if (row) {
          state = row.state;
          if (state === "device" || state === "unauthorized") break;
        }
        await sleep(400);
      }

      if (state === "device") return { ok: true, addr, state, message: "已连接" };
      if (state === "unauthorized") {
        return {
          ok: false,
          addr,
          state,
          message: "连上了但未授权",
          hint: "看手机屏幕，弹出「允许 USB 调试吗」时勾选「一律允许」再点确定。",
        };
      }
      if (state === "offline" && attempt === 0) {
        await drop();
        await sleep(600);
        continue;
      }
      break;
    }

    if (state === "offline") {
      return {
        ok: false,
        addr,
        state,
        message: "端口通了但握手完成不了（offline）",
        hint: await this.#diagHint(ip, port, isV6),
      };
    }
    return {
      ok: false,
      addr,
      state,
      message: out.split("\n")[0] ?? "连接后设备没出现",
      hint: "确认手机端「无线调试」处于开启状态；USB 模式切过来的端口重启后会失效，需要重新执行「转为无线」。",
    };
  }

  async pairDevice(ip: string, pairPort: number, code: string, connectPort?: number): Promise<ConnectResult> {
    const pairAddr = `${ip}:${pairPort}`;
    let out = "";
    try {
      out = await this.raw(["pair", pairAddr, code.trim()], 40_000);
    } catch (e) {
      out = e instanceof Error ? e.message : String(e);
    }
    const lower = out.toLowerCase();
    const paired = lower.includes("successfully paired") || lower.includes("already paired");
    if (!paired) {
      const hint = lower.includes("wrong") || lower.includes("failed")
        ? "配对码错了或已过期：配对码只在「使用配对码配对设备」弹窗开着时有效，关掉就要重新打开重取。"
        : "确认手机和电脑在同一网段、手机端配对弹窗还开着。";
      return { ok: false, addr: pairAddr, state: "failed", message: out.split("\n")[0] ?? "配对失败", hint };
    }
    if (!connectPort || connectPort <= 0) {
      return { ok: true, addr: pairAddr, state: "paired", message: "配对成功，接着点连接" };
    }
    const res = await this.connectChecked(ip, connectPort);
    return { ...res, message: res.ok ? "配对并连接成功" : `配对成功，但连接失败：${res.message}` };
  }

  async disconnect(addr: string): Promise<string> {
    return this.raw(["disconnect", addr], 10_000);
  }

  async disconnectAll(): Promise<string> {
    return this.raw(["disconnect"], 10_000);
  }

  /** `adb devices -l` 原始表，含 offline / unauthorized。 */
  async adbDevices(): Promise<AdbDeviceRow[]> {
    let out = "";
    try {
      out = await this.raw(["devices", "-l"], 15_000);
    } catch {
      return [];
    }
    const rows: AdbDeviceRow[] = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
      const parts = line.split(/\s+/);
      const serial = parts[0];
      if (!serial) continue;
      const kv: Record<string, string> = {};
      for (const p of parts.slice(2)) {
        const at = p.indexOf(":");
        if (at > 0) kv[p.slice(0, at)] = p.slice(at + 1);
      }
      rows.push({
        serial,
        state: parts[1] ?? "unknown",
        model: kv.model,
        product: kv.product,
        device: kv.device,
        transportId: kv.transport_id,
        wireless: serial.includes(":"),
      });
    }
    return rows;
  }

  async diagnose(ip: string, port: number): Promise<DiagnoseResult> {
    // IPv6 链路本地地址不能按 IPv4 网段算，也没必要再探一次：列表里就是探活过的。
    if (ip.startsWith("[")) {
      return {
        ip,
        port,
        portOpen: true,
        protocol: "adbd",
        sameSubnet: true,
        verdict: "IPv6 链路本地直连，不经三层网关",
        hint: "这条通道能绕过 VLAN 隔离；地址随手机 WiFi 重连变化，重新扫描即可。",
      };
    }
    const [probe, nets] = await Promise.all([this.#probeAdb(ip, port, 1500), Promise.resolve(this.networks())]);
    const target = ipToInt(ip);
    let sameSubnet = false;
    let localAddress: string | undefined;
    for (const n of nets) {
      const [net, bitsRaw] = n.cidr.split("/");
      const bits = Number(bitsRaw ?? 24);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((target & mask) >>> 0) === ((ipToInt(net ?? "0.0.0.0") & mask) >>> 0)) {
        sameSubnet = true;
        localAddress = n.address;
        break;
      }
    }
    if (!localAddress && nets[0]) {
      sameSubnet = false;
      localAddress = nets[0].address;
    }

    let verdict: string;
    let hint: string | undefined;
    switch (probe.protocol) {
      case "adbd":
        verdict = "端口是明文 adbd，可以直接连";
        break;
      case "tls":
        verdict = "端口是无线调试的 TLS 端口，已经配对过就能连，没配对要先配对";
        break;
      case "adb-server":
        verdict = "这个端口是 adb 服务端，不是手机";
        hint = "端口填错了，无线调试端口在手机「无线调试」页面顶部显示。";
        break;
      case "unknown":
        verdict = "端口能握手，但对方不发 ADB 数据";
        hint = sameSubnet
          ? "同网段却收不到 ADB 回包，多半是手机侧 adbd 没在监听：插一次 USB 用「转为无线」，或在手机上重新打开「无线调试」。"
          : "这是网络隔离：学校/宿舍路由器常把手机和电脑分到不同 VLAN，哪怕连的是同一个 WiFi，网关也只代答 TCP 握手、不放实际数据，所以 ping 通、端口通、adb 却一直 offline。程序会自动改走 IPv6 链路本地直连；如果仍失败，说明两块 WiFi 网卡不在同一广播域。";
        break;
      default:
        verdict = "端口不通";
        hint = sameSubnet
          ? "同网段也连不上：手机没开无线调试，或 adbd 没在监听这个端口。插 USB 执行一次「转为无线」，或让手机重新打开无线调试。"
          : "不在同一网段，跨子网被拦。程序会自动尝试 IPv6 链路本地直连；不行再检查手机和电脑是不是连的同一个 WiFi。";
    }
    return { ip, port, portOpen: probe.open, protocol: probe.protocol, sameSubnet, localAddress, verdict, hint };
  }

  async deviceIp(serial: string): Promise<string> {
    const out = await this.shell(serial, "ip -4 addr show wlan0 2>/dev/null | grep inet", 15_000);
    return /inet\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(out)?.[1] ?? "";
  }

  /** 把 adbd 切成 TCP 模式并立即连上。 */
  async toTcpip(serial: string, port = 5555): Promise<ConnectResult> {
    const addr = `${serial}:tcpip`;
    let ip = "";
    try {
      ip = await this.deviceIp(serial);
    } catch {
      ip = "";
    }
    const nets = this.networks();
    if (!ip) {
      return {
        ok: false,
        addr,
        state: "no-ip",
        message: "手机没连 Wi-Fi",
        hint: "先让手机连上 Wi-Fi 再执行一次。",
      };
    }
    // 必须逐张网卡比对：电脑常同时挂着以太网 / 校园网 / 热点，
    // 只看第一张物理网卡会把「手机其实在热点网段」误判成跨网段。
    // 热点网卡通常叫「本地连接* N」，名字里根本没有 wlan，不能按名字找。
    // 必须先按网段判断再决定要不要切：tcpip 会把 adbd 从 USB 切到 TCP，
    // 一旦切过去又连不上，手机就彻底失联了（只能拔线重来）。
    const sameNet = nets.find((n) => inSameSubnet(ip, n.address, prefixOf(undefined, n.cidr)));
    // 跨子网也照样开 5555：校园网把手机和电脑分到不同 VLAN 是常态，
    // 真正的通道是 IPv6 链路本地（connectChecked 会自动回退过去）。
    // 连不上会自动切回 USB，不会让手机失联。
    const crossSubnet = !sameNet;
    const mine = nets.filter((n) => !n.virtual).map((n) => `${n.name} ${n.address}`).join("、") || "无";

    let out = "";
    try {
      out = await this.raw(["-s", serial, "tcpip", String(port)], 25_000);
    } catch (e) {
      out = e instanceof Error ? e.message : String(e);
    }
    if (!/restarting in TCP mode|tcp mode port/i.test(out)) {
      return { ok: false, addr: `${ip}:${port}`, state: "failed", message: out.split("\n")[0] ?? "切换失败" };
    }
    await sleep(2500);
    const res = await this.connectChecked(ip, port);
    if (res.ok) {
      return {
        ...res,
        message: `已切到无线：${ip}:${port}，现在可以拔线了${crossSubnet ? "（跨网段，走 IPv6 链路本地）" : ""}`,
      };
    }
    if (crossSubnet) {
      // 端口开了但两条路都不通：切回 USB，别把手机弄丢。
      await this.raw(["-s", serial, "usb"], 20_000).catch(() => "");
      return {
        ...res,
        message: `已打开 ${port} 端口，但还是连不上：${res.message}`,
        hint: `这台手机和电脑不在同一子网（电脑: ${mine}），IPv6 链路本地也没找通。已自动切回 USB，手机没丢。`,
      };
    }
    return { ...res, message: `已切换，但连接失败：${res.message}` };
  }

  /** 切回 USB 模式。 */
  async toUsb(serial: string): Promise<string> {
    const out = await this.raw(["-s", serial, "usb"], 20_000);
    await sleep(1500);
    return out || "已切回 USB 模式";
  }

  // ---------- 系统信息 ----------

  async props(serial: string): Promise<DeviceProps> {
    const out = await this.shell(serial, "getprop", 30_000);
    const get = (key: string): string | undefined => {
      const m = new RegExp(`\\[${key}\\]: \\[(.*?)\\]`).exec(out);
      return m?.[1] || undefined;
    };
    const [resolution, density, storage, uptime] = await Promise.all([
      this.shell(serial, "wm size").catch(() => ""),
      this.shell(serial, "wm density").catch(() => ""),
      this.shell(serial, "df -h /data").catch(() => ""),
      this.shell(serial, "cat /proc/uptime").catch(() => ""),
    ]);
    const storageMatch = /\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+%)/.exec(storage);
    return {
      model: get("ro.product.model"),
      brand: get("ro.product.brand"),
      manufacturer: get("ro.product.manufacturer"),
      androidVersion: get("ro.build.version.release"),
      sdk: Number(get("ro.build.version.sdk")) || undefined,
      abi: get("ro.product.cpu.abi"),
      cpu: get("ro.board.platform") ?? get("ro.hardware"),
      serial: get("ro.serialno"),
      resolution: /Override size:\s*(\d+x\d+)/.exec(resolution)?.[1] ?? /Physical size:\s*(\d+x\d+)/.exec(resolution)?.[1],
      density: /Override density:\s*(\d+)/.exec(density)?.[1] ?? /Physical density:\s*(\d+)/.exec(density)?.[1],
      storageTotal: storageMatch?.[1],
      storageUsed: storageMatch?.[2],
      storageFree: storageMatch?.[3],
      uptime: uptime.split(" ")[0] ? `${Math.floor(Number(uptime.split(" ")[0]) / 3600)} 小时` : undefined,
    };
  }

  async stats(serial: string): Promise<DeviceStats> {
    const [battery, mem, cpu, net] = await Promise.all([
      this.shell(serial, "dumpsys battery").catch(() => ""),
      this.shell(serial, "cat /proc/meminfo | head -3").catch(() => ""),
      this.shell(serial, "dumpsys cpuinfo | head -3").catch(() => ""),
      this.shell(serial, "cat /proc/net/dev | grep wlan0").catch(() => ""),
    ]);
    const level = /level:\s*(\d+)/.exec(battery)?.[1];
    const temp = /temperature:\s*(\d+)/.exec(battery)?.[1];
    const status = /status:\s*(\d+)/.exec(battery)?.[1];
    const total = /MemTotal:\s*(\d+)/.exec(mem)?.[1];
    const avail = /MemAvailable:\s*(\d+)/.exec(mem)?.[1];
    const cpuLine = /\d+(?:\.\d+)?%/.exec(cpu)?.[0];
    const netMatch = /wlan0:\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(net);
    return {
      batteryLevel: level !== undefined ? Number(level) : undefined,
      batteryTemp: temp !== undefined ? Number(temp) / 10 : undefined,
      batteryCharging: status === "2",
      memTotal: total !== undefined ? Math.round(Number(total) / 1024) : undefined,
      memUsed: total !== undefined && avail !== undefined ? Math.round((Number(total) - Number(avail)) / 1024) : undefined,
      cpuUsage: cpuLine ? Number.parseFloat(cpuLine) : undefined,
      netRx: netMatch ? Number(netMatch[1]) : undefined,
      netTx: netMatch ? Number(netMatch[2]) : undefined,
    };
  }
}
