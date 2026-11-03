// One IPC subscription for the whole app; packets are routed to tiles by serial.
import type { VideoPacket } from "@shared/types";

type Route = {
  packet(packet: VideoPacket): void;
  stopped(reason: string): void;
  /** 视频真实分辨率，用来把容器比例调成和画面一致，避免黑边。 */
  size?(width: number, height: number): void;
};

const routes = new Map<string, Route>();

window.farm.mirror.onPacket((serial, packet) => routes.get(serial)?.packet(packet));
window.farm.mirror.onStopped((serial, reason) => routes.get(serial)?.stopped(reason));
window.farm.mirror.onSize((serial, width, height) => routes.get(serial)?.size?.(width, height));

export function route(serial: string, r: Route): () => void {
  routes.set(serial, r);
  return () => {
    if (routes.get(serial) === r) routes.delete(serial);
  };
}
