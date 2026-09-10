import { eq, gt, and, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { runEvents } from "../db/schema.ts";
import { hub } from "../hub.ts";

/**
 * Append-only, one monotonic seq per run. Written before broadcasting so a
 * client that reconnects and asks for `sinceSeq` can never miss an event that
 * a live subscriber already saw.
 */
export function appendEvent(runId: string, type: string, payload: unknown): void {
  const row = db
    .insert(runEvents)
    .values({
      runId,
      seq: sql`(select coalesce(max(seq), 0) + 1 from run_events where run_id = ${runId})`,
      type,
      payload: payload as object,
    })
    .returning({ seq: runEvents.seq, ts: runEvents.ts })
    .get();

  hub.broadcast(runId, { type: "event", runId, seq: row.seq, ts: row.ts, eventType: type, payload });
}

export function eventsSince(runId: string, sinceSeq: number) {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, sinceSeq)))
    .orderBy(runEvents.seq)
    .all();
}
