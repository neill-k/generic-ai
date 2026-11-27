import { randomUUID } from "node:crypto";

import {
  type AgentHarnessAdapter,
  type AgentHarnessAdapterRunContext,
  type AgentHarnessArtifactRef,
  type AgentHarnessConfig,
  type AgentHarnessRole,
  type AgentHarnessRunErrorCategory,
  type Awaitable,
  type CanonicalEvent,
  type CompileDiagnostic,
  type CompiledActor,
  type CompiledHarness,
  describeGoalForAgent,
  type GoalEvidence,
  type GoalValidationReport,
  goalTraceFromCanonicalEvents,
  type JsonObject,
  type PolicyDecisionRecord,
  type ProtocolAction,
  type ProtocolActionOutcome,
  type ProtocolActorVerdict,
  type ProtocolBindingSpec,
  type ProtocolPlugin,
  type ProtocolState,
  parseActorDirectives,
  type RunGoalValidatorsOptions,
  runGoalValidators,
  type SealedGoal,
  STANDARD_PROTOCOLS,
  type TraceEvent,
  type TraceEventType,
} from "@generic-ai/sdk";

/**
 * Protocol-driven topology runner.
 *
 * The runner drives a {@link ProtocolPlugin} reducer to completion: it asks the
 * protocol for the next batch of actions, executes them (actor actions run
 * through a pluggable {@link TopologyActorRunner}, independent actions in the
 * same batch run concurrently), records an outcome per action, and reduces
 * again until the protocol reports `done`, `failed`, or `blocked`.
 *
 * The runner owns scheduling concerns only: concurrency, retries, step and
 * deadline budgets, cancellation, idempotency, approvals, and the trace. What
 * an actor actually does is up to the actor runner; `createPiTopologyActorRunner`
 * in `agent-harness.ts` runs each actor as a policy-scoped Pi role session.
 */

export const DEFAULT_TOPOLOGY_MAX_STEPS = 32;
export const DEFAULT_TOPOLOGY_MAX_CONCURRENCY = 4;
export const DEFAULT_TOPOLOGY_MAX_ATTEMPTS = 2;

const ACTOR_ACTION_KINDS: ReadonlySet<ProtocolAction["kind"]> = new Set([
  "invoke_actor",
  "claim_work",
  "delegate_work",
  "review_artifact",
]);

export interface TopologyActorInvocation {
  readonly runId: string;
  readonly harnessId: string;
  readonly protocol: string;
  readonly bindingId: string;
  readonly step: number;
  readonly attempt: number;
  readonly action: ProtocolAction;
  readonly actor: CompiledActor;
  /** The overall task the topology is working on. */
  readonly instruction: string;
  /** The focused assignment for this actor, from the action payload. */
  readonly task: string;
  /** Outputs of other actors the protocol chose to share with this one. */
  readonly context: string;
  /** A ready-to-send prompt combining the instruction, task, and context. */
  readonly prompt: string;
  /** The goal's objective, definition of done, and checks, when the run has a goal. */
  readonly goalBrief?: string;
  readonly signal?: AbortSignal;
}

export interface TopologyActorResult {
  readonly status: "succeeded" | "failed";
  readonly outputText: string;
  readonly failureMessage?: string;
  /** Overrides any verdict parsed from `outputText`. */
  readonly verdict?: ProtocolActorVerdict;
  /** Merged over any directives parsed from `outputText`. */
  readonly data?: JsonObject;
  /** Set to false to stop the runner from retrying a failed attempt. */
  readonly retryable?: boolean;
  readonly costUsd?: number;
  readonly events?: readonly CanonicalEvent[];
  readonly policyDecisions?: readonly PolicyDecisionRecord[];
  readonly artifacts?: readonly AgentHarnessArtifactRef[];
}

export type TopologyActorRunner = (
  invocation: TopologyActorInvocation,
) => Awaitable<TopologyActorResult>;

export interface TopologyApprovalRequest {
  readonly runId: string;
  readonly protocol: string;
  readonly step: number;
  readonly action: ProtocolAction;
}

