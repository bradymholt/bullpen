import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../db/index.ts";
import { agents, approvals, runs, type Agent } from "../db/schema.ts";
import { hub } from "../hub.ts";
import { interpolateSecrets, summarizeMcpStatus } from "../mcp.ts";
import { removeWorkspace, resolveWorkspace, type WorkspaceSpec } from "../workspaces.ts";
import { dropPending, makeCanUseTool } from "./approvals.ts";
import { startRunner, type RunnerHandle } from "./ClaudeRunner.ts";
import { appendEvent } from "./eventLog.ts";

export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const ACTIVE_STATUSES: RunStatus[] = ["running", "awaiting_approval"];

/** Bullpen's UI modes, mapped to what the SDK actually accepts. */
const PERMISSION_MODES: Record<string, PermissionMode> = {
  supervised: "default",
  acceptEdits: "acceptEdits",
  plan: "plan",
  full: "bypassPermissions",
  auto: "auto",
  locked: "dontAsk",
};

export function toSdkPermissionMode(mode: string): PermissionMode {
  return PERMISSION_MODES[mode] ?? "default";
}

export function isPermissionMode(mode: string): boolean {
  return mode in PERMISSION_MODES;
}

const live = new Map<string, RunnerHandle>();
/** Runs the user stopped on purpose, so the interrupted result doesn't read as a failure. */
const stopping = new Set<string>();

export function isActive(runId: string): boolean {
  return live.has(runId);
}

export function agentHasActiveRun(agentId: string): boolean {
  const row = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), inArray(runs.status, ACTIVE_STATUSES)))
    .get();
  return row !== undefined;
}

function setStatus(runId: string, status: RunStatus, patch: Partial<typeof runs.$inferInsert> = {}) {
  db.update(runs).set({ status, ...patch }).where(eq(runs.id, runId)).run();
  hub.broadcast(runId, { type: "status", runId, status });
}

export function startRun(opts: {
  agent: Agent;
  trigger: "manual" | "cron" | "webhook" | "poll";
  prompt?: string;
  /** Overrides the agent's saved mode for this run only. */
  permissionMode?: string;
  /** Ignores the agent's workspace and runs in a directory used once. */
  ephemeralWorkspace?: boolean;
  /** Runs after the workspace exists, before the agent starts. */
  onWorkspace?: (path: string) => void;
}): string {
  const { agent, trigger } = opts;
  const runId = randomUUID();
  const prompt = opts.prompt ?? agent.prompt;
  const permissionMode = opts.permissionMode ?? agent.permissionMode;
  // Where the delivery body lives is bullpen's business, not something every
  // prompt should have to restate.
  const payloadNote =
    trigger === "webhook" || trigger === "poll"
      ? `This run was started by a ${trigger} delivery. Its full body is saved as ` +
        `.bullpen/payload.json in your working directory — read that file whenever you need ` +
        `fields the prompt does not already name. A field left blank in the prompt means the ` +
        `payload had nothing at that path, not that it is missing from the file.`
      : undefined;

  const spec: WorkspaceSpec = opts.ephemeralWorkspace
    ? { kind: "ephemeral" }
    : (agent.workspaceConfig as WorkspaceSpec);
  const ephemeral = spec.kind === "ephemeral";
  const workspace = resolveWorkspace(spec, {
    agentId: agent.id,
    agentName: agent.name,
    runId,
  });

  opts.onWorkspace?.(workspace.path);

  db.insert(runs)
    .values({
      id: runId,
      agentId: agent.id,
      status: "running",
      trigger,
      prompt,
      permissionMode,
      workspacePath: workspace.path,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
    })
    .run();

  appendEvent(runId, "run.started", { agentId: agent.id, trigger, prompt, permissionMode, cwd: workspace.path });

  const handle = startRunner(
    {
      cwd: workspace.path,
      prompt,
      model: agent.model ?? undefined,
      permissionMode: toSdkPermissionMode(permissionMode),
      allowedTools: agent.allowedTools as string[],
      disallowedTools: agent.disallowedTools as string[],
      mcpServers: interpolateSecrets(agent.mcpServers, agent.env as Record<string, string>) as never,
      strictMcpConfig: !agent.inheritMachineMcp,
      inheritUserSettings: agent.inheritUserSettings,
      appendSystemPrompt: payloadNote,
      env: agent.env as Record<string, string>,
      maxTurns: agent.maxTurns ?? undefined,
      canUseTool: makeCanUseTool(runId, (hasPending) => {
        const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
        if (!current || !ACTIVE_STATUSES.includes(current.status as RunStatus)) return;
        setStatus(runId, hasPending ? "awaiting_approval" : "running");
      }),
    },
    (message) => onMessage(runId, message),
  );

  live.set(runId, handle);

  handle.done
    .then(() => {
      if (stopping.has(runId)) return;
      const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
      if (current && ACTIVE_STATUSES.includes(current.status as RunStatus)) {
        setStatus(runId, "completed", { endedAt: Math.floor(Date.now() / 1000) });
      }
    })
    .catch((err: unknown) => {
      if (stopping.has(runId)) return;
      appendEvent(runId, "run.error", { message: String(err) });
      setStatus(runId, "failed", {
        error: String(err),
        endedAt: Math.floor(Date.now() / 1000),
      });
    })
    .finally(() => {
      live.delete(runId);
      stopping.delete(runId);
      // Only for a one-off dir, and only when it ended cleanly: a failed run's
      // directory is the only evidence it leaves, and a clone is always kept so
      // its diff can still be reviewed.
      const final = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
      if (ephemeral && final?.status === "completed") removeWorkspace(workspace.path);
    });

  return runId;
}

