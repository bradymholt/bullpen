import { useState } from "react";

const MASK = "••••";
const field =
  "rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-hidden placeholder:text-neutral-700 focus:border-neutral-600";

/**
 * Edits an env map the server has masked. A saved value arrives as the mask and
 * is shown as an empty field with a "saved" placeholder — the value itself never
 * reaches the browser. Leaving it alone sends the mask back, which the server
 * reads as "keep what you have"; typing replaces; removing the row deletes.
 */
export function EnvEditor({
  value,
  onChange,
  inherited,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** Keys this scope inherits from wider ones, shown read-only so precedence is visible. */
  inherited?: { from: string; keys: string[] }[];
}) {
  // Rows keep their own identity while a key is being typed, so editing the key
  // of a row doesn't reorder or drop it mid-keystroke.
  const [rows, setRows] = useState(() =>
    Object.entries(value).map(([k, v], i) => ({ id: i, key: k, value: v })),
  );
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), -1) + 1;

  const commit = (next: typeof rows) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])));
  };

  return (
    <div className="space-y-1.5">
      {inherited?.filter((g) => g.keys.length > 0).map((g) => (
        <p key={g.from} className="text-xs text-neutral-600">
          Inherits from {g.from}:{" "}
          <span className="font-mono text-neutral-500">{g.keys.join(", ")}</span>
        </p>
      ))}
      {rows.map((r) => {
        const saved = /^•+$/.test(r.value);
        return (
          <div key={r.id} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] gap-2">
            <input
              className={field}
              placeholder="NAME"
              value={r.key}
              spellCheck={false}
              onChange={(e) => commit(rows.map((x) => (x.id === r.id ? { ...x, key: e.target.value } : x)))}
            />
            <input
              className={field}
              type="password"
              autoComplete="off"
              placeholder={saved ? "saved — type to replace" : "value"}
              value={saved ? "" : r.value}
              onChange={(e) =>
                commit(rows.map((x) => (x.id === r.id ? { ...x, value: e.target.value || MASK } : x)))
              }
            />
            <button
              onClick={() => commit(rows.filter((x) => x.id !== r.id))}
              title="Remove"
              className="px-1 text-sm text-neutral-600 hover:text-red-400"
            >
              &times;
            </button>
          </div>
        );
      })}
      <button
        onClick={() => commit([...rows, { id: nextId++, key: "", value: "" }])}
        className="text-xs text-neutral-400 hover:text-neutral-100"
      >
        + Add variable
      </button>
    </div>
  );
}
