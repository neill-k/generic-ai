import { describe, expect, it } from "vitest";
import { PluginHostError, createPluginHost } from "./index.js";

describe("createPluginHost", () => {
  it("resolves dependency order deterministically", () => {
    const host = createPluginHost();

    host.register({
      manifest: { id: "gamma" },
      lifecycle: {
        setup: ({ state }) => {
          const calls = state["calls"] as string[];
          calls.push("gamma");
        },
      },
    });
    host.register({
      manifest: { id: "beta", dependencies: ["alpha"] },
      lifecycle: {
        setup: ({ state }) => {
          const calls = state["calls"] as string[];
          calls.push("beta");
        },
      },
    });
    host.register({
      manifest: { id: "alpha" },
      lifecycle: {
        setup: ({ state }) => {
          const calls = state["calls"] as string[];
          calls.push("alpha");
        },
      },
    });

    expect(host.resolveOrder().map((plugin) => plugin.manifest.id)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("surfaces missing dependency diagnostics with the registered ids", () => {
    const host = createPluginHost();
    host.register({
      manifest: { id: "beta", dependencies: ["alpha"] },
    });

    try {
      host.resolveOrder();
      throw new Error("Expected host.resolveOrder() to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginHostError);
      const pluginError = error as PluginHostError;
      expect(pluginError.code).toBe("missing-plugin-dependency");
      expect(pluginError.issues).toHaveLength(1);
      expect(pluginError.message).toContain("beta");
      expect(pluginError.message).toContain("alpha");
      expect(pluginError.message).toContain("Registered plugins: beta.");
    }
  });

  it("runs setup in dependency order and stop in reverse order", async () => {
    const host = createPluginHost();
    const calls: string[] = [];

    host.register({
      manifest: { id: "alpha" },
      lifecycle: {
        setup: ({ state }) => {
          (state["calls"] as string[]).push("alpha:setup");
        },
        stop: ({ state }) => {
          (state["calls"] as string[]).push("alpha:stop");
        },
      },
    });
    host.register({
      manifest: { id: "beta", dependencies: ["alpha"] },
      lifecycle: {
        setup: ({ state }) => {
          (state["calls"] as string[]).push("beta:setup");
        },
        stop: ({ state }) => {
          (state["calls"] as string[]).push("beta:stop");
        },
      },
    });
    host.register({
      manifest: { id: "gamma", dependencies: ["beta"] },
      lifecycle: {
        setup: ({ state }) => {
          (state["calls"] as string[]).push("gamma:setup");
        },
        stop: ({ state }) => {
          (state["calls"] as string[]).push("gamma:stop");
        },
      },
    });

    await host.runLifecycle("setup", { calls });
    await host.runLifecycle("stop", { calls });

    expect(calls).toEqual([
      "alpha:setup",
      "beta:setup",
      "gamma:setup",
      "gamma:stop",
      "beta:stop",
      "alpha:stop",
    ]);
  });

  it("detects dependency cycles with a readable cycle path", () => {
    const host = createPluginHost();
    host.register({
      manifest: { id: "alpha", dependencies: ["beta"] },
    });
    host.register({
      manifest: { id: "beta", dependencies: ["alpha"] },
    });

    expect(() => host.resolveOrder()).toThrowError(/alpha -> beta -> alpha/);
  });
});
