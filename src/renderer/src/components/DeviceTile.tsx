import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { BitmapVideoFrameRenderer, WebCodecsVideoDecoder } from "@yume-chan/scrcpy-decoder-webcodecs";
import { ScrcpyVideoCodecId, type ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { DeviceInfo, NavKey, RunStatus } from "@shared/types";
import { useT } from "../settings";
import { route } from "../video";

interface Props {
  device: DeviceInfo;
  selected: boolean;
  focused: boolean;
  recording: boolean;
  run?: RunStatus;
  /** Changes with stream settings, which restarts the stream. */
  streamKey: string;
  /** 磁贴宽度（px），由拖动边框调整。 */
  width: number;
  /** Input targets for this tile, depending on broadcast mode. */
  targets: () => string[];
  onResize: (width: number) => void;
  onToggleSelect: () => void;
  onToggleFocus: () => void;
}

type Status = { kind: "connecting" } | { kind: "live" } | { kind: "error"; message: string };

const MIN_W = 160;
const MAX_W = 900;

export function DeviceTile({ device, selected, focused, recording, run, streamKey, width, targets, onResize, onToggleSelect, onToggleFocus }: Props) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const pointerDown = useRef(false);
  // 先按常见比例占位，拿到真实分辨率后立刻纠正，避免开头闪一下黑边。
  const [aspect, setAspect] = useState(9 / 19.5);
  const online = device.state === "device";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!online || !canvas) return;

    let cancelled = false;
    setStatus({ kind: "connecting" });

    // Create the decoder before starting the stream so the codec configuration packet isn't lost.
    const decoder = new WebCodecsVideoDecoder({
      codec: ScrcpyVideoCodecId.H264,
      // Not WebGL: Chromium caps WebGL contexts at ~16 per page.
      renderer: new BitmapVideoFrameRenderer(canvas),
    });
    const writer = decoder.writable.getWriter();
    // Main may restart the stream (e.g. a scenario run); the tile then resumes on its own.
    let live = false;

    const unroute = route(device.serial, {
      packet(packet) {
        writer.write(packet as ScrcpyMediaStreamPacket).catch(() => {});
        if (!live && packet.type === "data") {
          live = true;
          setStatus({ kind: "live" });
        }
      },
      stopped(reason) {
        live = false;
        if (!cancelled) setStatus({ kind: "error", message: reason });
      },
      size(w, h) {
        if (!cancelled && w > 0 && h > 0) setAspect(w / h);
      },
    });

    void window.farm.mirror.start(device.serial).then((res) => {
      if (cancelled) return;
      if (!res.success) {
        setStatus({ kind: "error", message: res.error ?? t("tile.mirrorFailed") });
        return;
      }
      if (res.width && res.height) setAspect(res.width / res.height);
    });

    return () => {
      cancelled = true;
      unroute();
      void window.farm.mirror.stop(device.serial);
      writer.releaseLock();
      decoder.dispose();
    };
  }, [device.serial, online, attempt, streamKey]);

  function point(e: PointerEvent | WheelEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }

  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || status.kind !== "live") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerDown.current = true;
    window.farm.control.touch(targets(), { action: "down", ...point(e) });
  }

  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    if (!pointerDown.current) return;
    window.farm.control.touch(targets(), { action: "move", ...point(e) });
  }

  function onPointerUp(e: PointerEvent<HTMLCanvasElement>) {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    window.farm.control.touch(targets(), { action: "up", ...point(e) });
  }

  function onWheel(e: WheelEvent<HTMLCanvasElement>) {
    if (status.kind !== "live") return;
    const { x, y } = point(e);
    // One wheel notch ≈ 100px ≈ 3 lines; scrcpy expects notches.
    const notch = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100;
    window.farm.control.scroll(targets(), x, y, -e.deltaX / notch, -e.deltaY / notch);
  }

  const key = (k: NavKey) => window.farm.control.key(targets(), k);

  function onGripDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    document.body.classList.add("tile-resizing");

    // 监听 window：鼠标拖出磁贴范围也继续跟手，不依赖 pointer capture。
    const move = (ev: globalThis.PointerEvent): void =>
      onResize(Math.max(MIN_W, Math.min(MAX_W, startW + (ev.clientX - startX))));
    const up = (): void => {
      document.body.classList.remove("tile-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  const title = [device.brand, device.model].filter(Boolean).join(" ") || device.serial;

  return (
    <div
      className={`tile${selected ? " selected" : ""}${focused ? " focused" : ""}${recording ? " recording" : ""}`}
      style={{ width }}
    >
      <header className="tile-header">
        <label className="tile-check" title={t("tile.select")}>
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
        </label>
        <div className="tile-title" title={device.serial}>
          <span className="tile-name">{title}</span>
          <span className="tile-meta">
            {device.androidVersion ? `Android ${device.androidVersion}` : device.serial}
            {device.battery !== undefined && ` · ${device.battery}%`}
          </span>
        </div>
        {recording && (
          <span className="badge badge-rec" title={t("tile.recording")}>
            ● rec
          </span>
        )}
        {run && (
          <span className="badge badge-run" title={t("tile.run", { name: run.scenarioName, step: run.stepIndex + 1, count: run.stepCount, iteration: run.iteration })}>
            ▶ {run.stepIndex + 1}/{run.stepCount}
          </span>
        )}
        {device.proxy ? (
          <span className="badge badge-proxy" title={t("tile.proxy", { proxy: device.proxy })}>
            proxy
          </span>
        ) : null}
        <button className="icon-btn" onClick={onToggleFocus} title={focused ? t("tile.zoomOut") : t("tile.zoomIn")}>
          {focused ? "⤡" : "⤢"}
        </button>
      </header>

      <div className="screen" style={{ aspectRatio: String(aspect) }}>
        {online ? (
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onContextMenu={(e) => {
              e.preventDefault();
              key("back");
            }}
          />
        ) : null}
        {!online && (
          <div className="screen-overlay">
            {device.state === "unauthorized" ? t("tile.unauthorized") : t("tile.offline")}
          </div>
        )}
        {online && status.kind === "connecting" && <div className="screen-overlay">{t("tile.connecting")}</div>}
        {online && status.kind === "error" && (
          <div className="screen-overlay error">
            <span>{status.message}</span>
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              {t("tile.reconnect")}
            </button>
          </div>
        )}

        {/* 拖右边框或右下角调整投屏大小，只覆盖画面区域，不挡顶部按钮和底部导航 */}
        <div className="tile-resize tile-resize-r" title="拖动调整大小" onPointerDown={onGripDown} />
        <div className="tile-resize tile-resize-br" title="拖动调整大小" onPointerDown={onGripDown}>
          <span />
        </div>
      </div>

      <footer className="tile-nav">
        <button className="icon-btn" onClick={() => key("back")} title={t("key.back")}>
          ◁
        </button>
        <button className="icon-btn" onClick={() => key("home")} title={t("key.home")}>
          ○
        </button>
        <button className="icon-btn" onClick={() => key("recents")} title={t("key.recents")}>
          ▢
        </button>
        <button className="icon-btn" onClick={() => key("power")} title={t("key.power")}>
          ⏻
        </button>
      </footer>
    </div>
  );
}
