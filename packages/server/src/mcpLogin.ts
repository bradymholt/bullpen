import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * OAuth for a remote MCP server, driven through the harness's own
 * `claude mcp login --no-browser`, so the tokens land exactly where a run will
 * look for them (the config dir's credential store) in whatever format this
 * version of the harness uses. Bullpen only relays: it shows the URL the CLI
 * prints, and hands back the redirect the browser lands on.
 *
 * The CLI listens for that redirect on a localhost port. The browser can't
 * reach it on a headless box, but this process can — it shares the CLI's
 * network namespace — so completing a login is a paste in the dashboard.
 */

export type McpLoginState = "starting" | "awaiting_redirect" | "done" | "failed";

export type McpLogin = {
  id: string;
  name: string;
  state: McpLoginState;
  /** The authorization URL the CLI printed, once it has. */
  authUrl: string | null;
  error: string | null;
  startedAt: number;
};

type Session = { info: McpLogin; child: ChildProcess; output: string; exited: Promise<number | null> };

const sessions = new Map<string, Session>();
const LOGIN_TIMEOUT_MS = 10 * 60_000;

// The CLI wraps the URL in an OSC 8 hyperlink and prints it twice back to back,
// so the match stops at the next "https://" rather than at whitespace.
const URL_RE = /https:\/\/(?:(?!https:\/\/)[^\s\x1b\x07])+/;

/** The authorization URL out of the CLI's terminal output, or null until it has printed one. */
export function parseAuthUrl(output: string): string | null {
  return URL_RE.exec(stripTerminal(output))?.[0] ?? null;
}

/**
 * The CLI insists on a terminal for the paste prompt ("stdin isn't a terminal,
 * so authentication can't be completed here"), so it runs under a pty that we
 * can still write to. util-linux script(1) does that on the box (bsdutils is in
 * the image); BSD script wants a real tty on its own stdin, so a Mac dev box
 * uses Python's pty module instead.
 */
function ptyCommand(argv: string[]): [string, string[]] {
  if (process.platform === "darwin") {
    return ["python3", ["-c", "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)", ...argv]];
  }
  return ["script", ["-qfec", argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"]];
}

function stripTerminal(s: string): string {
  return s
    .replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function lastLine(s: string): string {
  const lines = stripTerminal(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function active(name: string): Session | undefined {
  for (const s of sessions.values()) {
    if (s.info.name === name && (s.info.state === "starting" || s.info.state === "awaiting_redirect")) return s;
  }
  return undefined;
}

export function startMcpLogin(name: string): McpLogin {
  const existing = active(name);
  if (existing) return existing.info;

  const child = spawn(...ptyCommand(["claude", "mcp", "login", "--no-browser", name]), {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const info: McpLogin = { id: randomUUID(), name, state: "starting", authUrl: null, error: null, startedAt: Date.now() };
  const session: Session = { info, child, output: "", exited: Promise.resolve(null) };

  const onData = (chunk: Buffer) => {
    session.output += chunk.toString();
    if (!info.authUrl) {
      const url = parseAuthUrl(session.output);
      if (url) {
        info.authUrl = url;
        info.state = "awaiting_redirect";
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  session.exited = new Promise((resolve) => {
    child.on("error", (e) => {
      info.state = "failed";
      info.error = e.message;
      resolve(null);
    });
    child.on("exit", (code) => {
      if (info.state !== "done" && info.state !== "failed") {
        if (code === 0) info.state = "done";
        else {
          info.state = "failed";
          info.error = lastLine(session.output) || `claude exited with ${code}`;
        }
      }
      resolve(code);
    });
  });

  setTimeout(() => {
    if (info.state === "starting" || info.state === "awaiting_redirect") {
      info.state = "failed";
      info.error = "timed out waiting for authorization";
      child.kill();
    }
  }, LOGIN_TIMEOUT_MS).unref();

  sessions.set(info.id, session);
  return info;
}

export function getMcpLogin(id: string): McpLogin | undefined {
  return sessions.get(id)?.info;
}

export function cancelMcpLogin(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.info.state === "starting" || s.info.state === "awaiting_redirect") {
    s.info.state = "failed";
    s.info.error = "cancelled";
    s.child.kill();
  }
}

/**
 * The redirect the browser landed on: http://localhost:<port>/callback?code=…&state=….
 * Delivered both ways the CLI accepts it — pasted on stdin, and as the HTTP
 * request its callback listener is waiting for.
 */
export async function completeMcpLogin(id: string, redirectUrl: string): Promise<McpLogin> {
  const s = sessions.get(id);
  if (!s) throw new Error("no such login");
  if (s.info.state !== "awaiting_redirect") throw new Error(`login is ${s.info.state}`);

  let url: URL;
  try {
    url = new URL(redirectUrl.trim());
  } catch {
    throw new Error("paste the whole URL the browser ended up on");
  }
  if (!url.searchParams.get("code")) throw new Error("that URL carries no authorization code");

  s.child.stdin?.write(`${url.toString()}\n`);
  if (url.port) {
    try {
      await fetch(`http://127.0.0.1:${url.port}${url.pathname}${url.search}`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      // the stdin path may already have finished it, or the listener is gone
    }
  }

  await Promise.race([s.exited, new Promise((r) => setTimeout(r, 60_000))]);
  if (s.info.state === "awaiting_redirect") {
    s.info.state = "failed";
    s.info.error = lastLine(s.output) || "the CLI did not finish after the redirect";
    s.child.kill();
  }
  return s.info;
}

export function mcpLogout(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["mcp", "logout", name], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(lastLine(out) || `claude exited with ${code}`))));
  });
}
