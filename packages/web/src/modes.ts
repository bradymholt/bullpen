/**
 * Permission modes in Claude Code's own order and words, so someone who uses it
 * daily recognises the list. Values are what the server and SDK expect; only
 * the label is ours. `locked` is bullpen's addition for unattended agents.
 */
export const MODES = [
  ["auto", "Auto", "Claude decides each permission — never prompts"],
  ["supervised", "Manual", "Always ask before making changes"],
  ["acceptEdits", "Accept edits", "Auto-accept file edits, ask for commands"],
  ["plan", "Plan", "Read and plan only, no changes"],
  ["full", "Bypass permissions", "Accept everything, no prompts"],
  ["locked", "Locked", "Deny anything not in allowed tools"],
] as const;

export type ModeValue = (typeof MODES)[number][0];

export function modeLabel(value: string): string {
  return MODES.find(([v]) => v === value)?.[1] ?? value;
}
