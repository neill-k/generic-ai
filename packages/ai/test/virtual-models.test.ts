// Adapted in part from pi (https://github.com/badlogic/pi-mono), packages/coding-agent/test/virtual-models.test.ts. MIT License.
// pi's session-selection cases (model_change entries, tree navigation) have no counterpart: Generic AI
// routes at the stream level and sessions record the physical model that answered.
import { afterEach, describe, expect, it } from "vitest";
import {
  type Context,
  complete,
  createFallbackModel,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  type ModelRouteRequest,
  registerFauxProvider,
  registerVirtualModel,
  resolveModel,
  type StreamOptions,
  stream,
} from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function faux(provider: string): FauxProviderRegistration {
  const registration = registerFauxProvider({
    provider,
    models: [
      { id: "small", contextWindow: 1000, maxTokens: 100, input: ["text"] },
      { id: "large", contextWindow: 50_000, maxTokens: 5000, reasoning: true },
    ],
  });
  cleanups.push(() => registration.unregister());
  return registration;
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

describe("virtual models", () => {
  it("resolves like a catalog model and routes each request to a physical model", async () => {
    const physical = faux("vm-a");
    const requests: ModelRouteRequest[] = [];
    const virtual = registerVirtualModel({
      provider: "router",
      id: "auto",
      name: "Auto",
      route(request) {
        requests.push(request);
        const id = request.reasoning === "high" ? "large" : "small";
        return { model: physical.getModel(id) ?? physical.getModel() };
      },
    });
    cleanups.push(virtual.unregister);
    expect(resolveModel("router/auto")).toMatchObject({ api: "virtual", name: "Auto" });

    physical.setResponses([fauxAssistantMessage("from small"), fauxAssistantMessage("from large")]);
    const quick = await complete(virtual.model, context);
    const hard = await complete(virtual.model, context, { reasoning: "high" });
    expect(quick.model).toBe("small");
    expect(quick.content).toEqual([{ type: "text", text: "from small" }]);
    expect(hard.model).toBe("large");
    expect(requests.map((request) => [request.attempt, request.reasoning])).toEqual([
      [0, undefined],
      [0, "high"],
    ]);
  });

  it("drops reasoning for models that do not reason and applies the route's level", async () => {
    const physical = faux("vm-b");
    const seen: Array<StreamOptions["reasoning"]> = [];
    physical.setResponses([
      (_context, options) => {
        seen.push(options?.reasoning);
        return fauxAssistantMessage("a");
      },
      (_context, options) => {
        seen.push(options?.reasoning);
        return fauxAssistantMessage("b");
      },
    ]);
    const small = registerVirtualModel({
      provider: "router",
      id: "small-only",
      route: () => ({ model: physical.getModel("small") ?? physical.getModel() }),
    });
    const large = registerVirtualModel({
      provider: "router",
      id: "large-low",
      route: () => ({ model: physical.getModel("large") ?? physical.getModel(), reasoning: "low" }),
    });
    cleanups.push(small.unregister, large.unregister);
    await complete(small.model, context, { reasoning: "high" });
    await complete(large.model, context, { reasoning: "high" });
    expect(seen).toEqual([undefined, "low"]);
  });

  it("does not forward the caller's key to a routed model of another provider", async () => {
    const physical = faux("vm-c");
    const keys: Array<string | undefined> = [];
    physical.setResponses([
      (_context, options) => {
        keys.push(options?.apiKey);
        return fauxAssistantMessage("x");
      },
      (_context, options) => {
        keys.push(options?.apiKey);
        return fauxAssistantMessage("y");
      },
    ]);
    const other = registerVirtualModel({
      provider: "router",
      id: "elsewhere",
      route: () => ({ model: physical.getModel() }),
    });
    const same = registerVirtualModel({
      provider: "vm-c",
      id: "same-provider",
      route: () => ({ model: physical.getModel() }),
    });
    cleanups.push(other.unregister, same.unregister);
    await complete(other.model, context, { apiKey: "router-key" });
    await complete(same.model, context, { apiKey: "vm-c-key" });
    expect(keys).toEqual([undefined, "vm-c-key"]);
  });

  it("rejects routes to virtual models and reports router failures", async () => {
    const loop = registerVirtualModel({
      provider: "router",
      id: "loop",
      route: () => ({ model: loop.model }),
    });
    const broken = registerVirtualModel({
      provider: "router",
      id: "broken",
      route: () => {
        throw new Error("no capacity");
      },
    });
    cleanups.push(loop.unregister, broken.unregister);
    const looped = await complete(loop.model, context);
    expect(looped.stopReason).toBe("error");
    expect(looped.errorMessage).toContain("routed to another virtual model");
    const failed = await complete(broken.model, context);
    expect(failed.errorMessage).toBe("Routing failed: no capacity");
  });

  it("fails clearly when the virtual model is not registered", async () => {
    const virtual = registerVirtualModel({
      provider: "router",
      id: "gone",
      route: () => {
        throw new Error("unreachable");
      },
    });
    virtual.unregister();
    const message = await complete(virtual.model, context);
    expect(message.errorMessage).toBe("Virtual model router/gone is not registered");
  });
});

describe("fallback models", () => {
  it("moves to the next model when one fails before any output", async () => {
    const primary = faux("fb-primary");
    const backup = faux("fb-backup");
    primary.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
    ]);
    backup.setResponses([fauxAssistantMessage("backup answered")]);
    const definition = createFallbackModel({
      provider: "router",
      id: "resilient",
      models: [
        primary.getModel("large") ?? primary.getModel(),
        backup.getModel("large") ?? backup.getModel(),
      ],
    });
    const virtual = registerVirtualModel(definition);
    cleanups.push(virtual.unregister);

    const events: string[] = [];
    const response = stream(virtual.model, context);
    for await (const event of response) events.push(event.type);
    const message = await response.result();
    expect(message.provider).toBe("fb-backup");
    expect(message.content).toEqual([{ type: "text", text: "backup answered" }]);
    expect(events).not.toContain("error");
    expect(events.at(-1)).toBe("done");
    expect(virtual.model.contextWindow).toBe(50_000);
  });

  it("returns the last failure when every model fails", async () => {
    const primary = faux("fb2-primary");
    const backup = faux("fb2-backup");
    primary.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "first" }),
    ]);
    backup.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "second" }),
    ]);
    const virtual = registerVirtualModel(
      createFallbackModel({
        provider: "router",
        id: "all-down",
        models: [primary.getModel(), backup.getModel()],
      }),
    );
    cleanups.push(virtual.unregister);
    const message = await complete(virtual.model, context);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("second");
  });

  it("needs at least one model", () => {
    expect(() => createFallbackModel({ provider: "router", id: "none", models: [] })).toThrow(
      "at least one model",
    );
  });
});
