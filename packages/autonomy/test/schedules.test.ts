// Cases ported from Prime Agent's cron tests (`crates/pa-core/src/cron/mod.rs`, `scheduler.rs`).
import { describe, expect, it, vi } from "vitest";

import {
  cronMatches,
  createScheduleTools,
  failureBackoffMs,
  formatScheduledJob,
  isDueJob,
  nextRunAfter,
  parseHeartbeatCommand,
  parseSchedule,
  ScheduleBook,
  type ScheduledJob,
  ScheduleRunner,
  shouldDeferHeartbeat,
} from "../src/index.js";

const BASE = 1_700_000_000_000; // 2023-11-14T22:13:20Z

function hourMinute(millis: number): [number, number] {
  const date = new Date(millis);
  return [date.getUTCMinutes(), date.getUTCHours()];
}

describe("schedule expressions", () => {
  it("parses one-shot and interval schedules", () => {
    expect(parseSchedule("in 10m", BASE)).toMatchObject({
      schedule: { kind: "once" },
      nextRunAt: BASE + 600_000,
    });
    expect(parseSchedule("IN 2H", BASE)).toMatchObject({
      schedule: { kind: "once" },
      nextRunAt: BASE + 7_200_000,
    });
    expect(parseSchedule("each 30s", BASE)).toMatchObject({
      schedule: { kind: "interval", intervalMs: 30_000 },
      nextRunAt: BASE + 30_000,
    });
    expect(() => parseSchedule("every 5s", BASE)).toThrow("at least 10 seconds");
    expect(() => parseSchedule("", BASE)).toThrow("cannot be empty");
    expect(parseSchedule("at 2100-01-01T00:00:00Z", BASE).nextRunAt).toBe(4_102_444_800_000);
    expect(() => parseSchedule("at 1999-01-01T00:00:00Z", BASE)).toThrow("in the future");
    expect(() => parseSchedule("at tomorrow", BASE)).toThrow("at <ISO date>");
    expect(parseSchedule("'in 10m'", BASE).schedule.expression).toBe("in 10m");
  });

  it("evaluates cron expressions in UTC", () => {
    const hourly = parseSchedule("@hourly", BASE);
    expect(hourly.schedule).toEqual({ kind: "cron", expression: "0 * * * *" });
    expect(hourMinute(hourly.nextRunAt)).toEqual([0, 23]);
    expect(hourMinute(parseSchedule("0 12 * * *", BASE).nextRunAt)).toEqual([0, 12]);
    const weekdays = parseSchedule("*/15 9-17 * * 1-5", BASE).nextRunAt;
    expect(new Date(weekdays).getUTCMinutes() % 15).toBe(0);
    expect([1, 2, 3, 4, 5]).toContain(new Date(weekdays).getUTCDay());
    // Day-of-week 7 is Sunday.
    expect(cronMatches("0 0 * * 7", 4_102_617_600_000)).toBe(true);
    expect(() => parseSchedule("* * * *", BASE)).toThrow("five fields");
    expect(() => parseSchedule("60 * * * *", BASE)).toThrow("out of range");
    expect(() => parseSchedule("a * * * *", BASE)).toThrow("Invalid cron number");
    expect(() => parseSchedule("5-1 * * * *", BASE)).toThrow("Invalid cron range");
    expect(() => parseSchedule("0 0 31 2 *", BASE)).toThrow("within one year");
  });

  it("matches a minute-by-minute scan", () => {
    for (const expression of ["7 3 * * *", "*/20 */5 1,15 * *", "0 0 29 2 *", "30 8 * * 0"]) {
      const next = parseSchedule(expression, BASE).nextRunAt;
      let scan = (Math.floor(BASE / 60_000) + 1) * 60_000;
      while (!cronMatches(expression, scan)) {
        scan += 60_000;
      }
      expect(next).toBe(scan);
    }
  });

  it("rolls schedules to their next run", () => {
    const daily = parseSchedule("@daily", BASE);
    expect(nextRunAfter(daily.schedule, daily.nextRunAt)).toBe(daily.nextRunAt + 86_400_000);
    expect(
      nextRunAfter({ kind: "interval", expression: "every 10m", intervalMs: 600_000 }, BASE),
    ).toBe(BASE + 600_000);
    expect(nextRunAfter({ kind: "once", expression: "in 10m" }, BASE)).toBeUndefined();
  });
});

