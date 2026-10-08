import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** Telegram clears the indicator after about five seconds, or at the bot's next message. */
export const TYPING_INTERVAL_MS = 4000;
/** Bot API limit for one message's text. */
export const MAX_MESSAGE_CHARS = 4096;
/** sendPhoto wants these; anything else goes as a document. */
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

type Send = (url: string, body: URLSearchParams | FormData) => Promise<unknown>;
const defaultSend: Send = (url, body) => fetch(url, { method: "POST", body });

/** The chat a run's delivery came from, read from the workspace's payload.json. */
function chatOf(cwd: string, env: Record<string, string>): { token: string; chatId: number } | null {
  let chatId: unknown;
  try {
    const payload = JSON.parse(readFileSync(join(cwd, ".bullpen", "payload.json"), "utf8"));
    chatId = payload?.message?.chat?.id;
  } catch {
    return null;
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || typeof chatId !== "number") return null;
  return { token, chatId };
}

/**
 * Shows "typing…" in the chat that triggered the run until the returned stop is
 * called. The chat comes from the workspace's payload.json, which a queued or
 * resumed run has too.
 */
export function startTelegramTyping(cwd: string, env: Record<string, string>, send: Send = defaultSend): () => void {
  const chat = chatOf(cwd, env);
  if (!chat) return () => {};

  const url = `https://api.telegram.org/bot${chat.token}/sendChatAction`;
  const body = new URLSearchParams({ chat_id: String(chat.chatId), action: "typing" });
  const tick = () => void send(url, body).catch(() => {});
  tick();
  const timer = setInterval(tick, TYPING_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Splits at the last line break before the limit, so a list isn't cut mid-item. */
export function chunkMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export type ReplyOutcome = { messages: number; files: number; errors: string[] };

/**
 * Posts the run's last message to the chat it came from, then each kept file:
 * images as photos, the rest as documents. Nothing is retried; what failed is
 * reported so the run page can show it.
 */
export async function sendTelegramReply(
  cwd: string,
  env: Record<string, string>,
  text: string,
  files: { name: string; path: string }[],
  send: Send = defaultSend,
): Promise<ReplyOutcome> {
  const outcome: ReplyOutcome = { messages: 0, files: 0, errors: [] };
  const chat = chatOf(cwd, env);
  if (!chat) {
    outcome.errors.push("no TELEGRAM_BOT_TOKEN in the agent's env, or no chat id in the payload");
    return outcome;
  }
  const api = (method: string) => `https://api.telegram.org/bot${chat.token}/${method}`;
  const chatId = String(chat.chatId);
  const check = async (what: string, call: Promise<unknown>) => {
    try {
      const res = (await call) as { ok?: boolean; json?: () => Promise<{ ok?: boolean; description?: string }> } | undefined;
      const body = typeof res?.json === "function" ? await res.json() : undefined;
      if (body && body.ok === false) throw new Error(body.description ?? "Telegram refused it");
      return true;
    } catch (e) {
      outcome.errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  for (const chunk of chunkMessage(text)) {
    if (await check("message", send(api("sendMessage"), new URLSearchParams({ chat_id: chatId, text: chunk })))) outcome.messages++;
  }
  for (const file of files) {
    const photo = PHOTO_EXTENSIONS.has(extname(file.name).toLowerCase());
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set(photo ? "photo" : "document", new Blob([readFileSync(file.path)]), basename(file.name));
    let ok = await check(file.name, send(api(photo ? "sendPhoto" : "sendDocument"), form));
    // Telegram is picky about photos (size, aspect ratio); the same bytes always go as a document.
    if (!ok && photo) {
      const retry = new FormData();
      retry.set("chat_id", chatId);
      retry.set("document", new Blob([readFileSync(file.path)]), basename(file.name));
      ok = await check(`${file.name} (as document)`, send(api("sendDocument"), retry));
    }
    if (ok) outcome.files++;
  }
  return outcome;
}
