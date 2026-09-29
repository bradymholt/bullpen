import type { RunnerEvents } from "./runner.ts";

type Result = Parameters<RunnerEvents["onResult"]>[0];

/**
 * Decides when a session's result means the run is over. An agent that starts
 * background work and ends its turn to wait for it gets a `result` right away,
 * but the task's completion starts another turn in the same process — so a
 * result that arrives while tasks are live is held until a later one arrives
 * with none, or until `waitMs` passes.
 */
export class ResultGate {
  private live = new Set<string>();
  private held: Result | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onResult: (r: Result) => void;
  private readonly waitMs: number;

  constructor(onResult: (r: Result) => void, waitMs: number) {
    this.onResult = onResult;
    this.waitMs = waitMs;
  }

  /** Replace semantics, as `background_tasks_changed` asks: the payload is the whole live set. */
  backgroundTasks(tasks: { task_id: string; ambient?: boolean }[]): void {
    this.live = new Set(tasks.filter((t) => !t.ambient).map((t) => t.task_id));
  }

  result(r: Result): void {
    // A result's num_turns covers its own turn, but its cost is the whole process's so far.
    if (this.held?.numTurns !== undefined) r = { ...r, numTurns: this.held.numTurns + (r.numTurns ?? 0) };
    if (this.live.size === 0) return this.release(r);
    this.held = r;
    this.timer ??= setTimeout(() => this.held && this.release(this.held), this.waitMs);
  }

  private release(r: Result): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.held = undefined;
    this.onResult(r);
  }

  /** The stream ended; a held result is still the run's last word. */
  flush(): void {
    if (this.held) this.release(this.held);
  }
}
