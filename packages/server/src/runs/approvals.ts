import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../db/index.ts";
import { approvals } from "../db/schema.ts";
import { hub } from "../hub.ts";
import { appendEvent } from "./eventLog.ts";

type Pending = { resolve: (r: PermissionResult) => void };

const pending = new Map<string, Pending>();

export function pendingApprovals(runId: string) {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
    .all();
}

/**
 * Never resolves to null: the SDK has no timeout on a permission prompt, so a
 * null reply leaves the tool blocked for the life of the process.
 */
export function makeCanUseTool(
  runId: string,
  onPending: (hasPending: boolean) => void,
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

      // A stopped run must not leave the child waiting on a prompt nobody
      // will ever answer.
      options.signal.addEventListener("abort", () => {
        if (!pending.delete(id)) return;
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
