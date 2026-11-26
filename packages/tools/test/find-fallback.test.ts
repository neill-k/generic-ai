import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeGlob } from "../src/find.js";

const ignore = ["**/node_modules/**", "**/.git/**"];

describe("find fallback without fd", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "generic-ai-find-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(root, ".config"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "src", "nested", "b.ts"), "");
    writeFileSync(join(root, "src", "Readme.MD"), "");
    writeFileSync(join(root, "node_modules", "dep", "c.ts"), "");
    writeFileSync(join(root, ".config", "d.ts"), "");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("matches basenames at any depth, including hidden paths, skipping ignored ones", async () => {
    const results = await nodeGlob("*.ts", root, { ignore, limit: 100 });
    expect(results.sort()).toEqual([".config/d.ts", "src/a.ts", "src/nested/b.ts"]);
  });

  it("anchors path patterns at the search path", async () => {
    expect(await nodeGlob("src/*.ts", root, { ignore, limit: 100 })).toEqual(["src/a.ts"]);
    expect(await nodeGlob("./src/**/*.ts", root, { ignore, limit: 100 })).toEqual([
      "src/a.ts",
      "src/nested/b.ts",
    ]);
  });

  it("uses smart case and stops at the limit", async () => {
    expect(await nodeGlob("*.md", root, { ignore, limit: 100 })).toEqual(["src/Readme.MD"]);
    expect(await nodeGlob("*.MD", root, { ignore, limit: 100 })).toEqual(["src/Readme.MD"]);
    expect(await nodeGlob("*.Md", root, { ignore, limit: 100 })).toEqual([]);
    expect(await nodeGlob("*.ts", root, { ignore, limit: 2 })).toHaveLength(2);
  });
});
