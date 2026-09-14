import { query, type Options, type PermissionMode, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { InputQueue } from "./inputQueue.ts";

export type RunnerSpec = {
  cwd: string;
  prompt: string;
  model?: string | undefined;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Options["mcpServers"];
  strictMcpConfig: boolean;
  inheritUserSettings: boolean;
  env?: Record<string, string>;
  maxTurns?: number | undefined;
  resumeSessionId?: string | undefined;
  canUseTool?: Options["canUseTool"];
};

export type RunnerHandle = {
  /** Resolves when the SDK stream ends. */
  done: Promise<void>;
  send(text: string): void;
  stop(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  sessionId(): string | undefined;
};

/**
 * Wraps one `query()` session. Always streaming-input mode: the SDK exposes
 * interrupt() and setPermissionMode() only there, and without them a run has
 * no stop button and no mid-run mode change.
 */
export function startRunner(spec: RunnerSpec, onMessage: (m: SDKMessage) => void): RunnerHandle {
  const input = new InputQueue();
  const abort = new AbortController();
  let sessionId: string | undefined;
  let q: Query | undefined;

  input.push(spec.prompt);

  const done = (async () => {
    q = query({
      prompt: input,
      options: {
        cwd: spec.cwd,
        ...(spec.model ? { model: spec.model } : {}),
        permissionMode: spec.permissionMode,
        ...(spec.allowedTools?.length ? { allowedTools: spec.allowedTools } : {}),
        ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
        ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
        strictMcpConfig: spec.strictMcpConfig,
        ...(spec.canUseTool ? { canUseTool: spec.canUseTool } : {}),
        ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
        ...(spec.resumeSessionId ? { resume: spec.resumeSessionId } : {}),
        settingSources: spec.inheritUserSettings ? ["project", "user"] : ["project"],
        includePartialMessages: true,
        abortController: abort,
        env: { ...process.env, ...spec.env } as Record<string, string>,
        stderr: (data) => console.error(`[claude] ${data.trimEnd()}`),
      },
    });

    try {
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }
        onMessage(message);
      }
    } finally {
      input.close();
    }
  })();

  return {
    done,
    send: (text) => input.push(text),
    async stop() {
      try {
        await q?.interrupt();
      } catch {
        // interrupt is best-effort; abort is the backstop that always lands.
      }
      abort.abort();
      input.close();
    },
    async setPermissionMode(mode) {
      await q?.setPermissionMode(mode);
    },
    sessionId: () => sessionId,
  };
}
