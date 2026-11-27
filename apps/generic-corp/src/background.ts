import { type AssistantMessage, complete, type Model, resolveModel } from "@generic-ai/ai";
import type { StorageContract } from "@generic-ai/sdk";

import { MEMORY_NAMESPACE } from "./memory.js";

/**
 * What the background memory jobs (the preference scanner and dreaming) share: a small model
 * call, settings the owner can change, a pause, and a usage tally.
 *
 * The owner powers the company with his Claude subscription, whose usage limit is the scarce
 * resource, so background work is frugal: a small model by default, a call only when there is
 * something new to read, one job at a time, and nothing at all while paused or while the
 * company says it may not spend.
 */
export const DEFAULT_BACKGROUND_MODEL = "anthropic/claude-haiku-5-5";

export interface BackgroundRequest {
  /** Which job is calling, so the call is counted under it. */
  readonly purpose?: "preferences" | "dreaming";
  /** The agent the work is for (dreaming); company-wide work leaves it out. */
  readonly agentId?: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface BackgroundReply {
  readonly text: string;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

/** One model call for background work. Tests pass a scripted one; nothing here calls a model. */
export type BackgroundModel = (request: BackgroundRequest) => Promise<BackgroundReply>;

export interface ModelBackgroundOptions {
  readonly model: string;
  readonly getAuth?: (
    provider: string,
  ) => Promise<
    { readonly apiKey?: string; readonly headers?: Readonly<Record<string, string>> } | undefined
  >;
  readonly resolveModel?: (ref: string) => Model;
  /** Every reply's usage, failed ones too, so each call is counted. */
  readonly onUsage?: (usage: AssistantMessage["usage"], request: BackgroundRequest) => void;
}

export function textOfReply(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function createModelBackground(options: ModelBackgroundOptions): BackgroundModel {
  const resolve = options.resolveModel ?? ((ref: string) => resolveModel(ref));
  return async (request) => {
    const model = resolve(options.model);
    const auth = await options.getAuth?.(model.provider);
    const reply = await complete(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      },
      {
        maxTokens: Math.min(request.maxTokens, model.maxTokens),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(auth?.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth?.headers === undefined ? {} : { headers: { ...auth.headers } }),
      },
    );
    options.onUsage?.(reply.usage, request);
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? `The model call ${reply.stopReason}.`);
    }
    if (reply.stopReason === "length") {
      throw new Error("The model hit its output limit.");
    }
    return {
      text: textOfReply(reply),
      totalTokens: reply.usage.totalTokens,
      costUsd: reply.usage.cost.total,
    };
  };
}

/** The first JSON object in a reply: bare, fenced, or embedded in text. */
export function jsonInReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

