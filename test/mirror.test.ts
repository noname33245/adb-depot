import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ clipboard: {} }));
import { restorePhysicalScreen } from "../src/main/mirror";
it("restores display power and cycles sleep before wake", async () => {
  vi.useFakeTimers();
  try {
    const calls: string[] = [];
    const work = restorePhysicalScreen(async () => { calls.push("normal"); }, async (command) => { calls.push(command); });
    await vi.runAllTimersAsync();
    await work;
    expect(calls).toEqual(["normal", "input keyevent 223", "input keyevent 224", "normal"]);
  } finally { vi.useRealTimers(); }
});
it("reports a failed sleep command without claiming recovery", async () => {
  const shell = vi.fn().mockRejectedValue(new Error("device disconnected"));
  await expect(restorePhysicalScreen(async () => {}, shell)).rejects.toThrow("device disconnected");
  expect(shell).toHaveBeenCalledTimes(1);
});
