import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { startScriptedServer, startThread, tempDataDir, threadReply } from "./harness.js";

// A load test: many requests at once against one server process, half answered by the CEO
// directly and half delegated to the VP, while a busy dashboard polls every read endpoint.
//
// What must hold under load:
// - every request is answered, correctly, and no HTTP call fails;
// - accepting a request never waits for agent work;
// - an agent never runs two turns at once (each agent has one home and one memory file, so the
//   cascade queues an agent's turns), while different agents' turns do run side by side.
//
// One process's throughput is therefore bounded by its busiest agent: every owner request goes
// through the CEO, so N requests take about N CEO turns. The test prints the numbers. Sizes are
// adjustable for a heavier local run:
//
//   LOAD_THREADS=200 LOAD_MODEL_DELAY_MS=250 npx playwright test e2e/load.spec.ts

const THREADS = Number(process.env.LOAD_THREADS ?? "40");
const MODEL_DELAY_MS = Number(process.env.LOAD_MODEL_DELAY_MS ?? "100");
const READ_PAUSE_MS = Number(process.env.LOAD_READ_PAUSE_MS ?? "100");
const READ_PATHS = ["/api/board", "/api/costs", "/api/tasks", "/api/threads", "/api/org-chart"];

interface Peaks {
  readonly all: number;
  readonly byAgent: Readonly<Record<string, number>>;
  readonly calls: number;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

test(`load: ${THREADS} requests at once are all answered, one turn per agent at a time`, async () => {
  const testInfo = test.info();
  test.setTimeout(300_000);
  const data = tempDataDir();
  const statsFile = path.join(data.dir, "model-stats.json");
  const server = await startScriptedServer({
    dataDir: data.dir,
    env: {
      E2E_MODEL_DELAY_MS: String(MODEL_DELAY_MS),
      E2E_STATS_FILE: statsFile,
      ...(process.env.GENERIC_CORP_WORKER_CONCURRENCY === undefined
        ? {}
        : { GENERIC_CORP_WORKER_CONCURRENCY: process.env.GENERIC_CORP_WORKER_CONCURRENCY }),
    },
  });
  try {
    const kinds = Array.from({ length: THREADS }, (_, index) =>
      index % 2 === 0 ? ("hello" as const) : ("delegate" as const),
    );
    let reads = 0;
    const httpErrors: string[] = [];
    let loading = true;
    const reader = (async () => {
      while (loading) {
        await Promise.all(
          READ_PATHS.map(async (readPath) => {
            const response = await fetch(`${server.url}${readPath}`);
            reads += 1;
            if (!response.ok) {
              httpErrors.push(`GET ${readPath}: ${response.status}`);
            }
            await response.arrayBuffer();
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, READ_PAUSE_MS));
      }
    })();

    const started = Date.now();
    const sent = await Promise.all(
      kinds.map(async (kind, index) => {
        const sentAt = Date.now();
        const threadId = await startThread(
          server.url,
          kind === "hello"
            ? `Say hello, request ${index}.`
            : `Please delegate the chair count, request ${index}.`,
        );
        return { kind, threadId, sentAt };
      }),
    );
    const acceptedMs = Date.now() - started;

    const latencies: number[] = [];
    const wrong: string[] = [];
    await Promise.all(
      sent.map(async ({ kind, threadId, sentAt }) => {
        const deadline = Date.now() + 240_000;
        for (;;) {
          const reply = await threadReply(server.url, threadId);
          if (reply.status === "succeeded" || reply.status === "failed") {
            latencies.push(Date.now() - sentAt);
            const expected =
              kind === "hello" ? "Hello from the CEO." : "The VP reports: 42 chairs counted.";
            if (reply.status !== "succeeded" || reply.text !== expected) {
              wrong.push(`${threadId}: ${reply.status} ${reply.text ?? ""}`);
            }
            return;
          }
          if (Date.now() > deadline) {
            wrong.push(`${threadId}: still ${reply.status}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }),
    );
    const wallMs = Date.now() - started;
    loading = false;
    await reader;

    const peaks = JSON.parse(readFileSync(statsFile, "utf8")) as Peaks;
    const ceoCalls = kinds.reduce((sum, kind) => sum + (kind === "hello" ? 1 : 3), 0);
    const metrics = {
      threads: THREADS,
      modelDelayMs: MODEL_DELAY_MS,
      modelCalls: peaks.calls,
      acceptedMs,
      wallMs,
      requestsPerMinute: Math.round((THREADS / wallMs) * 60_000),
      // The CEO's model time alone, run back to back: the floor for one process.
      ceoSerialModelMs: ceoCalls * MODEL_DELAY_MS,
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: Math.max(...latencies),
      },
      peakModelCallsInFlight: peaks.all,
      peakPerAgent: peaks.byAgent,
      dashboardReads: reads,
      httpErrors: httpErrors.length,
    };
    console.log(JSON.stringify(metrics, null, 2));
    await testInfo.attach("load-metrics.json", {
      body: JSON.stringify(metrics, null, 2),
      contentType: "application/json",
    });

    expect(wrong, server.output()).toEqual([]);
    expect(httpErrors).toEqual([]);
    expect(acceptedMs).toBeLessThan(10_000);
    // One turn per agent at a time...
    for (const [agent, peak] of Object.entries(peaks.byAgent)) {
      expect(peak, `${agent} ran ${peak} turns at once`).toBe(1);
    }
    // ...while the CEO and the VP work side by side.
    expect(peaks.all).toBeGreaterThanOrEqual(2);
  } finally {
    await server.stop();
    data.remove();
  }
});
