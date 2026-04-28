import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..");

describe("@generic-ai/plugin-web-ui import boundaries", () => {
  it("keeps the browser client separated from Node, core, and server entrypoints", async () => {
    const client = await readFile(join(packageRoot, "src", "client.tsx"), "utf8");

    expect(client).not.toMatch(/from\s+["']node:/);
    expect(client).not.toContain("@generic-ai/core");
    expect(client).not.toContain("@generic-ai/preset-");
    expect(client).not.toMatch(/from\s+["']\.\/server\.js["']/);
    expect(client).not.toMatch(/from\s+["']@generic-ai\/plugin-web-ui\/server["']/);
  });

  it("keeps server-only packages out of the public client export", async () => {
    const packageJson = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as {
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports).toHaveProperty("./client");
    expect(packageJson.exports).toHaveProperty("./server");
    expect(packageJson.exports).toHaveProperty("./agent-tools");
    expect(packageJson.exports).toHaveProperty("./styles.css");
  });
});