describe("heartbeat commands", () => {
  it("parses the /heartbeat grammar", () => {
    expect(parseHeartbeatCommand("status")).toEqual({ kind: "status" });
    expect(parseHeartbeatCommand("/heartbeat")).toEqual({ kind: "status" });
    expect(parseHeartbeatCommand("/heartbeat status")).toEqual({ kind: "status" });
    expect(parseHeartbeatCommand("/heartbeat pause")).toEqual({ kind: "pause" });
    expect(parseHeartbeatCommand("/heartbeat resume")).toEqual({ kind: "resume" });
    expect(parseHeartbeatCommand("/heartbeat stop")).toEqual({ kind: "clear" });
    expect(parseHeartbeatCommand("/heartbeat check the build")).toEqual({
      kind: "set",
      schedule: "every 5m",
      instruction: "check the build",
    });
    expect(parseHeartbeatCommand("/heartbeat --every 10m keep going")).toMatchObject({
      schedule: "every 10m",
      instruction: "keep going",
    });
    expect(parseHeartbeatCommand('/heartbeat --every="15 m" watch things')).toMatchObject({
      schedule: "every 15 m",
      instruction: "watch things",
    });
    expect(parseHeartbeatCommand("/heartbeat every 2h sweep logs")).toMatchObject({
      schedule: "every 2h",
      instruction: "sweep logs",
    });
    expect(parseHeartbeatCommand("/heartbeat --steer --every 5m ping")).toMatchObject({
      deliveryMode: "steer",
    });
    expect(parseHeartbeatCommand("/heartbeat --every 5m ping --follow-up")).toMatchObject({
      deliveryMode: "follow_up",
      instruction: "ping",
    });
    expect(parseHeartbeatCommand("/heartbeat --deliver=steer --every 5m ping")).toMatchObject({
      deliveryMode: "steer",
    });
    expect(parseHeartbeatCommand("/heartbeat --deliver follow_up --every 5m ping")).toMatchObject({
      deliveryMode: "follow_up",
    });
    expect(() => parseHeartbeatCommand("/heartbeat --every 10m")).toThrow("Usage");
    expect(() => parseHeartbeatCommand("/heartbeat --deliver=sideways ping")).toThrow(
      "delivery mode",
    );
  });
});

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job1",
    status: "active",
    source: "cron",
    prompt: "ping",
    schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
    createdAt: "",
    updatedAt: "",
    nextRunAt: "2000-01-01T00:00:00.000Z",
    runCount: 0,
    failureStreak: 0,
    ...overrides,
  };
}

