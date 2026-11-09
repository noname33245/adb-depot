import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdbDeviceRow, ConnHistoryItem, DiagnoseResult, NetworkInfo, ScanProgress, WirelessTarget } from "@shared/types";

interface Props {
  onClose: () => void;
}

interface LogLine {
  id: number;
  time: string;
  kind: "info" | "ok" | "fail" | "warn";
  text: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const stateLabel: Record<string, string> = {
  device: "在线",
  offline: "离线",
  unauthorized: "未授权",
  bootloader: "bootloader",
  recovery: "recovery",
  unknown: "未知",
};

const protocolLabel: Record<string, string> = {
  adbd: "明文 adbd",
  tls: "无线调试",
  "adb-server": "adb 服务端",
  unknown: "无响应",
  closed: "不通",
  host: "在线·未开 ADB",
};

function Badge({ kind, text }: { kind: "ok" | "warn" | "fail" | "muted"; text: string }) {
  return <span className={`conn-badge ${kind}`}>{text}</span>;
}

export function ConnectionCenter({ onClose }: Props) {
  const [nets, setNets] = useState<NetworkInfo[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [portText, setPortText] = useState("5555");
  const [targets, setTargets] = useState<WirelessTarget[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [adb, setAdb] = useState<AdbDeviceRow[]>([]);
  const [history, setHistory] = useState<ConnHistoryItem[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [autoMdns, setAutoMdns] = useState(true);
  /** 扫完本网段后扩扫同一 /16 的相邻网段（校园网常被切成多个 /21）。 */
  const [expandNearby, setExpandNearby] = useState(true);
  const [busyAddr, setBusyAddr] = useState("");

  const [manualIp, setManualIp] = useState("");
  const [manualPort, setManualPort] = useState("5555");

  const [pairIp, setPairIp] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairConnectPort, setPairConnectPort] = useState("");

  const [usbSerial, setUsbSerial] = useState("");
  const [tcpPort, setTcpPort] = useState("5555");

  const [diag, setDiag] = useState<DiagnoseResult | null>(null);

  /**
   * 手动添加的网段。
   * 校园网 / 公司网常被切成多个 /21，设备和本机不在同一个广播域里，
   * 按网卡自动展开根本扫不到；这里允许直接填对方的网段。
   */
  const [extraNets, setExtraNets] = useState<NetworkInfo[]>([]);
  const [manualCidr, setManualCidr] = useState("");

  const logId = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  /** 用户主动取消勾选的网段，自动刷新网卡时不要替他重新勾上。 */
  const manualOff = useRef<Set<string>>(new Set());
  const netsRef = useRef<NetworkInfo[]>([]);
  /** 扩扫阶段 total 会变大，用它识别「进度条变短」是加了一轮而不是出错。 */
  const scanTotalRef = useRef(0);

  const push = useCallback((kind: LogLine["kind"], text: string) => {
    logId.current += 1;
    const line: LogLine = {
      id: logId.current,
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      kind,
      text,
    };
    setLog((prev) => [...prev.slice(-199), line]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refreshDevices = useCallback(async () => {
    try {
      const rows = await window.farm.wireless.devices();
      setAdb(rows);
      setUsbSerial((prev) => (prev && rows.some((r) => r.serial === prev) ? prev : rows.find((r) => !r.wireless && r.state === "device")?.serial ?? ""));
    } catch {
      // 设备表拿不到时保留上一次结果，不打扰用户
    }
  }, []);

  /**
   * 重新读网卡。开热点、连 Wi-Fi、插网线都会新增网段，
   * 面板开一次只读一遍的话，后出现的网段永远扫不到。
   */
  const loadNets = useCallback(
    async (announce = false): Promise<NetworkInfo[]> => {
      try {
        const n = await window.farm.wireless.networks();
        const before = new Set(netsRef.current.map((x) => x.cidr));
        netsRef.current = n;
        setNets(n);
        setPicked((prev) => {
          const alive = new Set(n.map((x) => x.cidr));
          const next = new Set([...prev].filter((c) => alive.has(c)));
          for (const x of n) {
            if (x.virtual || manualOff.current.has(x.cidr)) continue;
            next.add(x.cidr);
          }
          return next;
        });
        if (announce) {
          const added = n.filter((x) => !before.has(x.cidr) && !x.virtual);
          if (added.length > 0) push("info", `检测到新网段：${added.map((x) => `${x.cidr}（${x.name}）`).join("、")}`);
        }
        return n;
      } catch (e) {
        push("fail", `读取网卡失败：${errText(e)}`);
        return netsRef.current;
      }
    },
    [push],
  );

  const mergeTargets = useCallback((incoming: WirelessTarget[]) => {
    setTargets((prev) => {
      const map = new Map<string, WirelessTarget>(prev.map((t) => [`${t.ip}:${t.port}`, t] as [string, WirelessTarget]));
      for (const t of incoming) {
        const key = `${t.ip}:${t.port}`;
        const old = map.get(key);
        map.set(key, { ...old, ...t, protocol: t.protocol ?? old?.protocol });
      }
      return [...map.values()];
    });
  }, []);

  const discover = useCallback(
    async (silent = false) => {
      try {
        const list = await window.farm.wireless.mdns();
        mergeTargets(list);
        const pairTarget = list.find((t) => t.pairing);
        if (pairTarget) {
          setPairIp((prev) => prev || pairTarget.ip);
          setPairPort((prev) => prev || String(pairTarget.port));
        } else if (list[0]) {
          setPairIp((prev) => prev || list[0]!.ip);
        }
        if (!silent) push("info", `mDNS 发现 ${list.length} 条无线调试服务`);
      } catch (e) {
        if (!silent) push("fail", `mDNS 发现失败：${errText(e)}`);
      }
    },
    [mergeTargets, push],
  );

  useEffect(() => {
    void (async () => {
      await loadNets();
      try {
        setHistory(await window.farm.wireless.history());
      } catch (e) {
        push("fail", `读取连接历史失败：${errText(e)}`);
      }
    })();
    void refreshDevices();
    void discover();
    push("info", "连接中心已打开");
  }, [discover, loadNets, push, refreshDevices]);

  // 热点 / Wi-Fi / 网线随时会变，网段列表跟着刷新，新出现的自动勾上。
  useEffect(() => {
    const timer = window.setInterval(() => void loadNets(true), 5000);
    return () => window.clearInterval(timer);
  }, [loadNets]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshDevices(), 2500);
    return () => window.clearInterval(timer);
  }, [refreshDevices]);

  useEffect(
    () =>
      window.farm.wireless.onProgress((p) => {
        setProgress(p);
        if (p.targets && p.targets.length > 0) mergeTargets(p.targets);
        if (p.phase === "nearby" && p.total > scanTotalRef.current && scanTotalRef.current > 0) {
          push("info", `本网段扫完，开始扩扫相邻网段：本轮共 ${p.total} 个地址`);
        }
        scanTotalRef.current = p.total;
      }),
    [mergeTargets, push],
  );

  useEffect(() => {
    if (!autoMdns) return;
    const timer = window.setInterval(() => void discover(true), 6000);
    return () => window.clearInterval(timer);
  }, [autoMdns, discover]);

  const ports = useMemo(() => {
    const raw = portText
      .split(/[\s,，]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    const fromMdns = targets.map((t) => t.port).filter((p) => p > 0);
    // 换网后 IP 会变，但 adbd 的端口在一次开机内不变 —— 历史端口值得一起扫。
    const fromHistory = history.map((h) => Number(h.addr.split(":")[1])).filter((p) => Number.isFinite(p) && p > 0);
    return [...new Set([...raw, ...fromMdns, ...fromHistory])];
  }, [portText, targets, history]);

  /** 接受 172.29.200.0/21，或者单个 IP（自动按 /24 处理）。 */
  const addCidr = (): void => {
    const raw = manualCidr.trim();
    if (!raw) return;
    let cidr = raw;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) cidr = `${raw.replace(/\.\d+$/, ".0")}/24`;
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr) || Number(cidr.split("/")[1]) < 16) {
      push("warn", "网段格式不对，例：172.29.200.0/21（不能大于 /16）");
      return;
    }
    if (nets.some((n) => n.cidr === cidr) || extraNets.some((n) => n.cidr === cidr)) {
      push("info", `${cidr} 已经在列表里了`);
      return;
    }
    setExtraNets((prev) => [...prev, { name: "手动", address: "", cidr, virtual: false }]);
    setPicked((prev) => new Set(prev).add(cidr));
    setManualCidr("");
  };

  const scan = async (): Promise<void> => {
    // 扫描前重读网卡：刚开的热点、刚连的 Wi-Fi 要立刻纳入范围。
    const fresh = await loadNets(true);
    const cidrs = [
      ...new Set([
        ...fresh
          .filter((x) => picked.has(x.cidr) || (!x.virtual && !manualOff.current.has(x.cidr)))
          .map((x) => x.cidr),
        ...extraNets.filter((n) => picked.has(n.cidr)).map((n) => n.cidr),
      ]),
    ];
    if (cidrs.length === 0) {
      push("warn", "没有可扫的网段：至少勾选一个，或确认网卡已拿到 IP");
      return;
    }
    setScanning(true);
    scanTotalRef.current = 0;
    setProgress({ done: 0, total: 0, found: 0, running: true, phase: "primary" });
    push("info", `开始扫描 ${cidrs.join("、")}，端口 ${ports.join(", ")}${expandNearby ? "，扫完扩相邻网段" : ""}`);
    try {
      // IPv6 链路本地一般 1 秒内就出结果，先单独推给列表：
      // 校园网 IPv4 那几千个地址要扫十几秒，不能让唯一的可用候选陪着等。
      const v6Promise = window.farm.wireless.ipv6(ports).catch(() => [] as WirelessTarget[]);
      void v6Promise.then((via6) => {
        if (via6.length === 0) return;
        mergeTargets(via6);
        push("ok", `IPv6 链路本地发现 ${via6.length} 个 ADB 端口：这条通道不过网关，跨 VLAN 也能直连`);
      });
      const found = await window.farm.wireless.scan({ cidrs, ports, expandNearby });
      // IPv4 扫描和 IPv6 发现是两条路，统计要合起来算，
      // 否则「只有 IPv6 命中」会被误报成「什么都没扫到」。
      const via6 = await v6Promise;
      const unique = new Map<string, WirelessTarget>();
      for (const t of [...found, ...via6]) unique.set(`${t.ip}:${t.port}`, t);
      const results = [...unique.values()];
      mergeTargets(results);
      const real = results.filter((f) => f.protocol === "adbd" || f.protocol === "tls").length;
      const hosts = results.filter((f) => f.protocol === "host").length;
      if (real > 0) {
        push("ok", `扫描结束：${results.length} 个端口有响应，其中 ${real} 个是真正的 ADB${results.length > real ? "（其余可能是网关假响应）" : ""}`);
      } else if (hosts > 0) {
        push(
          "warn",
          `扫描结束：网内有 ${hosts} 台设备在线，但都没有开 ADB 端口 —— 手机多半是 adbd 退回 USB 模式了。` +
            "插一次数据线，在右边「USB 转无线」里选中它并点「转为无线」。",
        );
      } else if (results.length > 0) {
        push("warn", `扫描结束：${results.length} 个端口有响应，但都不是真正的 ADB（网关假响应），没有可连的手机`);
      } else {
        // 空结果最常见的原因是手机 adbd 退回了 USB 模式，光说「没扫到」没法排查。
        push(
          "warn",
          "没扫到任何 ADB 端口，网内也没发现其他在线主机。确认手机和电脑连的是同一个 WiFi；" +
            "校园网跨网段时，候选里会出现 [fe80::…] 的「IPv6 直连」，点它旁边的连接就行。",
        );
      }
    } catch (e) {
      push("fail", `扫描失败：${errText(e)}`);
    } finally {
      setScanning(false);
      void refreshDevices();
    }
  };

  const cancelScan = async (): Promise<void> => {
    await window.farm.wireless.cancelScan();
    push("warn", "已请求停止扫描");
  };

  const doConnect = async (ip: string, port: number): Promise<void> => {
    setBusyAddr(`${ip}:${port}`);
    push("info", `连接 ${ip}:${port} …`);
    try {
      const res = await window.farm.wireless.connect(ip, port);
      if (res.ok) push("ok", `已连接：${res.addr}`);
      else push("fail", `${res.addr} 连接失败：${res.message}${res.hint ? `｜${res.hint}` : ""}`);
      setHistory(await window.farm.wireless.history());
      if (res.ok) setTargets((prev) => prev.filter((t) => `${t.ip}:${t.port}` !== res.addr));
    } catch (e) {
      push("fail", `连接 ${ip}:${port} 出错：${errText(e)}`);
    } finally {
      setBusyAddr("");
      void refreshDevices();
    }
  };

  const doPair = async (): Promise<void> => {
    const ip = pairIp.trim();
    const port = Number(pairPort);
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
      push("warn", "配对要先填手机 IP");
      return;
    }
    if (!port) {
      push("warn", "配对端口没填 —— 在手机「使用配对码配对设备」弹窗里能看到");
      return;
    }
    if (pairCode.trim().length < 6) {
      push("warn", "配对码是 6 位数字");
      return;
    }
    setBusyAddr(`pair:${ip}:${port}`);
    push("info", `配对 ${ip}:${port}，配对码 ${pairCode.trim()} …`);
    try {
      const connectPort = Number(pairConnectPort) || (pairConnectPort.trim() === "" ? undefined : 0);
      const res = await window.farm.wireless.pair(ip, port, pairCode.trim(), connectPort);
      if (res.ok) push("ok", res.message);
      else push("fail", `${res.message}${res.hint ? `｜${res.hint}` : ""}`);
      setHistory(await window.farm.wireless.history());
      if (res.ok) {
        setPairCode("");
        setPairPort("");
      }
      void refreshDevices();
    } catch (e) {
      push("fail", `配对失败：${errText(e)}`);
    } finally {
      setBusyAddr("");
    }
  };

  const doDiagnose = async (ip: string, port: number): Promise<void> => {
    push("info", `诊断 ${ip}:${port} …`);
    try {
      const res = await window.farm.wireless.diagnose(ip, port);
      setDiag(res);
      push(res.protocol === "adbd" || res.protocol === "tls" ? "ok" : "warn", `${ip}:${port} ${res.verdict}`);
    } catch (e) {
      push("fail", `诊断失败：${errText(e)}`);
    }
  };

  const toWireless = async (): Promise<void> => {
    if (!usbSerial) {
      push("warn", "先用 USB 连上手机，再执行这一步");
      return;
    }
    setBusyAddr(`usb:${usbSerial}`);
    push("info", `把 ${usbSerial} 切到 TCP 模式（端口 ${tcpPort}）…`);
    try {
      const res = await window.farm.wireless.toTcpip(usbSerial, Number(tcpPort) || 5555);
      push(res.ok ? "ok" : "fail", `${res.message}${res.hint ? `｜${res.hint}` : ""}`);
      setHistory(await window.farm.wireless.history());
      void refreshDevices();
    } catch (e) {
      push("fail", `切换失败：${errText(e)}`);
    } finally {
      setBusyAddr("");
    }
  };

  const toUsb = async (): Promise<void> => {
    if (!usbSerial) return;
    setBusyAddr(`usb:${usbSerial}`);
    try {
      const out = await window.farm.wireless.toUsb(usbSerial);
      push("ok", out.split("\n")[0] ?? "已切回 USB 模式");
      void refreshDevices();
    } catch (e) {
      push("fail", `切回 USB 失败：${errText(e)}`);
    } finally {
      setBusyAddr("");
    }
  };

  const doDisconnect = async (addr: string): Promise<void> => {
    try {
      await window.farm.wireless.disconnect(addr);
      push("info", `已断开 ${addr}`);
      void refreshDevices();
    } catch (e) {
      push("fail", `断开失败：${errText(e)}`);
    }
  };

  const doDisconnectAll = async (): Promise<void> => {
    try {
      await window.farm.wireless.disconnectAll();
      push("info", "已断开全部无线连接");
      void refreshDevices();
    } catch (e) {
      push("fail", `断开失败：${errText(e)}`);
    }
  };

  const connectAllReady = async (): Promise<void> => {
    const ready = targets.filter((t) => t.protocol === "adbd" || t.ready);
    if (ready.length === 0) {
      push("warn", "没有可直连的设备：先扫描，或对 TLS 端口走配对");
      return;
    }
    for (const t of ready) await doConnect(t.ip, t.port);
  };

  const forget = async (addr: string): Promise<void> => {
    setHistory(await window.farm.wireless.forget(addr));
  };

  const online = adb.filter((d) => d.state === "device");
  const wirelessOnline = online.filter((d) => d.wireless);
  const usbDevices = adb.filter((d) => !d.wireless && d.state === "device");
  const scanPercent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const scanHosts = [...nets, ...extraNets]
    .filter((n) => picked.has(n.cidr))
    .reduce((sum, n) => {
      const bits = Number(n.cidr.split("/")[1] ?? 24);
      return sum + (bits >= 31 ? 1 : 2 ** (32 - bits) - 2);
    }, 0);

  /** 能直连的排最前，假响应垫底，省得在一堆「无响应」里找手机。 */
  const orderedTargets = useMemo(() => {
    const rank = (t: WirelessTarget): number => {
      const p = t.protocol ?? (t.ready ? "adbd" : t.pairing ? "tls" : "unknown");
      if (p === "adbd") return 0;
      if (p === "tls") return 1;
      if (p === "adb-server") return 2;
      if (p === "unknown") return 4;
      if (p === "host") return 5;
      return 3;
    };
    return [...targets].sort((a, b) => rank(a) - rank(b));
  }, [targets]);

  const toggleCidr = (cidr: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(cidr)) {
        next.delete(cidr);
        manualOff.current.add(cidr);
      } else {
        next.add(cidr);
        manualOff.current.delete(cidr);
      }
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal conn-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="conn-headline">
            <span className="conn-title">连接中心</span>
            <span className="conn-sub">无线调试 · 局域网扫描 · 配对 · USB 转无线</span>
          </div>
          <div className="conn-head-actions">
            <Badge kind={wirelessOnline.length > 0 ? "ok" : "muted"} text={`无线 ${wirelessOnline.length}`} />
            <Badge kind={usbDevices.length > 0 ? "ok" : "muted"} text={`USB ${usbDevices.length}`} />
            <button
              className="btn"
              onClick={() => {
                void loadNets(true);
                void discover();
                void refreshDevices();
              }}
            >
              刷新
            </button>
            <button className="icon-btn" onClick={onClose} title="关闭">
              ✕
            </button>
          </div>
        </header>

        <div className="conn-body">
          {/* ---------- 左：发现 ---------- */}
          <section className="conn-col">
            <div className="conn-section-title">
              扫描范围
              <span className="conn-section-hint">
                {picked.size} / {nets.length + extraNets.length} 个网段 · 本段约 {scanHosts} 个地址{expandNearby ? " · 追加相邻网段" : ""}
              </span>
            </div>
            <div className="conn-nets">
              {nets.length === 0 && <div className="tool-hint">没读到网卡</div>}
              {nets.map((n) => (
                <label className={`conn-net${n.virtual ? " virtual" : ""}`} key={`${n.name}-${n.cidr}`}>
                  <input type="checkbox" checked={picked.has(n.cidr)} onChange={() => toggleCidr(n.cidr)} />
                  <span className="conn-net-name">{n.name}</span>
                  <span className="conn-net-cidr mono">{n.cidr}</span>
                  {n.virtual && <span className="conn-tag">虚拟</span>}
                </label>
              ))}
              {extraNets.map((n) => (
                <label className="conn-net" key={`manual-${n.cidr}`}>
                  <input type="checkbox" checked={picked.has(n.cidr)} onChange={() => toggleCidr(n.cidr)} />
                  <span className="conn-net-name">{n.name}</span>
                  <span className="conn-net-cidr mono">{n.cidr}</span>
                  <button
                    className="conn-tag"
                    style={{ cursor: "pointer", border: "none", background: "none" }}
                    title="移除"
                    onClick={(e) => {
                      e.preventDefault();
                      setExtraNets((prev) => prev.filter((x) => x.cidr !== n.cidr));
                      setPicked((prev) => {
                        const next = new Set(prev);
                        next.delete(n.cidr);
                        return next;
                      });
                    }}
                  >
                    移除
                  </button>
                </label>
              ))}
              <div className="conn-net-add">
                <input
                  className="input"
                  placeholder="一般不用填：默认自动扩扫相邻网段"
                  value={manualCidr}
                  onChange={(e) => setManualCidr(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCidr();
                    }
                  }}
                />
                <button className="btn" onClick={addCidr}>
                  添加
                </button>
              </div>
            </div>

