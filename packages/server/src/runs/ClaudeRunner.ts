import { query, type PermissionMode, type Query } from "@anthropic-ai/claude-agent-sdk";
import { summarizeMcpStatus } from "../mcp.ts";
import { InputQueue } from "./inputQueue.ts";
import type { ModeName, Runner, RunnerEvents, RunnerHandle, RunnerSpec } from "./runner.ts";

/**
 * Bullpen's mode names to the SDK's. `auto` here is the harness's classifier
 * mode, `locked` is deny-by-default with allowedTools as the whole allowance.
 */
const SDK_MODES: Record<ModeName, PermissionMode> = {
  supervised: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  auto: "auto",
  full: "bypassPermissions",
  locked: "dontAsk",
};

export function toSdkPermissionMode(mode: string): PermissionMode {
  return SDK_MODES[mode as ModeName] ?? "default";
}

/**
 * Wraps one `query()` session. Always streaming-input mode: the SDK exposes
 * interrupt() and setPermissionMode() only there, and without them a run has
 * no stop button and no mid-run mode change.
 */
function start(spec: RunnerSpec, events: RunnerEvents): RunnerHandle {
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
        permissionMode: toSdkPermissionMode(spec.permissionMode),
        ...(spec.allowedTools?.length ? { allowedTools: spec.allowedTools } : {}),
        ...(spec.disallowedTools?.length ? { disallowedTools: spec.disallowedTools } : {}),
        ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
        strictMcpConfig: spec.strictMcpConfig,
        ...(spec.canUseTool ? { canUseTool: spec.canUseTool } : {}),
        ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
        ...(spec.resumeSessionId ? { resume: spec.resumeSessionId } : {}),
        // Not `appendSystemPrompt`: that is no Options key and a spread hides the
        // typo from the compiler, so the note was silently dropped for months.
        ...(spec.appendSystemPrompt
          ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: spec.appendSystemPrompt } }
          : {}),
        settingSources: spec.inheritUserSettings ? ["project", "user"] : ["project"],
        includePartialMessages: true,
        abortController: abort,
        env: { ...process.env, ...spec.env } as Record<string, string>,
        stderr: (data) => console.error(`[claude] ${data.trimEnd()}`),
      },
    });

    try {
      for await (const message of q) {
        events.onMessage(message.type, message);
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          events.onSession(message.session_id);
          events.onMcpStatus(summarizeMcpStatus(message));
        }
        if (message.type === "result") {
          events.onResult({
            numTurns: message.num_turns,
            costUsd: message.total_cost_usd,
            isError: message.is_error,
          });
        }
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
      await q?.setPermissionMode(toSdkPermissionMode(mode));
    },
    sessionId: () => sessionId,
  };
}

export const claudeRunner: Runner = { start };
