import type { PiCapabilityBindings } from "@generic-ai/core";
import { interceptToolExecute, wrapToolBindings } from "@generic-ai/plugin-approvals";
import { getAgentHarnessToolEffects, type StorageContract } from "@generic-ai/sdk";

import { DEFAULT_SHELL_HOSTS, normalizeHostPattern } from "./egress.js";
import type { RefusalLog } from "./refusals.js";

/**
 * The owner's permissions (design decisions 37–39, 41).
 *
 * The owner sets broad categories of action once. An agent action outside them is refused on the
 * spot: the tool call fails with the reason, the agent finds another route, and the refusal is
 * logged to the refused-actions list. Nothing ever waits for the owner.
 *
 * Permissions and the owner's standing rules live in the host's storage, which agents cannot
 * reach: no agent tool writes them, and only the owner's API does. Later background work (memory
 * consolidation, "dreaming") gets no route to them either.
 */
export interface CompanyPermissions {
  /** Read outside systems: connector reads and the web tools. On by default. */
  readonly readOutside: boolean;
  /** Send messages on the owner's behalf (email, chat, posts, invites). Off by default. */
  readonly sendMessages: boolean;
  /** Spend money or commit to a purchase. Off by default. */
  readonly spendMoney: boolean;
  /** Create, change or delete records in outside systems, beyond the GitHub rules. Off. */
  readonly writeOutside: boolean;
  readonly github: GithubPermissions;
  /** Hosts agent shell commands may reach (see egress.ts). `*.` matches subdomains. */
  readonly shellHosts: readonly string[];
  /** The owner's standing rules, given to every agent at the start of every turn. */
  readonly standingRules: readonly string[];
}

/**
 * GitHub writes, scoped to repositories the owner picks (decision 39). Agents may read any repo
 * a connector can see; these cover writing.
 */
export interface GithubPermissions {
  /** `owner/name` repositories agents may write to. */
  readonly repos: readonly string[];
  /** Create branches and push commits (never to the default branch through a merge tool). */
  readonly push: boolean;
  readonly openPullRequests: boolean;
  /** Merge pull requests, and only when their checks are green. */
  readonly merge: boolean;
}

export interface StoredPermissions extends CompanyPermissions {
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export const DEFAULT_PERMISSIONS: CompanyPermissions = Object.freeze({
  readOutside: true,
  sendMessages: false,
  spendMoney: false,
  writeOutside: false,
  github: Object.freeze({ repos: [], push: true, openPullRequests: true, merge: true }),
  shellHosts: DEFAULT_SHELL_HOSTS,
  standingRules: [],
});

export class PermissionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionsError";
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RULES = 50;
const MAX_RULE_CHARS = 1000;

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new PermissionsError(`${key} must be true or false.`);
  }
  return value;
}

function readStrings(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PermissionsError(`${key} must be a list of strings.`);
  }
  return value as string[];
}

/**
 * Checks permissions from the owner or the company config. Missing fields keep `base`'s values,
 * so a partial update changes only what it names.
 */
