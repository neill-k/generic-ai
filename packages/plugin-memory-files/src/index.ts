import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createWorkspaceFs,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";

export const name = "@generic-ai/plugin-memory-files" as const;
export const kind = "memory-files" as const;

export interface MemoryEntryInput {
  readonly id?: string;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryEntry {
  readonly id: string;
  readonly agentId: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemorySearchResult {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matches: readonly string[];
}

export interface FileMemoryStoreOptions {
  readonly root: WorkspaceRootInput;
  readonly idFactory?: () => string;
  readonly now?: () => string | number | Date;
}

export interface FileMemoryStore {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  remember(agentId: string, entry: MemoryEntryInput): Promise<MemoryEntry>;
  get(agentId: string, id: string): Promise<MemoryEntry | undefined>;
  list(agentId: string): Promise<readonly MemoryEntry[]>;
  search(agentId: string, query: string, limit?: number): Promise<readonly MemorySearchResult[]>;
  forget(agentId: string, id: string): Promise<boolean>;
}

function normalizeTimestamp(value: FileMemoryStoreOptions["now"]): string {
  const current = value?.() ?? Date.now();
  const date = current instanceof Date ? current : new Date(current);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("FileMemoryStoreOptions.now() must return a valid date-like value.");
  }

  return date.toISOString();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

function scoreEntry(entry: MemoryEntry, queryTokens: readonly string[]): MemorySearchResult | undefined {
  const haystack = `${entry.text}\n${entry.tags.join(" ")}`.toLowerCase();
  const matches = queryTokens.filter((token) => haystack.includes(token));

  if (matches.length === 0) {
    return undefined;
  }

  return {
    entry,
    score: matches.length,
    matches,
  };
}

export function createFileMemoryStore(options: FileMemoryStoreOptions): FileMemoryStore {
  const workspace = createWorkspaceFs(options.root);
  const idFactory = options.idFactory ?? randomUUID;

  function memoryDirectory(agentId: string): string {
    return workspace.createAgentWorkspaceLayout(agentId).memory;
  }

  function memoryFilePath(agentId: string, id: string): string {
    return path.join(memoryDirectory(agentId), `${encodeURIComponent(id)}.json`);
  }

  async function readEntry(agentId: string, id: string): Promise<MemoryEntry | undefined> {
    try {
      const raw = await readFile(memoryFilePath(agentId, id), "utf8");
      return JSON.parse(raw) as MemoryEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async function loadEntries(agentId: string): Promise<MemoryEntry[]> {
    try {
      const files = await readdir(memoryDirectory(agentId));
      const entries = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const raw = await readFile(path.join(memoryDirectory(agentId), file), "utf8");
            return JSON.parse(raw) as MemoryEntry;
          }),
      );

      return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  return Object.freeze({
    name,
    kind,
    root: workspace.root,
    async remember(agentId: string, entry: MemoryEntryInput): Promise<MemoryEntry> {
      const id = entry.id ?? idFactory();
      const existing = await readEntry(agentId, id);
      const timestamp = normalizeTimestamp(options.now);
      const record: MemoryEntry = Object.freeze({
        id,
        agentId,
        text: entry.text,
        tags: [...(entry.tags ?? [])],
        metadata: {
          ...(entry.metadata ?? {}),
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });

      await workspace.ensureAgentWorkspaceLayout(agentId);
      await mkdir(memoryDirectory(agentId), { recursive: true });
      await writeFile(memoryFilePath(agentId, id), JSON.stringify(record, undefined, 2), "utf8");
      return record;
    },
    async get(agentId: string, id: string): Promise<MemoryEntry | undefined> {
      return readEntry(agentId, id);
    },
    async list(agentId: string): Promise<readonly MemoryEntry[]> {
      return loadEntries(agentId);
    },
    async search(agentId: string, query: string, limit = 5): Promise<readonly MemorySearchResult[]> {
      const queryTokens = tokenize(query);
      const entries = await loadEntries(agentId);

      return entries
        .map((entry) => scoreEntry(entry, queryTokens))
        .filter((result): result is MemorySearchResult => result !== undefined)
        .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
        .slice(0, limit);
    },
    async forget(agentId: string, id: string): Promise<boolean> {
      try {
        await rm(memoryFilePath(agentId, id), { force: false });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }

        throw error;
      }
    },
  });
}
