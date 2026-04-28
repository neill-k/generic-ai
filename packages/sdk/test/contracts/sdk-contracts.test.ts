import { describe, expect, expectTypeOf, it } from "vitest";
import { createRegistry } from "../../src/helpers/create-registry.js";
import { createScope } from "../../src/helpers/create-scope.js";
import { defineConfigSchema } from "../../src/helpers/define-config-schema.js";
import { defineLifecycle } from "../../src/helpers/define-lifecycle.js";
import { defineMemory } from "../../src/helpers/define-memory.js";
import { defineOutputPlugin } from "../../src/helpers/define-output-plugin.js";
import { definePlugin } from "../../src/helpers/define-plugin.js";
import type { ConfigSchemaContract } from "../../src/contracts/config-schema.js";
import type {
  MemoryRecord,
  MemoryRecordInput,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryService,
} from "../../src/contracts/memory.js";
import type { OutputPluginContract } from "../../src/contracts/output.js";
import type { PluginContract, PluginRuntimeContext } from "../../src/contracts/plugin.js";
import type { QueueContract, QueueJob, QueueLease } from "../../src/contracts/queue.js";
import type { Scope } from "../../src/scope/index.js";
import type { StorageContract, StorageKey, StorageRecord } from "../../src/contracts/storage.js";
import type { WorkspaceContract } from "../../src/contracts/workspace.js";

interface SampleConfig {
  readonly greeting: string;
  readonly outputRegistry: string;
}

interface SampleRun {
  readonly message: string;
}

interface SampleOutput {
  readonly message: string;
  readonly scopeId: string;
}

function createMemoryStorage(): StorageContract {
  const records = new Map<string, StorageRecord<unknown>>();

  return {
    kind: "storage",
    driver: "memory",
    async get<TValue>(key: StorageKey) {
      return records.get(`${key.namespace}:${key.collection}:${key.id}`) as
        | StorageRecord<TValue>
        | undefined;
    },
    async set(record) {
      records.set(`${record.key.namespace}:${record.key.collection}:${record.key.id}`, record);
    },
    async delete(key) {
      return records.delete(`${key.namespace}:${key.collection}:${key.id}`);
    },
    async list(filter) {
      return Array.from(records.values()).filter((record) => {
        if (filter?.namespace !== undefined && record.key.namespace !== filter.namespace) {
          return false;
        }
        if (filter?.collection !== undefined && record.key.collection !== filter.collection) {
          return false;
        }
        if (filter?.prefix !== undefined && !record.key.id.startsWith(filter.prefix)) {
          return false;
        }

        return true;
      });
    },
    async clear(filter) {
      if (filter === undefined) {
        records.clear();
        return;
      }

      for (const [key, record] of records.entries()) {
        if (filter.namespace !== undefined && record.key.namespace !== filter.namespace) {
          continue;
        }
        if (filter.collection !== undefined && record.key.collection !== filter.collection) {
          continue;
        }
        if (filter.prefix !== undefined && !record.key.id.startsWith(filter.prefix)) {
          continue;
        }

        records.delete(key);
      }
    },
  };
}

function createMemoryQueue(): QueueContract<{ readonly scopeId: string }, { readonly ok: true }> {
  const jobs = new Map<string, QueueJob<{ readonly scopeId: string }>>();
  const leases = new Map<string, QueueLease<{ readonly scopeId: string }>>();

  return {
    kind: "queue",
    driver: "memory",
    async enqueue(job) {
      const queued = {
        id: job.id,
        name: job.name,
        payload: job.payload,
        state: job.state ?? "queued",
        attempts: job.attempts ?? 0,
        enqueuedAt: job.enqueuedAt,
        ...(job.scopeId === undefined ? {} : { scopeId: job.scopeId }),
        ...(job.availableAt === undefined ? {} : { availableAt: job.availableAt }),
        ...(job.metadata === undefined ? {} : { metadata: job.metadata }),
      } satisfies QueueJob<{ readonly scopeId: string }>;

      jobs.set(queued.id, queued);
      return queued;
    },
    async lease() {
      const next = Array.from(jobs.values()).find((job) => job.state === "queued");

      if (next === undefined) {
        return undefined;
      }

      const lease: QueueLease<{ readonly scopeId: string }> = {
        ...next,
        state: "leased",
        leaseId: `lease:${next.id}`,
        leasedAt: "2026-04-13T00:00:00.000Z",
      };

      leases.set(lease.leaseId, lease);
      jobs.set(next.id, lease);
      return lease;
    },
    async ack(leaseId) {
      leases.delete(leaseId);
    },
    async nack(leaseId) {
      const lease = leases.get(leaseId);
      if (lease !== undefined) {
        jobs.set(lease.id, { ...lease, state: "failed" });
      }
      leases.delete(leaseId);
    },
    async cancel(jobId) {
      return jobs.delete(jobId);
    },
    async size() {
      return jobs.size;
    },
  };
}

