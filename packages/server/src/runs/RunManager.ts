import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { writePayload } from "../triggers/webhook.ts";
import { startTelegramTyping } from "../triggers/telegram.ts";
import { and, asc, eq, inArray, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, approvals, runs, type Agent } from "../db/schema.ts";
import { hub } from "../hub.ts";
import { claudeAttribution, resolveEnv, workspaceRetentionHours } from "../env.ts";
import { selectMcp } from "../mcp.ts";
import { exportMachineMcp } from "../machineMcp.ts";
import { removeWorkspace, resolveWorkspace, type WorkspaceSpec } from "../workspaces.ts";
import { collectArtifacts } from "../artifacts.ts";
import { pullState, type PullState } from "../git.ts";
import { systemNote } from "./systemNote.ts";
import { dropPending, makeCanUseTool } from "./approvals.ts";
import { claudeRunner } from "./ClaudeRunner.ts";
import { MODE_NAMES, type ModeName, type Runner, type RunnerHandle } from "./runner.ts";
import { appendEvent } from "./eventLog.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const ACTIVE_STATUSES: RunStatus[] = ["running", "awaiting_approval"];

/** Bullpen's UI modes, mapped to what the SDK actually accepts. */
export function isPermissionMode(mode: string): mode is ModeName {
  return (MODE_NAMES as readonly string[]).includes(mode);
}

/** The one backend today. A second one is another entry here and nothing else. */
const runners: Record<string, Runner> = { claude: claudeRunner };
const runner = runners.claude!;

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

export type RunRequest = {
  agent: Agent;
  trigger: "manual" | "cron" | "webhook" | "poll";
  prompt?: string;
  /** Overrides the agent's saved mode for this run only. */
  permissionMode?: string;
  /** Ignores the agent's workspace and runs in a directory used once. */
  ephemeralWorkspace?: boolean;
  /** The delivery body, written to .bullpen/payload.json once the workspace exists. */
  rawPayload?: string;
  /** Names this run in lists. The caller renders it; the payload lives there. */
  label?: string;
  /** Wait this long before starting; a later request with the same key replaces this one's payload instead of running too. */
  merge?: { key: string; waitSeconds: number };
};

export class QueueFullError extends Error {
  constructor(agentName: string, depth: number) {
    super(`${agentName} already has ${depth} runs queued`);
  }
}

/** Queued runs waiting behind an active one; beyond this a trigger is dropped, not queued. */
export const QUEUE_DEPTH = 20;
const queueDir = () => join(config.dataDir, "queue");
const spoolPath = (runId: string) => join(queueDir(), `${runId}.json`);

function queuedCount(agentId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.agentId, agentId), eq(runs.status, "queued")))
      .get()?.n ?? 0
  );
}

/**
 * The one entry point triggers use. `skip` is decided by the caller (it needs to
 * record why); this handles `queue`: while the agent has an active run, the
 * request is parked as a `queued` row and starts when that run ends.
 */
export function requestRun(opts: RunRequest): { runId: string; queued: boolean; merged?: boolean } {
  const { agent, merge } = opts;
  if (merge) {
    const waiting = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.agentId, agent.id), eq(runs.status, "queued"), eq(runs.mergeKey, merge.key), isNotNull(runs.startAfter)))
      .get();
    if (waiting) {
      mergeInto(waiting.id, opts);
      return { runId: waiting.id, queued: true, merged: true };
    }
    const depth = queuedCount(agent.id);
    if (depth >= QUEUE_DEPTH) throw new QueueFullError(agent.name, depth);
    const startAfter = Math.floor(Date.now() / 1000) + merge.waitSeconds;
    const runId = enqueueRun(opts, { mergeKey: merge.key, startAfter });
    scheduleRelease(runId, startAfter);
    return { runId, queued: true };
  }
  if (agent.concurrency === "queue" && agentHasActiveRun(agent.id)) {
    const depth = queuedCount(agent.id);
    if (depth >= QUEUE_DEPTH) throw new QueueFullError(agent.name, depth);
    return { runId: enqueueRun(opts), queued: true };
  }
  return { runId: startRun(opts), queued: false };
}

