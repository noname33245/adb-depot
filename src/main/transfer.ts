/**
 * 传输闸门。
 *
 * 相册缩略图、应用图标都走这里排队，共享同一个并发额度 ——
 * 以前各算各的 2 路，实际能跑到 4 路以上，把投屏的带宽挤掉了。
 *
 * 队列支持取消：翻页时把上一页还没轮到的请求全丢掉，
 * 否则新一页要排在 120 个旧请求后面，表现出来就是「翻不动」。
 */

interface Ticket {
  cancelled: boolean;
  resume: () => void;
}

export class TransferGate {
  #state = new Map<string, { running: number; queue: Ticket[] }>();

  /** 每台设备的令牌桶，用来做速率上限。 */
  #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly slots: () => number,
    private readonly limitKbps: () => number = () => 0,
  ) {}

  /**
   * 按限速消耗令牌；超了就等一下再返回。
   *
   * 严格说这是「出口限速」：数据已经读回来了才按速率放行，
   * 对端不会因为限速而少发，但界面上的加载节奏会按设定走。
   */
  async pace(serial: string, bytes: number): Promise<void> {
    const kbps = this.limitKbps();
    if (!kbps) return;
    const bps = kbps * 1024;
    const now = Date.now();
    const b = this.#buckets.get(serial) ?? { tokens: bps, at: now };
    b.tokens = Math.min(bps, b.tokens + ((now - b.at) / 1000) * bps);
    b.at = now;
    b.tokens -= bytes;
    this.#buckets.set(serial, b);
    if (b.tokens >= 0) return;
    const wait = Math.min(5_000, (-b.tokens / bps) * 1000);
    b.tokens = 0;
    b.at = now + wait;
    await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * @param priority 紧急任务（如点开的大图）：插到队首，不越过并发上限。
   *   以前预览是完全绕过闸门的，结果和 10 路缩略图挤同一条 adb 通道把连接顶死，
   *   正在跑的请求永远不结束，名额就再也放不出来了。
   */
  async run<T>(serial: string, task: () => Promise<T>, priority = false): Promise<T> {
    const limit = Math.max(1, Math.min(12, this.slots()));
    const slot = this.#state.get(serial) ?? { running: 0, queue: [] };
    this.#state.set(serial, slot);

    // 防泄漏：任何异常都不该让 running 超过上限，超了就说明有额度没还回来
    if (slot.running > limit) slot.running = limit;

    if (slot.running >= limit) {
      await new Promise<void>((resolve, reject) => {
        const ticket: Ticket = {
          cancelled: false,
          resume: () => (ticket.cancelled ? reject(new Error("cancelled")) : resolve()),
        };
        if (priority) slot.queue.unshift(ticket);
        else slot.queue.push(ticket);
      });
    }

    slot.running++;
    try {
      return await task();
    } finally {
      slot.running = Math.max(0, slot.running - 1);
      // 一次只放一个，避免额度被瞬间抢空
      slot.queue.shift()?.resume();
    }
  }

  /** 丢掉这台设备所有还没开始的排队任务（正在跑的照常完成）。 */
  cancelQueued(serial: string): void {
    const slot = this.#state.get(serial);
    if (!slot) return;
    const pending = slot.queue.splice(0, slot.queue.length);
    for (const t of pending) {
      t.cancelled = true;
      t.resume();
    }
  }
}
