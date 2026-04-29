export const DEFAULT_GENERIC_AI_RUNTIME_ADAPTER = "openai-codex" as const;
export const DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.5" as const;

export type GenericAILlmRuntimeAdapter = "openai-codex" | "pi";
export type GenericAIAgentTurnMode = "stop-tool-loop" | "single-turn";

export interface GenericAILlmRunOptions {
  readonly signal?: AbortSignal;
  readonly turnMode?: GenericAIAgentTurnMode;
  readonly maxTurns?: number;
}

export interface GenericAILlmRunResult {
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly model: string;
  readonly outputText: string;
  readonly requestId?: string;
}

export type GenericAILlmStreamChunk =
  | {
      readonly type: "text-delta";
      readonly delta: string;
    }
  | {
      readonly type: "response";
      readonly response: GenericAILlmRunResult;
    };

export interface GenericAILlmRuntime {
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly model: string;
  readonly instructions?: string;
  readonly run: (
    input: string,
    options?: GenericAILlmRunOptions,
  ) => Promise<GenericAILlmRunResult>;
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
  readonly agentDir?: string;
  readonly turnMode?: GenericAIAgentTurnMode;
  readonly maxTurns?: number;
}