export interface RunHarnessTopologyOptions {
  readonly compiled: CompiledHarness;
  readonly instruction: string;
  readonly runner: TopologyActorRunner;
  /** Binding id or protocol name to run. Defaults to the harness's first protocol binding. */
  readonly protocol?: string;
  /** Protocol implementations to resolve bindings against. Defaults to the standard protocols. */
  readonly protocols?: readonly ProtocolPlugin[];
  readonly runId?: string;
  /** Maximum reduce/execute cycles before the run fails. */
  readonly maxSteps?: number;
  /** Maximum actor invocations running at the same time within one step. */
  readonly maxConcurrency?: number;
  /** Attempts per actor action, including the first. */
  readonly maxAttempts?: number;
  readonly deadline?: string | Date;
  readonly signal?: AbortSignal;
  /** Resolves `request_approval` actions. Without it those actions block the run. */
  readonly approve?: (request: TopologyApprovalRequest) => Awaitable<boolean>;
  readonly onTraceEvent?: (event: TraceEvent) => Awaitable<void>;
  /** Called after every executed action, in completion order. */
  readonly onOutcome?: (outcome: ProtocolActionOutcome) => Awaitable<void>;
  /**
   * Outcomes recorded by an earlier, interrupted run of the same topology.
   * Protocol state is recomputed from outcomes, so the run resumes where it
   * stopped and does not repeat actions that already ran.
   */
  readonly resumeFrom?: readonly ProtocolActionOutcome[];
  /**
   * The sealed goal that decides whether the topology's work is done. Actors
   * see its definition of done, protocols can request `validate_goal` checks
   * (the verifier loop does by default), and a run only succeeds when the
   * goal's required validators pass on the final output.
   */
  readonly goal?: SealedGoal;
  /** Host-owned judges, checks, and timeouts for the goal's validators. */
  readonly goalValidators?: Omit<RunGoalValidatorsOptions, "signal">;
  /**
   * Adds evidence for goal validators, such as metrics, artifacts, or a fuller
   * trace than the actor results carry. Merged over the default evidence (the
   * candidate output and a trace built from collected canonical events).
   */
  readonly collectGoalEvidence?: (
    input: TopologyGoalEvidenceInput,
  ) => Awaitable<Partial<GoalEvidence> | undefined>;
}

export interface TopologyGoalEvidenceInput {
  readonly runId: string;
  readonly outputText: string;
  /** The action outcome that produced the output being checked, when known. */
  readonly candidate?: ProtocolActionOutcome;
  readonly outcomes: readonly ProtocolActionOutcome[];
  readonly events: readonly CanonicalEvent[];
}

export type HarnessTopologyRunStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export interface HarnessTopologyRunResult {
  readonly runId: string;
  readonly harnessId: string;
  readonly protocol: string;
  readonly bindingId?: string;
  readonly status: HarnessTopologyRunStatus;
  readonly outputText: string;
  readonly failureMessage?: string;
  readonly errorCategory?: AgentHarnessRunErrorCategory;
  readonly state: ProtocolState;
  readonly steps: number;
  readonly outcomes: readonly ProtocolActionOutcome[];
  readonly trace: readonly TraceEvent[];
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly notes: readonly string[];
  readonly events: readonly CanonicalEvent[];
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly artifacts: readonly AgentHarnessArtifactRef[];
  readonly costUsd?: number;
  /** The latest goal validation report, when the run had a goal. */
  readonly goalReport?: GoalValidationReport;
}

const TOPOLOGY_ROLE_KIND_ALIASES: Readonly<Record<string, AgentHarnessRole["kind"]>> =
  Object.freeze({
    root: "root",
    planner: "planner",
    manager: "planner",
    lead: "planner",
    architect: "planner",
    coordinator: "planner",
    explorer: "explorer",
    researcher: "explorer",
    analyst: "explorer",
    investigator: "explorer",
    builder: "builder",
    implementer: "builder",
    solver: "builder",
    repairer: "builder",
    developer: "builder",
    engineer: "builder",
    coder: "builder",
    writer: "builder",
    worker: "builder",
    verifier: "verifier",
    critic: "verifier",
    reviewer: "verifier",
    tester: "verifier",
    qa: "verifier",
    judge: "verifier",
  });

