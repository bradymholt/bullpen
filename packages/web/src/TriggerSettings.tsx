import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Agent, AgentInput, Delivery } from "./types.ts";

const field =
  "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none placeholder:text-neutral-700 focus:border-neutral-600";
const label = "block text-xs font-medium uppercase tracking-wide text-neutral-500 mb-1";

type TriggerKind = "manual" | "schedule" | "poll" | "webhook";

const CRON_PRESETS = [
  ["Every 5 minutes", "*/5 * * * *"],
  ["Every 15 minutes", "*/15 * * * *"],
  ["Hourly", "0 * * * *"],
  ["Daily 8am", "0 8 * * *"],
  ["Weekdays 9am", "0 9 * * 1-5"],
  ["Mondays 9am", "0 9 * * 1"],
] as const;

/** 32 random bytes, base64url — the same shape the server mints. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TIMEZONES = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona — no DST"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
  ["UTC", "UTC"],
] as const;

const KINDS: { kind: TriggerKind; title: string; hint: string; icon: React.ReactNode }[] = [
  {
    kind: "manual",
    title: "Manual",
    hint: "You start each run from the dashboard",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M5 3.5v9l7-4.5-7-4.5Z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    kind: "schedule",
    title: "Schedule",
    hint: "Run on a recurring cron schedule",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    kind: "poll",
    title: "Poll",
    hint: "Watch a URL and run only when it changes",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.9" strokeLinecap="round" />
        <path d="M13.5 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    kind: "webhook",
    title: "Webhook",
    hint: "Trigger from GitHub or your own code with a POST",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M6 4 2.5 8 6 12M10 4l3.5 4-3.5 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const PROVIDERS = [
  ["custom", "Custom — a shared token, or headers you name"],
  ["github", "GitHub — X-Hub-Signature-256"],
  ["slack", "Slack — v0= signature over timestamp + body"],
  ["asana", "Asana — X-Hook-Signature, with handshake"],
] as const;

/** A real field from each sender's payload, so the path isn't a guessing game. */
const FILTER_EXAMPLES: Record<string, { path: string; values: string; what: string }> = {
  slack: { path: "event.channel", values: "C0123ABC, C0456DEF", what: "a Slack channel id — Slack sends ids, never names" },
  github: { path: "action", values: "opened, reopened", what: "the action on a GitHub issue or PR" },
  asana: { path: "events.0.action", values: "changed, added", what: "what Asana did to the resource" },
  custom: { path: "type", values: "deploy.failed", what: "whatever field your sender uses to say what happened" },
};

type Shape = {
  header: string;
  prefix: string;
  eventHeader: string | null;
  handshake: boolean;
  /** True when the sender issues the secret and you paste it in. */
  pasted: boolean;
};

