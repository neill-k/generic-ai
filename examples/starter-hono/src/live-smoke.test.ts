import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLiveProviderSmokeTransport,
  LIVE_SMOKE_DONE_TEXT,
  LIVE_SMOKE_ENABLE_ENV,
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
        return;
      }

      expect(text).toContain("event: tool");
      expect(text).toContain('"toolName": "write"');
      expect(text).toContain('"toolName": "read"');
      expect(text).toContain("event: done");
      expect(text).toContain(`"assistantText": "${LIVE_SMOKE_DONE_TEXT}"`);
    });
  }, 120_000);
});
