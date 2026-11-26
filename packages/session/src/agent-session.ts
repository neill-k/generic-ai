import type { Agent, AgentMessage, AgentThinkingLevel, StreamFn } from "@generic-ai/agent";
import {
  type AssistantMessage,
  isContextOverflow,
  isRetryableAssistantError,
  type Model,
  type RetryPolicy,
  retryDelayMs,
} from "@generic-ai/ai";

import {
  type CompactionResult,
  type CompactionSettings,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "./compaction.js";
import type { SessionManager } from "./session-manager.js";

/** Default retry policy for transient provider errors: three retries, 2 s base backoff. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
};

/**
 * Persist every message the agent finishes to the session file, in order. Returns an unsubscribe
 * function. Failed assistant messages are kept in the file as history even when a retry removes
 * them from the live context.
 */
export function persistAgentMessages(agent: Agent, manager: SessionManager): () => void {
  return agent.subscribe((event) => {
    if (event.type === "message_end") {
      manager.appendMessage(event.message as Parameters<SessionManager["appendMessage"]>[0]);
    }
  });
}

/** Load a session's resolved context (after compactions and branch summaries) into an agent. */
export function restoreAgentContext(agent: Agent, manager: SessionManager): void {
  agent.state.messages = [...manager.buildSessionContext().messages];
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && "role" in message && message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryNotice {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly errorMessage: string;
}

/**
 * Run an agent step and retry it while it ends in a transient provider error (overloaded, rate
 * limited, 5xx, dropped connection). Each retry removes the failed assistant message from the live
 * context and continues the agent from the message before it. Quota and billing errors, aborts,
 * and other deterministic failures are not retried.
 *
 * Returns the number of retries used.
 */
export async function runWithRetry(
  agent: Agent,
  step: () => Promise<void>,
  options: {
    readonly policy?: RetryPolicy | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly onRetry?: ((notice: RetryNotice) => void | Promise<void>) | undefined;
    /**
     * Called once when the step ends in a context overflow (`isContextOverflow`). Compact the
     * session and return true to drop the failed message and continue, or false to stop.
     */
    readonly onContextOverflow?: (() => Promise<boolean>) | undefined;
    /** The model's context window, for detecting overflows a provider reports as success. */
    readonly contextWindow?: number | undefined;
  } = {},
): Promise<number> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  await step();
  let attempt = 0;
  let overflowHandled = false;
  for (;;) {
    const last = lastAssistant(agent.state.messages);
    if (
      options.onContextOverflow !== undefined &&
      !overflowHandled &&
      last !== undefined &&
      agent.state.messages.at(-1) === last &&
      isContextOverflow(last, options.contextWindow) &&
      !options.signal?.aborted
    ) {
      overflowHandled = true;
      if (!(await options.onContextOverflow())) {
        return attempt;
      }
      const after = agent.state.messages.at(-1);
      if (after !== undefined && "role" in after && after.role === "assistant") {
        agent.state.messages = agent.state.messages.slice(0, -1);
      }
      await agent.continue();
      continue;
    }
    if (
      !policy.enabled ||
      attempt >= policy.maxRetries ||
      last === undefined ||
      agent.state.messages.at(-1) !== last ||
      !isRetryableAssistantError(last)
    ) {
      return attempt;
    }
    if (options.signal?.aborted) {
      return attempt;
    }
    attempt += 1;
    const delayMs = retryDelayMs(policy, attempt);
    await options.onRetry?.({
      attempt,
      maxRetries: policy.maxRetries,
      delayMs,
      errorMessage: last.errorMessage ?? "Unknown error",
    });
    if (!(await sleep(delayMs, options.signal))) {
      return attempt;
    }
    agent.state.messages = agent.state.messages.slice(0, -1);
    await agent.continue();
  }
}

export interface AutoCompactionOptions {
  readonly model: Model;
  readonly settings?: Partial<CompactionSettings> | undefined;
  readonly apiKey?: string | undefined;
  readonly streamFn?: StreamFn | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly thinkingLevel?: AgentThinkingLevel | undefined;
  readonly retry?: RetryPolicy | undefined;
  /**
   * Called when the context needs compacting, before the summary is made. Return `cancel` to skip
   * this compaction, or `customInstructions` to steer the summary.
   */
  readonly beforeCompact?:
    | ((info: {
        readonly tokens: number;
        readonly contextWindow: number;
      }) => Promise<BeforeCompactDecision | undefined> | BeforeCompactDecision | undefined)
    | undefined;
}

export interface BeforeCompactDecision {
  readonly cancel?: boolean | undefined;
  readonly customInstructions?: string | undefined;
}

/** The context size the agent would send next: the last provider usage plus an estimate of later messages. */
export function currentContextTokens(messages: readonly AgentMessage[]): number {
  return estimateContextTokens([...messages]).tokens;
}

/**
 * Compact the session when its context is within `reserveTokens` of the model's context window:
 * summarise the older part of the branch with the model, append a compaction entry, and reload
 * the agent's context from the session. Returns the compaction result, or `undefined` when no
 * compaction was needed or possible.
 */
export async function compactIfNeeded(
  agent: Agent,
  manager: SessionManager,
  options: AutoCompactionOptions,
): Promise<CompactionResult | undefined> {
  const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings };
  const contextWindow = options.model.contextWindow;
  if (!settings.enabled || !(contextWindow > 0)) {
    return undefined;
  }
  const tokens = currentContextTokens(agent.state.messages);
  if (!shouldCompact(tokens, contextWindow, settings)) {
    return undefined;
  }
  const decision = await options.beforeCompact?.({ tokens, contextWindow });
  if (decision?.cancel === true) {
    return undefined;
  }
  return compactNow(agent, manager, {
    ...options,
    settings,
    ...(decision?.customInstructions === undefined
      ? {}
      : { customInstructions: decision.customInstructions }),
  });
}

/** Compact the session's current branch now, whatever its size. */
export async function compactNow(
  agent: Agent,
  manager: SessionManager,
  options: AutoCompactionOptions & { readonly customInstructions?: string | undefined },
): Promise<CompactionResult | undefined> {
  const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings };
  const preparation = prepareCompaction(manager.getBranch(), settings);
  if (preparation === undefined) {
    return undefined;
  }
  const result = await compact(
    preparation,
    options.model,
    options.apiKey,
    undefined,
    options.customInstructions,
    options.signal,
    options.thinkingLevel,
    options.streamFn,
    undefined,
    options.retry,
    undefined,
    manager.getSessionId(),
  );
  manager.appendCompaction(
    result.summary,
    result.firstKeptEntryId,
    result.tokensBefore,
    result.details,
    false,
    result.usage,
  );
  restoreAgentContext(agent, manager);
  return result;
}