/**
 * Everything startRun would need later, spooled to disk rather than the DB: a
 * webhook body can be a megabyte, and the row already holds prompt and mode.
 */
function enqueueRun(opts: RunRequest, wait?: { mergeKey: string; startAfter: number }): string {
  const { agent, trigger } = opts;
  const runId = randomUUID();
  writeSpool(runId, opts);
  db.insert(runs)
    .values({
      id: runId,
      agentId: agent.id,
      status: "queued",
      trigger,
      prompt: opts.prompt ?? agent.prompt,
      permissionMode: opts.permissionMode ?? agent.permissionMode,
      ...(opts.label ? { label: opts.label } : {}),
      ...wait,
    })
    .run();
  appendEvent(
    runId,
    "run.queued",
    wait ? { agentId: agent.id, trigger, startAfter: wait.startAfter } : { agentId: agent.id, trigger, behind: queuedCount(agent.id) - 1 },
  );
  return runId;
}

function writeSpool(runId: string, opts: RunRequest): void {
  mkdirSync(queueDir(), { recursive: true });
  writeFileSync(
    spoolPath(runId),
    JSON.stringify({ ephemeralWorkspace: opts.ephemeralWorkspace ?? false, rawPayload: opts.rawPayload ?? null }),
  );
}

/** The latest delivery wins: it describes the thing as it is now. */
function mergeInto(runId: string, opts: RunRequest): void {
  writeSpool(runId, opts);
  db.update(runs)
    .set({ prompt: opts.prompt ?? opts.agent.prompt, label: opts.label ?? null })
    .where(eq(runs.id, runId))
    .run();
  appendEvent(runId, "run.merged", { trigger: opts.trigger });
}

const releaseTimers = new Map<string, NodeJS.Timeout>();

function scheduleRelease(runId: string, startAfter: number): void {
  clearTimeout(releaseTimers.get(runId));
  const delay = Math.max(0, startAfter * 1000 - Date.now());
  releaseTimers.set(
    runId,
    setTimeout(() => {
      releaseTimers.delete(runId);
      releaseWaiting(runId);
    }, delay).unref(),
  );
}

/**
 * Ends a run's merge window. A `queue` agent's run joins the ordinary queue, so
 * it still waits its turn; a `skip` agent's is dropped if a run is active now,
 * since that check at delivery time is a window too old to mean anything; any
 * other agent's starts now.
 */
export function releaseWaiting(runId: string, start: (opts: RunRequest, existingId: string) => string = startRun): void {
  const row = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (row?.status !== "queued" || row.startAfter == null) return;
  db.update(runs).set({ startAfter: null }).where(eq(runs.id, runId)).run();
  const agent = getAgent(row.agentId);
  if (!agent) return;
  if (agent.concurrency === "queue") drainQueue(agent.id, start);
  else if (agent.concurrency === "skip" && agentHasActiveRun(agent.id)) {
    rmSync(spoolPath(runId), { force: true });
    appendEvent(runId, "run.skipped", { reason: "run already active" });
    setStatus(runId, "cancelled", { error: "skipped: another run was active", endedAt: Math.floor(Date.now() / 1000) });
  } else startQueued(row, agent, start);
}

/**
 * Starts the agent's oldest queued run if nothing is active. Called when a run
 * ends and at boot. `start` is injectable so the ordering can be tested without
 * spawning a harness.
 */
export function drainQueue(agentId: string, start: (opts: RunRequest, existingId: string) => string = startRun): void {
  if (agentHasActiveRun(agentId)) return;
  const next = db
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "queued"), isNull(runs.startAfter)))
    .orderBy(asc(runs.startedAt), asc(runs.id))
    .get();
  if (!next) return;
  const agent = getAgent(agentId);
  if (!agent) return;
  startQueued(next, agent, start);
}

