import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createLspPlugin, type LspClient } from "./index.js";

describe("createLspPlugin", () => {
  it("routes document-symbol requests through the configured client", async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-ai-lsp-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const calls: { serverId: string; method: string; params: unknown }[] = [];
    const client: LspClient = {
      async request(serverId, method, params) {
        calls.push({ serverId, method, params });
        return [{ name: "value", kind: 14 }];
      },
    };

    const plugin = createLspPlugin({
      root,
      servers: [{ id: "ts", command: "typescript-language-server", args: ["--stdio"] }],
      client,
    });
    const result = await plugin.tool.execute(
      "tool-call-1",
      {
        action: "document-symbols",
        documentPath: "src/index.ts",
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      serverId: "ts",
      method: "textDocument/documentSymbol",
    });
    expect(result).toMatchObject({
      details: {
        action: "document-symbols",
        serverId: "ts",
        documentPath: "src/index.ts",
      },
    });
  });
});
