import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, type Agent } from "../db/schema.ts";
import { agentHasActiveRun, startRun } from "../runs/RunManager.ts";
import { pollOnce } from "./poll.ts";

const jobs = new Map<string, Cron>();

export function nextRuns(expression: string, timezone: string | null, count = 3): string[] {
  const probe = new Cron(expression, { timezone: timezone ?? undefined, paused: true });
  return (probe.nextRuns(count) ?? []).map((d) => d.toISOString());
}

function schedule(agent: Agent): void {
  jobs.get(agent.id)?.stop();
  jobs.delete(agent.id);
  if (!agent.enabled || !agent.cron) return;

  try {
    const job = new Cron(
      agent.cron,
      { timezone: agent.cronTimezone ?? undefined, name: agent.id },
      () => {
        const fresh = db.select().from(agents).where(eq(agents.id, agent.id)).get();
        if (!fresh?.enabled || !fresh.cron) return;
        // Checked against the DB, not croner's in-process guard: a run can
        // outlive the process that started it.
        // A polling agent uses the same schedule to check, not to run: the
        // run only happens when the endpoint actually changed.
        if (fresh.pollUrl) {
          void pollOnce(fresh).catch((err: unknown) =>
            console.error(`[poll] ${fresh.name}: ${String(err)}`),
          );
          return;
        }
        if (fresh.concurrency === "skip" && agentHasActiveRun(fresh.id)) {
          console.log(`[cron] ${fresh.name}: skipped, a run is already active`);
          return;
        }
        startRun({ agent: fresh, trigger: "cron" });
      },
    );
    jobs.set(agent.id, job);
  } catch (err) {
    console.error(`[cron] ${agent.name}: bad expression ${agent.cron} — ${String(err)}`);
  }
}

export function rescheduleAgent(agentId: string): void {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (agent) schedule(agent);
  else {
    jobs.get(agentId)?.stop();
    jobs.delete(agentId);
  }
}

export function startScheduler(): number {
  for (const agent of db.select().from(agents).all()) schedule(agent);
  return jobs.size;
}

export function stopScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}
