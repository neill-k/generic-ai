import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Awaitable, JsonValue, StorageContract } from "@generic-ai/sdk";

const execFileAsync = promisify(execFile);

/**
 * Persistent agents (roadmap R8).
 *
 * An agent is a durable record in an org chart: who it is, whom it reports
 * to, which model and instructions it runs with, and where its memory file
 * and workspace live. Records are seeded from config and survive restarts;
 * the memory file and workspace survive across runs, so an agent picks up
 * where it left off.
 */
export type PersistentAgentStatus = "active" | "retired";

export type AgentWorkspaceMode = "directory" | "git-worktree";

export interface PersistentAgentRecord {
  readonly id: string;
  /** Org-chart role, for example `ceo`, `vp-research`, or `analyst`. */
  readonly role: string;
  readonly title?: string;
  /** Id of the agent this one reports to. Omit for the top of the org chart. */
  readonly reportsTo?: string;
  readonly instructions?: string;
  readonly model?: string;
  /** Harness role kind: `builder` (the default) or `custom`. Every agent gets its full tool set. */
  readonly roleKind?: string;
  /** The agent's home directory. Holds the memory file and the workspace. */
  readonly homePath: string;
  /** The agent's memory file, owned and edited by the agent. */
  readonly memoryPath: string;
  /** The agent's working directory (a plain directory or a git worktree). */
  readonly workspacePath: string;
  readonly workspaceMode: AgentWorkspaceMode;
  readonly status: PersistentAgentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** Config-level definition of an agent, for example from YAML. */
export interface PersistentAgentSeed {
  readonly id: string;
  readonly role: string;
  readonly title?: string;
  readonly reportsTo?: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly roleKind?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** Minimal persistence the directory needs. */
export interface AgentRecordStore {
  get(id: string): Awaitable<PersistentAgentRecord | undefined>;
  put(record: PersistentAgentRecord): Awaitable<void>;
  list(): Awaitable<readonly PersistentAgentRecord[]>;
}

/** Stores agent records in an SDK `StorageContract` (for example Postgres key-value storage). */
export function createStorageAgentStore(
  storage: StorageContract,
  options: { readonly namespace?: string; readonly collection?: string } = {},
): AgentRecordStore {
  const namespace = options.namespace ?? "generic-ai";
  const collection = options.collection ?? "agents";
  return {
    async get(id) {
      const record = await storage.get<PersistentAgentRecord>({ namespace, collection, id });
      return record?.value;
    },
    async put(record) {
      await storage.set({
        key: { namespace, collection, id: record.id },
        value: record,
        updatedAt: record.updatedAt,
      });
    },
    async list() {
      const records = await storage.list({ namespace, collection });
      return records.map((record) => record.value as PersistentAgentRecord);
    },
  };
}

/** The key-value namespace shape shared by the SQLite and in-memory storage plugins. */
export interface KeyValueNamespaceLike {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): unknown;
  values<T = unknown>(): T[];
}

/** Stores agent records in a SQLite or in-memory storage namespace. */
export function createNamespaceAgentStore(namespace: KeyValueNamespaceLike): AgentRecordStore {
  return {
    get: (id) => namespace.get<PersistentAgentRecord>(id),
    put: (record) => {
      namespace.set(record.id, record);
    },
    list: () => namespace.values<PersistentAgentRecord>(),
  };
}

/** Process-local store, for tests and demos. */
export function createMemoryAgentStore(): AgentRecordStore {
  const records = new Map<string, PersistentAgentRecord>();
  return {
    get: (id) => records.get(id),
    put: (record) => {
      records.set(record.id, record);
    },
    list: () => [...records.values()],
  };
}

export interface AgentWorkspaceOptions {
  /** Defaults to `directory`. */
  readonly mode?: AgentWorkspaceMode;
  /** Git repository to add worktrees to when `mode` is `git-worktree`. */
  readonly repository?: string;
  /** Branch prefix for agent worktrees. Defaults to `agent/`. */
  readonly branchPrefix?: string;
  /** Commit-ish new agent branches start from. Defaults to `HEAD`. */
  readonly baseRef?: string;
}

export interface CreateAgentDirectoryOptions {
  readonly store: AgentRecordStore;
  /** Root directory under which each agent gets `<root>/<agentId>/`. */
  readonly root: string;
  readonly workspace?: AgentWorkspaceOptions;
  readonly now?: () => Date;
}

export interface SeedAgentsResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly retired: readonly string[];
}

