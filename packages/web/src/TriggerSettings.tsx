import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Agent, AgentInput, Delivery } from "./types.ts";

const field = "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none focus:border-neutral-600";
const label = "block text-xs font-medium uppercase tracking-wide text-neutral-500 mb-1";

export function TriggerSettings({
  agent,
  draft,
  set,
}: {
  agent: Agent | null;
  draft: AgentInput;
  set: <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => void;
}) {
  const [next, setNext] = useState<string[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  // Saved cron only: the preview describes what will actually fire.
  useEffect(() => {
    if (!agent?.cron) {
      setNext(null);
      return;
    }
    api
      .schedule(agent.id)
      .then((r) => {
        setNext(r.next);
        setScheduleError(null);
      })
      .catch((e) => setScheduleError(String(e)));
  }, [agent?.id, agent?.cron, agent?.cronTimezone]);

  useEffect(() => {
    if (agent) void api.deliveries(agent.id).then(setDeliveries);
  }, [agent?.id]);

  const hookUrl = agent ? `${location.origin}/api/hooks/${agent.id}` : null;

  return (
    <div className="space-y-4 border-t border-neutral-800 pt-4">
      <h3 className="text-sm font-medium text-neutral-300">Triggers</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className={label}>Cron</span>
          <input
            className={field}
            placeholder="0 8 * * *"
            value={draft.cron ?? ""}
            onChange={(e) => set("cron", e.target.value || null)}
          />
        </div>
        <div>
          <span className={label}>Timezone</span>
          <input
            className={field}
            placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
            value={draft.cronTimezone ?? ""}
            onChange={(e) => set("cronTimezone", e.target.value || null)}
          />
        </div>
      </div>

      {scheduleError && <p className="text-xs text-red-400">{scheduleError}</p>}
      {next && (
        <div className="text-xs text-neutral-500">
          Next:{" "}
          {next.map((t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })).join(" · ")}
        </div>
      )}
      {!agent && draft.cron && (
        <p className="text-xs text-neutral-600">Save the agent to see when this fires.</p>
      )}

      {hookUrl && (
        <>
          <div>
            <span className={label}>Webhook URL</span>
            <div className="flex gap-2">
              <input readOnly value={hookUrl} className={`${field} font-mono text-xs text-neutral-400`} />
              <button
                onClick={() => void navigator.clipboard.writeText(hookUrl)}
                className="shrink-0 rounded border border-neutral-700 px-2 text-xs hover:bg-neutral-800"
              >
                Copy
              </button>
            </div>
            <p className="mt-1 text-xs text-neutral-600">
              Reachable by anything that can route here. Its secret is what protects it.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Verification</span>
              <select
                className={field}
                value={draft.webhookMode ?? "token"}
                onChange={(e) => set("webhookMode", e.target.value)}
              >
                <option value="token">token — X-Bullpen-Token header</option>
                <option value="hmac">hmac — GitHub-style signature</option>
              </select>
            </div>
            <div>
              <span className={label}>Only these events</span>
              <input
                className={field}
                placeholder="issues, pull_request"
                value={(draft.webhookEvents ?? []).join(", ")}
                onChange={(e) =>
                  set("webhookEvents", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
                }
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={draft.allowPromptOverride ?? false}
              onChange={(e) => set("allowPromptOverride", e.target.checked)}
            />
            Let the request body replace this agent&rsquo;s prompt
          </label>
          <p className="-mt-2 text-xs text-neutral-600">
            Off, the payload is interpolated as data via <code>{"{{payload.x}}"}</code>. On, whoever
            can call the webhook chooses what the agent does.
          </p>

          {deliveries.length > 0 && (
            <div>
              <span className={label}>Recent deliveries</span>
              <ul className="space-y-0.5">
                {deliveries.slice(0, 8).map((d) => (
                  <li key={d.id} className="font-mono text-xs">
                    <span className={d.accepted ? "text-emerald-500" : "text-neutral-600"}>
                      {d.accepted ? "OK  " : "DROP"}
                    </span>{" "}
                    <span className="text-neutral-500">{d.event ?? "—"}</span>{" "}
                    <span className="text-neutral-600">{d.reason ?? ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