/** What each sender actually puts on the wire, so the setup isn't guesswork. */
const SENDER_NOTES: Record<string, React.ReactNode> = {
  github: (
    <>
      GitHub signs every delivery with HMAC-SHA256 over the raw body and sends it as{" "}
      <code>X-Hub-Signature-256: sha256=&lt;hex&gt;</code>, keyed by the secret below — paste that
      into GitHub&rsquo;s webhook form. It names the event in <code>X-GitHub-Event</code> and gives
      each delivery an <code>X-GitHub-Delivery</code> id, which bullpen uses to ignore retries of
      something it already ran. Saving the hook sends a <code>ping</code> first; that gets a 200 and
      starts nothing. Set GitHub&rsquo;s content type to <code>application/json</code> — the
      form-urlencoded default is rejected.
    </>
  ),
  asana: (
    <>
      Asana picks the secret, not you. When you register the webhook it POSTs here with{" "}
      <code>X-Hook-Secret</code>; bullpen echoes that header back and stores the value, which is what
      completes the registration. Afterwards every delivery carries{" "}
      <code>X-Hook-Signature: &lt;hex&gt;</code> — the same HMAC-SHA256 over the raw body, but with
      no <code>sha256=</code> prefix. Asana batches changes into an <code>events</code> array in the
      body and sends no event header, so the allowlist doesn&rsquo;t apply; filter in the prompt
      instead.
    </>
  ),
  slack: (
    <>
      Slack signs <code>v0:&lt;timestamp&gt;:&lt;body&gt;</code> — the timestamp and body together,
      not the body alone — and sends the result as <code>X-Slack-Signature: v0=&lt;hex&gt;</code>
      alongside <code>X-Slack-Request-Timestamp</code>. The key is your app&rsquo;s{" "}
      <strong>signing secret</strong> from Slack&rsquo;s Basic Information page; paste it below,
      then set the Request URL in Event Subscriptions. Slack checks that URL by POSTing{" "}
      <code>url_verification</code> and expecting the <code>challenge</code> value echoed back —
      bullpen does that once the signature checks out. Requests older than five minutes are refused
      as replays, retries (<code>X-Slack-Retry-Num</code>) are dropped rather than run twice, and
      the event name comes from <code>event.type</code> in the body.
    </>
  ),

  custom: (
    <>
      <strong>Leave the headers blank</strong> and this is a plain shared secret — the right choice
      for anything that can set a header but doesn&rsquo;t sign: Zapier, Make, n8n, CI jobs, your own
      scripts, or a relay in front of a service bullpen doesn&rsquo;t speak natively. Send the secret
      verbatim as <code>X-Bullpen-Token</code>, set <code>Content-Type: application/json</code> (a
      form-encoded body is refused), and put a stable id in{" "}
      <code>X-Bullpen-Idempotency-Key</code> so a retry doesn&rsquo;t start a second run. Nothing is
      signed, so treat the secret as a password.
      <br />
      <br />
      <strong>Name a signature header</strong> and bullpen instead computes HMAC-SHA256 over the raw
      body as hex and compares it to <code>&lt;prefix&gt;&lt;hex&gt;</code> there. That covers
      senders which hash the body alone — it will <em>not</em> match Stripe or anything else signing
      a composed string with a timestamp.
    </>
  ),
};

/** "hmac" and "token" predate the sender list; both still round-trip. */
function CronPresets({ value, onPick }: { value: string; onPick: (expr: string) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {CRON_PRESETS.map(([title, expr]) => (
        <button
          key={expr}
          type="button"
          onClick={() => onPick(expr)}
          className={`rounded border px-1.5 py-0.5 text-xs transition ${
            value === expr
              ? "border-neutral-600 bg-neutral-800 text-neutral-200"
              : "border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
          }`}
        >
          {title}
        </button>
      ))}
    </div>
  );
}

function senderOption(mode: string | undefined): string {
  if (mode === "hmac") return "github";
  if (!mode || mode === "token") return "custom";
  return mode;
}

function shapeOf(draft: AgentInput): Shape {
  const mode = senderOption(draft.webhookMode);
  if (mode === "custom") {
    const header = draft.webhookSignatureHeader?.trim();
    if (!header) {
      return { header: "X-Bullpen-Token", prefix: "", eventHeader: null, handshake: false, pasted: false };
    }
    return {
      header,
      prefix: draft.webhookSignaturePrefix ?? "",
      eventHeader: null,
      handshake: false,
      pasted: true,
    };
  }
  if (mode === "slack")
    return {
      header: "X-Slack-Signature",
      prefix: "v0=",
      eventHeader: null,
      handshake: false,
      pasted: true,
    };
  if (mode === "asana")
    return { header: "X-Hook-Signature", prefix: "", eventHeader: null, handshake: true, pasted: false };
  if (mode === "github" || mode === "hmac")
    return {
      header: "X-Hub-Signature-256",
      prefix: "sha256=",
      eventHeader: "X-GitHub-Event",
      handshake: false,
      pasted: false,
    };
  return { header: "X-Bullpen-Token", prefix: "", eventHeader: null, handshake: false, pasted: false };
}

function exampleRequest(url: string, draft: AgentInput): string {
  const shape = shapeOf(draft);
  const example = FILTER_EXAMPLES[senderOption(draft.webhookMode)] ?? FILTER_EXAMPLES.custom!;
  const signed = shape.header.toLowerCase() !== "x-bullpen-token";
  if (signed) {
    return [
      `BODY='{"word":"hello"}'`,
      `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$BULLPEN_SECRET" | awk '{print $2}')`,
      ``,
      `curl -X POST ${url} \\`,
      `  -H "${shape.header}: ${shape.prefix}$SIG" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d "$BODY"`,
    ].join("\n");
  }
  return [
    `curl -X POST ${url} \\`,
    `  -H "${shape.header}: $BULLPEN_SECRET" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"word":"hello"}'`,
  ].join("\n");
}

