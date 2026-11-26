import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import type { DurableQueueContract, DurableQueueEnqueueInput } from "@generic-ai/sdk";
import { SessionManager } from "@generic-ai/session";
import { afterEach, describe, expect, it } from "vitest";

import {
  createScheduledSessionService,
  loadSessionScheduleBook,
  SCHEDULED_SESSION_JOB,
  type ScheduledSessionFire,
  type ScheduledSessionFireResult,
} from "./native-schedules.js";
import { runCapabilityNativeAgentSession } from "./native-session.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
});

function provider() {
  const registration = registerFauxProvider({ models: [{ id: "schedules" }] });
  registrations.push(registration);
  return registration;
}

function userTexts(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => ("text" in block ? block.text : "")).join(""),
    );
}

function fakeQueue() {
  const enqueued: DurableQueueEnqueueInput<ScheduledSessionFire>[] = [];
  const queue = {
    kind: "queue",
    driver: "fake",
    durable: true,
    enqueue: async (input: DurableQueueEnqueueInput<ScheduledSessionFire>) => {
      enqueued.push(input);
      return input;
    },
  } as unknown as DurableQueueContract<ScheduledSessionFire, ScheduledSessionFireResult>;
  return { queue, enqueued };
}

describe("native session schedules", () => {
  it("lets the agent schedule a prompt and saves it in the session", async () => {
    const faux = provider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("cron_add", { prompt: "Send the weekly report", schedule: "0 9 * * 1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Scheduled."),
    ]);
    const manager = SessionManager.inMemory("/tmp/work");

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Every Monday at 9, send the weekly report.",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction: false,
      retry: false,
      schedules: true,
    });

    expect(result.failureMessage).toBeUndefined();
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules?.[0]).toMatchObject({
      source: "cron",
      prompt: "Send the weekly report",
      schedule: { kind: "cron", expression: "0 9 * * 1" },
    });
    expect(loadSessionScheduleBook(manager).list()).toHaveLength(1);
  });

  it("steers a due heartbeat into the turn in progress", async () => {
    const faux = provider();
    const manager = SessionManager.inMemory("/tmp/work");
    const seeded = loadSessionScheduleBook(manager, { now: () => Date.now() - 400_000 });
    seeded.setHeartbeat({ instruction: "Check the CI run." });
    let seen: string[] = [];
    faux.setResponses([
      async () => {
        // The heartbeat is due but waits for a turn in progress; give the runner time to deliver.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return fauxAssistantMessage(fauxToolCall("cron_list", {}), { stopReason: "toolUse" });
      },
      (context) => {
        seen = userTexts(context);
        return fauxAssistantMessage("CI is green.");
      },
    ]);

    const result = await runCapabilityNativeAgentSession({
      cwd: "/tmp/work",
      model: faux.getModel(),
      capabilities: {},
      prompt: "Keep an eye on CI.",
      turnMode: "single-turn",
      sessionManager: manager,
      compaction: false,
      retry: false,
      schedules: true,
    });

    expect(result.failureMessage).toBeUndefined();
    expect(seen.at(-1)).toContain("[heartbeat");
    expect(seen.at(-1)).toContain("Check the CI run.");
    const fired = result.events.find((event) => event.name.endsWith("native.schedule_fired"));
    expect(fired?.data).toMatchObject({ source: "heartbeat", delivery: "steer" });
    expect(result.schedules?.[0]).toMatchObject({ runCount: 1 });
  });
});

describe("scheduled session service", () => {
  it("resumes a stored session for a due job and queues the next slot", async () => {
    const faux = provider();
    const manager = SessionManager.inMemory("/tmp/work");
    const book = loadSessionScheduleBook(manager, { now: () => Date.now() - 120_000 });
    const once = book.add({ prompt: "Write the summary.", schedule: "in 1m" });
    const every = book.add({ prompt: "Check the inbox.", schedule: "every 1h" });
    const { queue, enqueued } = fakeQueue();
    const prompts: string[] = [];
    const service = createScheduledSessionService({
      queue,
      openSession: () => manager,
      runSession: async ({ sessionManager, prompt }) => {
        prompts.push(prompt);
        faux.setResponses([fauxAssistantMessage("Done.")]);
        return runCapabilityNativeAgentSession({
          cwd: "/tmp/work",
          model: faux.getModel(),
          capabilities: {},
          prompt,
          turnMode: "single-turn",
          sessionManager,
          compaction: false,
          retry: false,
          schedules: true,
        });
      },
    });

    expect(await service.sync("session-1")).toBe(2);
    expect(enqueued[0]).toMatchObject({
      name: SCHEDULED_SESSION_JOB,
      concurrencyKey: "native-session:session-1",
      payload: { sessionFile: "session-1", jobId: once.id },
    });
    const fire = enqueued[0]?.payload as ScheduledSessionFire;

    const ran = await service.handle({ payload: fire });
    expect(ran).toEqual({ outcome: "ran", jobId: once.id });
    expect(prompts[0]).toMatch(/^\[scheduled job [0-9a-f]+, in 1m\]\nWrite the summary\.$/);
    expect(loadSessionScheduleBook(manager).get(once.id)).toMatchObject({
      status: "completed",
      runCount: 1,
    });
    expect(await service.handle({ payload: fire })).toMatchObject({ outcome: "stale" });

    const release = service.markOpen("session-1");
    const before = enqueued.length;
    expect(await service.handle({ payload: fire })).toMatchObject({ outcome: "busy" });
    expect(enqueued.length).toBe(before + 1);
    release();

    // Run the recurring job at its next slot, and fail it.
    const current = loadSessionScheduleBook(manager).get(every.id);
    const lateService = createScheduledSessionService({
      queue,
      openSession: () => manager,
      now: () => Date.parse(current?.nextRunAt ?? "") + 1,
      runSession: async () => {
        throw new Error("provider down");
      },
    });
    const failed = await lateService.handle({
      payload: {
        sessionFile: "session-1",
        jobId: every.id,
        scheduledFor: current?.nextRunAt ?? "",
      },
    });
    expect(failed).toEqual({ outcome: "failed", jobId: every.id, error: "provider down" });
    expect(loadSessionScheduleBook(manager).get(every.id)).toMatchObject({
      failureStreak: 1,
      lastError: "provider down",
    });
    expect(enqueued.at(-1)?.payload.jobId).toBe(every.id);
  });
});
