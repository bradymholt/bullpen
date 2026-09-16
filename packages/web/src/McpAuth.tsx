import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { McpLogin } from "./types.ts";

/**
 * Authorize a remote MCP server from the dashboard. The server runs the
 * harness's own login; we show the URL it printed and hand back the redirect
 * the browser lands on, which fails to load because it points at the box's
 * localhost — that failed page's address is the thing to paste.
 */
export function McpAuth({ name, onDone }: { name: string; onDone: () => void }) {
  const [login, setLogin] = useState<McpLogin | null>(null);
  const [redirect, setRedirect] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const stop = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };

  const begin = async () => {
    setError(null);
    setRedirect("");
    try {
      const l = await api.mcpLoginStart(name);
      setLogin(l);
      stop();
      // Poll until the login ends: on a laptop the browser reaches the CLI's
      // callback directly, so it can finish without anything being pasted.
      timer.current = window.setInterval(async () => {
        try {
          const cur = await api.mcpLoginGet(l.id);
          setLogin(cur);
          if (cur.state === "done" || cur.state === "failed") {
            stop();
            if (cur.state === "done") onDone();
          }
        } catch {
          stop();
        }
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => stop, []);

  const finish = async () => {
    if (!login) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.mcpLoginComplete(login.id, redirect);
      setLogin(done);
      if (done.state === "done") onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    stop();
    if (login && (login.state === "starting" || login.state === "awaiting_redirect")) {
      await api.mcpLoginCancel(login.id).catch(() => undefined);
    }
    setLogin(null);
    setRedirect("");
    setError(null);
  };

  const small = "text-xs text-neutral-500 hover:text-neutral-200";

  if (!login) {
    return (
      <span className="flex items-center gap-2">
        <button onClick={begin} className={small} title="Sign in to this server; tokens are stored where runs read them">
          Authorize
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </span>
    );
  }

  return (
    <div className="mt-1 w-full space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3 text-xs">
      {login.state === "starting" && <p className="text-neutral-400">Starting the sign-in for <code>{name}</code>…</p>}

      {login.state === "awaiting_redirect" && login.authUrl && (
        <>
          <p className="text-neutral-300">
            1.{" "}
            <a href={login.authUrl} target="_blank" rel="noreferrer" className="underline decoration-neutral-600 hover:text-white">
              Open the authorization page
            </a>{" "}
            and approve.
          </p>
          <p className="text-neutral-300">
            2. If the browser then shows a success page, you&rsquo;re done &mdash; this will update by itself.
            If it lands on a <code>localhost</code> address that fails to load (a headless box), copy that
            page&rsquo;s whole URL from the address bar and paste it here.
          </p>
          <div className="flex gap-2">
            <input
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-xs outline-none placeholder:text-neutral-700 focus:border-neutral-600"
              placeholder="http://localhost:…/callback?code=…&state=…"
              value={redirect}
              onChange={(e) => setRedirect(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && redirect.trim()) void finish();
              }}
            />
            <button
              onClick={() => void finish()}
              disabled={busy || !redirect.trim()}
              className="shrink-0 rounded bg-neutral-100 px-3 py-1.5 font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            >
              {busy ? "Finishing…" : "Finish"}
            </button>
          </div>
        </>
      )}

      {login.state === "done" && <p className="text-emerald-500">Authorized. The next run that uses <code>{name}</code> will connect.</p>}
      {login.state === "failed" && <p className="text-red-400">Sign-in failed: {login.error ?? "unknown error"}</p>}
      {error && <p className="text-red-400">{error}</p>}

      <div className="flex gap-3">
        {login.state === "done" || login.state === "failed" ? (
          <button onClick={() => void cancel()} className={small}>Close</button>
        ) : (
          <button onClick={() => void cancel()} className={small}>Cancel</button>
        )}
      </div>
    </div>
  );
}
