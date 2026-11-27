import type { AgentHold } from "@generic-ai/plugin-delegation";
import type { AgentTaskExecutionResult, StorageContract } from "@generic-ai/sdk";

import { MODEL_AUTH_PROVIDER, type ModelAuthSource } from "./model-auth.js";

/**
 * The Claude plan's usage limit (design decision 15). When agents run on the owner's Claude
 * sign-in and the plan's limit is reached, the owner chooses what happens (Neill: "Configurable
 * option"):
 *
 * - `wait` (the default): work is held, shown as "Paused until your Claude plan resets", and
 *   gets a fresh turn once the plan resets. Nothing is lost.
 * - `api_key`: if an Anthropic API key is available (from the environment or the secrets vault),
 *   turns use it until the plan resets, then go back to the plan. Without a key this falls back
 *   to waiting.
 *
 * The limit is noticed when a turn on the plan fails with Anthropic's rate-limit error after the
 * client's own retries. When the error carries the reset time it is used; otherwise the next try
 * is in 15 minutes, doubling each time the limit is still there, up to 5 hours (the plan's
 * window).
 */

export type PlanLimitBehaviour = "wait" | "api_key";
export const PLAN_LIMIT_BEHAVIOURS: readonly PlanLimitBehaviour[] = ["wait", "api_key"];

export const PLAN_RESET_REASON =
  "Paused until your Claude plan resets. Its usage limit is reached; work picks up again on its own.";

export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

interface StoredPlanLimit {
  readonly behaviour: PlanLimitBehaviour;
  /** While the plan is limited: when to try it again. */
  readonly limitedUntil?: string;
  readonly detectedAt?: string;
  /** How many times in a row the limit was found still in place, for the backoff. */
  readonly strikes?: number;
  /** Whether `limitedUntil` came from the provider rather than a guess. */
  readonly resetKnown?: boolean;
}

export interface PlanLimitStatus {
  readonly behaviour: PlanLimitBehaviour;
  /** True while the plan's limit is reached. */
  readonly limited: boolean;
  /** When the plan resets (or is next tried, when `resetKnown` is false). */
  readonly limitedUntil?: string;
  readonly resetKnown?: boolean;
  readonly detectedAt?: string;
  /** Whether an Anthropic API key is available for `api_key`. */
  readonly apiKeyAvailable: boolean;
  /** True while turns run on the API key instead of the plan. */
  readonly usingApiKey: boolean;
}

const KEY = { namespace: "generic-corp-owner", collection: "settings", id: "plan-limit" };
const FIRST_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 5 * 60 * 60_000;

/**
 * Reads a plan usage-limit error. Returns the reset time when the error carries one (as
 * `...|<unix seconds>`, the form Claude's usage-limit errors use), `null` when it is a limit
 * error without one, and `undefined` when it is some other error.
 */
export function readPlanLimitError(text: string | undefined): Date | null | undefined {
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  if (!/rate_limit_error|usage limit|rate limit|(?<![0-9])429(?![0-9])/i.test(text)) {
    return undefined;
  }
  const epoch = /\|(\d{10})(?!\d)/.exec(text)?.[1];
  if (epoch !== undefined) {
    return new Date(Number(epoch) * 1000);
  }
  return null;
}

export function parsePlanLimitBehaviour(value: unknown): PlanLimitBehaviour {
  if (typeof value === "string" && PLAN_LIMIT_BEHAVIOURS.includes(value as PlanLimitBehaviour)) {
    return value as PlanLimitBehaviour;
  }
  throw new PlanLimitError('Send {"behaviour": "wait"} or {"behaviour": "api_key"}.');
}

export interface PlanLimit {
  status(): Promise<PlanLimitStatus>;
  setBehaviour(behaviour: PlanLimitBehaviour): Promise<PlanLimitStatus>;
  /**
   * Request auth for a turn: the plan's sign-in, or the API key while the plan is limited and
   * the owner chose `api_key`.
   */
  getAuth<T>(
    provider: string,
    fromSignIn: (provider: string) => Promise<T>,
  ): Promise<T | { apiKey: string }>;
  /**
   * Looks at a finished turn. Returns true when it hit the plan's limit (and records that), so
   * the caller can retry it on the API key or let the hold park it.
   */
  observe(input: { readonly model?: string }, result: AgentTaskExecutionResult): Promise<boolean>;
  /** The hold source: the plan-reset hold while waiting on the plan. */
  holdFor(agentId: string): Promise<AgentHold | undefined>;
  /** Watches for the reset time. */
  start(): void;
  stop(): void;
}

