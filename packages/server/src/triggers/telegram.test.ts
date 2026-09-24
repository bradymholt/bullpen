import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTelegramTyping, TYPING_INTERVAL_MS } from "./telegram.ts";

function workspaceWith(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bullpen-telegram-"));
  mkdirSync(join(dir, ".bullpen"));
  writeFileSync(join(dir, ".bullpen", "payload.json"), JSON.stringify(payload));
  return dir;
}

describe("telegram typing", () => {
  afterEach(() => vi.useRealTimers());

  it("types in the payload's chat until stopped", () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());
    const stop = startTelegramTyping(workspaceWith({ message: { chat: { id: 99 } } }), { TELEGRAM_BOT_TOKEN: "T" }, send);
    vi.advanceTimersByTime(TYPING_INTERVAL_MS);
    stop();
    vi.advanceTimersByTime(TYPING_INTERVAL_MS * 3);

    expect(send).toHaveBeenCalledTimes(2);
    const [url, body] = send.mock.calls[0] as unknown as [string, URLSearchParams];
    expect(url).toBe("https://api.telegram.org/botT/sendChatAction");
    expect(body.get("chat_id")).toBe("99");
  });

  it("does nothing without a token", () => {
    const send = vi.fn(() => Promise.resolve());
    startTelegramTyping(workspaceWith({ message: { chat: { id: 99 } } }), {}, send)();
    expect(send).not.toHaveBeenCalled();
  });
});
