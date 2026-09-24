import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { skillsRefreshHours } from "./env.ts";
import { git } from "./workspaces.ts";

export type Skill = { name: string; description: string };


/** name/description out of SKILL.md's frontmatter, without pulling in a YAML parser. */
function readFrontmatter(path: string): Skill | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;

  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      key = match[1]!;
      fields[key] = match[2]!.trim();
    } else if (key && line.startsWith(" ")) {
      // A folded description continues on indented lines.
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  const name = fields.name?.replace(/^["']|["']$/g, "");
  return name ? { name, description: (fields.description ?? "").replace(/^["']|["']$/g, "") } : null;
}

/** Skills in ~/.claude/skills — the ones an agent gets when it inherits user settings. */
export function listSkills(): Skill[] {
  const dir = skillsDir();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readFrontmatter(join(dir, e.name, "SKILL.md")) ?? { name: e.name, description: "" })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Where the harness looks for skills: CLAUDE_CONFIG_DIR/skills, or ~/.claude/skills. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}
export function skillsDir(): string {
  return join(claudeConfigDir(), "skills");
}
/** Directories directly under `dir` that hold a SKILL.md. */
export function skillDirsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => d.name);
}
/**
 * Skills often live in a subdirectory of a bigger repo — a dotfiles checkout's
 * `.claude/skills`, say. Finds directories, up to two levels down, that contain
 * skill directories, so a blank path can be resolved or the user offered choices.
 */
export function findSkillRoots(checkout: string): string[] {
  const roots: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (skillDirsIn(dir).length > 0) roots.push(rel || ".");
    if (depth === 0) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== ".git" && d.name !== "node_modules") {
        walk(join(dir, d.name), rel ? `${rel}/${d.name}` : d.name, depth - 1);
      }
    }
  };
  walk(checkout, "", 2);
  return roots;
}
/**
 * What settings.json pre-approves. An agent that loads the shared config
 * inherits these, and anything on the list runs without a prompt — even on a
 * Manual agent. A bare tool name (no pattern) approves every use of that tool.
 */
export function preapprovedTools(): { count: number; bare: string[] } {
  const path = join(claudeConfigDir(), "settings.json");
  if (!existsSync(path)) return { count: 0, bare: [] };
  try {
    const allow = (JSON.parse(readFileSync(path, "utf8")).permissions?.allow ?? []) as string[];
    return { count: allow.length, bare: allow.filter((r) => typeof r === "string" && !r.includes("(")) };
  } catch {
    return { count: 0, bare: [] };
  }
}

/**
 * When the checkout last heard from its remote. `FETCH_HEAD` is rewritten by
 * every fetch or pull, including ones run outside bullpen; a clone that never
 * fetched again has none, so `HEAD` stands in for it. Epoch seconds.
 */
function lastFetchedAt(dir: string): number | null {
  let gitDir: string;
  try {
    gitDir = resolve(dir, git(dir, ["rev-parse", "--git-dir"], 5_000).trim());
  } catch {
    return null;
  }
  for (const name of ["FETCH_HEAD", "HEAD"]) {
    try {
      return Math.floor(statSync(join(gitDir, name)).mtimeMs / 1000);
    } catch {
      // try the next one
    }
  }
  return null;
}

export function skillsState() {
  const dir = skillsDir();
  const count = skillDirsIn(dir).length;
  let remote: string | null = null;
  let subdir: string | null = null;
  let lastPulledAt: number | null = null;
  // Set CLAUDE_CONFIG_DIR and the directory is bullpen's to manage; otherwise
  // it is the user's own ~/.claude and bullpen only reads it.
  const standalone = Boolean(process.env.CLAUDE_CONFIG_DIR);
  if (standalone && existsSync(dir)) {
    try {
      remote = git(dir, ["remote", "get-url", "origin"], 5_000).trim();
      const top = git(dir, ["rev-parse", "--show-toplevel"], 5_000).trim();
      const rel = relative(top, realpathSync(dir));
      subdir = rel === "" ? "." : rel;
      lastPulledAt = lastFetchedAt(dir);
    } catch {
      remote = null;
    }
  }
  const home = homedir();
  const dirDisplay = dir === home || dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
  return {
    dir,
    dirDisplay,
    count,
    remote,
    subdir,
    lastPulledAt,
    standalone,
    refreshHours: skillsRefreshHours(),
    preapproved: preapprovedTools(),
  };
}


/**
 * Refreshes the skills checkout at boot — but only where bullpen owns the
 * directory. CLAUDE_CONFIG_DIR being set is the signal: the container sets it
 * to /data/claude, which exists to be managed. On a laptop using ~/.claude the
 * skills are read as they sit, git checkout or not.
 * Never fatal: stale skills beat a server that refuses to start.
 */
export function pullSkillsIfStandalone(): string | null {
  if (!process.env.CLAUDE_CONFIG_DIR) return null;
  const state = skillsState();
  if (!state.remote) return null;
  try {
    const out = git(state.dir, ["pull", "--ff-only"], 60_000).trim().split("\n").pop() ?? "";
    return `skills: ${out || "up to date"} (${skillsState().count} installed)`;
  } catch (e) {
    return `skills: pull failed — ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Boot is the only pull a long-lived container would otherwise get, and it can
 * run for weeks — so repeat it on a timer. Same rule as the boot pull: standalone
 * directories only. Returns the interval in hours, 0 when nothing was started.
 */
export function startSkillsRefresh(): number {
  stopSkillsRefresh();
  const hours = skillsRefreshHours();
  if (hours <= 0 || !process.env.CLAUDE_CONFIG_DIR) return 0;
  refreshTimer = setInterval(
    () => {
      const note = pullSkillsIfStandalone();
      if (note) console.log(`[bullpen] ${note}`);
    },
    hours * 60 * 60 * 1000,
  );
  refreshTimer.unref();
  return hours;
}

export function stopSkillsRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

const CLAUDE_MD_MAX = 64 * 1024;

/**
 * The user-level CLAUDE.md the harness loads alongside skills and settings.json
 * when an agent uses the shared config. Content comes back so it can be seen;
 * it is only writable where bullpen owns the directory.
 */
export function claudeMdState() {
  const path = join(claudeConfigDir(), "CLAUDE.md");
  const standalone = Boolean(process.env.CLAUDE_CONFIG_DIR);
  if (!existsSync(path)) return { path, exists: false, size: 0, standalone, content: "" };
  const size = statSync(path).size;
  const content = size <= CLAUDE_MD_MAX ? readFileSync(path, "utf8") : readFileSync(path, "utf8").slice(0, CLAUDE_MD_MAX);
  return { path, exists: true, size, standalone, content };
}

export function writeClaudeMd(content: string): void {
  if (!process.env.CLAUDE_CONFIG_DIR) throw new Error("this CLAUDE.md is the user's own, not managed by bullpen");
  if (Buffer.byteLength(content) > CLAUDE_MD_MAX) throw new Error(`CLAUDE.md is limited to ${CLAUDE_MD_MAX / 1024} KB`);
  writeFileSync(join(claudeConfigDir(), "CLAUDE.md"), content);
}
