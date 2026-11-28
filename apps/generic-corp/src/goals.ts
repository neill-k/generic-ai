import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { type AssistantMessage, complete, type Model, resolveModel } from "@generic-ai/ai";
import {
  type AgentDirectory,
  type AgentTaskDeliverable,
  type AgentTaskHandIn,
  type DelegationCascade,
  handInOutput,
  type TaskGoalEvidenceInput,
} from "@generic-ai/plugin-delegation";
import {
  buildRubricJudgePrompt,
  type CanonicalEvent,
  type GoalEvidence,
  type GoalJudge,
  type GoalJudgment,
  goalTraceFromCanonicalEvents,
  type JsonValue,
  parseGoalJudgment,
  type RunStoreContract,
} from "@generic-ai/sdk";

/**
 * How Generic Corp checks a goal. The CEO's goal is the company's goal, so it is judged on the
 * whole team's work, not only on the CEO's last turn:
 *
 * - **Trace**: the CEO's turn plus every run of every task delegated under it, so a goal can
 *   require that someone searched the web or wrote a document. Checks never ask who did it.
 * - **Deliverables**: the files an agent hands in with `submit_work`. The host reads each text
 *   file and offers it to validators as an artifact, and measures it (decision 11: numeric checks
 *   read host-measured numbers, never numbers the agent reports about its own work).
 *
 * Deliverable paths are relative to the company root (`drive/goals/<id>/deliverables/x.md`,
 * `agents/<id>/workspace/x.md`), or to the agent's own home (`workspace/x.md`). A path that
 * leaves the company root is ignored.
 */
export const DELIVERABLE_ARTIFACT = "deliverable" as const;

/** Numbers the host measures for every hand-in, shown to agents drafting a goal. */
export const COMPANY_GOAL_METRICS: Readonly<Record<string, string>> = {
  deliverableCount: "files handed in",
  deliverableWords: "words across the text files handed in",
  deliverableLines: "non-empty lines across the text files handed in",
  deliverableLinks: "distinct web links across the text files handed in",
  deliverableTableRows: "Markdown table rows, header and divider rows not counted",
  deliverableListItems: "bulleted or numbered list items",
  deliverableSections: 'second-level Markdown headings ("## ...")',
};

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
  /** The company root deliverable paths are relative to. Files outside it are never read. */
  readonly companyRoot: string;
}

export interface CompanyGoalEvidence {
  readonly output?: JsonValue;
  readonly events: readonly CanonicalEvent[];
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly metrics?: Readonly<Record<string, number>>;
}

function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words === null ? 0 : words.length;
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function countTableRows(lines: readonly string[]): number {
  let rows = 0;
  let block: string[] = [];
  const flush = () => {
    rows += block.length >= 2 && TABLE_DIVIDER.test(block[1] ?? "") ? block.length - 2 : 0;
    block = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      block.push(line);
    } else {
      flush();
    }
  }
  flush();
  return rows;
}

