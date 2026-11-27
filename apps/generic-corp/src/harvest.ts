import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { isScriptPath, type PiCapabilityBindings } from "@generic-ai/core";
import type { AgentTaskExecutionInput, StorageContract } from "@generic-ai/sdk";

import { MEMORY_NAMESPACE } from "./memory.js";

/**
 * Script harvesting for Generic Corp (design decision 28, NOVA's offloading principle).
 *
 * While an agent works on a task, the scripts it writes with `write` and `edit` are noted. When
 * the task is accepted (its goal's checks passed), those scripts are copied to a host-owned folder
 * outside the company folder, with their checksum, so a later edit by the agent cannot change what
 * was harvested. Scripts from tasks that fail or are cancelled are dropped. Dreaming reads the
 * harvest and turns a script worth keeping into a saved procedure (a skill) in the agent's memory.
 */
export interface HarvestedScript {
  readonly id: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly rootTaskId: string;
  /** Where the agent wrote it, relative to the company root. */
  readonly sourcePath: string;
  readonly fileName: string;
  /** Where the copy is kept, outside the company folder. */
  readonly savedPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly harvestedAt: string;
}

export interface CompanyHarvest {
  /** Wraps a turn's file tools so the scripts it writes are noted against its task. */
  wrapBindings(
    bindings: PiCapabilityBindings,
    input: AgentTaskExecutionInput,
  ): PiCapabilityBindings;
  /** Saves the scripts a task wrote, once its work was accepted. */
  taskSucceeded(task: {
    readonly taskId: string;
    readonly rootTaskId: string;
    readonly agentId: string;
  }): Promise<readonly HarvestedScript[]>;
  /** Drops what a failed or cancelled task wrote. */
  taskEnded(taskId: string): Promise<void>;
  list(filter?: {
    readonly agentId?: string;
    readonly since?: string;
  }): Promise<readonly HarvestedScript[]>;
  get(id: string): Promise<HarvestedScript | undefined>;
  read(id: string): Promise<string | undefined>;
}

export interface CompanyHarvestOptions {
  readonly kv: StorageContract;
  /** The company root agent tools work from; written paths are resolved against it. */
  readonly companyRoot: string;
  /** Where harvested copies are kept. Must be outside the company root. */
  readonly root: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly isScript?: (relativePath: string) => boolean;
}

const PENDING_COLLECTION = "harvest-pending";
const SCRIPTS_COLLECTION = "harvest-scripts";
const WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_SCRIPT_BYTES = 256 * 1024;

interface ToolLike {
  readonly name?: string;
  readonly execute: (...args: never[]) => unknown;
}

function safeSegment(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 120) || "_"
  );
}

