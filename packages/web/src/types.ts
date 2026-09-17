/** The space an agent lands in when none is chosen; cannot be renamed or removed. */
export const DEFAULT_SPACE = "General";

/** "persistent" and "git" are the old spellings of "scratch" and "clone". */
export type WorkspaceConfig =
  | { kind: "scratch" }
  | { kind: "ephemeral" }
  | { kind: "persistent" }
  | { kind: "existing"; path: string }
  | { kind: "clone"; repoUrl: string; baseBranch?: string }
  | { kind: "git"; repoUrl: string; baseBranch?: string };

/** ANDed payload conditions; supersedes the single filterPath/filterValues pair. */
export type FilterCondition = { path: string; op: "in" | "not_in"; values: string[] };

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  space: string;
  model: string | null;
  prompt: string;
  permissionMode: string;
  workspaceKind: string;
  workspaceConfig: WorkspaceConfig;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, unknown>;
  inheritMachineMcp: boolean;
  /** null = every shared server; a list = only these. Only read when inheritMachineMcp is on. */
  sharedMcpPick: string[] | null;
  inheritUserSettings: boolean;
  env: Record<string, string>;
  pollUrl: string | null;
  pollHeaders: Record<string, string>;
  pollPath: string | null;
  pollState: string | null;
  pollStatus: string | null;
  pollCheckedAt: number | null;
  cron: string | null;
  cronTimezone: string | null;
  webhookSecret: string | null;
  trigger: "manual" | "schedule" | "poll" | "webhook";
  webhookMode: string;
  webhookEvents: string[];
  filterPath: string | null;
  filters: FilterCondition[];
  labelTemplate: string | null;
  filterValues: string[];
  webhookSignatureHeader: string | null;
  webhookSignaturePrefix: string | null;
  concurrency: string;
  maxTurns: number | null;
  enabled: boolean;
};

/** `id` is accepted only on create, so the editor can show a webhook URL that survives the save. */
export type AgentInput = Partial<Omit<Agent, "workspaceKind">>;

export type Run = {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  prompt: string;
  permissionMode: string | null;
  claudeSessionId: string | null;
  workspacePath: string | null;
  branch: string | null;
  costUsd: number | null;
  /** What the run is about, from the agent's labelTemplate. */
  label: string | null;
  numTurns: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The session is still attached, so it can take another message. */
  resumable?: boolean;
};

export type RunEvent = {
  seq: number;
  ts: number;
  type: string;
  payload: any;
};

export type SocketMessage =
  | { type: "event"; runId: string; seq: number; ts: number; eventType: string; payload: any }
  | { type: "status"; runId: string; status: string }
  | { type: "approval"; runId: string; id: string; status: string };

export type Approval = {
  id: string;
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  description: string | null;
  space: string | null;
  status: string;
};

export type Delivery = {
  id: string;
  /** Present on the cross-agent feed; per-agent listings imply it. */
  agentId: string;
  /** The sender's own id for this delivery; shared by every agent it fanned out to. */
  deliveryKey: string | null;
  ts: number;
  event: string | null;
  accepted: boolean;
  reason: string | null;
  /** What the delivery was about, from the agent's labelTemplate. */
  label: string | null;
  runId: string | null;
};

export type McpServerSummary = {
  name: string;
  transport: string;
  /** URL or command line — never env or header values. */
  detail: string;
  secretKeys: string[];
};

export type MachineMcp = {
  configPath: string;
  found: boolean;
  /** Bullpen may write the file directly (CLAUDE_CONFIG_DIR is set). */
  managed: boolean;
  global: McpServerSummary[];
  connectors: string[];
  /** Last connection state seen in a run's init message, by server name. */
  health: Record<string, { status: string; at: number; error?: string }>;
};

export type PollOutcome =
  | { kind: "primed"; status: number }
  | { kind: "unchanged"; status: number }
  | { kind: "changed"; status: number; runId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

export type Repo = { fullName: string; owner: string; cloneUrl: string; private: boolean };
export type RepoList = { configured: boolean; viewer: string | null; repos: Repo[] };

export type Skill = { name: string; description: string };

export type Health = {
  ok: boolean;
  dataDir: string;
  /** Base URL senders use for /api/hooks, when it differs from the dashboard's own. */
  publicUrl: string | null;
  /** The commit this server runs, and the repo to link it to; either may be unknown. */
  version: string | null;
  /** Release tag (v12) when deployed through the workflow; otherwise null and the commit is the reference. */
  release: string | null;
  repoUrl: string | null;
  claudeCredential: { source: string; detail: string };
};

/** Server-side aggregates; `/runs` is capped, so these can't be derived from it. */
export type McpLogin = {
  id: string;
  name: string;
  state: "starting" | "awaiting_redirect" | "done" | "failed";
  authUrl: string | null;
  error: string | null;
  startedAt: number;
};


export type Stats = {
  last24h: number;
  prev24h: number;
  failed24h: number;
  spend24h: number;
  total: number;
  /** Each agent's newest run, keyed by agent id. */
  latest: Record<string, { id: string; status: string; startedAt: number }>;
  /** Count of running / awaiting-approval runs per agent. */
  active: Record<string, number>;
  /** Runs waiting behind an active one, per agent. */
  queued: Record<string, number>;
};
