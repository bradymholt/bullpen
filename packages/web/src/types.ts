export type WorkspaceConfig =
  | { kind: "persistent" }
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
  env: Record<string, string>;
  cron: string | null;
  cronTimezone: string | null;
  maxTurns: number | null;
  enabled: boolean;
};

export type AgentInput = Partial<Omit<Agent, "id" | "workspaceKind">>;

export type Run = {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  prompt: string;
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
  | { type: "status"; runId: string; status: string };