            <div className="conn-inline">
              <label className="conn-field">
                <span>端口</span>
                <input value={portText} onChange={(e) => setPortText(e.target.value)} placeholder="5555, 41269" />
              </label>
              <label className="conn-check">
                <input type="checkbox" checked={autoMdns} onChange={(e) => setAutoMdns(e.target.checked)} />
                自动发现
              </label>
              <label className="conn-check" title="扫完本网段后，继续扫同一 /16 内的相邻网段；关掉可省约 10 秒">
                <input type="checkbox" checked={expandNearby} onChange={(e) => setExpandNearby(e.target.checked)} />
                扩扫相邻网段
              </label>
            </div>

            <div className="conn-inline">
              <button className="btn" disabled={scanning} onClick={() => void discover()}>
                mDNS 发现
              </button>
              <button className="btn primary" disabled={scanning} onClick={() => void scan()}>
                {scanning ? "扫描中…" : "扫描局域网"}
              </button>
              {scanning && (
                <button className="btn" onClick={() => void cancelScan()}>
                  停止
                </button>
              )}
              <button className="btn" disabled={busyAddr !== ""} onClick={() => void connectAllReady()}>
                连全部明文
              </button>
            </div>

            {(scanning || progress) && (
              <div className="conn-progress">
                <div className="conn-progress-bar">
                  <div style={{ width: `${scanPercent}%` }} />
                </div>
                <span className="conn-progress-text">
                  {progress
                    ? `${progress.phase === "nearby" ? "相邻网段" : "本网段"} ${progress.done} / ${progress.total} · 命中 ${progress.found}`
                    : "准备中"}
                </span>
              </div>
            )}