export function parsePermissions(
  input: unknown,
  base: CompanyPermissions = DEFAULT_PERMISSIONS,
): CompanyPermissions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PermissionsError("Permissions must be an object.");
  }
  const record = input as Record<string, unknown>;
  const known = new Set([
    "readOutside",
    "sendMessages",
    "spendMoney",
    "writeOutside",
    "github",
    "shellHosts",
    "standingRules",
    "updatedAt",
    "updatedBy",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new PermissionsError(`Unknown permission "${key}".`);
    }
  }
  let github = base.github;
  if (record["github"] !== undefined) {
    const raw = record["github"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PermissionsError("github must be an object.");
    }
    const githubRecord = raw as Record<string, unknown>;
    const repos = readStrings(githubRecord, "repos")?.map((repo) => repo.trim()) ?? github.repos;
    for (const repo of repos) {
      if (!REPO.test(repo)) {
        throw new PermissionsError(`"${repo}" is not a repository; use owner/name.`);
      }
    }
    github = {
      repos: [...new Set(repos.map((repo) => repo.toLowerCase()))],
      push: readBoolean(githubRecord, "push", github.push),
      openPullRequests: readBoolean(githubRecord, "openPullRequests", github.openPullRequests),
      merge: readBoolean(githubRecord, "merge", github.merge),
    };
  }
  let shellHosts = base.shellHosts;
  const hosts = readStrings(record, "shellHosts");
  if (hosts !== undefined) {
    try {
      shellHosts = [
        ...new Set(hosts.filter((host) => host.trim().length > 0).map(normalizeHostPattern)),
      ];
    } catch (error) {
      throw new PermissionsError(error instanceof Error ? error.message : String(error));
    }
  }
  let standingRules = base.standingRules;
  const rules = readStrings(record, "standingRules");
  if (rules !== undefined) {
    standingRules = rules.map((rule) => rule.trim()).filter((rule) => rule.length > 0);
    if (standingRules.length > MAX_RULES) {
      throw new PermissionsError(`Keep standing rules to ${MAX_RULES} or fewer.`);
    }
    if (standingRules.some((rule) => rule.length > MAX_RULE_CHARS)) {
      throw new PermissionsError(`Each standing rule is limited to ${MAX_RULE_CHARS} characters.`);
    }
  }
  return {
    readOutside: readBoolean(record, "readOutside", base.readOutside),
    sendMessages: readBoolean(record, "sendMessages", base.sendMessages),
    spendMoney: readBoolean(record, "spendMoney", base.spendMoney),
    writeOutside: readBoolean(record, "writeOutside", base.writeOutside),
    github,
    shellHosts,
    standingRules,
  };
}

// ---------------------------------------------------------------------------
// Deciding a tool call
// ---------------------------------------------------------------------------

export type PermissionCategory =
  | "read-outside"
  | "send-messages"
  | "spend-money"
  | "write-outside"
  | "github";

export interface PermissionSubject {
  readonly toolName: string;
  readonly effects: readonly string[];
  /** The MCP server a connector tool comes from. */
  readonly serverId?: string;
  /** The tool's own name on that server. */
  readonly serverToolName?: string;
  readonly input?: unknown;
}

export type PermissionVerdict =
  | { readonly allowed: true; readonly category?: PermissionCategory }
  | { readonly allowed: false; readonly category: PermissionCategory; readonly reason: string };

/** Effects that read from outside the company. */
const READ_EFFECTS = new Set(["mcp.read", "web.read", "web.search", "network.egress"]);
const WRITE_EFFECTS = new Set(["external.write", "mcp.write"]);

export type GithubAction = "push" | "open-pull-request" | "merge" | "other";

/** What a GitHub connector tool does, from its name. */
export function githubAction(toolName: string): GithubAction {
  const name = toolName.toLowerCase();
  if (name.includes("merge")) {
    return "merge";
  }
  if (/pull_?request/.test(name) && /(create|open|update)/.test(name)) {
    return "open-pull-request";
  }
  if (/(push|create_branch|create_or_update_file|delete_file|commit)/.test(name)) {
    return "push";
  }
  return "other";
}

/** The `owner/name` repository a GitHub tool call targets, if its input says. */
export function githubRepoOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (typeof record["owner"] === "string" && typeof record["repo"] === "string") {
    return `${record["owner"]}/${record["repo"]}`.toLowerCase();
  }
  for (const key of ["repository", "repo", "full_name"]) {
    const value = record[key];
    if (typeof value === "string" && REPO.test(value)) {
      return value.toLowerCase();
    }
  }
  return undefined;
}

const OWNER_HINT = "Find another way to reach the goal; do not ask the owner to do it for you.";

function refused(category: PermissionCategory, reason: string): PermissionVerdict {
  return { allowed: false, category, reason };
}

