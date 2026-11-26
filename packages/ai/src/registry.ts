import { AssistantMessageEventStream } from "./event-stream.js";
import { githubCopilotRequestHeaders } from "./providers/github-copilot.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  StreamFunction,
  StreamOptions,
} from "./types.js";
import { createAssistantMessage } from "./usage.js";

const apis = new Map<string, StreamFunction>();

/** Register (or replace) the stream implementation for a wire API. */
export function registerApi(api: Api, stream: StreamFunction): void {
  apis.set(api, stream);
}

/** Remove an API registration. With `stream`, only removes it if it is still the registered one. */
export function unregisterApi(api: Api, stream?: StreamFunction): void {
  if (stream === undefined || apis.get(api) === stream) {
    apis.delete(api);
  }
}

export function getRegisteredApis(): string[] {
  return [...apis.keys()];
}

/**
 * Stream one assistant response. Never throws: an unknown API, a missing key, or any provider failure
 * ends the stream with an `error` event.
 */
export function stream(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const implementation = apis.get(model.api);
  if (!implementation) {
    const events = new AssistantMessageEventStream();
    const message = createAssistantMessage(model);
    message.stopReason = "error";
    message.errorMessage = `No provider registered for API "${model.api}"`;
    events.push({ type: "error", reason: "error", error: message });
    return events;
  }
  if (model.provider === "github-copilot") {
    return implementation(model, context, {
      ...options,
      headers: { ...githubCopilotRequestHeaders(context), ...(options?.headers ?? {}) },
    });
  }
  return implementation(model, context, options);
}

/** Run one request to completion and return the final assistant message. */
export async function complete(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage> {
  const events = stream(model, context, options);
  for await (const _event of events) {
    // drain
  }
  return events.result();
}
