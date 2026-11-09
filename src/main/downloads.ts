/**
 * 下载队列。
 *
 * 以前多选 20 张点「下载」会把渲染层卡到全部传完，中途也停不下来。
 * 这里把任务排队后台跑，主进程每完成一张就推一次状态，界面可以边下边翻页。
 *
 * 串行执行：adb pull 本来就吃满一条链路，多开只会互相抢；
 * 而且 pullFile 走的是独立的 adb 命令进程，不占投屏那条 transport。
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AdbTools } from "./tools";
import type { DownloadTask } from "@shared/types";

export class DownloadQueue {
  #tasks: DownloadTask[] = [];
  #running = false;

  constructor(
    private readonly tools: AdbTools,
    private readonly emit: (tasks: DownloadTask[]) => void,
  ) {}

  list(): DownloadTask[] {
    return this.#tasks.map((t) => ({ ...t }));
  }

  /** 返回真正加进去的条数（重复项会被跳过）。 */
  enqueue(serial: string, paths: string[], dir: string): number {
    const pending = new Set(
      this.#tasks.filter((t) => t.state === "queued" || t.state === "running").map((t) => `${t.serial}|${t.path}`),
    );
    let added = 0;
    for (const path of paths) {
      if (!path || pending.has(`${serial}|${path}`)) continue;
      pending.add(`${serial}|${path}`);
      this.#tasks.push({
        id: randomUUID(),
        serial,
        path,
        name: basename(path) || path,
        state: "queued",
        dir,
      });
      added++;
    }
    // 只保留最近 300 条记录，别让历史把内存吃光
    if (this.#tasks.length > 300) this.#tasks.splice(0, this.#tasks.length - 300);
    this.#emit();
    void this.#pump();
    return added;
  }

  /** 不传 id = 取消全部还没开始的；正在传的那一张等它传完。 */
  cancel(id?: string): void {
    for (const t of this.#tasks) {
      if (t.state === "queued" && (!id || t.id === id)) t.state = "cancelled";
    }
    this.#emit();
  }

  /** 清掉已经结束的任务记录，保留排队中和传输中的。 */
  clear(): void {
    this.#tasks = this.#tasks.filter((t) => t.state === "queued" || t.state === "running");
    this.#emit();
  }

  #emit(): void {
    this.emit(this.list());
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        const task = this.#tasks.find((t) => t.state === "queued");
        if (!task) break;
        task.state = "running";
        this.#emit();
        try {
          task.saved = await this.tools.pullFile(task.serial, task.path, task.dir);
          task.state = "done";
        } catch (e) {
          task.state = "failed";
          task.error = e instanceof Error ? e.message : String(e);
        }
        this.#emit();
      }
    } finally {
      this.#running = false;
    }
  }
}
