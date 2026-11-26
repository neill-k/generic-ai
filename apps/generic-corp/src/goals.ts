import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { type AssistantMessage, complete, type Model, resolveModel } from "@generic-ai/ai";
import type {
  AgentDirectory,
  DelegationCascade,
  TaskGoalEvidenceInput,
} from "@generic-ai/plugin-delegation";
import {
  buildRubricJudgePrompt,
  type CanonicalEvent,
  type GoalEvidence,
  type GoalJudge,
  type GoalJudgment,
  goalTraceFromCanonicalEvents,
  type JsonValue,
  parseActorDirectives,
  parseGoalJudgment,
  type RunStoreContract,
} from "@generic-ai/sdk";

/**
 * How Generic Corp checks a goal. The CEO's goal is the company's goal, so it is judged on the
 * whole team's work, not only on the CEO's last turn:
 *
 * - **Trace**: the CEO's turn plus every run of every task delegated under it, so a goal can
 *   require that the research team searched the web or that someone wrote a document.
 * - **Deliverable**: when the final reply ends with a fenced JSON block naming a deliverable
 *   (`{"deliverable": {"agent": "vp-research", "path": "workspace/brief.md"}}`), the file is
 *   read from that agent's home and offered to validators as the `deliverable` artifact, with
 *   `deliverableWords`, `deliverableLines` and `deliverableLinks` (distinct web links) metrics. Rubrics then grade the work itself, not
 *   the CEO's summary of it.
 */
export const DELIVERABLE_ARTIFACT = "deliverable" as const;

/** Largest deliverable read into evidence. Longer files are cut, and the cut is noted. */
const MAX_DELIVERABLE_BYTES = 200_000;

const LINK = /https?:\/\/[^\s)\]>"'`]+/g;

/** Text formats a deliverable may use. Office files are converted by the agent, not here. */
const TEXT_DELIVERABLE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|html?)$/i;

export interface CompanyGoalEvidenceOptions {
  readonly runStore: Pick<RunStoreContract, "readEvents">;
  /** Looked up when evidence is collected, so it can be wired before the runtime exists. */
  readonly cascade: () => Pick<DelegationCascade, "tree">;
  readonly directory: () => Pick<AgentDirectory, "get">;
}

export interface CompanyGoalEvidence {
  readonly output?: JsonValue;
  readonly events: readonly CanonicalEvent[];
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly metrics?: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words === null ? 0 : words.length;
}

async function readDeliverable(
  directory: Pick<AgentDirectory, "get">,
  reference: unknown,
): Promise<{ text: string } | undefined> {
  if (!isRecord(reference)) {
    return undefined;
  }
  const agentId = reference["agent"];
  const filePath = reference["path"];
  if (
    typeof agentId !== "string" ||
    typeof filePath !== "string" ||
    !TEXT_DELIVERABLE.test(filePath)
  ) {
    return undefined;
  }
  const agent = await directory.get(agentId);
  if (agent === undefined) {
    return undefined;
  }
  const home = await realpath(agent.homePath);
  const resolved = path.resolve(home, filePath);
  try {
    const real = await realpath(resolved);
    if (real !== home && !real.startsWith(`${home}${path.sep}`)) {
      return undefined;
    }
    const buffer = await readFile(real);
    const text = buffer.subarray(0, MAX_DELIVERABLE_BYTES).toString("utf8");
    return {
      text:
        buffer.length > MAX_DELIVERABLE_BYTES
          ? `${text}\n\n[Cut at ${MAX_DELIVERABLE_BYTES} bytes of ${buffer.length}.]`
          : text,
    };
  } catch {
    return undefined;
  }
}

/**
 * Events of every run under a task: its own turns and everything delegated beneath it. Each run
 * belongs to one agent, so events that do not name a role are tagged with that agent's id; a
 * trace validator can then require that, say, the analyst wrote the brief.
 */
