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

/** HTTP statuses worth retrying: timeouts, conflicts, rate limits and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after-ms") ?? undefined;
  if (header !== undefined && Number.isFinite(Number(header))) {
    return Number(header);
  }
  const seconds = response.headers.get("retry-after");
  if (seconds === null) {
    return undefined;
  }
  const asNumber = Number(seconds);
  if (Number.isFinite(asNumber)) {
    return asNumber * 1000;
  }
  const date = Date.parse(seconds);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch` with the same retry behavior the SDK-backed providers get: up to `options.maxRetries`
 * (default 2) retries on network errors and retryable statuses, with exponential backoff that honors
 * `retry-after`. Aborts are never retried. The final response is returned whatever its status.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: StreamOptions | undefined,
): Promise<Response> {
  const doFetch = options?.fetch ?? globalThis.fetch;
  const maxRetries = Math.max(0, options?.maxRetries ?? 2);
  for (let attempt = 0; ; attempt += 1) {
    const backoff = Math.min(8_000, 500 * 2 ** attempt);
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options?.signal?.aborted || attempt >= maxRetries) {
        throw error;
      }
      await sleep(backoff, options?.signal);
      continue;
    }
    if (response.ok || !isRetryableStatus(response.status) || attempt >= maxRetries) {
      return response;
    }
    const wait = Math.min(60_000, retryAfterMs(response) ?? backoff);
    await response.body?.cancel().catch(() => {});
    await sleep(wait, options?.signal);
  }
}
