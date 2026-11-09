/**
 * IPv6 链路本地直连通道。
 *
 * 校园网 / 企业网常把手机和电脑切进不同 VLAN：IPv4 上 ping 通、TCP 握手也能完成
 * （网关代答 SYN），但真正的数据包被丢掉，adb 一直 offline。链路本地 IPv6 是二层
 * 寻址，不经过三层网关的 ACL，只要两块 WiFi 网卡在同一个广播域就能直着走通。
 *
 * 所以这里做的事是：列出本机 IPv6 邻居 → 对每个 fe80 地址发 ADB 握手包 →
 * 认出真正的 adbd → 交给上层用 `[fe80::…%zone]:port` 这个 serial 去 `adb connect`。
 */
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LinkNeighbor {
  /** 不带 zone 的 fe80:: 地址。 */
  addr: string;
  /** Windows 上是网卡 ifIndex，Linux 上是接口名。 */
  zone: number | string;
  mac: string;
}

/** ADB 明文握手包（CNXN）。真 adbd 会回 CNXN / AUTH，无线调试 TLS 端口会回 STLS。 */
function cnxnPacket(): Buffer {
  const payload = Buffer.from(
    "host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,abb,abb_exec,remount_shell,track_app,sendrecv_v2,apex,fixed_push_symlink_timestamp,openscreen_mdns,delayed_ack,devicetracker\0",
  );
  const b = Buffer.alloc(24 + payload.length);
  b.writeUInt32LE(0x4e584e43, 0);
  b.writeUInt32LE(0x01000001, 4);
  b.writeUInt32LE(1024 * 1024, 8);
  b.writeUInt32LE(payload.length, 12);
  let sum = 0;
  for (const x of payload) sum = (sum + x) >>> 0;
  b.writeUInt32LE(sum, 16);
  b.writeUInt32LE((0x4e584e43 ^ 0xffffffff) >>> 0, 20);
  payload.copy(b, 24);
  return b;
}

const WIN_PS =
  "@(Get-NetNeighbor -AddressFamily IPv6 -ErrorAction SilentlyContinue | " +
  "Where-Object { $_.IPAddress -like 'fe80::*' -and $_.LinkLayerAddress -and " +
  "$_.State -ne 'Unreachable' -and $_.State -ne 'Permanent' } | " +
  "ForEach-Object { [pscustomobject]@{a=$_.IPAddress;z=$_.InterfaceIndex;m=$_.LinkLayerAddress} }) | " +
  "ConvertTo-Json -Compress";

/** 从系统邻居表里取同链路的 IPv6 设备。拿不到就返回空，不抛异常。 */
export async function linkLocalNeighbors(): Promise<LinkNeighbor[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WIN_PS],
        { timeout: 8_000, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      );
      const text = stdout.trim();
      if (!text) return [];
      const raw: unknown = JSON.parse(text);
      const rows = Array.isArray(raw) ? raw : [raw];
      const out: LinkNeighbor[] = [];
      for (const r of rows) {
        const row = r as { a?: unknown; z?: unknown; m?: unknown };
        const addr = typeof row.a === "string" ? row.a : "";
        const zone = typeof row.z === "number" ? row.z : Number(row.z);
        const mac = typeof row.m === "string" ? row.m : "";
        if (!addr.startsWith("fe80:") || !Number.isFinite(zone) || zone <= 0) continue;
        // 路由器的链路本地地址通常就是 fe80::1，留着也无害，探测一次很快。
        out.push({ addr, zone, mac });
      }
      return out;
    }
    const { stdout } = await execFileAsync("ip", ["-6", "neigh", "show"], {
      timeout: 5_000,
      windowsHide: true,
      encoding: "utf8",
    });
    const out: LinkNeighbor[] = [];
    for (const line of stdout.split("\n")) {
      const m = /^(fe80:[0-9a-f:]+)\s+dev\s+(\S+)\s+lladdr\s+(\S+)/i.exec(line.trim());
      if (m && !/FAILED|INCOMPLETE/i.test(line)) {
        out.push({ addr: m[1]!, zone: m[2]!, mac: m[3]! });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** adb 用的 serial 形如 `[fe80::…%8]:5555`。 */
export function v6Serial(addr: string, zone: number | string, port: number): string {
  return `[${addr}%${zone}]:${port}`;
}

/** 对链路本地地址发握手包，区分明文 adbd / TLS 无线调试 / 不是 adb。 */
export function probeAdb6(
  addr: string,
  zone: number | string,
  port: number,
  timeoutMs = 1200,
): Promise<"adbd" | "tls" | "none"> {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const host = `${addr}%${zone}`;
    const sock = createConnection({ host, port, family: 6 });
    const finish = (r: "adbd" | "tls" | "none"): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish("none"));
    sock.once("connect", () => {
      connected = true;
      try {
        sock.write(cnxnPacket());
      } catch {
        finish("none");
      }
    });
    sock.once("data", (buf: Buffer) => {
      const head = buf.subarray(0, 4).toString("latin1");
      if (head === "CNXN" || head === "AUTH") finish("adbd");
      else if (head === "STLS") finish("tls");
      else finish("none");
    });
    sock.once("error", () => finish(connected ? "none" : "none"));
  });
}