export function createCompanyHarvest(options: CompanyHarvestOptions): CompanyHarvest {
  const { kv } = options;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const isScript = options.isScript ?? isScriptPath;
  const companyRoot = path.resolve(options.companyRoot);
  const key = (collection: string, id: string) => ({ namespace: MEMORY_NAMESPACE, collection, id });
  const queues = new Map<string, Promise<unknown>>();

  /** Serializes pending-list updates per task. */
  const withTask = <T>(taskId: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(taskId) ?? Promise.resolve()).then(work, work);
    queues.set(
      taskId,
      next.catch(() => undefined),
    );
    return next;
  };

  const pending = async (taskId: string): Promise<string[]> =>
    (await kv.get<string[]>(key(PENDING_COLLECTION, taskId)))?.value ?? [];

  const note = (taskId: string, toolRoot: string, rawPath: unknown) => {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return Promise.resolve();
    }
    const absolute = path.resolve(toolRoot, rawPath);
    const relative = path.relative(companyRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
      return Promise.resolve();
    }
    if (!isScript(relative)) {
      return Promise.resolve();
    }
    return withTask(taskId, async () => {
      const list = await pending(taskId);
      if (!list.includes(relative)) {
        await kv.set({
          key: key(PENDING_COLLECTION, taskId),
          value: [...list, relative],
          updatedAt: now().toISOString(),
        });
      }
    });
  };

  const wrap = <T extends ToolLike>(
    tool: T,
    input: AgentTaskExecutionInput,
    toolRoot: string,
  ): T => {
    if (tool.name === undefined || !WRITE_TOOLS.has(tool.name)) {
      return tool;
    }
    const execute = tool.execute as (...args: unknown[]) => Promise<unknown>;
    return {
      ...tool,
      execute: async (...args: unknown[]) => {
        const result = (await execute.apply(tool, args)) as { isError?: boolean } | undefined;
        if (result?.isError !== true) {
          const params = args[1] as { path?: unknown } | undefined;
          await note(input.taskId, toolRoot, params?.path).catch(() => undefined);
        }
        return result;
      },
    } as T;
  };

  async function list(filter: { readonly agentId?: string; readonly since?: string } = {}) {
    const records = await kv.list({ namespace: MEMORY_NAMESPACE, collection: SCRIPTS_COLLECTION });
    return records
      .map((record) => record.value as HarvestedScript)
      .filter((script) => filter.agentId === undefined || script.agentId === filter.agentId)
      .filter((script) => filter.since === undefined || script.harvestedAt > filter.since)
      .sort((left, right) => left.harvestedAt.localeCompare(right.harvestedAt));
  }

  return {
    wrapBindings(bindings, input) {
      const record = bindings as unknown as {
        readonly fileTools?: { readonly piTools: readonly ToolLike[] };
      };
      if (record.fileTools === undefined) {
        return bindings;
      }
      return {
        ...bindings,
        fileTools: {
          ...record.fileTools,
          piTools: record.fileTools.piTools.map((tool) => wrap(tool, input, companyRoot)),
        },
      } as unknown as PiCapabilityBindings;
    },

    taskSucceeded: (task) =>
      withTask(task.taskId, async () => {
        const paths = await pending(task.taskId);
        await kv.delete(key(PENDING_COLLECTION, task.taskId));
        const existing = await list({ agentId: task.agentId });
        const saved: HarvestedScript[] = [];
        for (const relative of paths) {
          const source = path.join(companyRoot, relative);
          let content: Buffer;
          try {
            const info = await stat(source);
            if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) {
              continue;
            }
            content = await readFile(source);
          } catch {
            continue;
          }
          const sha256 = createHash("sha256").update(content).digest("hex");
          if (existing.some((script) => script.sha256 === sha256)) {
            continue;
          }
          const id = `script_${createId().slice(0, 12)}`;
          const fileName = safeSegment(path.basename(relative));
          const dir = path.join(options.root, safeSegment(task.agentId), safeSegment(task.taskId));
          await mkdir(dir, { recursive: true });
          const savedPath = path.join(dir, `${id}-${fileName}`);
          await writeFile(savedPath, content, { mode: 0o600 });
          const script: HarvestedScript = {
            id,
            agentId: task.agentId,
            taskId: task.taskId,
            rootTaskId: task.rootTaskId,
            sourcePath: relative,
            fileName,
            savedPath,
            sha256,
            bytes: content.byteLength,
            harvestedAt: now().toISOString(),
          };
          await kv.set({
            key: key(SCRIPTS_COLLECTION, id),
            value: script,
            updatedAt: script.harvestedAt,
          });
          saved.push(script);
        }
        return saved;
      }),

    taskEnded: (taskId) =>
      withTask(taskId, async () => {
        await kv.delete(key(PENDING_COLLECTION, taskId));
      }),

    list,

    async get(id) {
      return (await kv.get<HarvestedScript>(key(SCRIPTS_COLLECTION, id)))?.value;
    },

    async read(id) {
      const script = (await kv.get<HarvestedScript>(key(SCRIPTS_COLLECTION, id)))?.value;
      if (script === undefined) {
        return undefined;
      }
      try {
        return await readFile(script.savedPath, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
