import { randomUUID } from "node:crypto";
import { dirname, relative, isAbsolute } from "node:path";
import { and, eq } from "drizzle-orm";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { agents, approvals, runs } from "../db/schema.ts";
import { hub } from "../hub.ts";
import { appendEvent } from "./eventLog.ts";

type Pending = { resolve: (r: PermissionResult) => void };

const pending = new Map<string, Pending>();

export function pendingApprovals(runId: string) {
  const workspace = db.select({ path: runs.workspacePath }).from(runs).where(eq(runs.id, runId)).get()?.path;
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
    .all()
    .map((row) => ({ ...row, rule: allowRuleFor(row.toolName, row.input, workspace ?? null) }));
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"]);

/**
 * The narrowest allow rule that would have covered this call: a command prefix
 * for Bash, a directory for file tools, a domain for WebFetch, the bare name for
 * everything else. Null when nothing sensible can be derived.
 */
export function allowRuleFor(toolName: string, input: unknown, workspacePath: string | null): string | null {
  const fields = (input ?? {}) as Record<string, unknown>;
  if (toolName === "AskUserQuestion") return null;

  if (toolName === "Bash") {
    const command = typeof fields.command === "string" ? fields.command : "";
    const first = command.split(/\s*(?:\|\|?|&&|;)\s*/)[0] ?? "";
    const words = first.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const prefix = words.length > 1 && /^[a-z][a-z0-9-]*$/i.test(words[1]!) ? `${words[0]} ${words[1]}` : words[0];
    return `Bash(${prefix}:*)`;
  }

  if (FILE_TOOLS.has(toolName)) {
    const target = [fields.file_path, fields.notebook_path, fields.path].find((v) => typeof v === "string") as
      | string
      | undefined;
    if (!target) return null;
    const dir = toolName === "Glob" || toolName === "Grep" ? target : dirname(target);
    if (dir.startsWith("~/")) return `${toolName}(${dir}/**)`;
    if (workspacePath && isAbsolute(dir)) {
      const rel = relative(workspacePath, dir);
      if (rel === "") return `${toolName}(**)`;
      if (!rel.startsWith("..") && !isAbsolute(rel)) return `${toolName}(${rel}/**)`;
    }
    return isAbsolute(dir) ? `${toolName}(/${dir}/**)` : `${toolName}(${dir}/**)`;
  }

  if (toolName === "WebFetch") {
    try {
      return `WebFetch(domain:${new URL(String(fields.url)).hostname})`;
    } catch {
      return null;
    }
  }

  return toolName;
}

/**
 * Adds the derived rule to the agent's allow list so later runs skip this
 * prompt. The live run is unaffected: its permission rules were fixed at launch.
 */
export function rememberApproval(id: string): string | null {
  const row = db
    .select({ toolName: approvals.toolName, input: approvals.input, agentId: runs.agentId, workspace: runs.workspacePath })
    .from(approvals)
    .innerJoin(runs, eq(runs.id, approvals.runId))
    .where(eq(approvals.id, id))
    .get();
  if (!row) return null;
  const rule = allowRuleFor(row.toolName, row.input, row.workspace);
  if (!rule) return null;
  const agent = db.select({ allowedTools: agents.allowedTools }).from(agents).where(eq(agents.id, row.agentId)).get();
  if (!agent) return null;
  const current = agent.allowedTools as string[];
  if (!current.includes(rule)) {
    db.update(agents).set({ allowedTools: [...current, rule] }).where(eq(agents.id, row.agentId)).run();
  }
  return rule;
}

/**
 * Never resolves to null: the SDK has no timeout on a permission prompt, so a
 * null reply leaves the tool blocked for the life of the process.
 */
export function makeCanUseTool(
  runId: string,
  onPending: (hasPending: boolean) => void,
  timeoutMs: number = config.approvalTimeoutMs,
): CanUseTool {
  return async (toolName, input, options) => {
    const id = randomUUID();

    db.insert(approvals)
      .values({
        id,
        runId,
        requestId: options.requestId,
        toolUseId: options.toolUseID,
        toolName,
        input: input as object,
        title: options.title ?? null,
        description: options.description ?? null,
      })
      .run();

    appendEvent(runId, "approval.requested", {
      id,
      toolName,
      input,
      title: options.title,
      description: options.description,
      defaultToNo: options.defaultToNo,
    });
    onPending(true);

    const decision = await new Promise<PermissionResult>((resolve) => {
      pending.set(id, { resolve });

      const expiry =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!pending.delete(id)) return;
              settle(id, "denied");
              appendEvent(runId, "approval.decided", {
                id,
                toolName,
                allow: false,
                reason: "expired",
              });
              hub.broadcast(runId, { type: "approval", runId, id, status: "denied" });
              resolve({
                behavior: "deny",
                message:
                  `No one answered this prompt within ${Math.round(timeoutMs / 60_000)} minutes, ` +
                  `so it was denied. Carry on without this tool if you can, or stop and say what ` +
                  `you needed it for.`,
              });
            }, timeoutMs)
          : undefined;

      const finish = (result: PermissionResult) => {
        clearTimeout(expiry);
        resolve(result);
      };
      pending.set(id, { resolve: finish });

      // A stopped run must not leave the child waiting on a prompt nobody
      // will ever answer.
      options.signal.addEventListener("abort", () => {
        if (!pending.delete(id)) return;
        clearTimeout(expiry);
        settle(id, "denied");
        resolve({ behavior: "deny", message: "Run stopped before approval." });
      });
    });

    onPending(pendingApprovals(runId).length > 0);
    return decision;
  };
}

function settle(id: string, status: "allowed" | "denied") {
  db.update(approvals)
    .set({ status, decidedAt: Math.floor(Date.now() / 1000) })
    .where(eq(approvals.id, id))
    .run();
}

/**
 * AskUserQuestion has no dialog channel here — the harness reads the answers
 * back out of the tool input the permission component returns, keyed by the
 * question text. So answering is an approval that rewrites its own input.
 */
export function decideApproval(
  id: string,
  allow: boolean,
  reason?: string,
  answers?: Record<string, string | string[]>,
): boolean {
  const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
  if (!row || row.status !== "pending") return false;

  const entry = pending.get(id);
  if (!entry) {
    // The resolver died with a previous process; the row is a leftover.
    settle(id, "denied");
    return false;
  }
  pending.delete(id);
  settle(id, allow ? "allowed" : "denied");

  appendEvent(row.runId, "approval.decided", { id, toolName: row.toolName, allow, reason });
  hub.broadcast(row.runId, { type: "approval", runId: row.runId, id, status: allow ? "allowed" : "denied" });

  if (allow && answers && Object.keys(answers).length > 0) {
    entry.resolve({
      behavior: "allow",
      updatedInput: { ...(row.input as object), answers },
    });
  } else {
    entry.resolve(
      allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: reason ?? "Denied from the bullpen dashboard." },
    );
  }
  return true;
}

export function dropPending(runId: string): void {
  for (const row of pendingApprovals(runId)) pending.delete(row.id);
}