function startQueued(
  next: typeof runs.$inferSelect,
  agent: Agent,
  start: (opts: RunRequest, existingId: string) => string,
): void {
  let spool: { ephemeralWorkspace?: boolean; rawPayload?: string | null } = {};
  try {
    spool = JSON.parse(readFileSync(spoolPath(next.id), "utf8"));
  } catch {
    // No spool means a manual run with nothing beyond what the row holds.
  }
  rmSync(spoolPath(next.id), { force: true });

  try {
    start(
      {
        agent,
        trigger: next.trigger as RunRequest["trigger"],
        prompt: next.prompt,
        ...(next.permissionMode ? { permissionMode: next.permissionMode } : {}),
        ...(spool.ephemeralWorkspace ? { ephemeralWorkspace: true } : {}),
        ...(spool.rawPayload ? { rawPayload: spool.rawPayload } : {}),
        ...(next.label ? { label: next.label } : {}),
      },
      next.id,
    );
  } catch (err) {
    // A workspace that can't be prepared fails this run and moves on to the next.
    setStatus(next.id, "failed", { error: String(err), endedAt: Math.floor(Date.now() / 1000) });
    drainQueue(agent.id, start);
  }
}

/** Removes a run that never started. Not for live runs — stopRun handles those. */
export function cancelQueued(runId: string): boolean {
  const row = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
  if (row?.status !== "queued") return false;
  clearTimeout(releaseTimers.get(runId));
  releaseTimers.delete(runId);
  rmSync(spoolPath(runId), { force: true });
  db.delete(runs).where(eq(runs.id, runId)).run();
  return true;
}

