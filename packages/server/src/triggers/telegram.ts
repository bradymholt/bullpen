import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Telegram clears the indicator after about five seconds, or at the bot's next message. */
export const TYPING_INTERVAL_MS = 4000;

/**
 * Shows "typing…" in the chat that triggered the run until the returned stop is
 * called. The chat comes from the workspace's payload.json, which a queued or
 * resumed run has too.
 */
export function startTelegramTyping(
  cwd: string,
  env: Record<string, string>,
  send: (url: string, body: URLSearchParams) => Promise<unknown> = (url, body) => fetch(url, { method: "POST", body }),
): () => void {
  let chatId: unknown;
  try {
    const payload = JSON.parse(readFileSync(join(cwd, ".bullpen", "payload.json"), "utf8"));
    chatId = payload?.message?.chat?.id;
  } catch {
    return () => {};
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || typeof chatId !== "number") return () => {};

  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  const body = new URLSearchParams({ chat_id: String(chatId), action: "typing" });
  const tick = () => void send(url, body).catch(() => {});
  tick();
  const timer = setInterval(tick, TYPING_INTERVAL_MS);
  return () => clearInterval(timer);
}