            <div className="conn-section-title">
              候选设备
              <span className="conn-section-hint">{targets.length} 个地址</span>
              {targets.length > 0 && (
                <button className="conn-link" onClick={() => setTargets([])}>
                  清空
                </button>
              )}
            </div>
            <div className="conn-list">
              {targets.length === 0 && (
                <div className="tool-empty">
                  还没有候选地址
                  <br />
                  开手机「无线调试」后点 mDNS 发现；或用 USB 插一次再「转为无线」
                </div>
              )}
              {orderedTargets.map((t) => {
                const key = `${t.ip}:${t.port}`;
                const proto = t.protocol ?? (t.ready ? "adbd" : t.pairing ? "tls" : undefined);
                return (
                  <div className="conn-row" key={key}>
                    <div className="conn-row-main">
                      <span
                        className="conn-addr mono"
                        title={
                          t.via6
                            ? "IPv6 链路本地地址：不过三层网关，跨 VLAN 也能直连。连接后会核对手机的实际 IPv4，不会连错人。"
                            : undefined
                        }
                      >
                        {key}
                      </span>
                      <span className="conn-row-tags">
                        {t.kind === "mdns" ? <span className="conn-tag">mDNS</span> : <span className="conn-tag">扫描</span>}
                        {t.pairing && <Badge kind="warn" text="配对端口" />}
                        {proto && (
                          <Badge
                            kind={
                              proto === "adbd"
                                ? "ok"
                                : proto === "tls" || proto === "host"
                                  ? "warn"
                                  : proto === "closed"
                                    ? "fail"
                                    : "muted"
                            }
                            text={protocolLabel[proto] ?? proto}
                          />
                        )}
                        {t.name && <span className="conn-tag">{t.name}</span>}
                      </span>
                    </div>
                    <div className="conn-row-actions">
                      {proto === "host" ? (
                        <span className="conn-tag">插 USB 后点「USB 转无线」</span>
                      ) : (
                        <button
                          className="btn primary"
                          disabled={busyAddr !== "" || t.pairing === true}
                          onClick={() => void doConnect(t.ip, t.port)}
                        >
                          连接
                        </button>
                      )}
                      <button
                        className="btn"
                        onClick={() => {
                          setPairIp(t.ip);
                          setPairPort(t.pairing ? String(t.port) : "");
                          setPairConnectPort(t.pairing ? "" : String(t.port));
                        }}
                      >
                        配对
                      </button>
                      <button className="btn" onClick={() => void doDiagnose(t.ip, t.port)}>
                        诊断
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {diag && (
              <div className="conn-diag">
                <div className="conn-diag-head">
                  <span className="mono">
                    {diag.ip}:{diag.port}
                  </span>
                  <Badge
                    kind={diag.protocol === "adbd" || diag.protocol === "tls" ? "ok" : "fail"}
                    text={protocolLabel[diag.protocol] ?? diag.protocol}
                  />
                  <Badge kind={diag.sameSubnet ? "ok" : "warn"} text={diag.sameSubnet ? "同网段" : "跨网段"} />
                  <button className="conn-link" onClick={() => setDiag(null)}>
                    收起
                  </button>
                </div>
                <div className="conn-diag-text">{diag.verdict}</div>
                {diag.hint && <div className="conn-diag-hint">{diag.hint}</div>}
              </div>
            )}
          </section>

          {/* ---------- 右：连接 ---------- */}
          <section className="conn-col">
            <div className="conn-section-title">手动连接</div>
            <div className="conn-inline">
              <input
                value={manualIp}
                onChange={(e) => setManualIp(e.target.value)}
                placeholder="手机 IP，如 192.168.137.29"
                className="conn-grow"
              />
              <input
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                placeholder="端口"
                className="conn-port"
              />
              <button
                className="btn primary"
                disabled={busyAddr !== ""}
                onClick={() => void doConnect(manualIp.trim(), Number(manualPort) || 5555)}
              >
                连接
              </button>
            </div>

            <div className="conn-section-title">
              配对
              <span className="conn-section-hint">Android 11+ 无线调试首次连接要先配对</span>
            </div>
            <div className="conn-inline">
              <input value={pairIp} onChange={(e) => setPairIp(e.target.value)} placeholder="手机 IP" className="conn-grow" />
              <input
                value={pairPort}
                onChange={(e) => setPairPort(e.target.value)}
                placeholder="配对端口"
                className="conn-port"
              />
            </div>
            <div className="conn-inline">
              <input
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value)}
                placeholder="6 位配对码"
                className="conn-grow"
                maxLength={6}
              />
              <input
                value={pairConnectPort}
                onChange={(e) => setPairConnectPort(e.target.value)}
                placeholder="连接端口(可选)"
                className="conn-port"
              />
              <button className="btn primary" disabled={busyAddr !== ""} onClick={() => void doPair()}>
                配对并连接
              </button>
            </div>

            <div className="conn-section-title">
              USB 转无线
              <span className="conn-section-hint">插一次线，之后可拔线</span>
            </div>
            <div className="conn-inline">
              <select value={usbSerial} onChange={(e) => setUsbSerial(e.target.value)} className="conn-grow">
                {usbDevices.length === 0 && <option value="">没有 USB 设备</option>}
                {usbDevices.map((d) => (
                  <option key={d.serial} value={d.serial}>
                    {d.model ?? d.serial} · {d.serial}
                  </option>
                ))}
              </select>
              <input value={tcpPort} onChange={(e) => setTcpPort(e.target.value)} className="conn-port" />
              <button className="btn primary" disabled={busyAddr !== "" || !usbSerial} onClick={() => void toWireless()}>
                转为无线
              </button>
              <button className="btn" disabled={busyAddr !== "" || !usbSerial} onClick={() => void toUsb()}>
                切回 USB
              </button>
            </div>
            {usbDevices.length === 0 && (
              <div className="tool-hint">
                当前没检测到 USB 设备：插上数据线后这里会自动出现（手机要先打开「USB 调试」）。
                没有线的话，就在手机开发者选项里打开「无线调试」，用上面的「配对并连接」。
              </div>
            )}

            <div className="conn-section-title">
              当前连接
              <span className="conn-section-hint">{online.length} 台可用</span>
              {wirelessOnline.length > 0 && (
                <button className="conn-link" onClick={() => void doDisconnectAll()}>
                  全部断开
                </button>
              )}
            </div>
            <div className="conn-list conn-list-short">
              {adb.length === 0 && <div className="tool-empty">没有设备</div>}
              {adb.map((d) => (
                <div className="conn-row" key={d.serial}>
                  <div className="conn-row-main">
                    <span className="conn-addr mono">{d.serial}</span>
                    <span className="conn-row-tags">
                      <Badge
                        kind={d.state === "device" ? "ok" : d.state === "unauthorized" ? "warn" : "fail"}
                        text={stateLabel[d.state] ?? d.state}
                      />
                      <span className="conn-tag">{d.wireless ? "无线" : "USB"}</span>
                      {d.model && <span className="conn-tag">{d.model}</span>}
                    </span>
                  </div>
                  <div className="conn-row-actions">
                    {d.wireless && (
                      <button className="btn" onClick={() => void doDisconnect(d.serial)}>
                        断开
                      </button>
                    )}
                    <button className="btn" onClick={() => void doDiagnose(d.serial.split(":")[0] ?? "", Number(d.serial.split(":")[1]) || 5555)}>
                      诊断
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="conn-section-title">
              最近连接
              {history.length > 0 && (
                <button className="conn-link" onClick={() => void window.farm.wireless.clearHistory().then(setHistory)}>
                  清空
                </button>
              )}
            </div>
            <div className="conn-list conn-list-short">
              {history.length === 0 && <div className="tool-empty">连过的地址会出现在这里</div>}
              {history.map((h) => (
                <div className="conn-row" key={h.addr}>
                  <div className="conn-row-main">
                    <span className="conn-addr mono">{h.addr}</span>
                    <span className="conn-row-tags">
                      <span className="conn-tag">
                        {new Date(h.lastSeen).toLocaleDateString("zh-CN")} · {h.count} 次
                      </span>
                    </span>
                  </div>
                  <div className="conn-row-actions">
                    <button
                      className="btn primary"
                      disabled={busyAddr !== ""}
                      onClick={() => void doConnect(h.addr.split(":")[0] ?? "", Number(h.addr.split(":")[1]) || 5555)}
                    >
                      连接
                    </button>
                    <button className="btn" onClick={() => void forget(h.addr)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="conn-foot">
          <div className="conn-foot-head">
            <span>运行日志</span>
            <button className="conn-link" onClick={() => setLog([])}>
              清空
            </button>
          </div>
          <div className="conn-log" ref={logRef}>
            {log.map((l) => (
              <div className={`conn-log-line ${l.kind}`} key={l.id}>
                <span className="conn-log-time">{l.time}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}