async function teamEvents(
  options: CompanyGoalEvidenceOptions,
  rootTaskId: string,
  extra: { readonly agentId?: string; readonly runIds: readonly string[] },
): Promise<CanonicalEvent[]> {
  const tasks = [...(await options.cascade().tree(rootTaskId))].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const owners = new Map<string, string | undefined>();
  for (const task of tasks) {
    for (const runId of task.runIds) {
      owners.set(runId, task.agentId);
    }
  }
  for (const runId of extra.runIds) {
    if (!owners.has(runId)) {
      owners.set(runId, extra.agentId);
    }
  }
  const events: CanonicalEvent[] = [];
  for (const [runId, agentId] of owners) {
    for (const event of await options.runStore.readEvents(runId)) {
      const named = event.data["roleId"] !== undefined || event.data["actorId"] !== undefined;
      events.push(
        named || agentId === undefined
          ? event
          : { ...event, data: { ...event.data, roleId: agentId } },
      );
    }
  }
  return events;
}

/** The company's evidence for a task: team trace, structured output and deliverable. */
export async function collectCompanyGoalEvidence(
  options: CompanyGoalEvidenceOptions,
  input: {
    readonly rootTaskId: string;
    readonly outputText: string;
    /** Runs of the turn being checked, which the task record may not list yet. */
    readonly runIds?: readonly string[];
    readonly agentId?: string;
  },
): Promise<CompanyGoalEvidence> {
  const events = await teamEvents(options, input.rootTaskId, {
    runIds: input.runIds ?? [],
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
  });
  const output = parseActorDirectives(input.outputText).data;
  const deliverable = isRecord(output)
    ? await readDeliverable(options.directory(), output["deliverable"])
    : undefined;
  return {
    ...(output === undefined ? {} : { output: output as JsonValue }),
    events,
    ...(deliverable !== undefined && "text" in deliverable
      ? {
          artifacts: { [DELIVERABLE_ARTIFACT]: deliverable.text },
          metrics: {
            deliverableWords: countWords(deliverable.text),
            deliverableLines: deliverable.text.split("\n").filter((line) => line.trim()).length,
            deliverableLinks: new Set(deliverable.text.match(LINK) ?? []).size,
          },
        }
      : {}),
  };
}

/** The cascade's `goals.evidence` hook for Generic Corp. */
export function createCompanyGoalEvidence(
  options: CompanyGoalEvidenceOptions,
): (input: TaskGoalEvidenceInput) => Promise<Partial<GoalEvidence>> {
  return async (input) => {
    const collected = await collectCompanyGoalEvidence(options, {
      rootTaskId: input.task.taskId,
      outputText: input.outputText,
      runIds: input.turnRunIds,
      agentId: input.task.agentId,
    });
    return {
      trace: goalTraceFromCanonicalEvents(collected.events),
      ...(collected.artifacts === undefined ? {} : { artifacts: collected.artifacts }),
      ...(collected.metrics === undefined ? {} : { metrics: collected.metrics }),
    };
  };
}

export interface ModelJudgeOptions {
  /** Model reference for grading, `provider/model-id`. */
  readonly model: string;
  readonly resolveModel?: (ref: string) => Model;
  /** Called with each grading call's usage, so an eval can count the judge against its cap. */
  readonly onUsage?: (usage: AssistantMessage["usage"]) => void;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

/**
 * A rubric judge backed by a model. It sees the rubric and the work only, never the agent's
 * conversation, and its reply is checked against the judgment schema; a malformed reply is an
 * error, which blocks completion rather than passing it.
 */
export function createModelJudge(options: ModelJudgeOptions): GoalJudge {
  const resolve = options.resolveModel ?? ((ref: string) => resolveModel(ref));
  return async (request): Promise<GoalJudgment> => {
    const model = resolve(options.model);
    const reply = await complete(
      model,
      {
        systemPrompt: "You are a strict, fair grader. Reply with JSON only.",
        messages: [
          { role: "user", content: buildRubricJudgePrompt(request), timestamp: Date.now() },
        ],
      },
      { signal: request.signal },
    );
    options.onUsage?.(reply.usage);
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(`The rubric judge failed: ${reply.errorMessage ?? reply.stopReason}`);
    }
    let parsed: unknown;
    try {
      parsed = jsonIn(textOf(reply));
    } catch {
      throw new Error("The rubric judge did not reply with JSON.");
    }
    const judgment = parseGoalJudgment(parsed);
    if (!judgment.ok) {
      throw new Error(
        `The rubric judge's reply did not match the schema: ${judgment.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return judgment.value;
  };
}
