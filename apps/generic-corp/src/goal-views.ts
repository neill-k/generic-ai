import {
  type AgentTaskRecord,
  DEFINITION_OF_DONE_VALIDATOR_ID,
  type PersistentAgentRecord,
} from "@generic-ai/plugin-delegation";

import type { DriveEntry } from "./drive.js";
import type { ChatThreadView, CompanyRuntime } from "./runtime.js";

/**
 * Goals as the owner sees them on the home screen (decision 47): what done means as a live
 * checklist, who is on it, what has been delivered, what it used, and its state in plain words
 * (decision 49). One goal is one owner request, so a goal's id is its root task id.
 */
export type GoalState =
  | "drafting"
  | "queued"
  | "working"
  | "waiting"
  | "paused"
  | "done"
  | "impossible"
  | "stopped"
  | "cancelled";

export type ChecklistItemState = "met" | "not-met" | "unchecked";

export interface GoalChecklistItem {
  readonly line: string;
  readonly state: ChecklistItemState;
}

export interface GoalTeamMember {
  readonly agentId: string;
  readonly role: string;
  readonly title?: string;
  /** True while the agent has a task on this goal that is running or about to. */
  readonly working: boolean;
  readonly statusText: string;
}

export interface GoalView {
  readonly goalId: string;
  readonly title: string;
  readonly objective?: string;
  readonly state: GoalState;
  /** The state in the product's own words, such as "Working on it." */
  readonly statusText: string;
  readonly revision?: number;
  readonly checklist: readonly GoalChecklistItem[];
  /** False when the owner changed the definition of done after the last check ran. */
  readonly checkedCurrentVersion: boolean;
  readonly lastCheckedAt?: string;
  readonly team: readonly GoalTeamMember[];
  readonly deliverables: readonly { readonly path: string; readonly title?: string }[];
  readonly usage: { readonly tokens: number; readonly costUsd: number };
  readonly openQuestions: number;
  readonly threadId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly failure?: string;
  readonly impossible?: { readonly reason: string; readonly reasoning?: string };
}

export interface GoalCheckView {
  readonly id: string;
  readonly kind: string;
  readonly description?: string;
  readonly required: boolean;
  readonly state: ChecklistItemState;
  readonly message?: string;
}

export interface GoalQuestionView {
  readonly questionId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly question: string;
  readonly assumption: string;
  readonly askedAt: string;
  readonly answer?: string;
  readonly answeredAt?: string;
}

export interface GoalDetailView extends GoalView {
  readonly definitionOfDone: readonly string[];
  /** Every check, including the ones beyond the definition of done. */
  readonly checks: readonly GoalCheckView[];
  readonly history: readonly {
    readonly revision: number;
    readonly source: string;
    readonly changedAt: string;
    readonly changedBy?: string;
  }[];
  readonly summary?: string;
  readonly questions: readonly GoalQuestionView[];
  readonly files: readonly DriveEntry[];
  readonly conversation?: ChatThreadView;
}

const ACTIVE = new Set(["queued", "running", "waiting"]);
const FINISHED_STATES: ReadonlySet<GoalState> = new Set([
  "done",
  "impossible",
  "stopped",
  "cancelled",
]);

export function goalStateOf(root: AgentTaskRecord): GoalState {
  if (root.impossible !== undefined) {
    return "impossible";
  }
  switch (root.status) {
    case "succeeded":
      return "done";
    case "failed":
      return "stopped";
    case "cancelled":
      return "cancelled";
    case "queued":
      return root.goalDraft === "pending" ? "drafting" : "queued";
    case "waiting":
      return "waiting";
    default:
      return root.goalDraft === "pending" ? "drafting" : "working";
  }
}

const GOAL_STATUS_TEXT: Readonly<Record<GoalState, string>> = {
  drafting: "Writing down what done means.",
  queued: "In the queue. It will be picked up shortly.",
  working: "Working on it.",
  waiting: "Waiting on the team.",
  paused: "Paused. Work resumes when the hold lifts.",
  done: "Done.",
  impossible: "Declared impossible. A second reviewer agreed.",
  stopped: "Stopped before it was done.",
  cancelled: "Cancelled. Partial work was kept on the drive.",
};

export function goalStatusText(state: GoalState): string {
  return GOAL_STATUS_TEXT[state];
}

