// Agent tools over a session's schedule book, adapted from Prime Agent's scheduling catalog (`cron_add`,
// `cron_list`, `cron_cancel`, `heartbeat_set`, `heartbeat_manage`; PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { AgentToolResult } from "@generic-ai/agent";
import { Type } from "@sinclair/typebox";

import { normalizeDeliveryMode } from "./schedule.js";
import { formatScheduledJob, type ScheduleBook, type ScheduledJob } from "./schedules.js";
import type { GoalTool } from "./tools.js";

export const CRON_ADD_TOOL = "cron_add";
export const CRON_LIST_TOOL = "cron_list";
export const CRON_CANCEL_TOOL = "cron_cancel";
export const HEARTBEAT_SET_TOOL = "heartbeat_set";
export const HEARTBEAT_MANAGE_TOOL = "heartbeat_manage";

export interface ScheduleToolsOptions {
  /** Give the agent the heartbeat tools. Default true. */
  readonly heartbeat?: boolean | undefined;
  /** At most this many active or paused jobs. Default 20. */
  readonly maxJobs?: number | undefined;
}

function text(lines: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: lines }], details };
}

function describe(job: ScheduledJob): string {
  return formatScheduledJob(job);
}

export function createScheduleTools(
  book: ScheduleBook,
  options: ScheduleToolsOptions = {},
): GoalTool[] {
  const maxJobs = options.maxJobs ?? 20;
  const tools: GoalTool[] = [
    {
      name: CRON_ADD_TOOL,
      label: "Schedule prompt",
      description:
        "Schedule a prompt to run in this session later or on a schedule. Schedules: `in 10m`, `at 2026-01-01T09:00:00Z`, `every 30m` (at least 10 seconds), `@hourly`, `@daily`, `@weekly`, `@monthly`, or five cron fields `minute hour day month weekday` in UTC. When the session is idle the prompt starts a new turn; while you are working it arrives as a follow-up.",
      promptSnippet: "schedule a prompt for later or on a recurring schedule",
      parameters: Type.Object({
        prompt: Type.String({ description: "What to do when the job runs." }),
        schedule: Type.String({
          description: "When to run, for example `in 1h` or `0 9 * * 1-5`.",
        }),
        label: Type.Optional(Type.String({ description: "A short name for the job." })),
      }),
      execute: async (_id, params) => {
        if (book.list().length >= maxJobs) {
          throw new Error(`cannot schedule more than ${maxJobs} jobs; cancel one first`);
        }
        const job = book.add({
          prompt: params.prompt,
          schedule: params.schedule,
          label: params.label,
        });
        return text(`Scheduled ${describe(job)}`, job);
      },
    },
    {
      name: CRON_LIST_TOOL,
      label: "List schedules",
      description: "List this session's scheduled prompts and heartbeat with their next runs.",
      parameters: Type.Object({
        include_inactive: Type.Optional(
          Type.Boolean({ description: "Also list completed and cancelled jobs." }),
        ),
      }),
      execute: async (_id, params) => {
        const jobs = book.list({ includeInactive: params.include_inactive === true });
        return text(jobs.length === 0 ? "No scheduled jobs." : jobs.map(describe).join("\n"), jobs);
      },
    },
    {
      name: CRON_CANCEL_TOOL,
      label: "Cancel schedule",
      description: "Cancel a scheduled prompt or the heartbeat by its id.",
      parameters: Type.Object({ id: Type.String({ description: "The job id from cron_list." }) }),
      execute: async (_id, params) => {
        const job = book.cancel(params.id);
        if (job === undefined) {
          throw new Error(`no active or paused job has id ${params.id}`);
        }
        return text(`Cancelled ${describe(job)}`, job);
      },
    },
  ];
  if (options.heartbeat ?? true) {
    tools.push(
      {
        name: HEARTBEAT_SET_TOOL,
        label: "Set heartbeat",
        description:
          "Start this session's heartbeat: an instruction that recurs on a schedule (default every 5m) to keep checking on long-running work. Replaces the current heartbeat. A heartbeat waits for its next slot while the session is compacting, retrying or running a command. `steer` (default) also reaches you mid-turn; `follow_up` waits until the turn ends.",
        promptSnippet: "set a recurring heartbeat to keep checking on long-running work",
        parameters: Type.Object({
          instruction: Type.String({ description: "What to check or do on each beat." }),
          every: Type.Optional(
            Type.String({
              description: "A recurring schedule such as `10m`, `every 1h` or `@hourly`.",
            }),
          ),
          delivery_mode: Type.Optional(
            Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
          ),
        }),
        execute: async (_id, params) => {
          const job = book.setHeartbeat({
            instruction: params.instruction,
            schedule: params.every,
            deliveryMode: normalizeDeliveryMode(params.delivery_mode),
          });
          return text(`Heartbeat set: ${describe(job)}`, job);
        },
      },
      {
        name: HEARTBEAT_MANAGE_TOOL,
        label: "Manage heartbeat",
        description: "Pause, resume or stop this session's heartbeat.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop")]),
        }),
        execute: async (_id, params) => {
          const job = book.manageHeartbeat(params.action);
          if (job === undefined) {
            throw new Error("this session has no heartbeat");
          }
          return text(`Heartbeat ${job.status}: ${describe(job)}`, job);
        },
      },
    );
  }
  return tools;
}
