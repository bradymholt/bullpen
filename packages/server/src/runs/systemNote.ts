import { OUT_DIR } from "../artifacts.ts";

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
  /** Every run: the workspace may be deleted when the run ends; this directory is the one thing kept. */
  files:
    `Rule for files: anything the user should end up with — a screenshot, a report, an export, ` +
    `a download — must be written to ${OUT_DIR}/ inside your working directory (mkdir -p it first). ` +
    `Not the working directory itself, not /tmp, not your home directory: those are deleted or ` +
    `unreachable when the run ends, and only ${OUT_DIR}/ is kept and offered to the user for ` +
    `download. When a tool takes a filename, give it a path under ${OUT_DIR}/. Finish by naming ` +
    `the files you saved there.`,
  /**
   * Only when the agent has the keyring password, since gog without it cannot
   * authenticate and an agent told otherwise spends turns finding that out.
   */
  gog:
    `The \`gog\` CLI is available and signed in to Google: Gmail, Calendar, Drive, Docs and ` +
    `Sheets, for reading, sending and organising. Run it with Bash — \`gog --help\` lists the ` +
    `commands, and \`--json\` or \`--plain\` give parseable output.`,
};

export function systemNote(trigger: string, env: Record<string, string> = {}): string {
  const hasGog = Boolean(env.GOG_KEYRING_PASSWORD ?? process.env.GOG_KEYRING_PASSWORD);
  return [
    trigger === "webhook" || trigger === "poll" ? SYSTEM_NOTE.delivery(trigger) : null,
    SYSTEM_NOTE.files,
    hasGog ? SYSTEM_NOTE.gog : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}