/** What an agent is doing on a task, in plain words. */
export function taskStatusText(task: AgentTaskRecord): string {
  if (task.impossible !== undefined) {
    return "Found it impossible.";
  }
  if (task.hold !== undefined && ACTIVE.has(task.status)) {
    return task.hold.reason;
  }
  switch (task.status) {
    case "queued":
      return task.goalDraft === "pending" ? "About to write down what done means." : "Up next.";
    case "running":
      return task.goalDraft === "pending" ? "Writing down what done means." : "Working on it.";
    case "waiting":
      return (task.pendingApprovalIds?.length ?? 0) > 0
        ? "Waiting on a permission."
        : "Waiting on its reports.";
    case "succeeded":
      return "Handed in.";
    case "failed":
      return "Stopped.";
    case "cancelled":
      return "Cancelled.";
    default:
      return String(task.status);
  }
}

function definitionOfDone(root: AgentTaskRecord): readonly string[] {
  const spec = root.goal?.spec;
  if (spec !== undefined) {
    return spec.definitionOfDone;
  }
  const text = root.goal?.definitionOfDone;
  return text === undefined
    ? []
    : text
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
        .filter((line) => line.length > 0);
}

function isCurrent(root: AgentTaskRecord): boolean {
  const report = root.lastGoalReport;
  if (report === undefined) {
    return true;
  }
  return root.goal?.fingerprint === undefined || report.fingerprint === root.goal.fingerprint;
}

export function checklistOf(root: AgentTaskRecord): GoalChecklistItem[] {
  const lines = definitionOfDone(root);
  const report = root.lastGoalReport;
  const current = isCurrent(root);
  const perLine = report?.checks?.find(
    (check) => check.validatorId === DEFINITION_OF_DONE_VALIDATOR_ID,
  )?.criteria;
  return lines.map((line, index) => {
    if (root.status === "succeeded" && current) {
      return { line, state: "met" };
    }
    if (report === undefined || !current) {
      return { line, state: "unchecked" };
    }
    const criterion = perLine?.find((entry) => entry.criterionId === `dod-${index + 1}`);
    if (criterion !== undefined) {
      return { line, state: criterion.passed ? "met" : "not-met" };
    }
    // The goal's own checks do not map one to one onto lines; only a full pass says much.
    return { line, state: report.status === "COMPLETE" ? "met" : "unchecked" };
  });
}

function checksOf(root: AgentTaskRecord): GoalCheckView[] {
  const spec = root.goal?.spec;
  if (spec === undefined) {
    return [];
  }
  const current = isCurrent(root);
  const results = new Map(
    (current ? (root.lastGoalReport?.checks ?? []) : []).map((check) => [check.validatorId, check]),
  );
  return spec.validators.map((validator) => {
    const result = results.get(validator.id);
    return {
      id: validator.id,
      kind: validator.kind,
      ...(validator.description === undefined ? {} : { description: validator.description }),
      required: validator.required !== false,
      state: result === undefined ? "unchecked" : result.status === "passed" ? "met" : "not-met",
      ...(result === undefined ? {} : { message: result.message }),
    };
  });
}

