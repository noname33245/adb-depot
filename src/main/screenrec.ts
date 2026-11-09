/**
 * 屏幕录制落盘。
 *
 * 画面来自渲染层的投屏 canvas，MediaRecorder 每秒吐一个分片，
 * 通过 IPC 追加写进用户选好的文件 —— 不把几十 MB 的 Blob 一次性塞进 IPC，
 * 也不在手机上跑录屏、不占手机存储、不弹任何手机界面。
 */

import { randomUUID } from "node:crypto";
import { appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app, dialog } from "electron";

interface Session {
  path: string;
  ext: string;
}

export class ScreenRecordFiles {
  #sessions = new Map<string, Session>();

  /** 返回 undefined 表示用户取消了保存对话框。 */
  async create(serial: string, ext: string): Promise<{ id: string; path: string } | undefined> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = serial.replace(/[^\w.-]/g, "_").slice(0, 40);
    const pick = await dialog.showSaveDialog({
      title: "保存屏幕录制",
      defaultPath: join(app.getPath("videos"), `AdbDepot_${safe}_${stamp}.${ext}`),
      filters: [{ name: ext === "mp4" ? "MP4 视频" : "WebM 视频", extensions: [ext] }],
    });
    if (pick.canceled || !pick.filePath) return undefined;
    const id = randomUUID();
    this.#sessions.set(id, { path: pick.filePath, ext });
    return { id, path: pick.filePath };
  }

  async append(id: string, bytes: Uint8Array): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s || bytes.byteLength === 0) return;
    await appendFile(s.path, Buffer.from(bytes));
  }

  async finish(id: string): Promise<string> {
    const s = this.#sessions.get(id);
    if (!s) return "";
    this.#sessions.delete(id);
    return s.path;
  }

  /** 录制失败 / 被取消：删掉半截文件，别留个打不开的残骸。 */
  async abort(id: string): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s) return;
    this.#sessions.delete(id);
    await unlink(s.path).catch(() => {});
  }

  /** 退出软件时把还没点「停止」的半截文件清掉。 */
  async abortAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.abort(id)));
  }
}
