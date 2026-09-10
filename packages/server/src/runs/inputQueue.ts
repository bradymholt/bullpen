import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Streaming input mode requires an AsyncIterable prompt, and the SDK only
 * exposes interrupt()/setPermissionMode()/setModel() in that mode. This is the
 * push end of it: the run holds the iterable open so follow-up messages can be
 * folded into a live session instead of starting a new one.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(text: string): void {
    if (this.#closed) throw new Error("InputQueue is closed");
    this.#pending.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.#pending.length > 0) yield this.#pending.shift()!;
      if (this.#closed) return;
      await new Promise<void>((r) => {
        this.#wake = () => {
          this.#wake = null;
          r();
        };
      });
    }
  }
}