function titleOf(root: AgentTaskRecord): string {
  const ownerText = root.metadata?.["ownerText"];
  const source =
    root.goal?.spec?.title ??
    (typeof ownerText === "string" ? ownerText : undefined) ??
    root.goal?.spec?.objective ??
    root.instruction;
  const line =
    source
      .split(/\r?\n/)
      .find((entry) => entry.trim().length > 0)
      ?.trim() ?? root.taskId;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function teamOf(
  tree: readonly AgentTaskRecord[],
  agents: ReadonlyMap<string, PersistentAgentRecord>,
): GoalTeamMember[] {
  const byAgent = new Map<string, AgentTaskRecord[]>();
  for (const task of tree) {
    byAgent.set(task.agentId, [...(byAgent.get(task.agentId) ?? []), task]);
  }
  const team: GoalTeamMember[] = [];
  for (const [agentId, tasks] of byAgent) {
    const latest = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const active = latest.find((task) => ACTIVE.has(task.status));
    const shown = active ?? latest[0];
    const agent = agents.get(agentId);
    team.push({
      agentId,
      role: agent?.role ?? agentId,
      ...(agent?.title === undefined ? {} : { title: agent.title }),
      working: active !== undefined && active.status !== "waiting",
      statusText: shown === undefined ? "" : taskStatusText(shown),
    });
  }
  // Whoever is working comes first; then by depth in the tree (the CEO first).
  const depth = new Map(tree.map((task) => [task.agentId, task.depth]));
  return team.sort(
    (left, right) =>
      Number(right.working) - Number(left.working) ||
      (depth.get(left.agentId) ?? 0) - (depth.get(right.agentId) ?? 0),
  );
}

function viewOf(
  root: AgentTaskRecord,
  tree: readonly AgentTaskRecord[],
  agents: ReadonlyMap<string, PersistentAgentRecord>,
  usage: { readonly tokens: number; readonly costUsd: number } | undefined,
): GoalView {
  let state = goalStateOf(root);
  // A goal is paused when its work is held and nobody on it is still finishing a step.
  const held = tree.find((task) => task.hold !== undefined && ACTIVE.has(task.status));
  if (
    held !== undefined &&
    !FINISHED_STATES.has(state) &&
    !tree.some((task) => task.status === "running" && task.hold === undefined)
  ) {
    state = "paused";
  }
  const threadId = root.metadata?.["threadId"];
  const openQuestions = tree.reduce(
    (count, task) =>
      count +
      (task.ownerQuestions ?? []).filter((question) => question.answer === undefined).length,
    0,
  );
  return {
    goalId: root.taskId,
    title: titleOf(root),
    ...(root.goal?.spec?.objective === undefined ? {} : { objective: root.goal.spec.objective }),
    state,
    statusText:
      state === "paused" && held?.hold !== undefined ? held.hold.reason : goalStatusText(state),
    ...(root.goalRevision === undefined ? {} : { revision: root.goalRevision }),
    checklist: checklistOf(root),
    checkedCurrentVersion: isCurrent(root),
    ...(root.lastGoalReport === undefined
      ? {}
      : { lastCheckedAt: root.lastGoalReport.evaluatedAt }),
    team: teamOf(tree, agents),
    deliverables: (root.handIn?.deliverables ?? []).map((deliverable) => ({ ...deliverable })),
    usage: usage ?? { tokens: 0, costUsd: 0 },
    openQuestions,
    ...(typeof threadId === "string" ? { threadId } : {}),
    createdAt: root.createdAt,
    updatedAt: tree.reduce(
      (latest, task) => (task.updatedAt > latest ? task.updatedAt : latest),
      root.updatedAt,
    ),
    ...(root.completedAt === undefined ? {} : { completedAt: root.completedAt }),
    ...(root.failureMessage === undefined || state !== "stopped"
      ? {}
      : { failure: root.failureMessage }),
    ...(root.impossible === undefined
      ? {}
      : {
          impossible: {
            reason: root.impossible.reason,
            ...(root.impossible.review === undefined
              ? {}
              : { reasoning: root.impossible.review.reasoning }),
          },
        }),
  };
}

async function usageByGoal(
  runtime: CompanyRuntime,
): Promise<Map<string, { tokens: number; costUsd: number }>> {
  const costs = await runtime.costs();
  return new Map(
    costs.byRequest.map((entry) => [
      entry.key,
      { tokens: entry.totals.totalTokens, costUsd: entry.totals.costUsd },
    ]),
  );
}

async function agentMap(runtime: CompanyRuntime): Promise<Map<string, PersistentAgentRecord>> {
  return new Map((await runtime.listAgents()).map((agent) => [agent.id, agent]));
}

/** Every goal, newest activity first: unfinished goals before finished ones. */
export async function listGoalViews(
  runtime: CompanyRuntime,
  options: { readonly limit?: number } = {},
): Promise<GoalView[]> {
  const [tasks, agents, usage] = await Promise.all([
    runtime.listTasks({ limit: 5000 }),
    agentMap(runtime),
    usageByGoal(runtime),
  ]);
  const trees = new Map<string, AgentTaskRecord[]>();
  for (const task of tasks) {
    trees.set(task.rootTaskId, [...(trees.get(task.rootTaskId) ?? []), task]);
  }
  const views = tasks
    .filter((task) => task.depth === 0)
    .map((root) => viewOf(root, trees.get(root.taskId) ?? [root], agents, usage.get(root.taskId)));
  const open = (view: GoalView) =>
    view.state === "done" ||
    view.state === "cancelled" ||
    view.state === "stopped" ||
    view.state === "impossible"
      ? 0
      : 1;
  views.sort(
    (left, right) => open(right) - open(left) || right.updatedAt.localeCompare(left.updatedAt),
  );
  return views.slice(0, options.limit ?? 200);
}

export async function goalDetailView(
  runtime: CompanyRuntime,
  goalId: string,
): Promise<GoalDetailView | undefined> {
  const root = await runtime.cascade.get(goalId);
  if (root === undefined || root.depth !== 0) {
    return undefined;
  }
  const [tree, agents, usage] = await Promise.all([
    runtime.cascade.tree(goalId),
    agentMap(runtime),
    usageByGoal(runtime),
  ]);
  const view = viewOf(root, tree, agents, usage.get(goalId));
  const questions: GoalQuestionView[] = tree
    .flatMap((task) =>
      (task.ownerQuestions ?? []).map((question) => ({
        questionId: question.id,
        taskId: task.taskId,
        agentId: question.agentId,
        question: question.question,
        assumption: question.assumption,
        askedAt: question.askedAt,
        ...(question.answer === undefined ? {} : { answer: question.answer }),
        ...(question.answeredAt === undefined ? {} : { answeredAt: question.answeredAt }),
      })),
    )
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt));
  const files = await goalFiles(runtime, goalId);
  const conversation =
    view.threadId === undefined ? undefined : await runtime.getThread(view.threadId);
  return {
    ...view,
    definitionOfDone: definitionOfDone(root),
    checks: checksOf(root),
    history: (root.goalHistory ?? []).map((entry) => ({
      revision: entry.revision,
      source: entry.source,
      changedAt: entry.changedAt,
      ...(entry.changedBy === undefined ? {} : { changedBy: entry.changedBy }),
    })),
    ...(root.handIn === undefined ? {} : { summary: root.handIn.summary }),
    questions,
    files,
    ...(conversation === undefined ? {} : { conversation }),
  };
}

