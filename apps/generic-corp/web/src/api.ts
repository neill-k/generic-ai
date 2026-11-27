/** The app's view of the server API. Every call is same-origin with the owner's session cookie. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    headers: {
      accept: "application/json",
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
  if (response.status === 401) {
    window.location.assign("/auth/login");
    throw new ApiError(401, "Please sign in to continue.");
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? `The request did not go through (${response.status}).`,
    );
  }
  return body as T;
}

export type GoalState =
  | "drafting"
  | "queued"
  | "working"
  | "waiting"
  | "paused"
  | "done"
  | "impossible"
  | "stopped"
  | "cancelled";

export type ChecklistState = "met" | "not-met" | "unchecked";

export interface GoalView {
  goalId: string;
  title: string;
  objective?: string;
  state: GoalState;
  statusText: string;
  revision?: number;
  checklist: { line: string; state: ChecklistState }[];
  checkedCurrentVersion: boolean;
  lastCheckedAt?: string;
  team: { agentId: string; role: string; title?: string; working: boolean; statusText: string }[];
  deliverables: { path: string; title?: string }[];
  usage: { tokens: number; costUsd: number };
  openQuestions: number;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: string;
  impossible?: { reason: string; reasoning?: string };
}

export interface DriveEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

export interface ChatExchange {
  message: {
    messageId: string;
    text: string;
    createdAt: string;
    taskId: string;
    attachments?: string[];
  };
  reply: {
    agentId: string;
    taskId: string;
    status: string;
    text?: string;
    error?: string;
    completedAt?: string;
  };
}

export interface ThreadView {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  exchanges: ChatExchange[];
}

export interface GoalDetail extends GoalView {
  definitionOfDone: string[];
  checks: {
    id: string;
    kind: string;
    description?: string;
    required: boolean;
    state: ChecklistState;
    message?: string;
  }[];
  history: { revision: number; source: string; changedAt: string; changedBy?: string }[];
  summary?: string;
  questions: {
    questionId: string;
    taskId: string;
    agentId: string;
    question: string;
    assumption: string;
    askedAt: string;
    answer?: string;
    answeredAt?: string;
  }[];
  files: DriveEntry[];
  conversation?: ThreadView;
}

export interface OrgNode {
  id: string;
  role: string;
  title?: string;
  tier: string;
  model?: string;
  status: string;
  activeTasks: number;
  reports: OrgNode[];
}

export interface TaskSummary {
  taskId: string;
  rootTaskId: string;
  agentId: string;
  delegatedBy?: string;
  depth: number;
  status: string;
  title: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  goal?: { definitionOfDone?: string; drafting?: boolean };
}

export interface AgentDetail {
  agent: {
    id: string;
    role: string;
    title?: string;
    model?: string;
    status: string;
    reportsTo?: string;
    instructions?: string;
  };
  memory: string;
  reports: string[];
  managementChain: string[];
  tasks: TaskSummary[];
}

export interface CompanyInfo {
  name: string;
  mission?: string;
  ceoId: string;
}

export interface GoalTemplate {
  id: string;
  title: string;
  description?: string;
  request: string;
  definitionOfDone: string[];
}

export interface PauseView {
  company: boolean;
  since?: string;
  agents: string[];
}

export function fileUrl(path: string, download = false): string {
  return `/api/drive/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}
