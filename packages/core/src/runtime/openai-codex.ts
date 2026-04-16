import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import {
  DEFAULT_OPENAI_CODEX_MODEL,
  type GenericAILlmRunOptions,
  type GenericAILlmRunResult,
  type GenericAILlmRuntime,
  type GenericAILlmStreamChunk,
} from "./types.js";

type OpenAIRequestOptions = {
  readonly signal?: AbortSignal;
};

interface OpenAIResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: OpenAIRequestOptions,
    ): Promise<Response>;
    create(
      body: ResponseCreateParamsStreaming,
      options?: OpenAIRequestOptions,
    ): Promise<AsyncIterable<ResponseStreamEvent>>;
  };
}

export interface OpenAICodexRuntimeDependencies {
  readonly client?: OpenAIResponsesClient;
}

function toRequestOptions(
  options: GenericAILlmRunOptions | undefined,
): OpenAIRequestOptions | undefined {
  if (options?.signal === undefined) {
    return undefined;
  }

  return {
    signal: options.signal,
  };
}

function toCreateParams(
  input: string,
  model: string,
  instructions: string | undefined,
): Omit<ResponseCreateParamsNonStreaming, "stream"> {
  return {
    model,
    input,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function toRunResult(
  model: string,
  outputText: string,
  requestId: string | undefined,
): GenericAILlmRunResult {
  return Object.freeze({
    adapter: "openai-codex" as const,
    model,
    outputText,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function extractStreamFailure(event: ResponseStreamEvent): Error | undefined {
  if (event.type === "error") {
    return new Error(event.message);
  }

  if (event.type === "response.failed") {
    return new Error(event.response.error?.message ?? "OpenAI response failed.");
  }

  if (event.type === "response.incomplete") {
    return new Error(`OpenAI response was incomplete: ${event.response.status}.`);
  }

  return undefined;
}

export function createOpenAICodexRuntime(
  input: {
    readonly apiKey: string;
    readonly model?: string;
    readonly instructions?: string;
  },
  dependencies: OpenAICodexRuntimeDependencies = {},
): GenericAILlmRuntime {
  const model = input.model ?? DEFAULT_OPENAI_CODEX_MODEL;
  const client =
    dependencies.client ??
    (new OpenAI({
      apiKey: input.apiKey,
    }) as unknown as OpenAIResponsesClient);

  return Object.freeze({
    adapter: "openai-codex",
    model,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    async run(prompt: string, options?: GenericAILlmRunOptions) {
      const response = await client.responses.create(
        toCreateParams(prompt, model, input.instructions),
        toRequestOptions(options),
      );

      return toRunResult(
        model,
        response.output_text,
        (response as Response & { _request_id?: string })._request_id,
      );
    },
    async *stream(prompt: string, options?: GenericAILlmRunOptions) {
      const events = await client.responses.create(
        {
          ...toCreateParams(prompt, model, input.instructions),
          stream: true,
        },
        toRequestOptions(options),
      );

      let outputText = "";
      let requestId: string | undefined;

      for await (const event of events) {
        const failure = extractStreamFailure(event);
        if (failure !== undefined) {
          throw failure;
        }

        if (event.type === "response.output_text.delta") {
          outputText += event.delta;
          yield {
            type: "text-delta",
            delta: event.delta,
          } satisfies GenericAILlmStreamChunk;
          continue;
        }

        if (event.type === "response.output_text.done") {
          outputText = event.text;
          continue;
        }

        if (event.type === "response.completed") {
          requestId = (event.response as Response & { _request_id?: string })._request_id;
          outputText = event.response.output_text;
        }
      }

      yield {
        type: "response",
        response: toRunResult(model, outputText, requestId),
      } satisfies GenericAILlmStreamChunk;
    },
  });
}
