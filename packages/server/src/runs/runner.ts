import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { summarizeMcpStatus } from "../mcp.ts";

/**
 * The seam between bullpen and whatever executes an agent. Everything outside
 * this file and its implementations — triggers, the event log, approvals, the
 * UI — speaks only in these terms. A second backend (Codex, say) is a second
 * implementation of `Runner` and nothing else has to know.
 *
 * Deliberately narrow: this normalizes the handful of facts bullpen acts on,
 * not every message. Raw messages still flow through `onMessage` untouched for
 * the event log, and the Timeline renders those; a second backend would bring
 * its own renderer for its own message shapes.
 */

/** Bullpen's own mode names — what agents store and the UI shows. */
export const MODE_NAMES = ["supervised", "acceptEdits", "plan", "auto", "full", "locked"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

export type RunnerSpec = {
  cwd: string;
  prompt: string;
  model?: string | undefined;
  /** One of MODE_NAMES; each runner translates to its own vocabulary. */
  permissionMode: ModeName;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Options["mcpServers"];
  strictMcpConfig: boolean;
  inheritUserSettings: boolean;
  appendSystemPrompt?: string | undefined;
  env?: Record<string, string>;
  maxTurns?: number | undefined;
  resumeSessionId?: string | undefined;
  canUseTool?: Options["canUseTool"];
};

export type RunnerEvents = {
  /** Every message the backend emits, as-is. Goes to the event log under `type`. */
  onMessage(type: string, payload: unknown): void;
  /** The backend's id for this session, for resuming it later. */
  onSession(sessionId: string): void;
  onMcpStatus(servers: ReturnType<typeof summarizeMcpStatus>): void;
  /** The run finished. `costUsd` is in dollars; storage decides the unit. */
  onResult(result: { numTurns: number | undefined; costUsd: number | undefined; isError: boolean }): void;
};

export type RunnerHandle = {
  /** Resolves when the backend's stream ends. */
  done: Promise<void>;
  send(text: string): void;
  stop(): Promise<void>;
  setPermissionMode(mode: ModeName): Promise<void>;
  sessionId(): string | undefined;
};

export type Runner = {
  start(spec: RunnerSpec, events: RunnerEvents): RunnerHandle;
};
