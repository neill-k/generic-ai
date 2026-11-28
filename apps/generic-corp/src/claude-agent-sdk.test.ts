import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveModel } from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudePlanCompletion, planLimitFailure, sdkModelId } from "./claude-agent-sdk.js";
import { createCompanyTaskExecutor, runsOnClaudePlan } from "./executor.js";
import { readPlanLimitError } from "./plan-limit.js";
import { createCompanyRuntime } from "./runtime.js";
import { openCompanyStorage } from "./storage.js";

/*
 * These tests run the real Claude Agent SDK (and the Claude Code binary it ships) against a fake
 * Anthropic Messages server on localhost. No request leaves the machine and no model is called.
 */

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly input: unknown };

interface FakeRequest {
  readonly model: string;
  readonly system: string;
  readonly toolNames: readonly string[];
  readonly lastUser: string;
  /** How many messages the request carried: more than one means the conversation continued. */
  readonly messageCount: number;
  readonly conversation: string;
}

/** A Messages API stand-in. Each agent request (one that offers company tools) takes the next reply. */
async function fakeAnthropic(
  replies: Array<(request: FakeRequest) => Block[] | "fail" | Promise<Block[] | "fail">>,
  sideText = "ok",
) {
  const seen: FakeRequest[] = [];
  let toolUseCounter = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        json(200, { input_tokens: 1 });
        return;
      }
      const parsed = JSON.parse(body || "{}") as {
        model?: string;
        stream?: boolean;
        system?: string | Array<{ text?: string }>;
        tools?: Array<{ name: string }>;
        messages?: Array<{ role: string; content: unknown }>;
      };
      const toolNames = (parsed.tools ?? []).map((tool) => tool.name);
      const isAgentCall =
        parsed.stream === true && toolNames.some((name) => name.startsWith("mcp__company__"));
      let blocks: Block[] | "fail" = [{ type: "text", text: sideText }];
      if (isAgentCall) {
        const request: FakeRequest = {
          model: parsed.model ?? "",
          system: Array.isArray(parsed.system)
            ? parsed.system.map((part) => part.text ?? "").join("\n")
            : (parsed.system ?? ""),
          toolNames,
          lastUser: JSON.stringify(parsed.messages?.at(-1)?.content ?? ""),
          messageCount: parsed.messages?.length ?? 0,
          conversation: JSON.stringify(parsed.messages ?? []),
        };
        seen.push(request);
        const reply = replies.shift();
        blocks =
          reply === undefined
            ? [{ type: "text", text: "Nothing left to say." }]
            : await reply(request);
      }
      if (blocks === "fail") {
        // A request Anthropic refuses outright: the turn fails without the client retrying.
        json(401, {
          type: "error",
          error: { type: "authentication_error", message: "Fake failure for the test." },
        });
        return;
      }
      const hasToolUse = blocks.some((block) => block.type === "tool_use");
      if (parsed.stream !== true) {
        json(200, {
          id: "msg_side",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${seen.length}_${Math.random().toString(36).slice(2)}`,
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      blocks.forEach((block, index) => {
        if (block.type === "text") {
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          });
        } else {
          toolUseCounter += 1;
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: `toolu_${toolUseCounter}`,
              name: block.name,
              input: {},
            },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn" },
        usage: { output_tokens: 20 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

const tool = (name: string, input: unknown): Block => ({
  type: "tool_use",
  name: `mcp__company__${name}`,
  input,
});
const text = (value: string): Block => ({ type: "text", text: value });

const TRIVIAL_GOAL = {
  objective: "Do what the owner asked.",
  definitionOfDone: ["The work is handed in with a summary."],
  validators: [
    { id: "handed-in", kind: "output_schema", schema: { type: "object", required: ["summary"] } },
  ],
};

describe("turns on the Claude plan through the Agent SDK", () => {
  it("runs a goal end to end: the CEO delegates, the engineer writes and hands in", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-sdk-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const storage = await openCompanyStorage({ sqlitePath: path.join(dataDir, "company.sqlite") });
    cleanups.push(() => storage.close());

    const fake = await fakeAnthropic([
      // CEO turn 1: set the goal, then hand the work to the engineer.
      () => [tool("set_goal", TRIVIAL_GOAL)],
      () => [
        text(
          'Handing this over.\n```json\n{"delegate_task": [{"to": "engineer", "task": "Write hello.txt"}]}\n```',
        ),
      ],
      // Engineer: write the file, hand it in, answer.
      () => [tool("write", { path: "workspace/hello.txt", content: "hello" })],
      () => [
        tool("submit_work", {
          summary: "Wrote hello.txt.",
          deliverables: [{ path: "workspace/hello.txt" }],
        }),
      ],
      () => [text("Handed in.")],
      // CEO turn 2: hand in to the owner.
      () => [
        tool("submit_work", { summary: "Done: the engineer wrote hello.txt.", deliverables: [] }),
      ],
      () => [text("Handed in.")],
    ]);

    const executor = createCompanyTaskExecutor({
      runStore: storage.runStore,
      artifactsRoot: path.join(dataDir, "artifacts"),
      sessionsRoot: path.join(dataDir, "sessions"),
      noProgress: false,
      claudePlan: {
        active: () => true,
        token: () => "sk-ant-oat01-test-token-not-real",
        configDir: path.join(dataDir, "claude"),
        // The fake server stands in for Anthropic. An API key outranks the plan token in Claude
        // Code, which keeps the binary from reaching claude.ai for the token's profile.
        env: { ANTHROPIC_BASE_URL: fake.baseUrl, ANTHROPIC_API_KEY: "test-key-not-real" },
      },
    });
    const runtime = createCompanyRuntime({
      company: {
        name: "SDK Corp",
        models: {
          ceo: "anthropic/claude-opus-4-6",
          vp: "anthropic/claude-sonnet-4-6",
          ic: "anthropic/claude-sonnet-4-6",
        },
        agents: [
          { id: "ceo", role: "ceo" },
          { id: "engineer", role: "engineer", reportsTo: "ceo" },
        ],
      },
      storage,
      agentsRoot: path.join(dataDir, "agents"),
      executor,
    });
    await runtime.initialize();
    const { task } = await runtime.sendMessage({ text: "Say hello in a file." });
    await runtime.cascade.drain();

    const settled = await runtime.cascade.get(task.taskId);
    expect(settled?.failureMessage).toBeUndefined();
    expect(settled?.status).toBe("succeeded");
    expect(settled?.outputText).toBe("Done: the engineer wrote hello.txt.");

    // Each agent ran on its own model, with only the company's tools.
    expect(fake.seen.map((request) => request.model)).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-6",
    ]);
    // The CEO's second turn on the goal resumed its SDK session: the request carries turn one.
    expect(fake.seen[0]?.messageCount).toBe(1);
    expect(fake.seen[5]?.messageCount).toBeGreaterThan(3);
    expect(fake.seen[5]?.lastUser).toContain("engineer");
    const offered = fake.seen[0]?.toolNames ?? [];
    expect(offered).toContain("mcp__company__set_goal");
    expect(offered).toContain("mcp__company__write");
    expect(offered.filter((name) => !name.startsWith("mcp__"))).not.toContain("Bash");

    const engineer = await runtime.directory.require("engineer");
    expect(await readFile(path.join(engineer.homePath, "workspace", "hello.txt"), "utf8")).toBe(
      "hello",
    );

    // The turn's run is persisted with tool events the goal trace reads, and with usage.
    const runId = settled?.runIds[0] as string;
    const events = await storage.runStore.readEvents(runId);
    const names = events.map((event) => event.name);
    expect(names).toContain("run.completed");
    expect(names).toContain("plugin.claude-agent-sdk.tool_execution_start");
    expect(names).toContain("usage.recorded");
  }, 120_000);
  it("resumes a turn a restart cut off, in the same SDK session", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-sdk-resume-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const storage = await openCompanyStorage({ sqlitePath: path.join(dataDir, "company.sqlite") });
    cleanups.push(() => storage.close());
    let reachedCrash: () => void = () => {};
    const crashed = new Promise<void>((resolve) => {
      reachedCrash = resolve;
    });
    let releaseCrash: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseCrash = resolve;
    });
    const fake = await fakeAnthropic([
      // The turn writes a file, then the process stops while the next model call is in flight.
      () => [tool("write", { path: "b.txt", content: "b" })],
      async () => {
        reachedCrash();
        await released;
        return "fail" as const;
      },
      // The restarted server resumes the saved SDK session instead of starting over.
      () => [text("Task B done.")],
    ]);
    const executorOptions = {
      runStore: storage.runStore,
      artifactsRoot: path.join(dataDir, "artifacts"),
      sessionsRoot: path.join(dataDir, "sessions"),
      noProgress: false,
      claudePlan: {
        active: () => true,
        token: () => "sk-ant-oat01-test-token-not-real",
        configDir: path.join(dataDir, "claude"),
        env: {
          ANTHROPIC_BASE_URL: fake.baseUrl,
          ANTHROPIC_API_KEY: "test-key-not-real",
          // So the abandoned turn ends as soon as its model call is refused.
          CLAUDE_CODE_MAX_RETRIES: "0",
        },
      },
    } as const;
    const input = (attempt: number) => ({
      taskId: "task-b",
      attemptRunId: `task-b-attempt-${attempt}`,
      rootTaskId: "goal-1",
      agentId: "engineer",
      role: "engineer",
      model: "anthropic/claude-sonnet-4-6",
      prompt: "Do task B.",
      workspaceRoot: path.join(dataDir, "home"),
    });

    // An agent's home always exists; the SDK can't start in a folder that doesn't.
    mkdirSync(path.join(dataDir, "home"), { recursive: true });
    const abandoned = Promise.resolve(createCompanyTaskExecutor(executorOptions)(input(1))).catch(
      () => undefined,
    );
    await crashed;

    const restarted = createCompanyTaskExecutor(executorOptions);
    const retry = await restarted(input(2));
    releaseCrash();
    await abandoned;

    expect(retry.failureMessage).toBeUndefined();
    expect(retry.status).toBe("succeeded");
    expect(retry.outputText).toBe("Task B done.");
    // The retry carried the first attempt's step and asked to continue, without resending the task.
    const resumed = fake.seen[2];
    expect(resumed?.conversation).toContain("toolu_1");
    expect(resumed?.lastUser).toContain("previous turn was interrupted");
    expect(resumed?.conversation.split("Do task B.").length).toBe(2);
    expect(await readFile(path.join(dataDir, "home", "b.txt"), "utf8")).toBe("b");
  }, 120_000);

  it("stops a turn when the agent is held, and picks it up again afterwards", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-sdk-hold-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const storage = await openCompanyStorage({ sqlitePath: path.join(dataDir, "company.sqlite") });
    cleanups.push(() => storage.close());
    let held = false;
    const fake = await fakeAnthropic([
      () => {
        // The owner pauses the agent while its first step is in flight.
        held = true;
        return [tool("write", { path: "c.txt", content: "c" })];
      },
      () => [text("Task C done.")],
    ]);
    const executor = createCompanyTaskExecutor({
      runStore: storage.runStore,
      artifactsRoot: path.join(dataDir, "artifacts"),
      sessionsRoot: path.join(dataDir, "sessions"),
      noProgress: false,
      claudePlan: {
        active: () => true,
        token: () => "sk-ant-oat01-test-token-not-real",
        configDir: path.join(dataDir, "claude"),
        env: { ANTHROPIC_BASE_URL: fake.baseUrl, ANTHROPIC_API_KEY: "test-key-not-real" },
      },
    });
    mkdirSync(path.join(dataDir, "home"), { recursive: true });
    const input = (attempt: number) => ({
      taskId: "task-c",
      attemptRunId: `task-c-attempt-${attempt}`,
      rootTaskId: "goal-1",
      agentId: "engineer",
      role: "engineer",
      model: "anthropic/claude-sonnet-4-6",
      prompt: "Do task C.",
      workspaceRoot: path.join(dataDir, "home"),
      stopRequested: () => held,
    });

    const stopped = await executor(input(1));
    expect(stopped.status).toBe("failed");
    expect(stopped.failureMessage).toBe("Stopped: the agent was held mid-turn.");
    expect(fake.seen).toHaveLength(1);

    held = false;
    const after = await executor(input(2));
    expect(after.status).toBe("succeeded");
    expect(after.outputText).toBe("Task C done.");
    // The retry continued the stopped turn's SDK session rather than starting over.
    expect(fake.seen[1]?.messageCount).toBeGreaterThan(1);
    expect(fake.seen[1]?.lastUser).toContain("previous turn was interrupted");
    expect(fake.seen[1]?.conversation.split("Do task C.").length).toBe(2);
  }, 120_000);
});

describe("one-shot calls on the Claude plan", () => {
  it("answers a judge's call through the SDK, shaped like complete()", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-sdk-once-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const fake = await fakeAnthropic([], '{"verdict": "pass"}');
    let fellBack = 0;
    const completeOnPlan = createClaudePlanCompletion({
      active: () => true,
      token: () => "sk-ant-oat01-test-token-not-real",
      configDir: path.join(dataDir, "claude"),
      env: { ANTHROPIC_BASE_URL: fake.baseUrl, ANTHROPIC_API_KEY: "test-key-not-real" },
      fallback: async () => {
        fellBack += 1;
        throw new Error("should not fall back");
      },
    });
    const reply = await completeOnPlan(resolveModel("anthropic/claude-sonnet-4-6"), {
      systemPrompt: "You are a strict, fair grader. Reply with JSON only.",
      messages: [{ role: "user", content: "Grade this.", timestamp: Date.now() }],
    });
    expect(reply.errorMessage).toBeUndefined();
    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toEqual([{ type: "text", text: '{"verdict": "pass"}' }]);
    expect(reply.usage.totalTokens).toBeGreaterThan(0);
    expect(fellBack).toBe(0);
  }, 60_000);

  it("reports the plan's usage windows, and a reached limit in the hold's form", async () => {
    const seen: unknown[] = [];
    const query = () => {
      const messages = [
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            resetsAt: 1_800_000_000,
            rateLimitType: "five_hour",
            utilization: 1,
          },
        },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: ["429"] },
      ];
      return Object.assign(
        (async function* () {
          yield* messages;
        })(),
        { interrupt: async () => undefined },
      );
    };
    const completeOnPlan = createClaudePlanCompletion({
      active: () => true,
      token: () => "t",
      configDir: "/nonexistent",
      query,
      onRateLimit: (info) => seen.push(info),
    });
    const reply = await completeOnPlan(resolveModel("anthropic/claude-sonnet-4-6"), {
      messages: [{ role: "user", content: "Grade this.", timestamp: Date.now() }],
    });
    expect(seen).toEqual([
      { status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour", utilization: 1 },
    ]);
    expect(reply.stopReason).toBe("error");
    expect(readPlanLimitError(reply.errorMessage)?.getTime()).toBe(1_800_000_000_000);
  });

  it("leaves other models, and calls while the plan is off, to the fallback", async () => {
    const calls: string[] = [];
    const fallback = async (model: { id: string }) => {
      calls.push(model.id);
      return { stopReason: "stop" } as never;
    };
    const on = createClaudePlanCompletion({
      active: () => true,
      token: () => "t",
      configDir: "/nonexistent",
      fallback,
    });
    const off = createClaudePlanCompletion({
      active: () => false,
      token: () => "t",
      configDir: "/nonexistent",
      fallback,
    });
    const context = { messages: [] };
    await on(resolveModel("openai/gpt-5.5"), context);
    await off(resolveModel("anthropic/claude-sonnet-4-6"), context);
    expect(calls).toEqual(["gpt-5.5", "claude-sonnet-4-6"]);
  });
});

describe("Claude plan helpers", () => {
  it("routes only Claude models to the SDK, and only while the plan is active", async () => {
    const on = { active: () => true };
    const off = { active: async () => false };
    expect(await runsOnClaudePlan(on, "anthropic/claude-sonnet-4-6")).toBe(true);
    expect(await runsOnClaudePlan(on, "openai/gpt-5.5")).toBe(false);
    expect(await runsOnClaudePlan(off, "anthropic/claude-sonnet-4-6")).toBe(false);
    expect(await runsOnClaudePlan(undefined, "anthropic/claude-sonnet-4-6")).toBe(false);
  });

  it("names models the way the SDK expects", () => {
    expect(sdkModelId("anthropic/claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(sdkModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("reports a plan limit in the form the plan-reset hold reads", () => {
    const message = planLimitFailure(1_800_000_000, "five_hour");
    expect(readPlanLimitError(message)?.getTime()).toBe(1_800_000_000_000);
    expect(readPlanLimitError(planLimitFailure(undefined, undefined))).toBeNull();
  });
});
