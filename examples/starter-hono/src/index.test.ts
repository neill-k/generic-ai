import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createReferenceExampleHarness,
  runReferenceExample,
} from "./index.js";
import { runStarterExampleCli } from "./run.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "example-starter-hono-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/example-starter-hono", () => {
  it("assembles the starter stack and proves the reference flow end to end", async () => {
    await withTempRoot(async (root) => {
      const harness = await createReferenceExampleHarness({ root });
      const run = await harness.run("the demo stack");

      expect(run.bootstrapDescription).toContain("Starter Hono preset");
      expect(run.delegatedSummary).toContain("Implementer saw");
      expect(run.skillNames).toContain("starter-summarizer");
      expect(run.mcpServers).toEqual(["filesystem"]);
      expect(run.transportHealth).toEqual({
        transport: "@generic-ai/plugin-hono",
        streaming: true,
      });

      const streamed = await harness.transport.app.request("/starter/run/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: "streamed demo",
        }),
      });
      const streamedText = await streamed.text();

      expect(streamedText).toContain("event: status");
      expect(streamedText).toContain("event: done");

      const convenienceRun = await runReferenceExample({ root }, "convenience");
      expect(convenienceRun.inboxSize).toBeGreaterThan(0);
    });
  });

  it("runs the fresh-clone CLI path when the provider key is present", async () => {
    await withTempRoot(async (root) => {
      const lines: string[] = [];
      const run = await runStarterExampleCli({
        args: ["fresh", "clone"],
        env: {
          ...process.env,
          GENERIC_AI_PROVIDER_API_KEY: "test-key",
          GENERIC_AI_WORKSPACE_ROOT: root,
        },
        log: (message) => lines.push(message),
      });

      expect(run.bootstrapDescription).toContain("Starter Hono preset");
      expect(lines.join("\n")).toContain("Workspace:");
      expect(lines.join("\n")).toContain("fresh clone");
    });
  });

  it("fails the CLI path clearly when the provider key is missing", async () => {
    await expect(
      runStarterExampleCli({
        env: {
          GENERIC_AI_WORKSPACE_ROOT: "unused",
        },
        log: () => undefined,
      }),
    ).rejects.toThrow("GENERIC_AI_PROVIDER_API_KEY must be set");
  });
});