describe("jobs", () => {
  it("defers heartbeats while the session is busy", () => {
    const streaming = { isStreaming: true };
    expect(shouldDeferHeartbeat(job(), streaming)).toBe(false);
    expect(
      shouldDeferHeartbeat(job({ source: "heartbeat", deliveryMode: "steer" }), streaming),
    ).toBe(false);
    expect(
      shouldDeferHeartbeat(job({ source: "heartbeat", deliveryMode: "follow_up" }), streaming),
    ).toBe(true);
    expect(
      shouldDeferHeartbeat(job({ source: "heartbeat" }), { isStreaming: true, isCompacting: true }),
    ).toBe(true);
    expect(shouldDeferHeartbeat(job({ source: "heartbeat" }), { unfinishedActionCount: 2 })).toBe(
      true,
    );
    expect(shouldDeferHeartbeat(job({ source: "heartbeat" }), {})).toBe(false);
  });

  it("finds due jobs and formats them", () => {
    const sweep = job({ label: "sweep", runCount: 3, prompt: "keep   working", lastError: "boom" });
    expect(isDueJob(sweep, 946_684_800_001)).toBe(true);
    expect(isDueJob(sweep, 946_684_799_999)).toBe(false);
    expect(isDueJob({ ...sweep, status: "paused" }, 946_684_800_001)).toBe(false);
    const formatted = formatScheduledJob(sweep);
    expect(formatted.startsWith('job1 active label="sweep" next=2000-01-01T00:00:00.000Z')).toBe(
      true,
    );
    expect(formatted).toContain('runs=3 schedule="every 5m" prompt="keep working" error=boom');
  });

  it("backs failures off from two minutes to an hour", () => {
    expect(failureBackoffMs(1)).toBe(120_000);
    expect(failureBackoffMs(2)).toBe(240_000);
    expect(failureBackoffMs(3)).toBe(480_000);
    expect(failureBackoffMs(20)).toBe(3_600_000);
  });
});

describe("schedule book", () => {
  function book(start = BASE) {
    let now = start;
    let ids = 0;
    const saved: unknown[] = [];
    const value = new ScheduleBook({
      now: () => now,
      newId: () => `j${++ids}`,
      persist: (state) => saved.push(state),
    });
    return { book: value, saved, at: (millis: number) => (now = millis) };
  }

  it("claims due jobs once, completes one-shots and rolls recurring jobs", () => {
    const { book: jobs, saved, at } = book();
    const once = jobs.add({ prompt: "remind me", schedule: "in 10m" });
    const every = jobs.add({ prompt: "check", schedule: "every 5m", label: " sweep " });
    expect(every.label).toBe("sweep");
    expect(jobs.claimDue()).toEqual([]);
    at(BASE + 600_000);
    const claimed = jobs.claimDue();
    expect(claimed.map((entry) => entry.job.id)).toEqual([once.id, every.id]);
    expect(jobs.claimDue()).toEqual([]);
    jobs.recordRun(once.id);
    jobs.recordRun(every.id);
    expect(jobs.get(once.id)).toMatchObject({ status: "completed", runCount: 1 });
    expect(jobs.get(once.id)?.nextRunAt).toBeUndefined();
    expect(jobs.get(every.id)).toMatchObject({
      status: "active",
      nextRunAt: new Date(BASE + 900_000).toISOString(),
    });
    expect(jobs.list().map((entry) => entry.id)).toEqual([every.id]);
    expect(saved.length).toBeGreaterThan(4);
    const restored = new ScheduleBook({ state: jobs.state });
    expect(restored.get(every.id)?.runCount).toBe(1);
  });

  it("pushes a failing job back and clears the streak on success", () => {
    const { book: jobs, at } = book();
    const every = jobs.add({ prompt: "check", schedule: "every 1m" });
    at(BASE + 60_000);
    jobs.claimDue();
    jobs.recordRun(every.id, { error: "provider down" });
    expect(jobs.get(every.id)).toMatchObject({ failureStreak: 1, lastError: "provider down" });
    expect(jobs.get(every.id)?.nextRunAt).toBe(new Date(BASE + 180_000).toISOString());
    at(BASE + 180_000);
    jobs.claimDue();
    jobs.recordRun(every.id);
    expect(jobs.get(every.id)).toMatchObject({ failureStreak: 0 });
    expect(jobs.get(every.id)?.lastError).toBeUndefined();
  });

  it("keeps one live heartbeat and manages it", () => {
    const { book: jobs, at } = book();
    const first = jobs.setHeartbeat({ instruction: "check CI" });
    expect(first).toMatchObject({
      source: "heartbeat",
      deliveryMode: "steer",
      schedule: { expression: "every 5m" },
    });
    const second = jobs.setHeartbeat({ instruction: "check CI", schedule: "10m" });
    expect(jobs.get(first.id)?.status).toBe("cancelled");
    expect(jobs.heartbeat()?.id).toBe(second.id);
    expect(() => jobs.setHeartbeat({ instruction: "x", schedule: "in 5m" })).toThrow("recurring");
    expect(jobs.manageHeartbeat("pause")).toMatchObject({ status: "paused" });
    expect(jobs.nextWakeAt()).toBeUndefined();
    at(BASE + 1_000_000);
    expect(jobs.manageHeartbeat("resume")?.nextRunAt).toBe(
      new Date(BASE + 1_600_000).toISOString(),
    );
    expect(jobs.manageHeartbeat("stop")).toMatchObject({ status: "cancelled" });
    expect(jobs.manageHeartbeat("pause")).toBeUndefined();
  });

  it("skips a deferred run to the next slot", () => {
    const { book: jobs, at } = book();
    const beat = jobs.setHeartbeat({ instruction: "check" });
    at(BASE + 300_000);
    jobs.claimDue();
    jobs.recordSkip(beat.id);
    expect(jobs.get(beat.id)).toMatchObject({
      runCount: 0,
      lastSkippedAt: new Date(BASE + 300_000).toISOString(),
      nextRunAt: new Date(BASE + 600_000).toISOString(),
    });
  });
});

