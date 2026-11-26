import { AssistantMessageEventStream } from "./event-stream.js";
import type { AssistantMessage, Model, StreamOptions } from "./types.js";
import { createAssistantMessage } from "./usage.js";

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" ? reason : "Request was aborted");
  error.name = "AbortError";
  return error;
}

/** Apply `onPayload`: the hook may inspect the payload or return a replacement. */
export async function applyPayloadHook(
  payload: unknown,
  model: Model,
  options: StreamOptions | undefined,
): Promise<unknown> {
  if (!options?.onPayload) {
    return payload;
  }
  const replaced = await options.onPayload(payload, model);
  return replaced === undefined ? payload : replaced;
}

/**
 * Run a provider implementation behind the stream contract: the stream is returned at once, and any
 * failure (including aborts) becomes a terminal `error` event carrying an assistant message with
 * `stopReason` "error" or "aborted". `run` receives the output message it should fill and the stream
 * it should push block events to; it returns when the response is complete.
 */
export function runProviderStream(
  model: Model,
  options: StreamOptions | undefined,
  run: (output: AssistantMessage, stream: AssistantMessageEventStream) => Promise<void>,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const output = createAssistantMessage(model);
  void (async () => {
    try {
      await run(output, stream);
      if (options?.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        stream.push({ type: "error", reason: output.stopReason, error: output });
        return;
      }
      if (output.stopReason === "pending") {
        throw new Error("Provider stream ended without a stop reason");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      output.stopReason = aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    }
  })();
  return stream;
}

/** Resolve a header map where model-level headers come first and per-request headers win. */
export function mergeHeaders(
  base: Record<string, string>,
  model: Model,
  options: StreamOptions | undefined,
): Record<string, string> {
  return { ...base, ...(model.headers ?? {}), ...(options?.headers ?? {}) };
}
