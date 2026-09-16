import type { Delivery } from "./types.ts";

/** Callers supply their own heading, since the editor and the rail label it differently. */
export function DeliveryList({ deliveries, limit = 8 }: { deliveries: Delivery[]; limit?: number }) {
  return (
    <ul className="space-y-0.5">
      {deliveries.slice(0, limit).map((d) => (
        <li key={d.id} className="font-mono text-xs">
          <span className={d.accepted ? "text-emerald-500" : "text-neutral-600"}>
            {d.accepted ? "OK  " : "DROP"}
          </span>{" "}
          <span className="text-neutral-500">{d.event ?? "—"}</span>{" "}
          <span className="text-neutral-600">{d.reason ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}