/** Decides one tool call against the owner's permissions. */
export function decidePermission(
  permissions: CompanyPermissions,
  subject: PermissionSubject,
): PermissionVerdict {
  const effects = new Set(subject.effects);
  if (effects.has("payment.spend") && !permissions.spendMoney) {
    return refused("spend-money", "the owner has not allowed spending money");
  }
  if (effects.has("message.send") && !permissions.sendMessages) {
    return refused("send-messages", "the owner has not allowed sending messages on their behalf");
  }
  const writes = [...effects].some((effect) => WRITE_EFFECTS.has(effect));
  if (writes) {
    if (subject.serverId === "github") {
      const action = githubAction(subject.serverToolName ?? subject.toolName);
      if (action !== "other") {
        const repo = githubRepoOf(subject.input);
        if (repo === undefined || !permissions.github.repos.includes(repo)) {
          return refused(
            "github",
            repo === undefined
              ? "the call does not name a repository the owner opened for writing"
              : `the owner has not opened ${repo} for agents to write to`,
          );
        }
        const allowed =
          action === "push"
            ? permissions.github.push
            : action === "open-pull-request"
              ? permissions.github.openPullRequests
              : permissions.github.merge;
        if (!allowed) {
          return refused(
            "github",
            `the owner has not allowed agents to ${action.replace(/-/g, " ")} in GitHub`,
          );
        }
        return { allowed: true, category: "github" };
      }
    }
    if (!permissions.writeOutside) {
      return refused("write-outside", "the owner has not allowed writing to outside systems");
    }
    return { allowed: true, category: "write-outside" };
  }
  const reads = [...effects].some((effect) => READ_EFFECTS.has(effect));
  if (reads && !permissions.readOutside && !effects.has("process.spawn")) {
    return refused("read-outside", "the owner has not allowed reading outside systems");
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// The host-only store
// ---------------------------------------------------------------------------

export const PERMISSIONS_NAMESPACE = "generic-corp-owner";
const SETTINGS_COLLECTION = "settings";
const PERMISSIONS_ID = "permissions";

export interface PermissionStore {
  /** The permissions in force. Synchronous: tool calls read it on every call. */
  current(): StoredPermissions;
  /** Whether the owner has saved permissions (otherwise the company config's apply). */
  saved(): boolean;
  /** Saves the owner's change. Only the owner's API calls this. */
  update(input: unknown, updatedBy: string): Promise<StoredPermissions>;
  /** Forgets the owner's permissions; the company config's apply again. */
  reset(): Promise<StoredPermissions>;
}

/**
 * Opens the permission store. `defaults` come from the company config; the owner's saved
 * permissions replace them. Read once at start and cached; every change goes through `update`.
 */
export async function openPermissionStore(
  kv: StorageContract,
  defaults: CompanyPermissions = DEFAULT_PERMISSIONS,
  now: () => Date = () => new Date(),
): Promise<PermissionStore> {
  const key = {
    namespace: PERMISSIONS_NAMESPACE,
    collection: SETTINGS_COLLECTION,
    id: PERMISSIONS_ID,
  };
  const record = await kv.get<StoredPermissions>(key);
  let saved = record !== undefined;
  let current: StoredPermissions = defaults;
  if (record !== undefined) {
    try {
      current = {
        ...parsePermissions(record.value, defaults),
        ...(record.value.updatedAt === undefined ? {} : { updatedAt: record.value.updatedAt }),
        ...(record.value.updatedBy === undefined ? {} : { updatedBy: record.value.updatedBy }),
      };
    } catch {
      // Damaged settings fall back to the company config rather than opening anything up.
      saved = false;
    }
  }
  return {
    current: () => current,
    saved: () => saved,
    async update(input, updatedBy) {
      const {
        updatedAt: _ignoredAt,
        updatedBy: _ignoredBy,
        ...rest
      } = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
      const next: StoredPermissions = {
        ...parsePermissions(typeof input === "object" && input !== null ? rest : input, current),
        updatedAt: now().toISOString(),
        updatedBy,
      };
      await kv.set({ key, value: next, updatedAt: next.updatedAt as string });
      current = next;
      saved = true;
      return next;
    },
    async reset() {
      await kv.delete(key);
      current = defaults;
      saved = false;
      return current;
    },
  };
}

// ---------------------------------------------------------------------------
// The gate on an agent's tools
// ---------------------------------------------------------------------------

export interface PermissionGateOptions {
  readonly permissions: () => CompanyPermissions;
  readonly refusals: RefusalLog;
  readonly agentId: string;
  readonly taskId?: string;
  /**
   * Confirms a pull request's checks are green before a merge runs. Without one, merges are
   * refused, since nothing can confirm the checks.
   */
  readonly verifyGreenChecks?: (input: unknown) => Promise<boolean>;
}

interface McpToolMetadata {
  readonly serverId?: string;
  readonly toolName?: string;
}

function mcpMetadata(tool: unknown): McpToolMetadata | undefined {
  const mcp = (tool as { mcp?: unknown }).mcp;
  return typeof mcp === "object" && mcp !== null ? (mcp as McpToolMetadata) : undefined;
}

/** Wraps an agent's tools so each call is checked against the owner's permissions first. */
export function gateToolsWithPermissions(
  bindings: PiCapabilityBindings,
  options: PermissionGateOptions,
): PiCapabilityBindings {
  const wrap = <TTool>(tool: TTool): TTool =>
    interceptToolExecute(tool, async (raw, args, execute) => {
      const toolName = raw.name?.trim() || "unknown-tool";
      const mcp = mcpMetadata(raw);
      const input = args[1];
      const subject: PermissionSubject = {
        toolName,
        effects: getAgentHarnessToolEffects(raw),
        ...(mcp?.serverId === undefined ? {} : { serverId: mcp.serverId }),
        ...(mcp?.toolName === undefined ? {} : { serverToolName: mcp.toolName }),
        input,
      };
      let verdict = decidePermission(options.permissions(), subject);
      if (
        verdict.allowed &&
        verdict.category === "github" &&
        githubAction(subject.serverToolName ?? toolName) === "merge"
      ) {
        const green =
          options.verifyGreenChecks === undefined ? false : await options.verifyGreenChecks(input);
        if (!green) {
          verdict = refused(
            "github",
            options.verifyGreenChecks === undefined
              ? "merges need confirmed green checks, and nothing can confirm them yet"
              : "the pull request's checks are not all green",
          );
        }
      }
      if (verdict.allowed) {
        return execute();
      }
      await options.refusals
        .record({
          kind: "permission",
          agentId: options.agentId,
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
          category: verdict.category,
          action: toolName,
          reason: verdict.reason,
        })
        .catch(() => undefined);
      throw new Error(`Refused: ${verdict.reason}. ${OWNER_HINT}`);
    });
  return wrapToolBindings(
    bindings as Parameters<typeof wrapToolBindings>[0],
    wrap,
  ) as PiCapabilityBindings;
}

/**
 * The block every agent turn starts with: the owner's standing rules and what is off, so agents
 * do not waste steps on actions that would be refused.
 */
export function permissionsBriefing(permissions: CompanyPermissions): string {
  const off: string[] = [];
  if (!permissions.sendMessages) off.push("sending messages on the owner's behalf");
  if (!permissions.spendMoney) off.push("spending money");
  if (!permissions.writeOutside) off.push("writing to outside systems");
  if (!permissions.readOutside) off.push("reading outside systems");
  const lines = ["## The owner's permissions and standing rules", ""];
  if (off.length > 0) {
    lines.push(`Not allowed: ${off.join(", ")}. Such calls are refused; find another route.`);
  }
  if (permissions.github.repos.length > 0) {
    const can = [
      permissions.github.push ? "push branches" : undefined,
      permissions.github.openPullRequests ? "open pull requests" : undefined,
      permissions.github.merge ? "merge pull requests with green checks" : undefined,
    ].filter((entry) => entry !== undefined);
    lines.push(
      `GitHub: you may ${can.length > 0 ? can.join(", ") : "read only"} in ${permissions.github.repos.join(", ")}.`,
    );
  }
  lines.push(
    "Shell commands reach only package registries and GitHub; read web pages with the web tools.",
  );
  if (permissions.standingRules.length > 0) {
    lines.push("", "Standing rules from the owner:");
    for (const rule of permissions.standingRules) {
      lines.push(`- ${rule}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