async function goalFiles(runtime: CompanyRuntime, goalId: string): Promise<DriveEntry[]> {
  if (runtime.drive === undefined) {
    return [];
  }
  const shelf = await runtime.drive.deliverables().catch(() => []);
  return [...(shelf.find((entry) => entry.goalId === goalId)?.files ?? [])];
}

/** One piece of work in the activity view (decision 49): who is on what, in plain words. */
export interface ActivityItem {
  readonly taskId: string;
  readonly goalId: string;
  readonly goalTitle: string;
  readonly agentId: string;
  readonly agentRole: string;
  readonly agentTitle?: string;
  /** Who asked for it: an agent's id, or undefined when the owner did. */
  readonly delegatedBy?: string;
  readonly title: string;
  readonly active: boolean;
  readonly held: boolean;
  readonly statusText: string;
  readonly updatedAt: string;
}

export interface ActivityView {
  /** Work running, queued, waiting or held, newest first. */
  readonly now: readonly ActivityItem[];
  /** Work that finished, newest first. */
  readonly recent: readonly ActivityItem[];
}

/** The live activity view that replaces the board: what is happening now, and what just finished. */
export async function activityView(
  runtime: CompanyRuntime,
  options: { readonly limit?: number } = {},
): Promise<ActivityView> {
  const limit = options.limit ?? 100;
  const [tasks, agents] = await Promise.all([
    runtime.listTasks({ limit: 5000 }),
    agentMap(runtime),
  ]);
  const roots = new Map(
    tasks.filter((task) => task.depth === 0).map((task) => [task.taskId, task]),
  );
  const items = tasks.map((task): ActivityItem => {
    const root = roots.get(task.rootTaskId);
    const agent = agents.get(task.agentId);
    return {
      taskId: task.taskId,
      goalId: task.rootTaskId,
      goalTitle: root === undefined ? task.rootTaskId : titleOf(root),
      agentId: task.agentId,
      agentRole: agent?.role ?? task.agentId,
      ...(agent?.title === undefined ? {} : { agentTitle: agent.title }),
      ...(task.delegatedBy === undefined ? {} : { delegatedBy: task.delegatedBy }),
      title: titleOf(task),
      active: ACTIVE.has(task.status),
      held: task.hold !== undefined && ACTIVE.has(task.status),
      statusText: taskStatusText(task),
      updatedAt: task.updatedAt,
    };
  });
  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    now: items.filter((item) => item.active).slice(0, limit),
    recent: items.filter((item) => !item.active).slice(0, limit),
  };
}

