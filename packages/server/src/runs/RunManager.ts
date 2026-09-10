import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../db/index.ts";
import { agents, approvals, runs, type Agent } from "../db/schema.ts";
import { hub } from "../hub.ts";
import { resolveWorkspace, type WorkspaceSpec } from "../workspaces.ts";
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
  locked: "dontAsk",
};

export function toSdkPermissionMode(mode: string): PermissionMode {
  return PERMISSION_MODES[mode] ?? "default";
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
  trigger: "manual" | "cron" | "webhook";
  prompt?: string;
  /** Runs after the workspace exists, before the agent starts. */
  onWorkspace?: (path: string) => void;
}): string {
  const { agent, trigger } = opts;
  const runId = randomUUID();
  const prompt = opts.prompt ?? agent.prompt;

  const workspace = resolveWorkspace(agent.workspaceConfig as WorkspaceSpec, {
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
      workspacePath: workspace.path,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
    })
    .run();

  appendEvent(runId, "run.started", { agentId: agent.id, trigger, prompt, cwd: workspace.path });

  const handle = startRunner(
    {
      cwd: workspace.path,
      prompt,
      model: agent.model ?? undefined,
      permissionMode: toSdkPermissionMode(agent.permissionMode),
      allowedTools: agent.allowedTools as string[],
      disallowedTools: agent.disallowedTools as string[],
      mcpServers: agent.mcpServers as never,
      strictMcpConfig: !agent.inheritMachineMcp,
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
    });

  return runId;
}

function onMessage(runId: string, message: SDKMessage): void {
  appendEvent(runId, message.type, message);

  if (message.type === "system" && message.subtype === "init") {
    db.update(runs).set({ claudeSessionId: message.session_id }).where(eq(runs.id, runId)).run();
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

export async function setRunPermissionMode(runId: string, mode: string): Promise<boolean> {
  const handle = live.get(runId);
  if (!handle) return false;
  const sdkMode = toSdkPermissionMode(mode);
  await handle.setPermissionMode(sdkMode);
  appendEvent(runId, "permission.mode", { mode, sdkMode });
  return true;
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
      setStatus(id, "interrupted", { endedAt: Math.floor(Date.now() / 1000) });
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