/** The host's measurements of a set of text files (see `COMPANY_GOAL_METRICS`). */
export function measureDeliverables(
  texts: readonly string[],
  count: number,
): Record<string, number> {
  const lines = texts.flatMap((text) => text.split("\n"));
  return {
    deliverableCount: count,
    deliverableWords: texts.reduce((sum, text) => sum + countWords(text), 0),
    deliverableLines: lines.filter((line) => line.trim().length > 0).length,
    deliverableLinks: new Set(texts.flatMap((text) => text.match(LINK) ?? [])).size,
    deliverableTableRows: texts.reduce((sum, text) => sum + countTableRows(text.split("\n")), 0),
    deliverableListItems: lines.filter((line) => /^\s*([-*+]|\d+[.)])\s+\S/.test(line)).length,
    deliverableSections: lines.filter((line) => /^##\s+\S/.test(line)).length,
  };
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Where a handed-in path lives: under the company root first, then under the submitter's home.
 * Undefined when the file does not exist or resolves outside the company root.
 */
export async function resolveDeliverablePath(
  companyRoot: string,
  home: string | undefined,
  filePath: string,
): Promise<string | undefined> {
  let root: string;
  try {
    root = await realpath(companyRoot);
  } catch {
    return undefined;
  }
  const bases = [root];
  if (home !== undefined) {
    try {
      bases.push(await realpath(home));
    } catch {
      // A home that does not exist yet holds no files.
    }
  }
  for (const base of bases) {
    try {
      const real = await realpath(path.resolve(base, filePath));
      if (inside(root, real) && (await stat(real)).isFile()) {
        return real;
      }
    } catch {
      // Not here; try the next base.
    }
  }
  return undefined;
}

async function readText(file: string): Promise<string> {
  const buffer = await readFile(file);
  const text = buffer.subarray(0, MAX_DELIVERABLE_BYTES).toString("utf8");
  return buffer.length > MAX_DELIVERABLE_BYTES
    ? `${text}\n\n[Cut at ${MAX_DELIVERABLE_BYTES} bytes of ${buffer.length}.]`
    : text;
}

async function homeOf(
  options: CompanyGoalEvidenceOptions,
  agentId: string | undefined,
): Promise<string | undefined> {
  return agentId === undefined ? undefined : (await options.directory().get(agentId))?.homePath;
}

/**
 * Reads the text files of a hand-in into artifacts: `deliverable` is the first text file,
 * `deliverable.<ext>` the first file of each extension, `deliverable:<name>` each file by name.
 */
async function readDeliverables(
  options: CompanyGoalEvidenceOptions,
  handIn: AgentTaskHandIn,
  submitterId: string | undefined,
): Promise<Pick<CompanyGoalEvidence, "artifacts" | "metrics">> {
  const home = await homeOf(options, submitterId);
  const artifacts: Record<string, string> = {};
  const texts: string[] = [];
  for (const deliverable of handIn.deliverables) {
    if (!TEXT_DELIVERABLE.test(deliverable.path)) {
      continue;
    }
    const file = await resolveDeliverablePath(options.companyRoot, home, deliverable.path);
    if (file === undefined) {
      continue;
    }
    const text = await readText(file);
    texts.push(text);
    const extension = path.extname(file).slice(1).toLowerCase();
    artifacts[DELIVERABLE_ARTIFACT] ??= text;
    artifacts[`${DELIVERABLE_ARTIFACT}.${extension}`] ??= text;
    artifacts[`${DELIVERABLE_ARTIFACT}:${path.basename(file)}`] ??= text;
  }
  return {
    ...(texts.length === 0 ? {} : { artifacts }),
    metrics: measureDeliverables(texts, handIn.deliverables.length),
  };
}

/**
 * The `checkHandIn` hook: refuses a hand-in naming a file that does not exist, so the agent
 * fixes the path in the same turn instead of failing the goal later.
 */
export function createCompanyHandInCheck(
  options: Pick<CompanyGoalEvidenceOptions, "companyRoot">,
): (input: {
  readonly agent: { readonly homePath: string };
  readonly deliverables: readonly AgentTaskDeliverable[];
}) => Promise<string | undefined> {
  return async (input) => {
    const home = input.agent.homePath;
    const missing: string[] = [];
    for (const deliverable of input.deliverables) {
      if (
        (await resolveDeliverablePath(options.companyRoot, home, deliverable.path)) === undefined
      ) {
        missing.push(deliverable.path);
      }
    }
    return missing.length === 0
      ? undefined
      : `no file at ${missing.map((item) => `"${item}"`).join(", ")}. Paths are relative to the company root (for example agents/<agent>/workspace/x.md) or to your own home (workspace/x.md).`;
  };
}

/**
 * Events of every run under a task: its own turns and everything delegated beneath it. Each run
 * belongs to one agent, so events that do not name a role are tagged with that agent's id.
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

/** The company's evidence for a task: team trace, the hand-in and its deliverables. */
export async function collectCompanyGoalEvidence(
  options: CompanyGoalEvidenceOptions,
  input: {
    readonly rootTaskId: string;
    /** What the task's agent handed in with `submit_work`. */
    readonly handIn?: AgentTaskHandIn;
    /** Runs of the turn being checked, which the task record may not list yet. */
    readonly runIds?: readonly string[];
    /** The agent that owns the task and handed in. */
    readonly agentId?: string;
  },
): Promise<CompanyGoalEvidence> {
  const events = await teamEvents(options, input.rootTaskId, {
    runIds: input.runIds ?? [],
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
  });
  if (input.handIn === undefined) {
    return { events };
  }
  return {
    output: handInOutput(input.handIn),
    events,
    ...(await readDeliverables(options, input.handIn, input.agentId)),
  };
}

/** The cascade's `goals.evidence` hook for Generic Corp. */
export function createCompanyGoalEvidence(
  options: CompanyGoalEvidenceOptions,
): (input: TaskGoalEvidenceInput) => Promise<Partial<GoalEvidence>> {
  return async (input) => {
    const collected = await collectCompanyGoalEvidence(options, {
      rootTaskId: input.task.taskId,
      ...(input.handIn === undefined ? {} : { handIn: input.handIn }),
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
  /**
   * The model call. Defaults to `complete` from `@generic-ai/ai`; the server passes one that runs
   * Claude calls on the owner's plan through the Claude Agent SDK when that is on.
   */
  readonly complete?: typeof complete;
  /** Model reference for grading, `provider/model-id`. */
  readonly model: string;
  readonly resolveModel?: (ref: string) => Model;
  /** Called with each grading call's usage, so an eval can count the judge against its cap. */
  readonly onUsage?: (usage: AssistantMessage["usage"]) => void;
  /**
   * Request auth per provider (the owner's saved API key or the environment). Without it the
   * provider's environment variable is used.
   */
  readonly getAuth?: (
    provider: string,
  ) => Promise<
    { readonly apiKey?: string; readonly headers?: Readonly<Record<string, string>> } | undefined
  >;
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
    const auth = await options.getAuth?.(model.provider);
    const reply = await (options.complete ?? complete)(
      model,
      {
        systemPrompt: "You are a strict, fair grader. Reply with JSON only.",
        messages: [
          { role: "user", content: buildRubricJudgePrompt(request), timestamp: Date.now() },
        ],
      },
      {
        signal: request.signal,
        ...(auth?.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth?.headers === undefined ? {} : { headers: { ...auth.headers } }),
      },
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