/** One goal named in the daily summary. */
export interface SummaryGoal {
  readonly goalId: string;
  readonly title: string;
  readonly state: GoalState;
}

/**
 * The quiet daily summary (decision 35): what the company did in a window, read from records
 * already kept. Nothing is sent and no model is asked; the owner reads it when they look.
 */
export interface DailySummary {
  readonly from: string;
  readonly to: string;
  /** One line in the company's voice, such as "2 goals done. 1 action refused. $0.84 spent." */
  readonly headline: string;
  /** Goals that reached done in the window. */
  readonly done: readonly SummaryGoal[];
  /** Goals that ended without being done: impossible, stopped or cancelled. */
  readonly ended: readonly SummaryGoal[];
  /** Goals the owner set in the window. */
  readonly started: number;
  /** Goals still open at the end of the window. */
  readonly open: number;
  /** Pieces of delegated work handed in by agents in the window. */
  readonly handedIn: number;
  readonly refused: number;
  /** Changes to the org in the window, in the product's own words. */
  readonly orgChanges: readonly string[];
  readonly tokens: number;
  readonly costUsd: number;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export async function dailySummary(
  runtime: CompanyRuntime,
  options: {
    readonly now?: Date;
    readonly hours?: number;
    readonly refusals?: {
      list(options?: { readonly limit?: number }): Promise<readonly { readonly at: string }[]>;
    };
  } = {},
): Promise<DailySummary> {
  const to = options.now ?? new Date();
  const from = new Date(to.getTime() - (options.hours ?? 24) * 3_600_000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const inWindow = (at: string) => at >= fromIso && at <= toIso;
  const [tasks, refusals, changes, costs] = await Promise.all([
    runtime.listTasks({ limit: 5000 }),
    options.refusals?.list({ limit: 1000 }) ?? Promise.resolve([]),
    runtime.org.changes({ limit: 500 }),
    runtime.costs({ since: fromIso, limit: 5000 }),
  ]);
  const roots = tasks.filter((task) => task.depth === 0);
  const finished = roots
    .filter((root) => FINISHED_STATES.has(goalStateOf(root)) && inWindow(root.updatedAt))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(
      (root): SummaryGoal => ({
        goalId: root.taskId,
        title: titleOf(root),
        state: goalStateOf(root),
      }),
    );
  const done = finished.filter((goal) => goal.state === "done");
  const ended = finished.filter((goal) => goal.state !== "done");
  const started = roots.filter((root) => inWindow(root.createdAt)).length;
  const open = roots.filter((root) => !FINISHED_STATES.has(goalStateOf(root))).length;
  const handedIn = tasks.filter(
    (task) => task.depth > 0 && task.status === "succeeded" && inWindow(task.updatedAt),
  ).length;
  const refused = refusals.filter((refusal) => inWindow(refusal.at)).length;
  const orgChanges = changes
    .filter((change) => inWindow(change.at))
    .map((change) => change.summary);

  const parts: string[] = [];
  if (done.length > 0) parts.push(`${plural(done.length, "goal")} done.`);
  if (ended.length > 0) parts.push(`${plural(ended.length, "goal")} ended without being done.`);
  if (started > 0) parts.push(`${plural(started, "goal")} set.`);
  if (handedIn > 0) parts.push(`${plural(handedIn, "piece")} of work handed in.`);
  if (refused > 0) parts.push(`${plural(refused, "action")} refused.`);
  if (orgChanges.length > 0) parts.push(`${plural(orgChanges.length, "change")} to the org.`);
  if (costs.totals.costUsd > 0) parts.push(`$${costs.totals.costUsd.toFixed(2)} spent.`);
  let headline = parts.join(" ");
  if (parts.length === 0) {
    headline =
      open > 0
        ? `Nothing finished. ${plural(open, "goal")} still open.`
        : "Nothing happened. The office was quiet.";
  }

  return {
    from: fromIso,
    to: toIso,
    headline,
    done,
    ended,
    started,
    open,
    handedIn,
    refused,
    orgChanges,
    tokens: costs.totals.totalTokens,
    costUsd: costs.totals.costUsd,
  };
}
