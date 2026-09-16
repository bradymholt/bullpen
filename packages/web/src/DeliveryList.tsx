import { ago } from "./time.ts";
import type { Delivery } from "./types.ts";

/** Callers supply their own heading, since each surface labels it differently. */
export function DeliveryList({ deliveries, limit = 8 }: { deliveries: Delivery[]; limit?: number }) {
  return (
    <ul className="space-y-0.5">
      {deliveries.slice(0, limit).map((d) => (
        <li key={d.id} className="flex items-baseline gap-1.5 font-mono text-xs">
          <span className={d.accepted ? "shrink-0 text-emerald-500" : "shrink-0 text-neutral-600"}>
            {d.accepted ? "OK  " : "DROP"}
          </span>
          <span className="shrink-0 tabular-nums text-neutral-500" title={new Date(d.ts * 1000).toLocaleString()}>
            {ago(d.ts)}
          </span>
          {/* The label names the thing; without one, the event name is all there is. */}
          <span className="truncate text-neutral-300">{d.label ?? d.event ?? "—"}</span>
          <span className="ml-auto shrink-0 truncate text-neutral-600">{d.reason ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One delivery, one block. A shared space URL fans a single delivery out to
 * every agent in the space, so a flat list shows one event as several rows and
 * reads like several events. Grouping makes the one-in, several-out shape plain.
 */
export function GroupedDeliveryList({
  deliveries,
  limit = 8,
  agentName,
}: {
  deliveries: Delivery[];
  limit?: number;
  agentName: (id: string) => string;
}) {
  const groups: { key: string; rows: Delivery[] }[] = [];
  for (const d of deliveries) {
    // No delivery key means nothing to group on, so it stands alone.
    const key = d.deliveryKey ?? `one-${d.id}`;
    const existing = groups.find((g) => g.key === key);
    if (existing) existing.rows.push(d);
    else groups.push({ key, rows: [d] });
  }

  return (
    <ul className="space-y-2.5">
      {groups.slice(0, limit).map(({ key, rows }) => {
        const first = rows[0]!;
        const ran = rows.filter((r) => r.accepted).length;
        return (
          <li key={key}>
            <div className="flex items-baseline gap-2 text-xs">
              <span
                className="shrink-0 tabular-nums text-neutral-500"
                title={new Date(first.ts * 1000).toLocaleString()}
              >
                {ago(first.ts)}
              </span>
              <span className="truncate font-mono text-neutral-200">
                {first.label ?? first.event ?? "—"}
              </span>
              <span className="ml-auto shrink-0 text-neutral-600">
                {ran} of {rows.length} ran
              </span>
            </div>
            <ul className="mt-0.5 space-y-0.5 border-l border-neutral-800 pl-2">
              {rows.map((d) => (
                <li key={d.id} className="flex items-baseline gap-1.5 font-mono text-xs">
                  <span className={d.accepted ? "shrink-0 text-emerald-500" : "shrink-0 text-neutral-600"}>
                    {d.accepted ? "OK  " : "DROP"}
                  </span>
                  <span className="shrink-0 text-neutral-400">{agentName(d.agentId)}</span>
                  <span className="ml-auto truncate text-neutral-600">{d.reason ?? ""}</span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