export function startRun(opts: RunRequest, existingId?: string): string {
  const { agent, trigger } = opts;
  const runId = existingId ?? randomUUID();
  const prompt = opts.prompt ?? agent.prompt;
  const permissionMode = opts.permissionMode ?? agent.permissionMode;
  // Global, then the space's, then the agent's own — later wins. Resolved here
  // because the note reads the config dir an agent's own env may override.
  const env = resolveEnv(agent);
  // Where the delivery body lives is bullpen's business, not something every
  // prompt should have to restate.
  const payloadNote = systemNote(trigger, env);

  const spec: WorkspaceSpec = opts.ephemeralWorkspace
    ? { kind: "ephemeral" }
    : (agent.workspaceConfig as WorkspaceSpec);
  const ephemeral = spec.kind === "ephemeral";
  const workspace = resolveWorkspace(spec, {
    agentId: agent.id,
    agentName: agent.name,
    runId,
  });

  if (opts.rawPayload !== undefined) writePayload(workspace.path, opts.rawPayload);

  const row = {
    agentId: agent.id,
    status: "running" as const,
    trigger,
    prompt,
    permissionMode,
    workspacePath: workspace.path,
    startedAt: Math.floor(Date.now() / 1000),
    ...(opts.label ? { label: opts.label } : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
  };
  // A queued run already has its row; it is promoted rather than re-inserted.
  if (existingId) db.update(runs).set(row).where(eq(runs.id, runId)).run();
  else db.insert(runs).values({ id: runId, ...row }).run();

  appendEvent(runId, "run.started", { agentId: agent.id, trigger, prompt, permissionMode, cwd: workspace.path });

  launch(runId, agent, { trigger, cwd: workspace.path, prompt, permissionMode, env, systemNote: payloadNote, ephemeral });
  return runId;
}

type Launch = {
  trigger: RunRequest["trigger"];
  cwd: string;
  prompt: string;
  permissionMode: string;
  env: Record<string, string>;
  systemNote: string;
  ephemeral: boolean;
  resumeSessionId?: string;
  /** What earlier sessions of this run already spent; a resumed session reports only its own. */
  prior?: { numTurns: number; costUsd: number };
};

function launch(runId: string, agent: Agent, l: Launch): void {
  const { env, ephemeral, permissionMode } = l;
  const prior = l.prior ?? { numTurns: 0, costUsd: 0 };
  const workspace = { path: l.cwd };
  const payloadNote = l.systemNote;
  const mcp = selectMcp(agent, exportMachineMcp(), env);
  const stopTyping =
    agent.webhookMode === "telegram" && l.trigger === "webhook" ? startTelegramTyping(l.cwd, env) : () => {};
  let closed = false;
  const handle = runner.start(
    {
      cwd: workspace.path,
      prompt: l.prompt,
      resumeSessionId: l.resumeSessionId,
      model: agent.model ?? undefined,
      permissionMode: isPermissionMode(permissionMode) ? permissionMode : "supervised",
      allowedTools: agent.allowedTools as string[],
      disallowedTools: agent.disallowedTools as string[],
      mcpServers: mcp.mcpServers as never,
      strictMcpConfig: mcp.strictMcpConfig,
      inheritUserSettings: agent.inheritUserSettings,
      attribution: claudeAttribution(),
      appendSystemPrompt: payloadNote,
      env,
      maxTurns: agent.maxTurns ?? undefined,
      canUseTool: makeCanUseTool(runId, (hasPending) => {
        const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
        if (!current || !ACTIVE_STATUSES.includes(current.status as RunStatus)) return;
        setStatus(runId, hasPending ? "awaiting_approval" : "running");
      }),
    },
    {
      onMessage: (type, payload) => appendEvent(runId, type, payload),
      onSession: (sessionId) =>
        db.update(runs).set({ claudeSessionId: sessionId }).where(eq(runs.id, runId)).run(),
      // MCP startup is non-blocking, so a server that failed to connect leaves
      // the agent quietly short of tools unless someone surfaces it.
      onMcpStatus: (servers) => {
        if (servers.length > 0) appendEvent(runId, "mcp.status", { servers });
      },
      onResult: ({ numTurns, costUsd, isError }) => {
        stopTyping();
        db.update(runs)
          .set({
            numTurns: numTurns === undefined ? undefined : prior.numTurns + numTurns,
            // Stored in micro-dollars: an integer column, and sums stay exact.
            costUsd: prior.costUsd + Math.round((costUsd ?? 0) * 1_000_000),
            endedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(runs.id, runId))
          .run();
        if (closed || stopping.has(runId)) return;
        setStatus(runId, isError ? "failed" : "completed");
        // An idle session is a whole claude process; a reply resumes it from its transcript instead.
        closed = true;
        live.delete(runId);
        handle.close();
        keepArtifacts();
        drainQueue(agent.id);
      },
    },
  );

  live.set(runId, handle);

  // Idempotent: the second call finds an empty directory.
  const keepArtifacts = () => {
    try {
      const kept = collectArtifacts(runId, workspace.path);
      if (kept > 0) appendEvent(runId, "artifacts", { count: kept });
    } catch (e) {
      console.warn(`[bullpen] run ${runId}: could not collect artifacts: ${String(e)}`);
    }
  };

  handle.done
    .then(() => {
      if (closed || stopping.has(runId)) return;
      const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
      if (current && ACTIVE_STATUSES.includes(current.status as RunStatus)) {
        setStatus(runId, "completed", { endedAt: Math.floor(Date.now() / 1000) });
      }
    })
    .catch((err: unknown) => {
      if (closed || stopping.has(runId)) return;
      appendEvent(runId, "run.error", { message: String(err) });
      setStatus(runId, "failed", {
        error: String(err),
        endedAt: Math.floor(Date.now() / 1000),
      });
    })
    .finally(() => {
      stopTyping();
      // A reply may already have resumed this run in a new session, which these belong to.
      if (live.get(runId) === handle) {
        live.delete(runId);
        stopping.delete(runId);
      }
      // Only for a one-off dir, and only when it ended cleanly: a failed run's
      // directory is the only evidence it leaves, and a clone is always kept so
      // its diff can still be reviewed.
      const final = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
      // Stopped or interrupted runs never reached onResult; anything they left is gathered here.
      if (!closed) keepArtifacts();
      if (ephemeral && final?.status === "completed" && workspaceRetentionHours() === 0) removeWorkspace(workspace.path);
      // A stopped or crashed run never reached onResult.
      if (!closed) drainQueue(agent.id);
    });
}

/**
 * Every deploy closes every session, so a reply that could only reach a live
 * one would lose most runs' context within the hour. The harness keeps the
 * transcript on disk under the cwd, so resuming in the same directory — made
 * again if an ephemeral run's was removed — picks the conversation back up.
 */
function resumeRun(runId: string, text: string): boolean {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run?.claudeSessionId) return false;
  return relaunch(runId, text, run.claudeSessionId, () => appendEvent(runId, "user.message", { text }));
}

function relaunch(runId: string, prompt: string, resumeSessionId: string | undefined, record: () => void): boolean {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run?.workspacePath) return false;
  if (run.status === "queued" || ACTIVE_STATUSES.includes(run.status as RunStatus)) return false;
  const agent = getAgent(run.agentId);
  if (!agent) return false;

  mkdirSync(run.workspacePath, { recursive: true });
  const env = resolveEnv(agent);
  record();
  setStatus(runId, "running", { endedAt: null });
  launch(runId, agent, {
    trigger: run.trigger as RunRequest["trigger"],
    cwd: run.workspacePath,
    prompt,
    permissionMode: run.permissionMode ?? agent.permissionMode,
    env,
    systemNote: systemNote(run.trigger as RunRequest["trigger"], env),
    ephemeral: !run.branch && run.workspacePath === join(config.workspacesDir, runId),
    resumeSessionId,
    prior: { numTurns: run.numTurns ?? 0, costUsd: run.costUsd ?? 0 },
  });
  return true;
}

