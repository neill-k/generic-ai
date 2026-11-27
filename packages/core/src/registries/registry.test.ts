import { describe, expect, it } from "vitest";
import { RegistryError, createRegistry } from "./index.js";

describe("createRegistry", () => {
  it("keeps insertion order and rejects duplicates", () => {
    const registry = createRegistry<string>("plugins");

    registry.register("alpha", "A");
    registry.register("beta", "B");

    expect(registry.keys()).toEqual(["alpha", "beta"]);
    expect(registry.values()).toEqual(["A", "B"]);
    expect(() => registry.register("alpha", "again")).toThrow(RegistryError);
  });

  it("rejects blank keys with a clear diagnostic", () => {
    const registry = createRegistry<string>("plugins");

    expect(() => registry.register("   ", "value")).toThrowError(/does not accept blank keys/);
  });
});