export interface CreatePlanLimitOptions {
  readonly kv: StorageContract;
  /** Where agents' model access comes from right now. */
  readonly source: () => Promise<ModelAuthSource>;
  /** An Anthropic API key to fall back to, when there is one (environment or secrets vault). */
  readonly apiKey: () => Promise<string | undefined>;
  /** Called when the plan may have reset, so held work gets a fresh turn. */
  readonly onRelease?: () => unknown;
  readonly now?: () => Date;
  readonly checkEveryMs?: number;
}

export async function createPlanLimit(options: CreatePlanLimitOptions): Promise<PlanLimit> {
  const now = options.now ?? (() => new Date());
  let state: StoredPlanLimit = (await options.kv.get<StoredPlanLimit>(KEY))?.value ?? {
    behaviour: "wait",
  };
  const save = async (next: StoredPlanLimit) => {
    state = next;
    await options.kv.set({ key: KEY, value: next, updatedAt: now().toISOString() });
  };
  const limited = () =>
    state.limitedUntil !== undefined && Date.parse(state.limitedUntil) > now().getTime();
  const release = () => Promise.resolve(options.onRelease?.()).catch(() => undefined);

  /** The fallback key, when the owner chose it and the plan is limited. */
  const fallbackKey = async (): Promise<string | undefined> =>
    state.behaviour === "api_key" && limited() ? options.apiKey() : undefined;

  const status = async (): Promise<PlanLimitStatus> => {
    const apiKey = await options.apiKey();
    const isLimited = limited();
    return {
      behaviour: state.behaviour,
      limited: isLimited,
      ...(isLimited && state.limitedUntil !== undefined
        ? {
            limitedUntil: state.limitedUntil,
            resetKnown: state.resetKnown === true,
            ...(state.detectedAt === undefined ? {} : { detectedAt: state.detectedAt }),
          }
        : {}),
      apiKeyAvailable: apiKey !== undefined,
      usingApiKey: isLimited && state.behaviour === "api_key" && apiKey !== undefined,
    };
  };

  let timer: NodeJS.Timeout | undefined;

  return {
    status,

    async setBehaviour(behaviour) {
      await save({ ...state, behaviour });
      // Switching to the API key lets held work go now.
      await release();
      return status();
    },

    async getAuth(provider, fromSignIn) {
      if (provider === MODEL_AUTH_PROVIDER) {
        const key = await fallbackKey();
        if (key !== undefined) {
          return { apiKey: key };
        }
      }
      return fromSignIn(provider);
    },

    async observe(input, result) {
      if (input.model !== undefined && !input.model.startsWith(`${MODEL_AUTH_PROVIDER}/`)) {
        return false;
      }
      if (result.status !== "failed") {
        // A turn got through: the next limit starts the backoff afresh.
        if ((state.strikes ?? 0) > 0 && !limited()) {
          const { strikes: _strikes, ...rest } = state;
          await save(rest);
        }
        return false;
      }
      // Only the plan has a plan limit; a key's rate limit is the provider's ordinary retry case.
      if ((await options.source()) !== "subscription" || (await fallbackKey()) !== undefined) {
        return false;
      }
      const reset = readPlanLimitError(result.failureMessage ?? result.outputText);
      if (reset === undefined) {
        return false;
      }
      const at = now();
      const strikes = (state.strikes ?? 0) + 1;
      const guess = Math.min(FIRST_BACKOFF_MS * 2 ** (strikes - 1), MAX_BACKOFF_MS);
      const until =
        reset !== null && reset.getTime() > at.getTime() ? reset : new Date(at.getTime() + guess);
      await save({
        ...state,
        limitedUntil: until.toISOString(),
        detectedAt: at.toISOString(),
        strikes,
        resetKnown: reset !== null,
      });
      return true;
    },

    async holdFor() {
      if (!limited()) {
        return undefined;
      }
      if ((await fallbackKey()) !== undefined) {
        return undefined;
      }
      return {
        kind: "plan-reset",
        reason: PLAN_RESET_REASON,
        ...(state.limitedUntil === undefined ? {} : { until: state.limitedUntil }),
      };
    },

    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        if (state.limitedUntil !== undefined && !limited()) {
          // The reset time has passed: try the plan again. `strikes` stays until a turn
          // succeeds, so a limit that is still there backs off further.
          const { limitedUntil: _until, ...rest } = state;
          void save(rest)
            .then(release)
            .catch(() => undefined);
        }
      }, options.checkEveryMs ?? 30_000);
      timer.unref();
    },

    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
