import { useEffect, useRef, useState } from "react";
import type { DeviceInfo, PhoneNotification } from "@shared/types";
import { useSettings } from "../settings";
import { Empty } from "./ToolsPanels";

/** 优先录 MP4；当前 Chromium 不支持时才退回 WebM，界面会如实显示扩展名。 */
function pickMime(): { mime: string; ext: string } | undefined {
  const candidates: [string, string][] = [
    ["video/mp4;codecs=avc1.42E01E", "mp4"],
    ["video/mp4;codecs=avc1", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm;codecs=vp8", "webm"],
    ["video/webm", "webm"],
  ];
  for (const [mime, ext] of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return undefined;
}

interface ActiveRec {
  id: string;
  path: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  chain: Promise<void>;
  startedAt: number;
}

export function MonitorPanel({ serial, devices }: { serial?: string; devices: DeviceInfo[] }) {
  const { settings } = useSettings();
  const online = devices.filter((d) => d.state === "device");

  // ---------- 性能 ----------
  const [perf, setPerf] = useState<Record<string, { fps: number; kbps: number }>>({});
  const [ping, setPing] = useState<number>();
  useEffect(() => window.farm.mirror.onStats((s, stats) => setPerf((prev) => ({ ...prev, [s]: stats }))), []);
  useEffect(() => {
    if (!serial) return;
    let alive = true;
    const measure = async (): Promise<void> => {
      try {
        const ms = await window.farm.system.ping(serial);
        if (alive) setPing(ms);
      } catch {
        if (alive) setPing(undefined);
      }
    };
    void measure();
    const timer = window.setInterval(() => void measure(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [serial]);

  // ---------- 屏幕录制 ----------
  const recRef = useRef<ActiveRec | null>(null);
  const [recording, setRecording] = useState(false);
  const [recMsg, setRecMsg] = useState("");
  const [lastPath, setLastPath] = useState("");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const r = recRef.current;
      if (r) setElapsed(Math.floor((Date.now() - r.startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const startRec = async (): Promise<void> => {
    if (!serial || recRef.current) return;
    const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-serial="${CSS.escape(serial)}"]`);
    if (!canvas || !canvas.width || !canvas.height) {
      setRecMsg("当前设备没有可用的投屏画面。请先切到「视频优先」并确认画面正常，再开始录制。");
      return;
    }
    const picked = pickMime();
    if (!picked) {
      setRecMsg("当前环境不支持 MediaRecorder，无法录制。");
      return;
    }
    const created = await window.farm.screenrec.create(serial, picked.ext);
    if (!created) {
      setRecMsg("已取消");
      return;
    }
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    try {
      stream = canvas.captureStream(30);
      if (stream.getVideoTracks().length === 0) throw new Error("浏览器没能从投屏画布取到视频轨");
      recorder = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 8_000_000 });
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      await window.farm.screenrec.abort(created.id);
      setRecMsg(`采集画面失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!stream || !recorder) return;

    const rec: ActiveRec = {
      id: created.id,
      path: created.path,
      recorder,
      stream,
      chain: Promise.resolve(),
      startedAt: Date.now(),
    };
    recRef.current = rec;
    let gotData = false;
    // bitmaprenderer 画布偶尔取不到帧：别让用户拿到一个 0 字节的视频文件
    const guard = window.setTimeout(() => {
      if (recRef.current === rec && !gotData) {
        setRecMsg("6 秒内没有录到画面帧，已停止。请确认投屏画面正常、且处于「视频优先」。");
        stopRec();
      }
    }, 6_000);

    // 分片严格按到达顺序追加写盘，stop 时最后一个 finish 会排在所有 append 之后
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      gotData = true;
      const bytes = e.data.arrayBuffer().then((b) => new Uint8Array(b));
      rec.chain = rec.chain.then(async () => {
        await window.farm.screenrec.append(rec.id, await bytes);
      });
    };
    recorder.onerror = () => {
      rec.chain = rec.chain.then(() => window.farm.screenrec.abort(rec.id));
      if (recRef.current === rec) stopRec();
    };
    recorder.onstop = () => {
      window.clearTimeout(guard);
      rec.chain = rec.chain.then(async () => {
        if (!gotData) {
          await window.farm.screenrec.abort(rec.id);
          return;
        }
        const path = await window.farm.screenrec.finish(rec.id);
        setLastPath(path);
        setRecMsg(path ? `已保存：${path}` : "录制已结束");
      });
    };
    // 投屏被关掉 / 设备掉线时，canvas 没了就自动收尾，别留下半截文件
    const track = stream.getVideoTracks()[0];
    if (track) track.onended = () => { if (recRef.current === rec) stopRec(); };

    recorder.start(1000);
    setElapsed(0);
    setRecording(true);
    setRecMsg(`录制中 → ${created.path}`);
  };

  function stopRec(): void {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    if (rec.recorder.state !== "inactive") rec.recorder.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    setRecording(false);
  }

  // ---------- 通知同步 ----------
  const [items, setItems] = useState<PhoneNotification[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [popup, setPopup] = useState(() => localStorage.getItem("adbdepot.notifyPopup") !== "0");
  useEffect(() => {
    void window.farm.notifications.list().then(setItems);
    void window.farm.notifications.serial().then((s) => setSyncing(Boolean(s)));
    return window.farm.notifications.onChange(setItems);
  }, []);
  useEffect(() => {
    if (syncing && serial) void window.farm.notifications.start(serial, popup);
  }, [serial, syncing, popup]);
  const toggleSync = (): void => {
    if (syncing) {
      setSyncing(false);
      void window.farm.notifications.stop();
    } else {
      if (!serial) return;
      setSyncing(true);
      void window.farm.notifications.start(serial, popup);
    }
  };

  if (!serial) return <Empty text="先在左侧勾选一台设备" />;

  return (
    <div className="tool-panel monitor-panel">
      {/* ---------- 性能 ---------- */}
      <section className="mon-section">
        <h4 className="mon-title">性能</h4>
        <div className="mon-settings">
          <span>链路 <b>{settings.linkMode === "files" ? "文件优先" : "视频优先"}</b></span>
          <span>并发 <b>{settings.linkMode === "video" ? 2 : Math.max(8, settings.transferSlots)}</b></span>
          <span>限速 <b>{settings.linkMode === "files" ? "不限" : settings.linkMode === "video" ? "512 KB/s" : settings.transferLimitKbps ? `${settings.transferLimitKbps} KB/s` : "不限"}</b></span>
          <span>控制延迟 <b>{ping === undefined ? "—" : `${ping} ms`}</b></span>
        </div>
        <div className="mon-perf">
          {online.length === 0 && <div className="tool-hint">没有在线设备</div>}
          {online.map((d) => {
            const p = perf[d.serial];
            return (
              <div className="mon-row" key={d.serial}>
                <span className="mon-name" title={d.serial}>{d.model || d.serial}</span>
                <span className={p ? "mon-val" : "mon-val dim"}>
                  {p ? `${p.fps} fps` : "无视频流"}
                </span>
                <span className={p ? "mon-val" : "mon-val dim"}>
                  {p ? (p.kbps >= 1000 ? `${(p.kbps / 1000).toFixed(1)} Mbps` : `${p.kbps} Kbps`) : "—"}
                </span>
              </div>
            );
          })}
        </div>
        <div className="tool-hint">帧率 / 码率每 2 秒汇总一次；控制延迟是 adb 指令往返时间。文件优先模式下没有视频流，这两项为空属正常。</div>
      </section>

      {/* ---------- 屏幕录制 ---------- */}
      <section className="mon-section">
        <h4 className="mon-title">屏幕录制</h4>
        <div className="tool-bar">
          {!recording ? (
            <button className="btn primary" onClick={() => void startRec()}>● 开始录制</button>
          ) : (
            <button className="btn danger" onClick={stopRec}>■ 停止 ({elapsed}s)</button>
          )}
          {lastPath && (
            <button className="btn" onClick={() => void window.farm.screenrec.reveal(lastPath)}>打开所在文件夹</button>
          )}
        </div>
        <div className="tool-hint">{recMsg || "录电脑上的投屏画面，不在手机上跑录屏、不占手机存储。需要「视频优先」且画面正常。"}</div>
      </section>

      {/* ---------- 通知同步 ---------- */}
      <section className="mon-section">
        <div className="mon-head">
          <h4 className="mon-title">通知同步</h4>
          <button className="btn" onClick={toggleSync}>{syncing ? "停止同步" : "开始同步"}</button>
          <label className="mon-check">
            <input
              type="checkbox"
              checked={popup}
              onChange={(e) => {
                setPopup(e.target.checked);
                localStorage.setItem("adbdepot.notifyPopup", e.target.checked ? "1" : "0");
              }}
            />
            弹系统通知
          </label>
          <button className="btn" onClick={() => void window.farm.notifications.clear()}>清空</button>
        </div>
        <div className="tool-hint">只读通知栏，不装 APK、不打开手机界面，约 5 秒轮询一次，只作用于当前选择的设备。</div>
        <div className="mon-list">
          {items.length === 0 && <div className="tool-hint">暂无通知</div>}
          {items.map((n) => (
            <div className="mon-notif" key={n.id}>
              <div className="mon-notif-head">
                <span className="mon-name">{n.title || n.pkg}</span>
                <span className="tool-hint">{new Date(n.at).toLocaleTimeString()}</span>
              </div>
              {n.text && <div className="mon-notif-body">{n.text}</div>}
              <div className="tool-hint">{n.pkg}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
