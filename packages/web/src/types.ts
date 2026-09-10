export type Agent = {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  prompt: string;
  permissionMode: string;
  workspaceKind: string;
  enabled: boolean;
};

export type Run = {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  prompt: string;
  claudeSessionId: string | null;
  workspacePath: string | null;
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
