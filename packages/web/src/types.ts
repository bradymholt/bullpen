/** "persistent" and "git" are the old spellings of "scratch" and "clone". */
export type WorkspaceConfig =
  | { kind: "scratch" }
  | { kind: "persistent" }
  | { kind: "existing"; path: string }
  | { kind: "clone"; repoUrl: string; baseBranch?: string }
  | { kind: "git"; repoUrl: string; baseBranch?: string };

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  prompt: string;
  permissionMode: string;
  workspaceKind: string;
  workspaceConfig: WorkspaceConfig;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, unknown>;
  inheritMachineMcp: boolean;
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
  webhookMode: string;
  webhookEvents: string[];
  filterPath: string | null;
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
  numTurns: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
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
  status: string;
};

export type Delivery = {
  id: string;
  ts: number;
  event: string | null;
  accepted: boolean;
  reason: string | null;
  runId: string | null;
};

export type MachineMcp = {
  configPath: string;
  found: boolean;
  global: { name: string; transport: string }[];
  connectors: string[];
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
  claudeCredential: { source: string; detail: string };
};