export interface MemorySettings {
  /** Stops every background memory job until turned back on. */
  readonly paused: boolean;
  readonly scanner: {
    readonly enabled: boolean;
    /** How often to look for new owner messages. */
    readonly intervalMinutes: number;
  };
  readonly dreaming: {
    readonly enabled: boolean;
    /** How long an agent must be idle before it dreams. */
    readonly idleMinutes: number;
    /** Least time between two dreams of one agent. */
    readonly minHoursBetween: number;
  };
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = Object.freeze({
  paused: false,
  scanner: Object.freeze({ enabled: true, intervalMinutes: 15 }),
  dreaming: Object.freeze({ enabled: true, idleMinutes: 30, minHoursBetween: 6 }),
});

export interface BackgroundUsage {
  readonly calls: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface BackgroundJobState {
  readonly lastRunAt?: string;
  readonly lastError?: string;
  readonly lastResult?: string;
  readonly usage: BackgroundUsage;
}

export interface MemoryBackgroundStore {
  settings(): Promise<MemorySettings>;
  updateSettings(patch: unknown): Promise<MemorySettings>;
  job(name: string): Promise<BackgroundJobState>;
  recordRun(
    name: string,
    outcome: {
      readonly result?: string;
      readonly error?: string;
      readonly reply?: BackgroundReply;
    },
  ): Promise<void>;
  /** Free-form job state (cursors, last dream times). */
  getState<T>(key: string): Promise<T | undefined>;
  setState<T>(key: string, value: T): Promise<void>;
}

const SETTINGS_COLLECTION = "settings";
const JOBS_COLLECTION = "jobs";
const JOB_STATE_COLLECTION = "job-state";

function positive(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

/** Reads settings from untrusted JSON, keeping defaults for anything missing or malformed. */
export function normalizeMemorySettings(
  raw: unknown,
  base = DEFAULT_MEMORY_SETTINGS,
): MemorySettings {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const scanner = (
    typeof value["scanner"] === "object" && value["scanner"] !== null ? value["scanner"] : {}
  ) as Record<string, unknown>;
  const dreaming = (
    typeof value["dreaming"] === "object" && value["dreaming"] !== null ? value["dreaming"] : {}
  ) as Record<string, unknown>;
  return {
    paused: typeof value["paused"] === "boolean" ? value["paused"] : base.paused,
    scanner: {
      enabled: typeof scanner["enabled"] === "boolean" ? scanner["enabled"] : base.scanner.enabled,
      intervalMinutes: positive(scanner["intervalMinutes"], base.scanner.intervalMinutes, 24 * 60),
    },
    dreaming: {
      enabled:
        typeof dreaming["enabled"] === "boolean" ? dreaming["enabled"] : base.dreaming.enabled,
      idleMinutes: positive(dreaming["idleMinutes"], base.dreaming.idleMinutes, 7 * 24 * 60),
      minHoursBetween: positive(
        dreaming["minHoursBetween"],
        base.dreaming.minHoursBetween,
        24 * 30,
      ),
    },
  };
}

export function createMemoryBackgroundStore(options: {
  readonly kv: StorageContract;
  readonly now?: () => Date;
}): MemoryBackgroundStore {
  const { kv } = options;
  const now = options.now ?? (() => new Date());
  const key = (collection: string, id: string) => ({ namespace: MEMORY_NAMESPACE, collection, id });
  const settings = async () =>
    normalizeMemorySettings((await kv.get(key(SETTINGS_COLLECTION, "background")))?.value);
  const job = async (name: string): Promise<BackgroundJobState> =>
    (await kv.get<BackgroundJobState>(key(JOBS_COLLECTION, name)))?.value ?? {
      usage: { calls: 0, totalTokens: 0, costUsd: 0 },
    };
  return {
    settings,
    async updateSettings(patch) {
      const current = await settings();
      const value = (typeof patch === "object" && patch !== null ? patch : {}) as Record<
        string,
        unknown
      >;
      const merged = normalizeMemorySettings(
        {
          ...current,
          ...value,
          scanner: { ...current.scanner, ...(value["scanner"] as object | undefined) },
          dreaming: { ...current.dreaming, ...(value["dreaming"] as object | undefined) },
        },
        current,
      );
      await kv.set({
        key: key(SETTINGS_COLLECTION, "background"),
        value: merged,
        updatedAt: now().toISOString(),
      });
      return merged;
    },
    job,
    async recordRun(name, outcome) {
      const previous = await job(name);
      const at = now().toISOString();
      const value: BackgroundJobState = {
        lastRunAt: at,
        ...(outcome.error === undefined ? {} : { lastError: outcome.error }),
        ...(outcome.result === undefined
          ? previous.lastResult === undefined
            ? {}
            : { lastResult: previous.lastResult }
          : { lastResult: outcome.result }),
        usage: {
          calls: previous.usage.calls + (outcome.reply === undefined ? 0 : 1),
          totalTokens: previous.usage.totalTokens + (outcome.reply?.totalTokens ?? 0),
          costUsd: previous.usage.costUsd + (outcome.reply?.costUsd ?? 0),
        },
      };
      await kv.set({ key: key(JOBS_COLLECTION, name), value, updatedAt: at });
    },
    async getState<T>(id: string) {
      return (await kv.get<T>(key(JOB_STATE_COLLECTION, id)))?.value;
    },
    async setState<T>(id: string, value: T) {
      await kv.set({
        key: key(JOB_STATE_COLLECTION, id),
        value,
        updatedAt: now().toISOString(),
      });
    },
  };
}

/**
 * Why background work may not run now, or undefined when it may. Spending limits and the company
 * pause (decision 15) plug in through `canSpend` once they exist.
 */
export type BackgroundGate = () => Promise<string | undefined>;

export function createBackgroundGate(options: {
  readonly store: MemoryBackgroundStore;
  readonly canSpend?: () => Promise<string | undefined> | string | undefined;
}): BackgroundGate {
  return async () => {
    const settings = await options.store.settings();
    if (settings.paused) {
      return "Background memory work is paused.";
    }
    return (await options.canSpend?.()) ?? undefined;
  };
}

/** Runs `tick` every `intervalMs`, never two at once. The timer does not keep the process up. */
export function createBackgroundTimer(
  intervalMs: () => Promise<number> | number,
  tick: () => Promise<void>,
  onError: (error: unknown) => void,
): { start(): void; stop(): Promise<void>; runNow(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  const run = async () => {
    if (running !== undefined) {
      return running;
    }
    running = tick()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const schedule = async () => {
    if (stopped) {
      return;
    }
    const delay = await Promise.resolve(intervalMs()).catch(() => 15 * 60_000);
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void run().then(schedule);
    }, delay);
    timer.unref?.();
  };
  return {
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      void schedule();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      await running;
    },
    runNow: run,
  };
}
