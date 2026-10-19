import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OUT_DIR } from "../artifacts.ts";
import { MAX_MESSAGE_CHARS } from "../triggers/telegram.ts";

/**
 * What bullpen appends to the harness's own system prompt for every run. Kept
 * as data so Settings can show it verbatim: an agent's behaviour should be
 * explainable from things the operator can read.
 */
export const SYSTEM_NOTE = {
  /** Only for runs a delivery started; where the body was written. */
  delivery: (trigger: string) =>
    `This run was started by a ${trigger} delivery. Its full body is saved as ` +
    `.bullpen/payload.json in your working directory — read that file whenever you need ` +
    `fields the prompt does not already name. A field left blank in the prompt means the ` +
    `payload had nothing at that path, not that it is missing from the file.`,
  /** Only for runs a Telegram message started; what the chat can show and who sends the reply. */
  telegram: (reply: boolean) =>
    `This run is answering a Telegram message. The sender's text is at message.text in the payload; ` +
    `when that is empty, the same message object holds a caption, photo, document, voice note or ` +
    `audio file instead, described by its Bot API fields (a file is fetched with getFile and ` +
    `$TELEGRAM_BOT_TOKEN). The person is on their phone and waiting, so keep tool calls few and ` +
    `the reply short, plain text with no Markdown. Bullpen shows a typing indicator in the chat ` +
    `while you work; never send one yourself. ` +
    (reply
      ? `Your final message is posted to the chat as the reply, so end your turn with exactly what ` +
        `the person should read and nothing else: no summary of what you did, no sign-off. A ` +
        `message over ${MAX_MESSAGE_CHARS} characters is split. Files you saved under ${OUT_DIR}/ ` +
        `are sent after it, images as photos and anything else as documents. Do not call the Bot ` +
        `API to send any of this yourself.`
      : `The reply is yours to send: POST to https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage ` +
        `with chat_id set to message.chat.id from the payload, at most ${MAX_MESSAGE_CHARS} characters ` +
        `per message. A file goes with sendPhoto (images) or sendDocument (anything else).`),
  /** Every run: the workspace may be deleted when the run ends; this directory is the one thing kept. */
  files:
    `Rule for files: anything the user should end up with — a screenshot, a report, an export, ` +
    `a download — must be written to ${OUT_DIR}/ inside your working directory (mkdir -p it first). ` +
    `Not the working directory itself, not /tmp, not your home directory: those are deleted or ` +
    `unreachable when the run ends, and only ${OUT_DIR}/ is kept and offered to the user for ` +
    `download. When a tool takes a filename, give it a path under ${OUT_DIR}/. Finish by naming ` +
    `the files you saved there.`,
  /** Every run: the shell's `wait` and `jobs` never see a harness background task. */
  waiting:
    `To wait for a background command (a \`sleep\`, a build), end your turn: you are re-invoked ` +
    `when it finishes. Shell \`wait\` and \`jobs\` do not see background commands, and polling ` +
    `its output file only tells you it has not finished yet.`,
  /**
   * Only when the config dir is not `~/.claude`. Agents reach for
   * `~/.claude/skills` by reflex, and in the container HOME is /home/node
   * while CLAUDE_CONFIG_DIR is on the data volume — so that guess costs a
   * turn, and a failed `cd` at the top of a run, every time.
   */
  config: (dir: string) =>
    `Claude Code's configuration directory on this machine is ${dir}, not ~/.claude: skills are ` +
    `in ${join(dir, "skills")} and settings in ${join(dir, "settings.json")}. $CLAUDE_CONFIG_DIR ` +
    `holds the same path. A skill's own files — its scripts, config and data — sit in its ` +
    `directory there, so reach them by absolute path; your working directory is somewhere else ` +
    `entirely, and a shell that cd's out of it is reset on the next command.`,
};

/**
 * The config dir a run will actually see: its own env wins over the process,
 * the same order `resolveEnv()` hands to the harness. Null when it is the
 * default `~/.claude`, which needs no explaining.
 */
export function noteworthyConfigDir(env: Record<string, string> = {}): string | null {
  const dir = env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return null;
  return resolve(dir) === join(homedir(), ".claude") ? null : dir;
}

export type NoteOptions = {
  /** Set when a Telegram message started the run; `reply` is the agent's webhookReply setting. */
  telegram?: { reply: boolean };
};

export function systemNote(trigger: string, env: Record<string, string> = {}, opts: NoteOptions = {}): string {
  const configDir = noteworthyConfigDir(env);
  return [
    trigger === "webhook" || trigger === "poll" ? SYSTEM_NOTE.delivery(trigger) : null,
    opts.telegram ? SYSTEM_NOTE.telegram(opts.telegram.reply) : null,
    SYSTEM_NOTE.files,
    SYSTEM_NOTE.waiting,
    configDir ? SYSTEM_NOTE.config(configDir) : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}
