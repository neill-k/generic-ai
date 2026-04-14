import { describe, expect, it } from "vitest";

import {
  createRootScope,
  ensureScope,
  getScope,
  hasScope,
  inheritScope,
  withChildScope,
  withScope,
} from "../../src/scope/index.ts";

describe("scope propagation helpers", () => {
  it("attaches a scope without mutating the source object", () => {
    const scope = createRootScope({ id: "root" });
    const source = { kind: "run", nested: true };

    const attached = withScope(source, scope);

    expect(attached).not.toBe(source);
    expect(attached.scope).toBe(scope);
    expect(source).not.toHaveProperty("scope");
    expect(hasScope(attached)).toBe(true);
    expect(getScope(attached)).toBe(scope);
  });

  it("derives and propagates a child scope for a new object", () => {
    const parent = createRootScope({ id: "root", kind: "framework" });
    const source = { kind: "plugin", task: "build" };

    const propagated = withChildScope(source, parent, {
      id: "child",
      label: "plugin child",
    });

    expect(propagated.scope.id).toBe("child");
    expect(propagated.scope.parentId).toBe("root");
    expect(propagated.scope.rootId).toBe("root");
    expect(propagated.scope.lineage).toEqual(["root", "child"]);
    expect(source).not.toHaveProperty("scope");
  });

  it("keeps an existing scope when asked to ensure one", () => {
    const existing = createRootScope({ id: "root" });
    const source = withScope({ payload: true }, existing);
    const ensured = ensureScope(source, createRootScope({ id: "fallback" }));

    expect(ensured.scope).toBe(existing);
  });

  it("creates a new scoped value from a parent scope when inheriting", () => {
    const parent = createRootScope({ id: "root" });
    const inherited = inheritScope({ payload: true }, parent, {
      id: "child",
      kind: "session",
    });

    expect(inherited.scope.id).toBe("child");
    expect(inherited.scope.kind).toBe("session");
    expect(inherited.scope.parentId).toBe("root");
    expect(inherited.scope.rootId).toBe("root");
  });
});