/**
 * Map a compiled DSL actor to the harness role that governs its tool policy.
 *
 * A role in `harness.roles` whose id matches the actor id (or, failing that, the
 * actor's role name) wins. Otherwise the actor's role name is mapped onto a
 * built-in role kind, so `implementer`/`solver`/`repairer` get build tools,
 * `critic`/`reviewer` get verify tools, and `manager`/`planner` stay read-only.
 * Unrecognised role names fall back to a read-only custom role.
 */
export function resolveTopologyActorRole(
  actor: Pick<CompiledActor, "id" | "role" | "instructions" | "model">,
  roles: readonly AgentHarnessRole[] = [],
): AgentHarnessRole {
  const configured =
    roles.find((role) => role.id === actor.id) ?? roles.find((role) => role.id === actor.role);
  if (configured !== undefined) {
    return Object.freeze({
      ...configured,
      id: actor.id,
      ...(actor.instructions === undefined || configured.instructions !== undefined
        ? {}
        : { instructions: actor.instructions }),
      ...(actor.model === undefined || configured.model !== undefined
        ? {}
        : { model: actor.model }),
    });
  }
  const kind = TOPOLOGY_ROLE_KIND_ALIASES[actor.role.toLowerCase()] ?? "custom";
  return Object.freeze({
    id: actor.id,
    kind: kind === "root" ? "custom" : kind,
    description: `Topology actor with role "${actor.role}".`,
    ...(actor.instructions === undefined ? {} : { instructions: actor.instructions }),
    ...(actor.model === undefined ? {} : { model: actor.model }),
    readOnly: kind !== "builder",
  });
}

export interface CreateAdapterTopologyActorRunnerOptions<
  TCapabilities = unknown,
  TOutput = unknown,
> {
  /** Any runtime that implements the SDK `AgentHarnessAdapter` contract. */
  readonly adapter: AgentHarnessAdapter<TCapabilities, TOutput>;
  /** Base harness config; each actor runs with its resolved role and model. */
  readonly harness: AgentHarnessConfig;
  readonly workspaceRoot: string;
  /** Run context per invocation (event sink, artifact store, policy evaluator). */
  readonly context:
    | AgentHarnessAdapterRunContext
    | ((invocation: TopologyActorInvocation) => AgentHarnessAdapterRunContext);
  readonly capabilities?: TCapabilities;
  readonly resolveRole?: (actor: CompiledActor) => AgentHarnessRole;
}

const NON_RETRYABLE_ERROR_CATEGORIES: ReadonlySet<AgentHarnessRunErrorCategory> = new Set([
  "cancelled",
  "deadline_exceeded",
  "budget_exceeded",
  "policy_denied",
]);

/**
 * Run each topology actor through any `AgentHarnessAdapter`, so topologies work
 * with every runtime behind the adapter boundary, not only Pi. Each actor gets a
 * single-role harness config whose model comes from the actor, its configured
 * role, or the harness default, in that order.
 */
export function createAdapterTopologyActorRunner<TCapabilities = unknown, TOutput = unknown>(
  options: CreateAdapterTopologyActorRunnerOptions<TCapabilities, TOutput>,
): TopologyActorRunner {
  return async (invocation) => {
    const role =
      options.resolveRole?.(invocation.actor) ??
      resolveTopologyActorRole(invocation.actor, options.harness.roles);
    const model = role.model ?? options.harness.model;
    const harness: AgentHarnessConfig = {
      ...options.harness,
      id: `${options.harness.id}:${invocation.actor.id}`,
      primaryAgent: invocation.actor.id,
      roles: [role],
      ...(model === undefined ? {} : { model }),
    };
    const context =
      typeof options.context === "function" ? options.context(invocation) : options.context;
    const result = await options.adapter.run(
      {
        instruction: invocation.prompt,
        harness,
        workspaceRoot: options.workspaceRoot,
        runId: `${invocation.runId}:${invocation.action.id}:${invocation.attempt}`,
        rootAgentId: invocation.actor.id,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        metadata: {
          topologyRunId: invocation.runId,
          protocol: invocation.protocol,
          actionId: invocation.action.id,
          actionKind: invocation.action.kind,
          step: invocation.step,
          attempt: invocation.attempt,
        },
      },
      {
        ...context,
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      },
    );
    return {
      status: result.status,
      outputText: result.outputText,
      ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
      ...(result.errorCategory !== undefined &&
      NON_RETRYABLE_ERROR_CATEGORIES.has(result.errorCategory)
        ? { retryable: false }
        : {}),
      events: result.events,
      policyDecisions: result.policyDecisions,
      artifacts: result.artifacts,
    };
  };
}