function createMemoryWorkspace(): WorkspaceContract {
  const files = new Map<string, string>();

  return {
    kind: "workspace",
    root: "/workspace",
    layout: {
      root: "/workspace",
      framework: "/workspace/.generic-ai",
      agents: "/workspace/workspace/agents",
      plugins: "/workspace/workspace/plugins",
      skills: "/workspace/.agents/skills",
      shared: "/workspace/workspace/shared",
    },
    resolvePath(...segments) {
      return ["/workspace", ...segments].join("/").replaceAll("//", "/");
    },
    async exists(path) {
      return files.has(path);
    },
    async mkdir() {
      return;
    },
    async readText(path) {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`Missing file: ${path}`);
      }

      return value;
    },
    async writeText(path, content) {
      files.set(path, content);
    },
    async readBinary(path) {
      return new TextEncoder().encode(await this.readText(path));
    },
    async writeBinary(path, content) {
      files.set(path, new TextDecoder().decode(content));
    },
    async list(path = "/workspace") {
      return Array.from(files.keys())
        .filter((entryPath) => entryPath.startsWith(path))
        .map((entryPath) => ({ path: entryPath, kind: "file" as const }));
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function createMemoryService(): MemoryService {
  const records = new Map<string, MemoryRecord>();

  function recordKey(agentId: string, id: string): string {
    return `${agentId}:${id}`;
  }

  function matchesQuery(record: MemoryRecord, query: MemorySearchQuery): boolean {
    if (query.kind !== undefined && record.kind !== query.kind) {
      return false;
    }
    if (query.tags !== undefined && !query.tags.every((tag) => record.tags.includes(tag))) {
      return false;
    }

    return true;
  }

  return defineMemory({
    capability: "memory",
    driver: "test-memory",
    async remember(agentId: string, entry: MemoryRecordInput) {
      const record: MemoryRecord = {
        id: entry.id ?? `memory-${records.size + 1}`,
        agentId,
        text: entry.text,
        tags: [...(entry.tags ?? [])],
        metadata: entry.metadata ?? {},
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
        ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }),
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        ...(entry.importance === undefined ? {} : { importance: entry.importance }),
        ...(entry.salience === undefined ? {} : { salience: entry.salience }),
        ...(entry.validFrom === undefined ? {} : { validFrom: entry.validFrom }),
        ...(entry.validTo === undefined ? {} : { validTo: entry.validTo }),
        ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
        ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
      };

      records.set(recordKey(agentId, record.id), record);
      return record;
    },
    async get(agentId: string, id: string) {
      return records.get(recordKey(agentId, id));
    },
    async list(agentId: string) {
      return Array.from(records.values()).filter((record) => record.agentId === agentId);
    },
    async search(agentId: string, query: string | MemorySearchQuery, limit = 5) {
      const searchQuery: MemorySearchQuery = typeof query === "string" ? { text: query } : query;
      const tokens = searchQuery.text.toLowerCase().split(/\W+/).filter(Boolean);

      return Array.from(records.values())
        .filter((record) => record.agentId === agentId && matchesQuery(record, searchQuery))
        .map((entry): MemorySearchResult => {
          const haystack = `${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
          const matches = tokens.filter((token) => haystack.includes(token));

          return {
            entry,
            score: matches.length,
            matches,
          };
        })
        .filter((result) => result.score > 0)
        .slice(0, searchQuery.limit ?? limit);
    },
    async forget(agentId: string, id: string) {
      return records.delete(recordKey(agentId, id));
    },
  });
}

describe("@generic-ai/sdk contracts", () => {
  it("lets a sample plugin implement the public contracts without kernel internals", async () => {
    const pluginRegistry = createRegistry<PluginContract<SampleConfig>>("plugins");
    const outputRegistry = createRegistry<OutputPluginContract<SampleRun, SampleOutput>>("outputs");
    const scope = createScope({ id: "run-001", kind: "run", metadata: { team: "sdk" } });
    const storage = createMemoryStorage();
    const workspace = createMemoryWorkspace();
    const queue = createMemoryQueue();
    const memory = createMemoryService();

    const sampleOutputPlugin = defineOutputPlugin<SampleRun, SampleOutput>({
      kind: "output-plugin",
      manifest: {
        kind: "plugin",
        id: "sample-output",
        name: "Sample Output",
      },
      contentType: "application/json",
      async finalize(input) {
        return {
          kind: "output-envelope",
          pluginId: input.pluginId,
          contentType: "application/json",
          payload: {
            message: input.run.message,
            scopeId: input.scopeId,
          },
        };
      },
    });

    const sampleSchema = defineConfigSchema<SampleConfig>({
      kind: "config-schema",
      id: "sample.plugin.config",
      schema: {
        type: "object",
        properties: {
          greeting: { type: "string" },
          outputRegistry: { type: "string" },
        },
        required: ["greeting", "outputRegistry"],
        additionalProperties: false,
      },
      parse(input) {
        const candidate = input as Partial<SampleConfig> | undefined;
        if (typeof candidate?.greeting !== "string") {
          throw new Error("greeting is required");
        }
        if (typeof candidate?.outputRegistry !== "string") {
          throw new Error("outputRegistry is required");
        }

        return {
          greeting: candidate.greeting,
          outputRegistry: candidate.outputRegistry,
        };
      },
    });

    const samplePlugin = definePlugin<SampleConfig>({
      manifest: {
        kind: "plugin",
        id: "sample.plugin",
        name: "Sample Plugin",
        description: "Demonstrates the SDK contract surface only.",
        dependencies: [
          { id: "plugin-workspace-fs" },
          { id: "plugin-storage-memory", optional: true },
        ],
      },
      configSchema: sampleSchema,
      lifecycle: defineLifecycle({
        async start(context) {
          await context.storage?.set({
            key: { namespace: "sample", collection: "runs", id: context.scope.id },
            value: { greeting: context.config.greeting },
            updatedAt: "2026-04-13T00:00:00.000Z",
          });

          await context.workspace?.writeText(
            context.workspace.resolvePath(
              "workspace",
              "agents",
              context.scope.id,
              "memory",
              "note.txt",
            ),
            context.config.greeting,
          );

          await context.queue?.enqueue({
            id: "job-001",
            name: "sample.run",
            payload: { scopeId: context.scope.id },
            state: "queued",
            attempts: 0,
            enqueuedAt: "2026-04-13T00:00:00.000Z",
          });
        },
      }),
      async register(context) {
        const registry = context.registries[context.config.outputRegistry] as
          | typeof outputRegistry
          | undefined;
        registry?.register("sample-output", sampleOutputPlugin);
        await context.storage?.set({
          key: { namespace: "sample", collection: "registry", id: context.pluginId },
          value: { outputRegistry: context.config.outputRegistry },
          updatedAt: "2026-04-13T00:00:00.000Z",
        });
      },
    });

    expectTypeOf(samplePlugin).toMatchTypeOf<PluginContract<SampleConfig>>();
    expectTypeOf(sampleSchema).toMatchTypeOf<ConfigSchemaContract<SampleConfig>>();
    expectTypeOf(scope).toMatchTypeOf<Scope>();
    expectTypeOf(memory).toMatchTypeOf<MemoryService>();

    pluginRegistry.register(samplePlugin.manifest.id, samplePlugin);
    outputRegistry.register(sampleOutputPlugin.manifest.id, sampleOutputPlugin);

    const parsedConfig = samplePlugin.configSchema?.parse({
      greeting: "hello from sdk",
      outputRegistry: "outputs",
    });

    expect(parsedConfig).toEqual({
      greeting: "hello from sdk",
      outputRegistry: "outputs",
    });

    const runtimeContext: PluginRuntimeContext<SampleConfig> = {
      pluginId: samplePlugin.manifest.id,
      manifest: samplePlugin.manifest,
      scope,
      config: parsedConfig ?? {
        greeting: "hello from sdk",
        outputRegistry: "outputs",
      },
      registries: {
        plugins: pluginRegistry,
        outputs: outputRegistry,
      },
      storage,
      workspace,
      queue,
      runtime: { mode: "test" },
    };

    await samplePlugin.register?.(runtimeContext);
    await samplePlugin.lifecycle?.start?.(runtimeContext);

    expect(pluginRegistry.get("sample.plugin")).toBe(samplePlugin);

    const storedRegistration = await storage.get({
      namespace: "sample",
      collection: "registry",
      id: "sample.plugin",
    });
    expect(storedRegistration?.value).toEqual({ outputRegistry: "outputs" });

    const storedRun = await storage.get({
      namespace: "sample",
      collection: "runs",
      id: "run-001",
    });
    expect(storedRun?.value).toEqual({ greeting: "hello from sdk" });

    expect(await queue.size()).toBe(1);
    expect(await workspace.readText("/workspace/workspace/agents/run-001/memory/note.txt")).toBe(
      "hello from sdk",
    );

    const remembered = await memory.remember("coordinator", {
      id: "memory-001",
      kind: "fact",
      text: "The SDK memory contract keeps memory implementations replaceable.",
      tags: ["sdk", "memory"],
      metadata: { source: "contract-test" },
    });

    expect(await memory.get("coordinator", remembered.id)).toEqual(remembered);
    expect(await memory.search("coordinator", { text: "replaceable memory", tags: ["sdk"] })).toEqual([
      {
        entry: remembered,
        score: 2,
        matches: ["replaceable", "memory"],
      },
    ]);

    const lease = await queue.lease();
    expect(lease?.state).toBe("leased");
    expect(lease?.payload).toEqual({ scopeId: "run-001" });

    const envelope = await sampleOutputPlugin.finalize({
      runId: "run-001",
      scopeId: "run-001",
      pluginId: sampleOutputPlugin.manifest.id,
      run: { message: "finalized" },
    });

    expect(envelope).toEqual({
      kind: "output-envelope",
      pluginId: "sample-output",
      contentType: "application/json",
      payload: {
        message: "finalized",
        scopeId: "run-001",
      },
    });
  });
});
