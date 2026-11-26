import { AssistantMessageEventStream } from "./event-stream.js";
import { registerModel } from "./models.js";
import { registerApi, stream } from "./registry.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
  ThinkingLevel,
} from "./types.js";
import { createAssistantMessage } from "./usage.js";

/**
 * Virtual models: catalog entries that route each request to a physical model. Adapted from pi's
 * `virtual-models.ts` (badlogic/pi-mono, MIT), at the stream level so any caller of `stream()` (the
 * agent loop, compaction, extensions) routes the same way.
 *
 * A router picks the physical model and reasoning level per request, for example a cheap model for
 * short turns and a strong one for hard ones. `createFallbackModel` is a ready-made router that
 * tries models in order and moves on when one fails before producing any output.
 *
 * Responses name the physical model that answered. A caller's API key belongs to the virtual
 * model's provider, so it is only forwarded when the routed model has the same provider; other
 * providers resolve their own credentials (environment variables or `getAuth`).
 */

export const VIRTUAL_MODEL_API = "virtual";

export interface ModelRouteRequest {
  /** The virtual model being routed. */
  model: Model;
  context: Context;
  /** Requested reasoning level, if any. Its meaning is up to the router. */
  reasoning?: ThinkingLevel;
  /** 0 for the first route; higher when a fallback router moves to the next model. */
  attempt: number;
  /** The failed response of the previous attempt, for routers that retry. */
  failed?: { model: Model; message: AssistantMessage };
  signal?: AbortSignal;
}

export interface ModelRoute {
  model: Model;
  /** Reasoning level for the physical model; `undefined` keeps the requested level. `null` sends none. */
  reasoning?: ThinkingLevel | null;
}

export interface VirtualModelDefinition {
  provider: string;
  id: string;
  name?: string;
  /** Limits reported before routing. Defaults to 200k context and 32k output. */
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  route(request: ModelRouteRequest): ModelRoute | Promise<ModelRoute>;
  /**
   * After a failed response that produced no output, route again (with `attempt + 1` and `failed`)
   * up to this many times. Default 0: failures are returned as they are.
   */
  maxReroutes?: number;
}

const definitions = new Map<string, VirtualModelDefinition>();

function key(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export function isVirtualModel(model: Pick<Model, "api">): boolean {
  return model.api === VIRTUAL_MODEL_API;
}

/** The catalog entry for a virtual model definition. */
export function createVirtualModel(definition: Omit<VirtualModelDefinition, "route">): Model {
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api: VIRTUAL_MODEL_API,
    provider: definition.provider,
    baseUrl: "",
    reasoning: definition.reasoning ?? true,
    input: definition.input ?? ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: definition.contextWindow ?? 200_000,
    maxTokens: definition.maxTokens ?? 32_000,
  };
}

/**
 * Register a virtual model. It resolves like any other model (`resolveModel("router/auto")`) and
 * streams through its router. Returns the model and a function that removes it.
 */
export function registerVirtualModel(definition: VirtualModelDefinition): {
  model: Model;
  unregister: () => void;
} {
  const model = createVirtualModel(definition);
  definitions.set(key(definition.provider, definition.id), definition);
  registerModel(model);
  return {
    model,
    unregister: () => {
      if (definitions.get(key(definition.provider, definition.id)) === definition) {
        definitions.delete(key(definition.provider, definition.id));
      }
    },
  };
}

export interface FallbackModelOptions {
  provider: string;
  id: string;
  name?: string;
  /** Physical models to try, in order. */
  models: readonly Model[];
}

/** A virtual model that tries `models` in order, moving on when one fails before any output. */
export function createFallbackModel(options: FallbackModelOptions): VirtualModelDefinition {
  const [first] = options.models;
  if (first === undefined) {
    throw new Error("createFallbackModel needs at least one model");
  }
  return {
    provider: options.provider,
    id: options.id,
    ...(options.name === undefined ? {} : { name: options.name }),
    contextWindow: Math.min(...options.models.map((model) => model.contextWindow)),
    maxTokens: Math.min(...options.models.map((model) => model.maxTokens)),
    reasoning: options.models.some((model) => model.reasoning),
    input: options.models.every((model) => model.input.includes("image"))
      ? ["text", "image"]
      : ["text"],
    maxReroutes: options.models.length - 1,
    route: ({ attempt }) => ({ model: options.models[attempt] ?? first }),
  };
}

function failure(model: Model, message: string, aborted = false): AssistantMessage {
  const error = createAssistantMessage(model);
  error.stopReason = aborted ? "aborted" : "error";
  error.errorMessage = message;
  return error;
}

function physicalOptions(
  virtual: Model,
  routed: Model,
  route: ModelRoute,
  options: StreamOptions | undefined,
): StreamOptions | undefined {
  if (options === undefined && route.reasoning === undefined) return undefined;
  const { apiKey, reasoning, ...rest } = options ?? {};
  const level = route.reasoning === undefined ? reasoning : (route.reasoning ?? undefined);
  return {
    ...rest,
    // A key for the virtual provider must not leak to another provider.
    ...(apiKey !== undefined && routed.provider === virtual.provider ? { apiKey } : {}),
    ...(level !== undefined && routed.reasoning ? { reasoning: level } : {}),
  };
}

/** Whether an event carries output a reroute would have to discard (empty blocks do not). */
function isOutput(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "text_end":
    case "thinking_end":
      return event.content.length > 0;
    case "toolcall_start":
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}

export function streamVirtual(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const out = new AssistantMessageEventStream();
  const definition = definitions.get(key(model.provider, model.id));
  void (async () => {
    if (definition === undefined) {
      const error = failure(model, `Virtual model ${model.provider}/${model.id} is not registered`);
      out.push({ type: "error", reason: "error", error });
      return;
    }
    let failed: ModelRouteRequest["failed"];
    for (let attempt = 0; attempt <= (definition.maxReroutes ?? 0); attempt += 1) {
      let route: ModelRoute;
      try {
        route = await definition.route({
          model,
          context,
          attempt,
          ...(options?.reasoning === undefined ? {} : { reasoning: options.reasoning }),
          ...(failed === undefined ? {} : { failed }),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.push({
          type: "error",
          reason: "error",
          error: failure(model, `Routing failed: ${message}`),
        });
        return;
      }
      if (isVirtualModel(route.model)) {
        out.push({
          type: "error",
          reason: "error",
          error: failure(
            model,
            `Virtual model ${model.provider}/${model.id} routed to another virtual model`,
          ),
        });
        return;
      }
      const inner = stream(
        route.model,
        context,
        physicalOptions(model, route.model, route, options),
      );
      let started = false;
      const held: AssistantMessageEvent[] = [];
      let retry = false;
      for await (const event of inner) {
        if (!started) {
          if (event.type !== "error" && event.type !== "done" && !isOutput(event)) {
            held.push(event);
            continue;
          }
          const canReroute =
            event.type === "error" &&
            event.reason === "error" &&
            attempt < (definition.maxReroutes ?? 0) &&
            !options?.signal?.aborted;
          if (canReroute) {
            failed = { model: route.model, message: event.error };
            retry = true;
            break;
          }
          started = true;
          for (const heldEvent of held) out.push(heldEvent);
          out.push(event);
          continue;
        }
        out.push(event);
      }
      if (!retry) {
        if (!started) for (const heldEvent of held) out.push(heldEvent);
        if (!out.isDone) out.end();
        return;
      }
    }
  })();
  return out;
}

registerApi(VIRTUAL_MODEL_API, streamVirtual);