interface TopologySelection {
  readonly binding?: ProtocolBindingSpec;
  readonly plugin?: ProtocolPlugin;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Resolve which protocol binding and implementation a topology run should use.
 */
export function selectHarnessTopology(
  compiled: CompiledHarness,
  options: { readonly protocol?: string; readonly protocols?: readonly ProtocolPlugin[] } = {},
): TopologySelection {
  const protocols = options.protocols ?? STANDARD_PROTOCOLS;
  const binding =
    options.protocol === undefined
      ? compiled.protocols[0]
      : (compiled.protocols.find((candidate) => candidate.id === options.protocol) ??
        compiled.protocols.find((candidate) => candidate.protocol === options.protocol));
  if (binding === undefined) {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "missing_protocol_binding",
          message:
            options.protocol === undefined
              ? `Harness "${compiled.id}" declares no protocol bindings to run.`
              : `Harness "${compiled.id}" has no protocol binding "${options.protocol}".`,
          path: "protocols",
        },
      ],
    };
  }

  const packageName = compiled.packages.find((pkg) => pkg.id === binding.packageRef)?.package;
  const plugin =
    protocols.find((candidate) => candidate.manifest.protocol === binding.protocol) ??
    (packageName === undefined
      ? undefined
      : protocols.find((candidate) => candidate.manifest.id === packageName));
  if (plugin === undefined) {
    return {
      binding,
      diagnostics: [
        {
          severity: "error",
          code: "unknown_protocol",
          message: `No protocol implementation is registered for "${binding.protocol}".`,
          path: `protocols.${binding.id}.protocol`,
        },
      ],
    };
  }
  return { binding, plugin, diagnostics: [] };
}

function payloadString(action: ProtocolAction, key: string): string {
  const value = action.payload?.[key];
  return typeof value === "string" ? value : "";
}

