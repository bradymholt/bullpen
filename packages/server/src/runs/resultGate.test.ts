import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultGate } from "./resultGate.ts";

const r = (numTurns: number) => ({ numTurns, costUsd: 0, isError: false });

afterEach(() => vi.useRealTimers());

describe("ResultGate", () => {
  it("holds a result while background work is live, releasing the next result once it settles", () => {
    const seen: number[] = [];
    const gate = new ResultGate((x) => seen.push(x.numTurns!), 60_000);
    gate.backgroundTasks([{ task_id: "sleep" }, { task_id: "watcher", ambient: true }]);
    gate.result(r(9));
    expect(seen).toEqual([]);
    gate.backgroundTasks([{ task_id: "watcher", ambient: true }]);
    gate.result(r(11));
    expect(seen).toEqual([20]);
  });

  it("closes anyway once the wait runs out", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const gate = new ResultGate((x) => seen.push(x.numTurns!), 60_000);
    gate.backgroundTasks([{ task_id: "dev-server" }]);
    gate.result(r(3));
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([3]);
  });
});
