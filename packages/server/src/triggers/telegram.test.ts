import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkMessage, sendTelegramReply, startTelegramTyping, TYPING_INTERVAL_MS } from "./telegram.ts";

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

describe("telegram reply", () => {
  const ok = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });

  it("splits a long message at a line break and sends files as photo or document", async () => {
    const cwd = workspaceWith({ message: { chat: { id: 99 } } });
    writeFileSync(join(cwd, "shot.png"), "png");
    writeFileSync(join(cwd, "report.csv"), "a,b");
    const send = vi.fn((_url: string, _body: URLSearchParams | FormData) => ok());
    const text = `${"a".repeat(4000)}\n${"b".repeat(200)}`;

    const outcome = await sendTelegramReply(cwd, { TELEGRAM_BOT_TOKEN: "T" }, text, [
      { name: "shot.png", path: join(cwd, "shot.png") },
      { name: "report.csv", path: join(cwd, "report.csv") },
    ], send);

    expect(outcome).toEqual({ messages: 2, files: 2, errors: [] });
    const urls = send.mock.calls.map(([url]) => url.replace("https://api.telegram.org/botT/", ""));
    expect(urls).toEqual(["sendMessage", "sendMessage", "sendPhoto", "sendDocument"]);
    expect((send.mock.calls[0]![1] as URLSearchParams).get("text")).toBe("a".repeat(4000));
    expect((send.mock.calls[2]![1] as FormData).get("chat_id")).toBe("99");
  });

  it("falls back to a document when Telegram refuses the photo, and reports what failed", async () => {
    const cwd = workspaceWith({ message: { chat: { id: 99 } } });
    writeFileSync(join(cwd, "tall.png"), "png");
    const send = vi.fn((url: string, _body: URLSearchParams | FormData) =>
      url.endsWith("sendPhoto")
        ? Promise.resolve({ json: () => Promise.resolve({ ok: false, description: "PHOTO_INVALID_DIMENSIONS" }) })
        : ok(),
    );

    const outcome = await sendTelegramReply(cwd, { TELEGRAM_BOT_TOKEN: "T" }, "hi", [{ name: "tall.png", path: join(cwd, "tall.png") }], send);

    expect(outcome.messages).toBe(1);
    expect(outcome.files).toBe(1);
    expect(outcome.errors).toEqual(["tall.png: PHOTO_INVALID_DIMENSIONS"]);
  });

  it("chunks at the limit when there is no usable line break", () => {
    expect(chunkMessage("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
    expect(chunkMessage("  ", 4)).toEqual([]);
  });
});