export function buildTopologyActorPrompt(input: {
  readonly instruction: string;
  readonly protocol: string;
  readonly action: ProtocolAction;
  readonly task: string;
  readonly context: string;
  /** Rendered goal (objective, definition of done, checks), when the run has one. */
  readonly goalBrief?: string;
}): string {
  const phase = payloadString(input.action, "phase");
  return [
    "Overall task:",
    input.instruction,
    "",
    ...(input.goalBrief === undefined || input.goalBrief.length === 0 ? [] : [input.goalBrief, ""]),
    `Your assignment (${input.protocol}${phase.length > 0 ? ` / ${phase}` : ""}):`,
    input.task.length > 0 ? input.task : "Work on the overall task.",
    ...(input.context.length > 0 ? ["", "Context from other agents:", input.context] : []),
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  run: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as TItem, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Execute a compiled harness's protocol topology to completion.
 */
export async function runHarnessTopology(
  options: RunHarnessTopologyOptions,
): Promise<HarnessTopologyRunResult> {
  const { compiled, instruction } = options;
  const runId = options.runId ?? randomUUID();
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_TOPOLOGY_MAX_STEPS);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_TOPOLOGY_MAX_CONCURRENCY);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_TOPOLOGY_MAX_ATTEMPTS);
  const deadline =
    options.deadline === undefined
      ? undefined
      : options.deadline instanceof Date
        ? options.deadline
        : new Date(options.deadline);

  const trace: TraceEvent[] = [];
  const outcomes: ProtocolActionOutcome[] = [...(options.resumeFrom ?? [])];
  const executedKeys = new Set<string>(outcomes.map((outcome) => outcome.idempotencyKey));
  const events: CanonicalEvent[] = [];
  const policyDecisions: PolicyDecisionRecord[] = [];
  const artifacts: AgentHarnessArtifactRef[] = [];
  let totalCostUsd: number | undefined;

  const selection = selectHarnessTopology(compiled, {
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
  });
  const protocolName = selection.binding?.protocol ?? options.protocol ?? "unknown";
  const protocolId = selection.plugin?.manifest.id;

  async function record(input: {
    readonly type: TraceEventType;
    readonly summary: string;
    readonly actorId?: string;
    readonly causedByEventId?: string;
    readonly latencyMs?: number;
    readonly costUsd?: number;
  }): Promise<TraceEvent> {
    const sequence = trace.length + 1;
    const event: TraceEvent = Object.freeze({
      id: `${runId}:topology:${sequence}`,
      type: input.type,
      sequence,
      timestamp: new Date().toISOString(),
      runId,
      harnessId: compiled.id,
      ...(protocolId === undefined ? {} : { protocolId }),
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.causedByEventId === undefined ? {} : { causedByEventId: input.causedByEventId }),
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
      ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
      summary: input.summary,
    });
    trace.push(event);
    await options.onTraceEvent?.(event);
    return event;
  }

  let state: ProtocolState = Object.freeze({ status: "ready" });
  let steps = outcomes.reduce((max, outcome) => Math.max(max, outcome.step), 0);
  const notes: string[] = [];

  const goal = options.goal;
  const goalBrief = goal === undefined ? undefined : describeGoalForAgent(goal);
  let goalReport: GoalValidationReport | undefined;

  async function validateGoal(input: {
    readonly outputText: string;
    readonly candidate?: ProtocolActionOutcome;
    readonly causedByEventId?: string;
  }): Promise<GoalValidationReport> {
    if (goal === undefined) {
      throw new Error("No goal was supplied to the topology runner.");
    }
    const extra = await options.collectGoalEvidence?.({
      runId,
      outputText: input.outputText,
      ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
      outcomes: [...outcomes],
      events: [...events],
    });
    const evidence: GoalEvidence = {
      outputText: input.outputText,
      trace: goalTraceFromCanonicalEvents(events),
      ...(extra ?? {}),
    };
    const startedAt = Date.now();
    const report = await runGoalValidators(goal, evidence, {
      ...(options.goalValidators ?? {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      expectedFingerprint: goal.fingerprint,
    });
    goalReport = report;
    await record({
      type: "grader.completed",
      ...(input.causedByEventId === undefined ? {} : { causedByEventId: input.causedByEventId }),
      latencyMs: Date.now() - startedAt,
      summary: `Goal ${report.goalId} ${report.status}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.errored} errored.`,
    });
    return report;
  }

  /**
   * Gate success on the goal: when the final output was not already accepted
   * by a `validate_goal` action, run the validators on it once more.
   */
  async function succeed(): Promise<HarnessTopologyRunResult> {
    if (goal === undefined) {
      return finish({ status: "succeeded" });
    }
    const stateOutput = state.data?.["output"];
    const lastSucceeded = [...outcomes]
      .reverse()
      .find((outcome) => outcome.status === "succeeded" && outcome.outputText !== undefined);
    const outputText =
      typeof stateOutput === "string" ? stateOutput : (lastSucceeded?.outputText ?? "");
    const lastValidation = [...outcomes]
      .reverse()
      .find((outcome) => outcome.kind === "validate_goal" && outcome.status === "succeeded");
    const validatedCandidate =
      lastValidation?.verdict === "pass"
        ? outcomes.find(
            (outcome) => outcome.actionId === lastValidation.data?.["candidateActionId"],
          )
        : undefined;
    if (validatedCandidate !== undefined && validatedCandidate.outputText === outputText) {
      return finish({ status: "succeeded" });
    }
    let report: GoalValidationReport;
    try {
      report = await validateGoal({ outputText });
    } catch (error) {
      return finish({
        status: "failed",
        failureMessage: `Goal validation could not run: ${errorMessage(error)}`,
      });
    }
    if (report.complete) {
      return finish({ status: "succeeded" });
    }
    notes.push(`Goal ${report.goalId} is INCOMPLETE.`);
    return finish({ status: "failed", failureMessage: report.feedback });
  }

  function finish(input: {
    readonly status: HarnessTopologyRunStatus;
    readonly diagnostics?: readonly CompileDiagnostic[];
    readonly failureMessage?: string;
    readonly errorCategory?: AgentHarnessRunErrorCategory;
  }): HarnessTopologyRunResult {
    const stateOutput = state.data?.["output"];
    const lastSucceeded = [...outcomes]
      .reverse()
      .find((outcome) => outcome.status === "succeeded" && outcome.outputText !== undefined);
    const outputText =
      typeof stateOutput === "string" ? stateOutput : (lastSucceeded?.outputText ?? "");
    return Object.freeze({
      runId,
      harnessId: compiled.id,
      protocol: protocolName,
      ...(selection.binding === undefined ? {} : { bindingId: selection.binding.id }),
      status: input.status,
      outputText,
      ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage }),
      ...(input.errorCategory === undefined ? {} : { errorCategory: input.errorCategory }),
      state,
      steps,
      outcomes: Object.freeze([...outcomes]),
      trace: Object.freeze([...trace]),
      diagnostics: Object.freeze([...(input.diagnostics ?? selection.diagnostics)]),
      notes: Object.freeze([...new Set(notes)]),
      events: Object.freeze([...events]),
      policyDecisions: Object.freeze([...policyDecisions]),
      artifacts: Object.freeze([...artifacts]),
      ...(totalCostUsd === undefined ? {} : { costUsd: totalCostUsd }),
      ...(goalReport === undefined ? {} : { goalReport }),
    });
  }

  const { binding, plugin } = selection;
  if (binding === undefined || plugin === undefined) {
    for (const diagnostic of selection.diagnostics) {
      await record({ type: "diagnostic", summary: diagnostic.message });
    }
    return finish({
      status: "blocked",
      failureMessage: selection.diagnostics[0]?.message ?? "No runnable protocol topology.",
    });
  }

  const validation = (await plugin.validate?.(compiled)) ?? [];
  const errors = validation.filter((diagnostic) => diagnostic.severity === "error");
  for (const diagnostic of validation) {
    await record({ type: "diagnostic", summary: `${diagnostic.code}: ${diagnostic.message}` });
  }
  if (errors.length > 0) {
    state = Object.freeze({ status: "blocked" });
    return finish({
      status: "blocked",
      diagnostics: validation,
      failureMessage: errors.map((diagnostic) => diagnostic.message).join(" "),
    });
  }

  state = (await plugin.initialize?.(compiled)) ?? state;
  const actorsById = new Map(compiled.agents.map((agent) => [agent.id, agent]));

  async function executeActorAction(
    planned: ProtocolAction,
    step: number,
    plannedEvent: TraceEvent,
  ): Promise<ProtocolActionOutcome> {
    const actor = planned.actorRef === undefined ? undefined : actorsById.get(planned.actorRef);
    const base = {
      actionId: planned.id,
      idempotencyKey: planned.idempotencyKey,
      kind: planned.kind,
      ...(planned.actorRef === undefined ? {} : { actorRef: planned.actorRef }),
      ...(planned.payload === undefined ? {} : { payload: planned.payload }),
      step,
    };
    if (actor === undefined) {
      return Object.freeze({
        ...base,
        status: "failed",
        attempt: 0,
        failureMessage: `Action references unknown actor "${planned.actorRef ?? ""}".`,
      });
    }

    const task = payloadString(planned, "task");
    const context = payloadString(planned, "context");
    const prompt = buildTopologyActorPrompt({
      instruction,
      protocol: protocolName,
      action: planned,
      task,
      context,
      ...(goalBrief === undefined ? {} : { goalBrief }),
    });

    let last: ProtocolActionOutcome | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        break;
      }
      const invoked = await record({
        type: "actor.invoked",
        actorId: actor.id,
        causedByEventId: plannedEvent.id,
        summary: `${actor.id} invoked for ${planned.kind}${attempt > 1 ? ` (attempt ${attempt})` : ""}.`,
      });
      const startedAt = Date.now();
      let actorResult: TopologyActorResult;
      try {
        actorResult = await options.runner({
          runId,
          harnessId: compiled.id,
          protocol: protocolName,
          bindingId: binding?.id ?? protocolName,
          step,
          attempt,
          action: planned,
          actor,
          instruction,
          task,
          context,
          prompt,
          ...(goalBrief === undefined ? {} : { goalBrief }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        actorResult = { status: "failed", outputText: "", failureMessage: errorMessage(error) };
      }
      const latencyMs = Date.now() - startedAt;
      events.push(...(actorResult.events ?? []));
      policyDecisions.push(...(actorResult.policyDecisions ?? []));
      artifacts.push(...(actorResult.artifacts ?? []));
      if (actorResult.costUsd !== undefined) {
        totalCostUsd = (totalCostUsd ?? 0) + actorResult.costUsd;
      }

      const parsed = parseActorDirectives(actorResult.outputText);
      const verdict = actorResult.verdict ?? parsed.verdict;
      const data =
        parsed.data === undefined && actorResult.data === undefined
          ? undefined
          : { ...(parsed.data ?? {}), ...(actorResult.data ?? {}) };
      last = Object.freeze({
        ...base,
        status: actorResult.status,
        attempt,
        outputText: actorResult.outputText,
        ...(verdict === undefined ? {} : { verdict }),
        ...(data === undefined ? {} : { data }),
        ...(actorResult.failureMessage === undefined
          ? {}
          : { failureMessage: actorResult.failureMessage }),
      });
      await record({
        type: "actor.completed",
        actorId: actor.id,
        causedByEventId: invoked.id,
        latencyMs,
        ...(actorResult.costUsd === undefined ? {} : { costUsd: actorResult.costUsd }),
        summary:
          actorResult.status === "succeeded"
            ? `${actor.id} completed ${planned.kind}${verdict === undefined ? "" : ` with verdict ${verdict}`}.`
            : `${actor.id} failed ${planned.kind}: ${actorResult.failureMessage ?? "unknown error"}.`,
      });
      if (actorResult.status === "succeeded" || actorResult.retryable === false) {
        break;
      }
    }

    return (
      last ??
      Object.freeze({
        ...base,
        status: "skipped",
        attempt: 0,
        failureMessage: "Run was cancelled before the action started.",
      })
    );
  }

  async function executeAction(
    planned: ProtocolAction,
    step: number,
  ): Promise<
    | ProtocolActionOutcome
    | { readonly terminal: HarnessTopologyRunStatus; readonly message?: string }
  > {
    const plannedEvent = await record({
      type: "protocol.action.planned",
      ...(planned.actorRef === undefined ? {} : { actorId: planned.actorRef }),
      summary: `Step ${step}: ${planned.kind}${planned.actorRef === undefined ? "" : ` -> ${planned.actorRef}`} (${planned.id}).`,
    });
    const base = {
      actionId: planned.id,
      idempotencyKey: planned.idempotencyKey,
      kind: planned.kind,
      ...(planned.actorRef === undefined ? {} : { actorRef: planned.actorRef }),
      ...(planned.payload === undefined ? {} : { payload: planned.payload }),
      step,
      attempt: 1,
    };

    if (ACTOR_ACTION_KINDS.has(planned.kind)) {
      return executeActorAction(planned, step, plannedEvent);
    }
    switch (planned.kind) {
      case "complete":
        return { terminal: "succeeded" };
      case "validate_goal": {
        const candidateId = payloadString(planned, "candidateActionId");
        const candidate =
          outcomes.find((outcome) => outcome.actionId === candidateId) ??
          [...outcomes]
            .reverse()
            .find((outcome) => outcome.status === "succeeded" && outcome.kind !== "validate_goal");
        try {
          const report = await validateGoal({
            outputText: candidate?.outputText ?? "",
            ...(candidate === undefined ? {} : { candidate }),
            causedByEventId: plannedEvent.id,
          });
          return Object.freeze({
            ...base,
            status: "succeeded",
            verdict: report.complete ? "pass" : "fail",
            outputText: report.feedback,
            data: {
              goalId: report.goalId,
              goalFingerprint: report.goalFingerprint,
              goalStatus: report.status,
              ...(candidate === undefined ? {} : { candidateActionId: candidate.actionId }),
              required: report.summary.required,
              passed: report.summary.passed,
              failed: report.summary.failed,
              errored: report.summary.errored,
            },
          });
        } catch (error) {
          return Object.freeze({
            ...base,
            status: "failed",
            failureMessage: `Goal validation could not run: ${errorMessage(error)}`,
          });
        }
      }
      case "fail":
        return {
          terminal: "failed",
          message: payloadString(planned, "reason") || "Protocol failed the run.",
        };
      case "emit_trace":
        await record({
          type: "diagnostic",
          causedByEventId: plannedEvent.id,
          summary: payloadString(planned, "summary") || `Protocol trace from ${planned.id}.`,
        });
        return Object.freeze({ ...base, status: "succeeded" });
      case "request_approval": {
        if (options.approve === undefined) {
          return {
            terminal: "blocked",
            message: `Action ${planned.id} requires approval and no approver is configured.`,
          };
        }
        const approved = await options.approve({
          runId,
          protocol: protocolName,
          step,
          action: planned,
        });
        await record({
          type: "policy.decision",
          causedByEventId: plannedEvent.id,
          summary: `Approval ${approved ? "granted" : "rejected"} for ${planned.id}.`,
        });
        return Object.freeze({
          ...base,
          status: "succeeded",
          verdict: approved ? "pass" : "fail",
        });
      }
      default:
        return Object.freeze({
          ...base,
          status: "skipped",
          failureMessage: `Action kind "${planned.kind}" is not supported by the topology runner.`,
        });
    }
  }

  while (true) {
    if (options.signal?.aborted) {
      await record({ type: "diagnostic", summary: "Topology run cancelled." });
      return finish({
        status: "cancelled",
        failureMessage: "Topology run was cancelled.",
        errorCategory: "cancelled",
      });
    }
    if (deadline !== undefined && Date.now() >= deadline.getTime()) {
      await record({ type: "diagnostic", summary: "Topology run deadline elapsed." });
      return finish({
        status: "failed",
        failureMessage: "Topology run deadline elapsed.",
        errorCategory: "deadline_exceeded",
      });
    }
    if (steps >= maxSteps) {
      await record({
        type: "diagnostic",
        summary: `Topology step budget of ${maxSteps} exhausted.`,
      });
      return finish({
        status: "failed",
        failureMessage: `Topology did not finish within ${maxSteps} steps.`,
        errorCategory: "budget_exceeded",
      });
    }

    const reduction = await plugin.reduce({
      compiled,
      state,
      events: trace,
      outcomes,
      binding,
      instruction,
      ...(goal === undefined ? {} : { goal: { id: goal.spec.id, fingerprint: goal.fingerprint } }),
    });
    state = reduction.state;
    notes.push(...(reduction.summary.notes ?? []));
    const fresh = reduction.actions.filter(
      (candidate) => !executedKeys.has(candidate.idempotencyKey),
    );

    if (fresh.length === 0) {
      if (state.status === "done") {
        return succeed();
      }
      if (state.status === "failed") {
        return finish({
          status: "failed",
          failureMessage: reduction.summary.notes?.join(" ") || "Protocol reported failure.",
        });
      }
      return finish({
        status: "blocked",
        failureMessage:
          reduction.summary.notes?.join(" ") ||
          (state.status === "blocked"
            ? "Protocol is blocked."
            : "Protocol produced no new actions before finishing."),
      });
    }

    steps += 1;
    for (const planned of fresh) {
      executedKeys.add(planned.idempotencyKey);
    }
    const executed = await mapWithConcurrency(fresh, maxConcurrency, (planned) =>
      executeAction(planned, steps),
    );
    let terminal:
      | { readonly terminal: HarnessTopologyRunStatus; readonly message?: string }
      | undefined;
    for (const item of executed) {
      if ("terminal" in item) {
        terminal ??= item;
        continue;
      }
      outcomes.push(item);
      await options.onOutcome?.(item);
    }
    if (terminal?.terminal === "succeeded") {
      return succeed();
    }
    if (terminal !== undefined) {
      return finish({
        status: terminal.terminal,
        ...(terminal.message === undefined ? {} : { failureMessage: terminal.message }),
      });
    }
  }
}
