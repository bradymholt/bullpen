import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { McpCatalogEntry } from "./types.ts";

const field =
  "w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm outline-hidden placeholder:text-neutral-700 focus:border-neutral-600";
const primary =
  "rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40";
const secondary = "rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900 disabled:opacity-40";

/** Saves one key into global env without disturbing the others, which arrive masked. */
async function saveGlobal(key: string, value: string) {
  const { env } = await api.globalEnv();
  await api.setGlobalEnv({ ...env, [key]: value });
}

/**
 * Shown instead of the dashboard when no Claude credential exists: nothing can
 * run without one, so there is nothing to dismiss to. Values go to global env,
 * so they are editable afterwards under Settings and never shown again.
 */
export function SetupView({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"claude" | "github" | "skills" | "mcp">("claude");
  // The MCP step exists only on a managed box (a config dir that is bullpen's to write).
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    void api
      .mcpCatalog()
      .then((r) => {
        if (!r.managed) return;
        setCatalog(r.entries);
        // Pre-selected: what is installed, or every available entry on a fresh box.
        const installed = r.entries.filter((e) => e.installed).map((e) => e.key);
        setPicked(new Set(installed.length > 0 ? installed : r.entries.filter((e) => !e.unavailable).map((e) => e.key)));
      })
      .catch(() => setCatalog(null));
  }, []);
  const total = catalog ? 4 : 3;
  const afterSkills = () => (catalog ? setStep("mcp") : onDone());
  const [skillsUrl, setSkillsUrl] = useState("");
  const [skillsPath, setSkillsPath] = useState("");
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [skills, setSkills] = useState<{ dir: string; dirDisplay: string; count: number; remote: string | null } | null>(null);
  useEffect(() => {
    if (step !== "skills") return;
    void api.skillsState().then(setSkills).catch(() => setSkills(null));
  }, [step]);
  const [claude, setClaude] = useState("");
  const [github, setGithub] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => setNote(null), [step]);

  const claudeLooksRight = claude.trim().startsWith("sk-ant-oat01-");

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 px-6 font-sans text-neutral-100">
      <div className="w-full max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Set up Bullpen</h1>
            <p className="text-xs text-neutral-500">
              {step === "claude"
                ? `Step 1 of ${total} — Claude`
                : step === "github"
                  ? `Step 2 of ${total} — GitHub (optional)`
                  : step === "skills"
                    ? `Step 3 of ${total} — Skills (optional)`
                    : `Step 4 of ${total} — MCP servers (optional)`}
            </p>
          </div>
        </div>

        {step === "claude" && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-neutral-300">
              Agents run through Claude Code on your subscription. On any machine where you are
              logged in, run:
            </p>
            <pre className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200">
              claude setup-token
            </pre>
            <p className="text-sm leading-relaxed text-neutral-400">
              Paste the token it prints. It is stored once, in this bullpen&rsquo;s global
              environment, and never displayed again.
            </p>
            <input
              className={field}
              type="password"
              autoComplete="off"
              placeholder="sk-ant-oat01-…"
              value={claude}
              onChange={(e) => setClaude(e.target.value)}
            />
            {claude.trim() && !claudeLooksRight && (
              <p className="text-xs text-amber-500/80">
                Tokens from <code>claude setup-token</code> start with <code>sk-ant-oat01-</code>. This
                one doesn&rsquo;t — it will still be saved if you continue.
              </p>
            )}
            <button
              disabled={!claude.trim() || busy !== null}
              onClick={() =>
                run("save", async () => {
                  await api.setupClaudeTest(claude.trim());
                  await saveGlobal("CLAUDE_CODE_OAUTH_TOKEN", claude.trim());
                  setStep("github");
                })
              }
              title="Runs one tiny turn to check the token — a few cents, a few seconds"
              className={primary}
            >
              {busy === "save" ? "Checking the token…" : "Save and continue"}
            </button>
          </div>
        )}

        {step === "github" && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-neutral-300">
              Agents that touch GitHub — cloning private repos, reviewing or merging PRs — need a
              token. Skip this if none of yours will.
            </p>
            <input
              className={field}
              type="password"
              autoComplete="off"
              placeholder="ghp_… or github_pat_…"
              value={github}
              onChange={(e) => setGithub(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button
                disabled={!github.trim() || busy !== null}
                onClick={() =>
                  run("verify", async () => {
                    await api.setupGithub(github.trim());
                    await saveGlobal("GITHUB_TOKEN", github.trim());
                    setStep("skills");
                  })
                }
                className={primary}
              >
                {busy === "verify" ? "Checking…" : "Verify and finish"}
              </button>
              <button disabled={busy !== null} onClick={() => { setNote(null); setStep("skills"); }} className={secondary}>
                Skip for now
              </button>
            </div>
            <p className="text-xs text-neutral-600">
              You can add or change it later under Settings &rarr; Global environment.
            </p>
          </div>
        )}

        {step === "skills" && (
          <div className="space-y-4">
            {skills && skills.count > 0 ? (
              <>
                <p className="text-sm leading-relaxed text-neutral-300">
                  {skills.count} skills already present in <code className="text-neutral-400">{skills.dirDisplay}</code>
                  {skills.remote ? <> from <code className="text-neutral-400">{skills.remote}</code></> : null}.
                  Nothing to do here.
                </p>
                <button onClick={afterSkills} className={primary}>{catalog ? "Continue" : "Finish"}</button>
              </>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-neutral-300">
                  Agents invoke skills — <code>/pr-review</code>, say — from this bullpen&rsquo;s
                  skills directory, which is empty. If yours live in a git repo, it can be cloned in now.
                </p>
                {skills && (
                  <p className="text-xs text-neutral-600">
                    Skills directory: <code>{skills.dirDisplay}</code>
                  </p>
                )}
                <input
                  className={field}
                  placeholder="https://github.com/you/dotfiles"
                  value={skillsUrl}
                  onChange={(e) => { setSkillsUrl(e.target.value); setCandidates(null); }}
                />
                <input
                  className={field}
                  placeholder="path inside the repo, e.g. .claude/skills — blank to detect"
                  value={skillsPath}
                  onChange={(e) => setSkillsPath(e.target.value)}
                />
                {candidates && candidates.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-neutral-500">Skills were found in more than one place — pick one:</p>
                    <div className="flex flex-wrap gap-1">
                      {candidates.map((c) => (
                        <button
                          key={c}
                          onClick={() => { setSkillsPath(c === "." ? "" : c); setCandidates(null); }}
                          className="rounded border border-neutral-700 px-2 py-0.5 font-mono text-xs hover:bg-neutral-800"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    disabled={!skillsUrl.trim() || busy !== null}
                    onClick={() =>
                      run("clone", async () => {
                        try {
                          await api.skillsClone(skillsUrl.trim(), skillsPath.trim() || undefined);
                          afterSkills();
                        } catch (e) {
                          const c = (e as { candidates?: string[] }).candidates;
                          if (c && c.length > 0) setCandidates(c);
                          throw e;
                        }
                      })
                    }
                    className={primary}
                  >
                    {busy === "clone" ? "Cloning…" : catalog ? "Clone and continue" : "Clone and finish"}
                  </button>
                  <button disabled={busy !== null} onClick={afterSkills} className={secondary}>Skip</button>
                </div>
                <p className="text-xs text-neutral-600">
                  Private repo? Save the GitHub token first — the clone uses it. Later, Settings has
                  &ldquo;Pull now&rdquo; for updates.
                </p>
              </>
            )}
          </div>
        )}

        {step === "mcp" && catalog && (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-neutral-300">
              Servers agents can use with no account and no key. Agents opt in with &ldquo;Use the shared
              MCP servers&rdquo;; you can change this later under Settings. Servers that need a sign-in
              (Datadog, Cloudflare, &hellip;) are added there too, then authorized in place.
            </p>
            <div className="space-y-2">
              {catalog.map((e) => (
                <label
                  key={e.key}
                  className={`flex items-start gap-3 rounded border px-3 py-2 ${
                    e.unavailable ? "border-neutral-900 opacity-60" : "border-neutral-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={!!e.unavailable}
                    checked={!e.unavailable && picked.has(e.key)}
                    onChange={(ev) =>
                      setPicked((prev) => {
                        const n = new Set(prev);
                        ev.target.checked ? n.add(e.key) : n.delete(e.key);
                        return n;
                      })
                    }
                  />
                  <span>
                    <span className="text-sm text-neutral-200">{e.name}</span>
                    <span className="block text-xs text-neutral-500">{e.description}</span>
                    {e.unavailable && <span className="block text-xs text-amber-500/80">Not available: {e.unavailable}.</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={busy !== null}
                onClick={() =>
                  run("mcp", async () => {
                    await api.applyMcpCatalog([...picked]);
                    onDone();
                  })
                }
                className={primary}
              >
                {busy === "mcp" ? "Applying…" : "Finish"}
              </button>
              <button disabled={busy !== null} onClick={onDone} className={secondary}>Skip</button>
            </div>
          </div>
        )}

        {note && (
          <p className={`text-sm ${note.tone === "ok" ? "text-emerald-500" : "text-red-400"}`}>{note.text}</p>
        )}
      </div>
    </div>
  );
}