function onMessage(runId: string, message: SDKMessage): void {
  appendEvent(runId, message.type, message);

  if (message.type === "system" && message.subtype === "init") {
    db.update(runs).set({ claudeSessionId: message.session_id }).where(eq(runs.id, runId)).run();
    // MCP startup is non-blocking, so a server that failed to connect leaves
    // the agent quietly short of tools unless someone surfaces it.
    const servers = summarizeMcpStatus(message);
    if (servers.length > 0) appendEvent(runId, "mcp.status", { servers });
  }

  if (message.type === "result") {
    db.update(runs)
      .set({
        numTurns: message.num_turns,
        costUsd: Math.round((message.total_cost_usd ?? 0) * 1_000_000),
        endedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(runs.id, runId))
      .run();
    if (stopping.has(runId)) return;
    setStatus(runId, message.is_error ? "failed" : "completed");
  }
}

export function sendToRun(runId: string, text: string): boolean {
  const handle = live.get(runId);
  if (!handle) return false;
  appendEvent(runId, "user.message", { text });
  // A finished run is still attached; talking to it puts it back to work, and
  // the status should say so rather than reading completed while it thinks.
  const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
  if (current && !ACTIVE_STATUSES.includes(current.status as RunStatus)) {
    setStatus(runId, "running", { endedAt: null });
  }
  handle.send(text);
  return true;
}

export async function stopRun(runId: string): Promise<boolean> {
  const handle = live.get(runId);
  if (!handle) return false;
  stopping.add(runId);
  dropPending(runId);
  await handle.stop();
  setStatus(runId, "cancelled", { endedAt: Math.floor(Date.now() / 1000) });
  return true;
}

/**
 * Approval resolvers and child processes die with the process, so any run the
 * DB still calls active is a lie left over from the last boot.
 */
export function recoverOrphanedRuns(): number {
  const orphans = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, ACTIVE_STATUSES))
    .all();

  for (const { id } of orphans) {
    appendEvent(id, "run.interrupted", { reason: "server restarted" });
    db.update(runs)
      .set({ status: "interrupted", endedAt: Math.floor(Date.now() / 1000) })
      .where(eq(runs.id, id))
      .run();
    db.update(approvals)
      .set({ status: "denied", decidedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(approvals.runId, id), eq(approvals.status, "pending")))
      .run();
  }
  return orphans.length;
}

/**
 * The harness refuses to widen into bypassPermissions on a session that wasn't
 * launched with it, so this reports the refusal rather than leaving the UI
 * claiming a mode the run never entered.
 */
export async function setRunPermissionMode(
  runId: string,
  mode: string,
): Promise<{ ok: true } | { ok: false; live: boolean; error?: string }> {
  const handle = live.get(runId);
  if (!handle) return { ok: false, live: false };
  const sdkMode = toSdkPermissionMode(mode);
  try {
    await handle.setPermissionMode(sdkMode);
  } catch (err) {
    return { ok: false, live: true, error: err instanceof Error ? err.message : String(err) };
  }
  db.update(runs).set({ permissionMode: mode }).where(eq(runs.id, runId)).run();
  appendEvent(runId, "permission.mode", { mode, sdkMode });
  return { ok: true };
}

/**
 * Child `claude` processes are reparented, not killed, when we exit — so a
 * shutdown that skips this leaves agents running against the API with nobody
 * reading their output. SIGKILL can't be caught; that case is covered by
 * recoverOrphanedRuns() on the next boot.
 */
export async function shutdownLiveRuns(timeoutMs = 5000): Promise<number> {
  const handles = [...live.entries()];
  await Promise.allSettled(
    handles.map(async ([id, handle]) => {
      stopping.add(id);
      await handle.stop();
      // The child only exits once the SDK finishes tearing the stream down;
      // returning before that races our own process.exit.
      await Promise.race([
        handle.done.catch(() => {}),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
      // A finished run stays attached so it can be replied to. Shutting the
      // session down is not an interruption of work that already ended.
      const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).get();
      if (current && ACTIVE_STATUSES.includes(current.status as RunStatus)) {
        setStatus(id, "interrupted", { endedAt: Math.floor(Date.now() / 1000) });
      }
    }),
  );
  return handles.length;
}

export function listAgents(): Agent[] {
  return db.select().from(agents).all();
}

export function getAgent(id: string): Agent | undefined {
  return db.select().from(agents).where(eq(agents.id, id)).get();
}
