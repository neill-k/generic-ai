import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "@generic-ai/plugin-workspace-fs" as const;

export type WorkspaceRootInput = string | URL;

export interface WorkspaceLayout {
  root: string;
  framework: string;
  agents: string;
  plugins: string;
  skills: string;
  workspace: string;
  workspaceAgents: string;
  shared: string;
}

export interface AgentWorkspaceLayout {
  root: string;
  memory: string;
  results: string;
}

export interface WorkspaceFs {
  root: string;
  layout: WorkspaceLayout;
  resolvePath(...segments: string[]): string;
  resolveAgentPath(agentId: string, ...segments: string[]): string;
  createAgentWorkspaceLayout(agentId: string): AgentWorkspaceLayout;
  ensureLayout(): Promise<WorkspaceLayout>;
  ensureAgentWorkspaceLayout(agentId: string): Promise<AgentWorkspaceLayout>;
}

function toAbsoluteWorkspaceRoot(input: WorkspaceRootInput): string {
  return path.resolve(input instanceof URL ? fileURLToPath(input) : input);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureInsideRoot(root: string, candidate: string, label: string): string {
  if (!isInsideRoot(root, candidate)) {
    throw new Error(`${label} escapes the workspace root: ${candidate}`);
  }

  return candidate;
}

function assertWorkspaceToken(token: string, label: string): string {
  if (token.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  if (token === "." || token === "..") {
    throw new Error(`${label} must be a stable path segment`);
  }

  if (path.isAbsolute(token) || token.includes("/") || token.includes("\\")) {
    throw new Error(`${label} must be a single relative path segment`);
  }

  if (token.includes(":") || token.includes("\0")) {
    throw new Error(`${label} contains unsupported path characters`);
  }

  return token;
}

export function resolveWorkspacePath(rootInput: WorkspaceRootInput, ...segments: string[]): string {
  const root = toAbsoluteWorkspaceRoot(rootInput);

  if (segments.length === 0) {
    return root;
  }

  const candidate = path.resolve(root, ...segments);
  return ensureInsideRoot(root, candidate, "Workspace path");
}

export function createWorkspaceLayout(rootInput: WorkspaceRootInput): WorkspaceLayout {
  const root = toAbsoluteWorkspaceRoot(rootInput);

  return {
    root,
    framework: resolveWorkspacePath(root, ".generic-ai"),
    agents: resolveWorkspacePath(root, ".generic-ai", "agents"),
    plugins: resolveWorkspacePath(root, ".generic-ai", "plugins"),
    skills: resolveWorkspacePath(root, ".agents", "skills"),
    workspace: resolveWorkspacePath(root, "workspace"),
    workspaceAgents: resolveWorkspacePath(root, "workspace", "agents"),
    shared: resolveWorkspacePath(root, "workspace", "shared"),
  };
}

export function createAgentWorkspaceLayout(
  rootInput: WorkspaceRootInput,
  agentId: string,
): AgentWorkspaceLayout {
  const layout = createWorkspaceLayout(rootInput);
  const safeAgentId = assertWorkspaceToken(agentId, "agentId");
  const root = resolveWorkspacePath(layout.workspaceAgents, safeAgentId);

  return {
    root,
    memory: resolveWorkspacePath(root, "memory"),
    results: resolveWorkspacePath(root, "results"),
  };
}

async function ensureDirectories(directories: readonly string[]): Promise<void> {
  await Promise.all(directories.map(async (directory) => mkdir(directory, { recursive: true })));
}

export async function ensureRecommendedWorkspaceStructure(
  rootInput: WorkspaceRootInput,
): Promise<WorkspaceLayout> {
  const layout = createWorkspaceLayout(rootInput);

  await ensureDirectories([
    layout.framework,
    layout.agents,
    layout.plugins,
    layout.skills,
    layout.workspace,
    layout.workspaceAgents,
    layout.shared,
  ]);

  return layout;
}

export async function ensureAgentWorkspaceStructure(
  rootInput: WorkspaceRootInput,
  agentId: string,
): Promise<AgentWorkspaceLayout> {
  const layout = createAgentWorkspaceLayout(rootInput, agentId);

  await ensureDirectories([layout.root, layout.memory, layout.results]);

  return layout;
}

export function createWorkspaceFs(rootInput: WorkspaceRootInput): WorkspaceFs {
  const layout = createWorkspaceLayout(rootInput);

  return {
    root: layout.root,
    layout,
    resolvePath: (...segments: string[]) => resolveWorkspacePath(layout.root, ...segments),
    resolveAgentPath: (agentId: string, ...segments: string[]) => {
      const agentLayout = createAgentWorkspaceLayout(layout.root, agentId);
      return segments.length === 0
        ? agentLayout.root
        : resolveWorkspacePath(agentLayout.root, ...segments);
    },
    createAgentWorkspaceLayout: (agentId: string) => createAgentWorkspaceLayout(layout.root, agentId),
    ensureLayout: () => ensureRecommendedWorkspaceStructure(layout.root),
    ensureAgentWorkspaceLayout: (agentId: string) => ensureAgentWorkspaceStructure(layout.root, agentId),
  };
}

