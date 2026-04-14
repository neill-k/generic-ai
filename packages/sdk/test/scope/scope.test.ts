import { describe, expect, it } from "vitest";

import {
  createChildScope,
  createRootScope,
  createScope,
  isRootScope,
  isScope,
  scopeChain,
  scopeDepth,
  scopeLineage,
  scopeRootId,
} from "../../src/scope/index.ts";

describe("scope primitive", () => {
  it("creates an immutable root scope", () => {
    const scope = createRootScope({
      id: "root",
      kind: "framework",
      label: "bootstrap",
      metadata: { phase: "initial" },
    });

    expect(scope.id).toBe("root");
    expect(scope.rootId).toBe("root");
    expect(scope.parentId).toBeUndefined();
    expect(scope.lineage).toEqual(["root"]);
    expect(scopeDepth(scope)).toBe(0);
    expect(scopeRootId(scope)).toBe("root");
    expect(scopeLineage(scope)).toEqual(["root"]);
    expect(scopeChain(scope)).toEqual(["root"]);
    expect(isRootScope(scope)).toBe(true);
    expect(isScope(scope)).toBe(true);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.lineage)).toBe(true);
    expect(Object.isFrozen(scope.metadata)).toBe(true);
  });

  it("creates a child scope with inherited lineage", () => {
    const parent = createRootScope({ id: "root", kind: "framework" });
    const child = createChildScope(parent, {
      id: "plugin-run",
      label: "plugin execution",
      metadata: { step: "delegate" },
    });

    expect(child.id).toBe("plugin-run");
    expect(child.parentId).toBe("root");
    expect(child.rootId).toBe("root");
    expect(child.kind).toBe("framework");
    expect(child.lineage).toEqual(["root", "plugin-run"]);
    expect(scopeDepth(child)).toBe(1);
    expect(isRootScope(child)).toBe(false);
  });

  it("creates a child scope through the generic factory", () => {
    const parent = createRootScope({ id: "root" });
    const child = createScope({
      parent,
      id: "child",
      kind: "session",
    });

    expect(child.id).toBe("child");
    expect(child.parentId).toBe("root");
    expect(child.rootId).toBe("root");
    expect(child.kind).toBe("session");
  });
});
