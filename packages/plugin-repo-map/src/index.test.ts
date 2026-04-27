import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createRepoMapPlugin } from "./index.js";

describe("createRepoMapPlugin", () => {
  it("returns a deterministic compact repo map", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-repo-map-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: { test: "vitest", build: "tsc" },
        dependencies: { zod: "latest" },
      }),
      "utf8",
    );
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "node_modules", "ignored", "index.js"), "", "utf8");

    const plugin = createRepoMapPlugin({ root });
    const first = await plugin.snapshot();
    const second = await plugin.snapshot();

    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual(["package.json", "src/index.ts"]);
    expect(first.packages[0]).toMatchObject({
      name: "fixture",
      scripts: ["build", "test"],
      dependencies: ["zod"],
    });
  });
});
