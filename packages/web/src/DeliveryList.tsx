import { useState } from "react";
import { ago } from "./time.ts";
import type { Delivery } from "./types.ts";

/** Mirrors the server's BY_DESIGN: a drop that means the filters did their job. */
const EXPECTED = /filter|allowlist|ping acknowledged|url_verification|handshake|duplicate/i;
const expected = (d: Delivery) => !d.accepted && EXPECTED.test(d.reason ?? "");

/** The server's reasons are sentences; a log column wants the operands. */
export function compactReason(reason: string | null): string {
  if (!reason) return "";
  let m = /^(.+?)=(.*) is not in the filter$/.exec(reason);
  if (m) return `${m[1]}=${m[2]} not in filter`;
  m = /^(.+?)=(.*) is excluded by the filter$/.exec(reason);
  if (m) return `${m[1]}=${m[2]} excluded by filter`;
  m = /^event (\S+) not in this agent's allowlist$/.exec(reason);
  if (m) return `${m[1]} not in events`;
  return reason;
}

function Outcome({ d }: { d: Delivery }) {
  if (d.accepted) return <span className="shrink-0 text-emerald-500">RAN </span>;
  return <span className={expected(d) ? "shrink-0 text-neutral-600" : "shrink-0 text-amber-500"}>DROP</span>;
}

/** Callers supply their own heading, since each surface labels it differently. */
export function DeliveryList({ deliveries, limit = 8 }: { deliveries: Delivery[]; limit?: number }) {
  return (
    <ul className="space-y-0.5">
      {deliveries.slice(0, limit).map((d) => (
        <li key={d.id} className="flex items-baseline gap-1.5 font-mono text-xs">
          <Outcome d={d} />
          <span className="shrink-0 tabular-nums text-neutral-500" title={new Date(d.ts * 1000).toLocaleString()}>
            {ago(d.ts)}
          </span>
          {/* The label names the thing; without one, the event name is all there is. */}
          <span className="shrink-0 text-neutral-300">{d.label ?? d.event ?? "—"}</span>
          {d.label && d.event && <span className="shrink-0 text-neutral-600">{d.event}</span>}
          <span className="min-w-0 truncate text-neutral-600" title={d.reason ?? undefined}>
            {compactReason(d.reason)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One delivery, one block. A shared space URL fans a single delivery out to
 * every agent in the space, so a flat list shows one event as several rows and
 * reads like several events. Grouping makes the one-in, several-out shape plain,
 * and folding the expected drops away leaves only what changed: a run, or a
 * drop that was not a filter's decision.
 */
export function GroupedDeliveryList({
  deliveries,
  limit = 8,
  agentName,
  onOpenRun,
  onOpenAgent,
}: {
  deliveries: Delivery[];
  limit?: number;
  agentName: (id: string) => string;
  onOpenRun?: (runId: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups: { key: string; rows: Delivery[] }[] = [];
  for (const d of deliveries) {
    // No delivery key means nothing to group on, so it stands alone.
    const key = d.deliveryKey ?? `one-${d.id}`;
    const existing = groups.find((g) => g.key === key);
    if (existing) existing.rows.push(d);
    else groups.push({ key, rows: [d] });
  }

  return (
    <ul className="space-y-2">
      {groups.slice(0, limit).map(({ key, rows }) => {
        const first = rows[0]!;
        const label =
          rows.map((r) => r.label ?? "").reduce((a, b) => (b.length > a.length ? b : a), "") || null;
        const ran = rows.filter((r) => r.accepted).length;
        const declined = rows.filter(expected);
        const notable = rows.filter((r) => !expected(r));
        const unexpected = notable.length - ran;
        const tallyClass =
          ran > 0 ? "text-emerald-500" : unexpected > 0 ? "text-amber-500" : "text-neutral-600";
        const isOpen = open.has(key);
        return (
          <li key={key}>
            <div className="flex items-baseline gap-2 text-xs">
              <span
                className="shrink-0 tabular-nums text-neutral-500"
                title={new Date(first.ts * 1000).toLocaleString()}
              >
                {ago(first.ts)}
              </span>
              <span className="truncate font-mono text-neutral-200" title={label ?? undefined}>
                {label ?? first.event ?? "—"}
              </span>
              {label && first.event && (
                <span className="truncate font-mono text-neutral-500">{first.event}</span>
              )}
              <span className={`ml-auto shrink-0 tabular-nums ${tallyClass}`}>
                {ran} of {rows.length} ran
              </span>
            </div>
            {(notable.length > 0 || declined.length > 0) && (
              <ul className="mt-0.5 space-y-0.5 border-l border-neutral-800 pl-2">
                {notable.map((d) => (
                  <li key={d.id} className="flex items-baseline gap-1.5 font-mono text-xs">
                    <Outcome d={d} />
                    {onOpenAgent ? (
                      <button onClick={() => onOpenAgent(d.agentId)} className="shrink-0 text-neutral-400 hover:text-neutral-200">
                        {agentName(d.agentId)}
                      </button>
                    ) : (
                      <span className="shrink-0 text-neutral-400">{agentName(d.agentId)}</span>
                    )}
                    {d.accepted && d.runId && onOpenRun ? (
                      <button onClick={() => onOpenRun(d.runId!)} className="shrink-0 text-neutral-500 hover:text-neutral-200">
                        view run →
                      </button>
                    ) : (
                      <span className="min-w-0 truncate text-neutral-500" title={d.reason ?? undefined}>
                        {compactReason(d.reason)}
                      </span>
                    )}
                  </li>
                ))}
                {declined.length > 0 && (
                  <li className="font-mono text-xs">
                    <button
                      onClick={() => toggle(key)}
                      className="text-neutral-600 hover:text-neutral-400"
                      title="Agents whose filters declined this delivery"
                    >
                      {isOpen ? "▾" : "▸"} {declined.length} declined
                    </button>
                    {isOpen && (
                      <ul className="mt-0.5 space-y-0.5">
                        {declined.map((d) => (
                          <li key={d.id} className="flex items-baseline gap-1.5 pl-3">
                            {onOpenAgent ? (
                              <button onClick={() => onOpenAgent(d.agentId)} className="shrink-0 text-neutral-500 hover:text-neutral-300">
                                {agentName(d.agentId)}
                              </button>
                            ) : (
                              <span className="shrink-0 text-neutral-500">{agentName(d.agentId)}</span>
                            )}
                            <span className="min-w-0 truncate text-neutral-600" title={d.reason ?? undefined}>
                              {compactReason(d.reason)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