const RESTART_NOTE =
  "The server restarted while you were working and your session was cut off. Check what you already did, then carry on from where you left off.";

/**
 * An interrupted run picks its session back up when it had one. A run cut off
 * before the harness reported a session has nothing to resume, so it starts
 * over on its original prompt in the same workspace, where the payload still is.
 */
export function restartRun(runId: string): boolean {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run?.status !== "interrupted") return false;
  const resume = run.claudeSessionId ?? undefined;
  return relaunch(runId, resume ? RESTART_NOTE : run.prompt, resume, () =>
    appendEvent(runId, "run.restarted", { resumed: resume !== undefined }),
  );
}

/** A finished run whose session is closed can still be replied to while its transcript can be found. */
export function isResumable(run: { id: string; status: string; claudeSessionId: string | null }): boolean {
  if (live.has(run.id)) return true;
  return run.claudeSessionId != null && run.status !== "queued" && !ACTIVE_STATUSES.includes(run.status as RunStatus);
}

export function sendToRun(runId: string, text: string): boolean {
  const handle = live.get(runId);
  if (!handle) return resumeRun(runId, text);
  appendEvent(runId, "user.message", { text });
  handle.send(text);
  return true;
}

export async function stopRun(runId: string): Promise<boolean> {
  if (cancelQueued(runId)) return true;
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
  // Queued runs survive a restart by design; with nothing active now, they can go.
  const waiting = db
    .selectDistinct({ agentId: runs.agentId })
    .from(runs)
    .where(eq(runs.status, "queued"))
    .all();
  for (const { agentId } of waiting) drainQueue(agentId);
  const merging = db
    .select({ id: runs.id, startAfter: runs.startAfter })
    .from(runs)
    .where(and(eq(runs.status, "queued"), isNotNull(runs.startAfter)))
    .all();
  for (const { id, startAfter } of merging) scheduleRelease(id, startAfter!);
  return orphans.length;
}