function initialKind(agent: Agent | null, draft: AgentInput): TriggerKind {
  if (draft.pollUrl) return "poll";
  if (draft.cron) return "schedule";
  if (agent && (agent.webhookEvents.length > 0 || agent.webhookMode !== "token"))
    return "webhook";
  return "manual";
}

export function TriggerSettings({
  agent,
  draft,
  set,
}: {
  agent: Agent | null;
  draft: AgentInput;
  set: <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => void;
}) {
  const [kind, setKind] = useState<TriggerKind>(() => initialKind(agent, draft));
  const [next, setNext] = useState<string[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [testBody, setTestBody] = useState('{"word":"hello"}');
  const [showExample, setShowExample] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [pollNote, setPollNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    setKind(initialKind(agent, agent ?? {}));
  }, [agent?.id]);

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

  const loadDeliveries = () => {
    if (agent) void api.deliveries(agent.id).then(setDeliveries);
  };
  useEffect(() => {
    setSecret(agent?.webhookSecret ?? null);
    setRevealed(false);
    setTestResult(null);
    loadDeliveries();
  }, [agent?.id]);

  const pick = (k: TriggerKind) => {
    setKind(k);
    // Both schedule and poll run off the cron expression, so it only survives
    // a move between those two.
    if (k !== "schedule" && k !== "poll" && draft.cron) {
      set("cron", null);
      set("cronTimezone", null);
    }
    if (k !== "poll" && draft.pollUrl) set("pollUrl", null);
  };

  // The draft carries its own id, so an unsaved agent can still show the URL it will answer on.
  const agentId = agent?.id ?? draft.id;
  const hookUrl = agentId ? `${location.origin}/api/hooks/${agentId}` : null;
  const shownSecret = agent ? secret : (draft.webhookSecret ?? null);
  const shape = shapeOf(draft);
  const example = FILTER_EXAMPLES[senderOption(draft.webhookMode)] ?? FILTER_EXAMPLES.custom!;

  return (
    <div className="space-y-3 border-y border-neutral-800 py-4">
      <span className={label}>Trigger</span>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {KINDS.map((k) => {
          const selected = kind === k.kind;
          return (
            <button
              key={k.kind}
              type="button"
              onClick={() => pick(k.kind)}
              aria-pressed={selected}
              className={`rounded-lg border px-3 py-2.5 text-left transition ${
                selected
                  ? "border-neutral-400 bg-neutral-900"
                  : "border-neutral-800 bg-neutral-950 hover:border-neutral-700 hover:bg-neutral-900/50"
              }`}
            >
              <span className={`flex items-center gap-2 text-sm font-medium ${selected ? "text-neutral-100" : "text-neutral-300"}`}>
                {k.icon}
                {k.title}
              </span>
              <span className="mt-1 block text-xs text-neutral-500">{k.hint}</span>
            </button>
          );
        })}
      </div>

      {kind === "manual" && (
        <p className="text-xs text-neutral-600">
          Nothing starts this agent but you. Its webhook URL still exists and still needs its
          secret &mdash; pick Webhook to see it.
        </p>
      )}

      {kind === "schedule" && (
        <div className="space-y-3 rounded-lg border border-neutral-800 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Cron</span>
              <input
                className={field}
                placeholder="0 8 * * *"
                value={draft.cron ?? ""}
                onChange={(e) => set("cron", e.target.value || null)}
              />
              <CronPresets value={draft.cron ?? ""} onPick={(expr) => set("cron", expr)} />
            </div>
            <div>
              <span className={label}>Timezone</span>
              <select
                className={field}
                value={draft.cronTimezone ?? ""}
                onChange={(e) => set("cronTimezone", e.target.value || null)}
              >
                <option value="">Server local time</option>
                {TIMEZONES.map(([tz, name]) => (
                  <option key={tz} value={tz}>
                    {name} — {tz}
                  </option>
                ))}
                {draft.cronTimezone && !TIMEZONES.some(([tz]) => tz === draft.cronTimezone) && (
                  <option value={draft.cronTimezone}>{draft.cronTimezone}</option>
                )}
              </select>
            </div>
          </div>

          {scheduleError && <p className="text-xs text-red-400">{scheduleError}</p>}
          {next && (
            <div className="text-xs text-neutral-500">
              Next:{" "}
              {next
                .map((t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))
                .join(" · ")}
            </div>
          )}
          {!agent && draft.cron && (
            <p className="text-xs text-neutral-600">Save the agent to see when this fires.</p>
          )}
        </div>
      )}

      {kind === "poll" && (
        <div className="space-y-3 rounded-lg border border-neutral-800 p-3">
          <p className="text-xs leading-relaxed text-neutral-500">
            Bullpen fetches this URL on the schedule below and hashes the response. The agent runs
            only when that hash changes, so a quiet endpoint costs nothing. The first check just
            records what&rsquo;s there — it never fires on the backlog. Outbound only: nothing needs
            to reach this machine.
          </p>

          <div>
            <span className={label}>URL</span>
            <input
              className={field}
              placeholder="https://api.example.com/status"
              value={draft.pollUrl ?? ""}
              onChange={(e) => set("pollUrl", e.target.value || null)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Check every</span>
              <input
                className={field}
                placeholder="*/5 * * * *"
                value={draft.cron ?? ""}
                onChange={(e) => set("cron", e.target.value || null)}
              />
              <CronPresets value={draft.cron ?? ""} onPick={(expr) => set("cron", expr)} />
            </div>
            <div>
              <span className={label}>Watch only this path</span>
              <input
                className={field}
                placeholder="whole response"
                value={draft.pollPath ?? ""}
                onChange={(e) => set("pollPath", e.target.value || null)}
              />
              <p className="mt-1 text-xs text-neutral-600">
                Dot path into a JSON response, e.g. <code>data.status</code>. Blank watches
                everything — including fields that change on every request.
              </p>
            </div>
          </div>

          <div>
            <span className={label}>Request headers</span>
            <textarea
              className={`${field} h-16 resize-y font-mono text-xs`}
              placeholder={'{"Authorization": "Bearer ${MY_TOKEN}"}'}
              defaultValue={JSON.stringify(draft.pollHeaders ?? {}, null, 0)}
              onBlur={(e) => {
                try {
                  set("pollHeaders", JSON.parse(e.target.value || "{}"));
                  setPollNote(null);
                } catch {
                  setPollNote("Request headers must be valid JSON");
                }
              }}
            />
            <p className="mt-1 text-xs text-neutral-600">
              JSON. <code>{"${NAME}"}</code> reads from this agent&rsquo;s env, so the token is never
              stored here.
            </p>
          </div>

          {agent?.pollStatus && (
            <p className="text-xs text-neutral-500">
              Last check: <span className="font-mono">{agent.pollStatus}</span>
              {agent.pollCheckedAt
                ? ` · ${new Date(agent.pollCheckedAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                : ""}
            </p>
          )}

          {agent && (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setPollNote("checking…");
                  try {
                    const r = await api.poll(agent.id);
                    setPollNote(
                      r.kind === "changed"
                        ? `changed — started a run`
                        : r.kind === "failed" || r.kind === "skipped"
                          ? `${r.kind}: ${r.reason}`
                          : r.kind,
                    );
                  } catch (e) {
                    setPollNote(String(e));
                  }
                }}
                className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
              >
                Check now
              </button>
              <button
                onClick={async () => {
                  await api.clearPollState(agent.id);
                  setPollNote("Forgot the last response — the next check primes again.");
                }}
                className="rounded border border-neutral-700 px-3 py-1 text-xs text-amber-400 hover:bg-neutral-800"
              >
                Forget last response
              </button>
            </div>
          )}
          {pollNote && <p className="font-mono text-xs text-neutral-400">{pollNote}</p>}
          {!agent && <p className="text-xs text-neutral-600">Save the agent, then check it here.</p>}
        </div>
      )}

      {kind === "webhook" && hookUrl && (
        <div className="space-y-4 rounded-lg border border-neutral-800 p-3">
          <div>
            <span className={label}>Sender</span>
            <select
              className={field}
              value={senderOption(draft.webhookMode)}
              onChange={(e) => {
                const mode = e.target.value;
                set("webhookMode", mode);
                // Only mint a secret for senders that expect us to choose one.
                if (!agent) set("webhookSecret", mode === "asana" ? null : randomSecret());
              }}
            >
              {PROVIDERS.map(([v, desc]) => (
                <option key={v} value={v}>
                  {desc}
                </option>
              ))}
            </select>
          </div>

          <p className="-mt-1 text-xs leading-relaxed text-neutral-500">
            {SENDER_NOTES[senderOption(draft.webhookMode)]}
          </p>

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
              {agent
                ? "Reachable by anything that can route here. Its secret is what protects it."
                : "This is the URL this agent will answer on — it starts working when you create it."}
            </p>
          </div>

          {shape.pasted ? (
            <div>
              <span className={label}>Signing secret</span>
              <div className="flex gap-2">
                <input
                  value={draft.webhookSecret ?? ""}
                  onChange={(e) => set("webhookSecret", e.target.value || null)}
                  placeholder={agent ? "unchanged" : "paste the sender's secret"}
                  className={`${field} font-mono text-xs`}
                />
                {agent && (
                  <button
                    disabled={!draft.webhookSecret?.trim()}
                    onClick={async () => {
                      await api.setSecret(agent.id, draft.webhookSecret!.trim());
                      setSecret(draft.webhookSecret!.trim());
                      setSaved("Secret saved.");
                    }}
                    className="shrink-0 rounded border border-neutral-700 px-2 text-xs hover:bg-neutral-800 disabled:opacity-40"
                  >
                    Save
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-neutral-600">
                {agent && secret
                  ? "A secret is already stored. Pasting a new one replaces it immediately, before you save the agent."
                  : "The sender issues this one — bullpen can't generate it."}
              </p>
              {saved && <p className="mt-1 text-xs text-emerald-500">{saved}</p>}
            </div>
          ) : shape.handshake ? (
            <div className="rounded border border-neutral-800 bg-neutral-950 p-2.5 text-xs">
              <span className={label}>Secret</span>
              {!agent ? (
                <p className="text-neutral-500">
                  Set by Asana on registration. Create this agent first, then point Asana&rsquo;s
                  webhook at the URL above.
                </p>
              ) : shownSecret ? (
                <>
                  <p className="text-emerald-500">Handshake complete — Asana set this agent&rsquo;s secret.</p>
                  <button
                    onClick={async () => {
                      if (!confirm("Clear the secret? The current Asana webhook stops working until you re-register it.")) return;
                      await api.clearSecret(agent.id);
                      setSecret(null);
                    }}
                    className="mt-2 rounded border border-neutral-700 px-2 py-0.5 text-xs text-amber-400 hover:bg-neutral-800"
                  >
                    Clear and await a new handshake
                  </button>
                </>
              ) : (
                <p className="text-amber-400">
                  Waiting for Asana&rsquo;s handshake. Register the webhook in Asana now; the first
                  request sets the secret.
                </p>
              )}
            </div>
          ) : (
          <div>
            <span className={label}>Secret</span>
            <div className="flex gap-2">
              <input
                readOnly
                value={revealed ? (shownSecret ?? "") : "•".repeat(24)}
                className={`${field} font-mono text-xs text-neutral-400`}
              />
              <button
                onClick={() => setRevealed((r) => !r)}
                className="shrink-0 rounded border border-neutral-700 px-2 text-xs hover:bg-neutral-800"
              >
                {revealed ? "Hide" : "Reveal"}
              </button>
              <button
                onClick={() => shownSecret && void navigator.clipboard.writeText(shownSecret)}
                className="shrink-0 rounded border border-neutral-700 px-2 text-xs hover:bg-neutral-800"
              >
                Copy
              </button>
              <button
                onClick={async () => {
                  if (!agent) {
                    set("webhookSecret", randomSecret());
                    setRevealed(true);
                    return;
                  }
                  if (!confirm("Rotate the secret? Anything already using the old one stops working.")) return;
                  const { webhookSecret } = await api.rotateSecret(agent.id);
                  setSecret(webhookSecret);
                  setRevealed(true);
                }}
                className="shrink-0 rounded border border-neutral-700 px-2 text-xs text-amber-400 hover:bg-neutral-800"
              >
                Rotate
              </button>
            </div>
          </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setShowExample((v) => !v)}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              {showExample ? "▾" : "▸"} Example request
            </button>

            {showExample && (
              <div className="mt-2">
                <pre className="overflow-x-auto rounded border border-neutral-800 bg-neutral-950 p-2.5 font-mono text-xs leading-relaxed text-neutral-400">
                  {exampleRequest(hookUrl, draft)}
                </pre>
                <button
                  onClick={() =>
                    void navigator.clipboard.writeText(exampleRequest(hookUrl, draft))
                  }
                  className="mt-1 rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
                >
                  Copy
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {shape.eventHeader && (
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
                <p className="mt-1 text-xs text-neutral-600">Matched against {shape.eventHeader}.</p>
              </div>
            )}
          </div>

          {draft.webhookMode === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className={label}>Signature header</span>
                <input
                  className={field}
                  placeholder="X-Hook-Signature"
                  value={draft.webhookSignatureHeader ?? ""}
                  onChange={(e) => set("webhookSignatureHeader", e.target.value || null)}
                />
              </div>
              <div>
                <span className={label}>Prefix</span>
                <input
                  className={field}
                  placeholder="sha256="
                  value={draft.webhookSignaturePrefix ?? ""}
                  onChange={(e) => set("webhookSignaturePrefix", e.target.value || null)}
                />
              </div>
            </div>
          )}

          {draft.webhookMode === "custom" && (
            <p className="-mt-2 text-xs text-neutral-600">
              Leave the signature header blank to match the secret as a plain token. Otherwise the
              secret is used as an HMAC-SHA256 key over the raw body, hex, with your prefix.
            </p>
          )}



          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Only run when</span>
              <input
                className={field}
                placeholder={example.path}
                value={draft.filterPath ?? ""}
                onChange={(e) => set("filterPath", e.target.value || null)}
              />
            </div>
            <div>
              <span className={label}>is one of</span>
              <input
                className={field}
                placeholder={example.values}
                value={(draft.filterValues ?? []).join(", ")}
                onChange={(e) =>
                  set("filterValues", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))
                }
              />
            </div>
          </div>
          <p className="-mt-2 text-xs leading-relaxed text-neutral-600">
            A dot path into the body, checked before the agent starts — nothing runs and nothing is
            spent when it doesn&rsquo;t match. Any sender, any field; for this one,{" "}
            <code>{example.path}</code> is {example.what}. Use <code>0</code> as a path segment to
            index an array. Leave either box blank to accept everything.
          </p>

          <p className="text-xs leading-relaxed text-neutral-600">
            The payload reaches the agent as data, never as instructions: pull fields into this
            agent&rsquo;s prompt with <code>{"{{payload.a.b}}"}</code>, and read the whole body from{" "}
            <code>.bullpen/payload.json</code> in the workspace.
          </p>

          {agent && (
          <div>
            <span className={label}>Test fire</span>
            <div className="flex gap-2">
              <input
                value={testBody}
                onChange={(e) => setTestBody(e.target.value)}
                className={`${field} font-mono text-xs`}
              />
              <button
                onClick={async () => {
                  if (!agent) return;
                  setTestResult("firing…");
                  try {
                    const r = await api.testFire(agent.id, testBody);
                    setTestResult(`${r.status} ${JSON.stringify(r.body)}`);
                  } catch (e) {
                    setTestResult(String(e));
                  }
                  loadDeliveries();
                }}
                className="shrink-0 rounded border border-neutral-700 px-3 text-sm hover:bg-neutral-800"
              >
                Send
              </button>
            </div>
            <p className="mt-1 text-xs text-neutral-600">
              Signs the request the same way a real caller would, using the settings above. Save
              first if you just changed them.
            </p>
            {testResult && <p className="mt-1 font-mono text-xs text-neutral-400">{testResult}</p>}
          </div>
          )}

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
        </div>
      )}
    </div>
  );
}
