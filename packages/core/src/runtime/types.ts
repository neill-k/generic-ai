import type { UsageBudgetLimits, UsageTotals } from "@generic-ai/sdk";

export const DEFAULT_GENERIC_AI_RUNTIME_ADAPTER = "native" as const;
/** Model used when neither the caller nor the config names one. */
export const DEFAULT_GENERIC_AI_MODEL = "gpt-5.5" as const;
/** @deprecated Use `DEFAULT_GENERIC_AI_MODEL`. The `openai-codex` adapter has been removed. */
export const DEFAULT_OPENAI_CODEX_MODEL = DEFAULT_GENERIC_AI_MODEL;

export type GenericAILlmRuntimeAdapter = "native";
export type GenericAIAgentTurnMode = "stop-tool-loop" | "single-turn";

export interface GenericAILlmRunOptions {
  readonly signal?: AbortSignal;
  readonly turnMode?: GenericAIAgentTurnMode;
  readonly maxTurns?: number;
  /**
   * Token and dollar caps for this run. When a cap is reached the run stops after the response that
   * reached it and rejects with a `UsageBudgetExceededError`. Supported by the native adapter.
   */
  readonly budget?: UsageBudgetLimits;
}

export interface GenericAILlmRunResult {
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly model: string;
  readonly outputText: string;
  readonly requestId?: string;
  /** Tokens and dollars spent by this run, when the adapter reports them (native does). */
  readonly usage?: UsageTotals;
}

export interface GenericAILlmRuntimeEvent {
  readonly name: string;
  readonly data: unknown;
}

export type GenericAILlmStreamChunk =
  | {
      readonly type: "text-delta";
      readonly delta: string;
    }
  | {
      readonly type: "event";
      readonly event: GenericAILlmRuntimeEvent;
    }
  | {
      readonly type: "response";
      readonly response: GenericAILlmRunResult;
    };

export interface GenericAILlmRuntime {
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly model: string;
  readonly instructions?: string;
  readonly run: (input: string, options?: GenericAILlmRunOptions) => Promise<GenericAILlmRunResult>;
  readonly stream: (
    input: string,
    options?: GenericAILlmRunOptions,
  ) => AsyncIterable<GenericAILlmStreamChunk>;
  readonly close?: () => Promise<void>;
}

export interface CreateGenericAILlmRuntimeOptions {
  readonly adapter?: GenericAILlmRuntimeAdapter;
  readonly apiKey?: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly cwd?: string;
  readonly turnMode?: GenericAIAgentTurnMode;
  readonly maxTurns?: number;
}