export interface AgentDirectory {
  readonly root: string;
  /**
   * Upserts agents from config. Existing agents keep their memory and
   * workspace; config fields are refreshed. Agents missing from the seed are
   * retired unless `retireMissing` is false.
   */
  seed(
    seeds: readonly PersistentAgentSeed[],
    options?: { readonly retireMissing?: boolean },
  ): Promise<SeedAgentsResult>;
  get(id: string): Promise<PersistentAgentRecord | undefined>;
  require(id: string): Promise<PersistentAgentRecord>;
  list(options?: { readonly includeRetired?: boolean }): Promise<readonly PersistentAgentRecord[]>;
  /** Agents that report directly to `id`. */
  directReports(id: string): Promise<readonly PersistentAgentRecord[]>;
  /** The management chain above `id`, nearest first. */
  managementChain(id: string): Promise<readonly PersistentAgentRecord[]>;
  /** Creates the agent's home, memory file, and workspace if they are missing. */
  ensureWorkspace(id: string): Promise<PersistentAgentRecord>;
  readMemory(id: string): Promise<string>;
  writeMemory(id: string, contents: string): Promise<void>;
  appendMemory(id: string, entry: string): Promise<void>;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEMORY_FILE = "context.md";
const WORKSPACE_DIR = "workspace";

export function isValidAgentId(id: string): boolean {
  return AGENT_ID_PATTERN.test(id) && !id.includes("..");
}

export function createAgentDirectory(options: CreateAgentDirectoryOptions): AgentDirectory {
  const root = path.resolve(options.root);
  const now = options.now ?? (() => new Date());
  const workspaceMode = options.workspace?.mode ?? "directory";
  if (workspaceMode === "git-worktree" && options.workspace?.repository === undefined) {
    throw new TypeError("Agent workspaces in git-worktree mode need a repository path.");
  }

  const homeOf = (id: string) => path.join(root, id);

  async function require(id: string): Promise<PersistentAgentRecord> {
    const record = await options.store.get(id);
    if (record === undefined) {
      throw new Error(`Unknown agent "${id}".`);
    }
    return record;
  }

  function validateSeeds(seeds: readonly PersistentAgentSeed[]): void {
    const ids = new Set<string>();
    for (const seed of seeds) {
      if (!isValidAgentId(seed.id)) {
        throw new TypeError(
          `Agent id "${seed.id}" must be 1-128 letters, digits, dots, dashes, or underscores.`,
        );
      }
      if (ids.has(seed.id)) {
        throw new TypeError(`Agent id "${seed.id}" is declared more than once.`);
      }
      if (typeof seed.role !== "string" || seed.role.trim().length === 0) {
        throw new TypeError(`Agent "${seed.id}" needs a role.`);
      }
      ids.add(seed.id);
    }
    const byId = new Map(seeds.map((seed) => [seed.id, seed]));
    for (const seed of seeds) {
      if (seed.reportsTo === undefined) {
        continue;
      }
      if (!byId.has(seed.reportsTo)) {
        throw new TypeError(`Agent "${seed.id}" reports to unknown agent "${seed.reportsTo}".`);
      }
      const seen = new Set<string>([seed.id]);
      let cursor = byId.get(seed.reportsTo);
      while (cursor !== undefined) {
        if (seen.has(cursor.id)) {
          throw new TypeError(`The org chart has a reporting cycle through "${seed.id}".`);
        }
        seen.add(cursor.id);
        cursor = cursor.reportsTo === undefined ? undefined : byId.get(cursor.reportsTo);
      }
    }
  }

  async function provisionWorkspace(record: PersistentAgentRecord): Promise<void> {
    await mkdir(record.homePath, { recursive: true });
    if (!(await exists(record.memoryPath))) {
      await writeFile(
        record.memoryPath,
        [
          `# ${record.title ?? record.role} (${record.id})`,
          "",
          "This is your memory file. It persists across tasks. Keep it short and current:",
          "what you are responsible for, decisions you made, and what you learned.",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    if (await exists(record.workspacePath)) {
      return;
    }
    if (record.workspaceMode === "git-worktree") {
      const repository = options.workspace?.repository as string;
      const branch = `${options.workspace?.branchPrefix ?? "agent/"}${record.id}`;
      const baseRef = options.workspace?.baseRef ?? "HEAD";
      const branchExists = await git(repository, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]).then(
        () => true,
        () => false,
      );
      await git(
        repository,
        branchExists
          ? ["worktree", "add", record.workspacePath, branch]
          : ["worktree", "add", "-b", branch, record.workspacePath, baseRef],
      );
      return;
    }
    await mkdir(record.workspacePath, { recursive: true });
  }

  const directory: AgentDirectory = {
    root,
    async seed(seeds, seedOptions = {}) {
      validateSeeds(seeds);
      const created: string[] = [];
      const updated: string[] = [];
      const retired: string[] = [];
      const timestamp = now().toISOString();
      const existing = new Map((await options.store.list()).map((record) => [record.id, record]));
      for (const seed of seeds) {
        const previous = existing.get(seed.id);
        const homePath = previous?.homePath ?? homeOf(seed.id);
        const record: PersistentAgentRecord = {
          id: seed.id,
          role: seed.role,
          ...(seed.title === undefined ? {} : { title: seed.title }),
          ...(seed.reportsTo === undefined ? {} : { reportsTo: seed.reportsTo }),
          ...(seed.instructions === undefined ? {} : { instructions: seed.instructions }),
          ...(seed.model === undefined ? {} : { model: seed.model }),
          ...(seed.roleKind === undefined ? {} : { roleKind: seed.roleKind }),
          homePath,
          memoryPath: previous?.memoryPath ?? path.join(homePath, MEMORY_FILE),
          workspacePath: previous?.workspacePath ?? path.join(homePath, WORKSPACE_DIR),
          workspaceMode: previous?.workspaceMode ?? workspaceMode,
          status: "active",
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
          ...(seed.metadata === undefined ? {} : { metadata: seed.metadata }),
        };
        if (previous === undefined) {
          created.push(seed.id);
        } else if (!sameConfig(previous, record)) {
          updated.push(seed.id);
        } else {
          continue;
        }
        await options.store.put(record);
        await provisionWorkspace(record);
      }
      if (seedOptions.retireMissing !== false) {
        const seeded = new Set(seeds.map((seed) => seed.id));
        for (const record of existing.values()) {
          if (!seeded.has(record.id) && record.status === "active") {
            await options.store.put({ ...record, status: "retired", updatedAt: timestamp });
            retired.push(record.id);
          }
        }
      }
      return { created, updated, retired };
    },
    async get(id) {
      return options.store.get(id);
    },
    require,
    async list(listOptions = {}) {
      const records = await options.store.list();
      return records
        .filter((record) => listOptions.includeRetired === true || record.status === "active")
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    async directReports(id) {
      const records = await directory.list();
      return records.filter((record) => record.reportsTo === id);
    },
    async managementChain(id) {
      const chain: PersistentAgentRecord[] = [];
      const seen = new Set<string>([id]);
      let cursor = (await require(id)).reportsTo;
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        const manager = await options.store.get(cursor);
        if (manager === undefined) {
          break;
        }
        chain.push(manager);
        cursor = manager.reportsTo;
      }
      return chain;
    },
    async ensureWorkspace(id) {
      const record = await require(id);
      await provisionWorkspace(record);
      return record;
    },
    async readMemory(id) {
      const record = await require(id);
      try {
        return await readFile(record.memoryPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return "";
        }
        throw error;
      }
    },
    async writeMemory(id, contents) {
      const record = await require(id);
      await mkdir(record.homePath, { recursive: true });
      await writeFile(record.memoryPath, contents, "utf8");
    },
    async appendMemory(id, entry) {
      const current = await directory.readMemory(id);
      const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
      await directory.writeMemory(id, `${current}${separator}${entry.trimEnd()}\n`);
    },
  };
  return directory;
}

function sameConfig(left: PersistentAgentRecord, right: PersistentAgentRecord): boolean {
  return (
    left.status === right.status &&
    left.role === right.role &&
    left.title === right.title &&
    left.reportsTo === right.reportsTo &&
    left.instructions === right.instructions &&
    left.model === right.model &&
    left.roleKind === right.roleKind &&
    JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null)
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    windowsHide: true,
  });
  return stdout;
}