/**
 * A completed run's fresh directory is kept for the retention window so it can
 * still be looked into, then removed here. One that ended any other way is the
 * only evidence of the failure, so it gets the longer failed-run window.
 * Clones are left alone: they are kept for their diff.
 */
export function sweepWorkspaces(): number {
  const now = Math.floor(Date.now() / 1000);
  const retention = workspaceRetentionHours();
  const completedCutoff = now - retention * 3600;
  const failedCutoff = now - Math.max(retention, config.failedWorkspaceRetentionHours) * 3600;
  const due = db
    .select({ id: runs.id, path: runs.workspacePath })
    .from(runs)
    .where(
      and(
        isNull(runs.branch),
        like(runs.workspacePath, `${config.workspacesDir}/%`),
        or(
          and(eq(runs.status, "completed"), lte(runs.endedAt, completedCutoff)),
          and(inArray(runs.status, ["failed", "cancelled", "interrupted"]), lte(runs.endedAt, failedCutoff)),
        ),
      ),
    )
    .all();
  let removed = 0;
  for (const { id, path } of due) {
    if (path !== join(config.workspacesDir, id) || !existsSync(path)) continue;
    removeWorkspace(path);
    removed++;
  }
  return removed;
}

/** Clones found to have no pull request; not asked about again until the next boot. */
const unpulled = new Set<string>();

/**
 * A clone is kept for its diff, but once its branch's pull request is merged
 * or closed that diff lives on GitHub. A clone that never got a PR is kept,
 * since the directory is the only copy. Needs a GitHub token; without one
 * nothing is swept.
 */
export async function sweepMergedClones(lookup: (cwd: string, branch: string) => Promise<PullState> = pullState): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - workspaceRetentionHours() * 3600;
  const due = db
    .select({ id: runs.id, path: runs.workspacePath, branch: runs.branch })
    .from(runs)
    .where(
      and(
        isNotNull(runs.branch),
        like(runs.workspacePath, `${config.workspacesDir}/%`),
        inArray(runs.status, ["completed", "failed", "cancelled", "interrupted"]),
        lte(runs.endedAt, cutoff),
      ),
    )
    .all();
  let removed = 0;
  for (const { id, path, branch } of due) {
    if (path !== join(config.workspacesDir, id) || !existsSync(path) || unpulled.has(id)) continue;
    let state: PullState;
    try {
      state = await lookup(path, branch!);
    } catch {
      continue;
    }
    if (state === "none") unpulled.add(id);
    if (state !== "closed") continue;
    removeWorkspace(path);
    removed++;
  }
  return removed;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startWorkspaceSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => {
    sweepWorkspaces();
    void sweepMergedClones();
  }, 60 * 60 * 1000);
  sweepTimer.unref();
}

/**
 * The harness refuses to widen into bypassPermissions on a session that wasn't
 * launched with it, so this reports the refusal rather than leaving the UI
 * claiming a mode the run never entered.
 */
export async function setRunPermissionMode(
  runId: string,
  mode: ModeName,
): Promise<{ ok: true } | { ok: false; live: boolean; error?: string }> {
  const handle = live.get(runId);
  if (!handle) return { ok: false, live: false };
  try {
    await handle.setPermissionMode(mode);
  } catch (err) {
    return { ok: false, live: true, error: err instanceof Error ? err.message : String(err) };
  }
  db.update(runs).set({ permissionMode: mode }).where(eq(runs.id, runId)).run();
  appendEvent(runId, "permission.mode", { mode });
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
      const current = db.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).get();
      if (current && ACTIVE_STATUSES.includes(current.status as RunStatus)) {
        setStatus(id, "interrupted", { endedAt: Math.floor(Date.now() / 1000) });
      }
    }),
  );
  return handles.length;
}

export function listAgents(): Agent[] {
  return db.select().from(agents).orderBy(agents.sortOrder, sql`rowid`).all();
}

export function getAgent(id: string): Agent | undefined {
  return db.select().from(agents).where(eq(agents.id, id)).get();
}
