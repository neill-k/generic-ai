import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLiveProviderSmokeTransport,
  LIVE_SMOKE_AGENT_DIR_ENV,
  LIVE_SMOKE_DONE_TEXT,
  LIVE_SMOKE_ENABLE_ENV,
  type LiveProviderSmokeCompletedResult,
  runLiveProviderSmoke,
} from "./live-smoke.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "example-starter-hono-live-"));
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

describe("@generic-ai/example-starter-hono live smoke", () => {
  it("returns a skipped result until live smoke is explicitly enabled", async () => {
    await withTempRoot(async (root) => {
      const result = await runLiveProviderSmoke({
        root,
        env: {},
      });

      expect(result.skipped).toBe(true);
      if (result.skipped) {
        expect(result.reason).toContain(LIVE_SMOKE_ENABLE_ENV);
      }
    });
  });

  it("requires credentials even after live smoke is enabled", async () => {
    await withTempRoot(async (root) => {
      const result = await runLiveProviderSmoke({
        root,
        env: {
          [LIVE_SMOKE_ENABLE_ENV]: "1",
          [LIVE_SMOKE_AGENT_DIR_ENV]: path.join(root, "empty-pi-agent"),
        },
      });

      expect(result.skipped).toBe(true);
      if (result.skipped) {
        expect(result.reason).toContain("No credentials");
      }
    });
  });

  it("streams a done event even when the live smoke run is skipped", async () => {
    await withTempRoot(async (root) => {
      const transport = createLiveProviderSmokeTransport({
        root,
        env: {},
      });
      const response = await transport.app.request("/starter/live/run/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "ignored" }),
      });
      const text = await response.text();

      expect(text).toContain("event: status");
      expect(text).toContain("event: done");
      expect(text).toContain('"skipped": true');
    });
  });

  it("runs the real provider smoke flow when explicitly enabled and configured", async () => {
    if (process.env[LIVE_SMOKE_ENABLE_ENV] !== "1") {
      return;
    }

    await withTempRoot(async (root) => {
      const transport = createLiveProviderSmokeTransport({
        root,
        env: process.env,
      });
      const response = await transport.app.request("/starter/live/run/stream", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "ignored" }),
      });
      const text = await response.text();

      if (text.includes('"skipped": true')) {
        throw new Error(
          "Live smoke was skipped but LIVE_PROVIDER_SMOKE is enabled — check credentials/model config",
        );
      }

      // Parse the done event payload to get the full result.
      // `createHonoPlugin` serialises with `JSON.stringify(..., 2)`, which
      // spreads the payload across multiple `data:` lines.  Collect every
      // consecutive `data:` line that follows `event: done`, strip the
      // prefix, and join them so `JSON.parse` receives the complete object.
      const doneSection = text.match(/event: done\n((?:data: .*\n?)+)/);
      expect(doneSection).not.toBeNull();
      const donePayload = doneSection?.[1];
      expect(donePayload).toBeDefined();
      if (donePayload === undefined) {
        throw new Error("Expected to capture the done event payload.");
      }

      const doneJson = donePayload
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      const doneData = JSON.parse(doneJson) as LiveProviderSmokeCompletedResult;

      // Verify agent_end was observed
      expect(doneData.sawAgentEnd).toBe(true);

      // Verify exactly 1 write and 1 read tool call
      const writeCalls = doneData.toolCalls.filter((tc) => tc.toolName === "write");
      const readCalls = doneData.toolCalls.filter((tc) => tc.toolName === "read");
      expect(writeCalls).toHaveLength(1);
      expect(readCalls).toHaveLength(1);

      // Verify write comes before read
      const writeIndex = doneData.toolCalls.findIndex((tc) => tc.toolName === "write");
      const readIndex = doneData.toolCalls.findIndex((tc) => tc.toolName === "read");
      expect(writeIndex).toBeLessThan(readIndex);

      // Verify assistant text matches expected done marker
      expect(doneData.assistantText).toBe(LIVE_SMOKE_DONE_TEXT);

      // Verify SSE structure
      expect(text).toContain("event: tool");
      expect(text).toContain("event: done");
    });
  }, 120_000);
});