describe("schedule tools", () => {
  it("adds, lists and cancels jobs and sets the heartbeat", async () => {
    const jobs = new ScheduleBook({ now: () => BASE, newId: () => "abc" });
    const tools = Object.fromEntries(createScheduleTools(jobs).map((tool) => [tool.name, tool]));
    expect(Object.keys(tools)).toEqual([
      "cron_add",
      "cron_list",
      "cron_cancel",
      "heartbeat_set",
      "heartbeat_manage",
    ]);
    const added = await tools["cron_add"]?.execute("1", { prompt: "report", schedule: "@daily" });
    expect(added?.content[0]).toMatchObject({
      text: expect.stringContaining("Scheduled abc active"),
    });
    const listed = await tools["cron_list"]?.execute("2", {});
    expect(listed?.content[0]).toMatchObject({
      text: expect.stringContaining('schedule="0 0 * * *"'),
    });
    await tools["cron_cancel"]?.execute("3", { id: "abc" });
    await expect(tools["cron_cancel"]?.execute("4", { id: "abc" })).rejects.toThrow("no active");
    const beats = new ScheduleBook({ now: () => BASE });
    const beatTools = createScheduleTools(beats);
    await beatTools
      .find((tool) => tool.name === "heartbeat_set")
      ?.execute("5", {
        instruction: "check",
        every: "1h",
        delivery_mode: "follow_up",
      });
    expect(beats.heartbeat()).toMatchObject({
      deliveryMode: "follow_up",
      schedule: { expression: "every 1h" },
    });
    expect(createScheduleTools(beats, { heartbeat: false })).toHaveLength(3);
  });
});

describe("schedule runner", () => {
  it("wakes for due jobs, records skips and errors, and re-arms on changes", async () => {
    vi.useFakeTimers({ now: BASE });
    try {
      const jobs = new ScheduleBook();
      const runs: string[] = [];
      const runner = new ScheduleRunner({
        book: jobs,
        run: ({ job }) => {
          runs.push(job.prompt);
          if (job.prompt === "fail") {
            throw new Error("boom");
          }
          return job.source === "heartbeat" ? "skipped" : "ran";
        },
      });
      runner.start();
      jobs.add({ prompt: "first", schedule: "in 1m" });
      jobs.add({ prompt: "fail", schedule: "in 2m" });
      const beat = jobs.setHeartbeat({ instruction: "beat", schedule: "every 90s" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toEqual(["first", "beat", "fail"]);
      expect(jobs.get(beat.id)?.lastSkippedAt).toBeDefined();
      expect(
        jobs.list({ includeInactive: true }).find((job) => job.prompt === "fail"),
      ).toMatchObject({
        status: "completed",
        lastError: "boom",
      });
      await runner.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runs).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
