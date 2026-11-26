import type { JsonObject, JsonValue } from "../contracts/shared.js";
import type {
  CompiledActor,
  CompiledHarness,
  CompileDiagnostic,
  ProtocolAction,
  ProtocolActionOutcome,
  ProtocolActorVerdict,
  ProtocolBindingSpec,
  ProtocolPlugin,
  ProtocolReduceInput,
  ProtocolState,
  ProtocolSummary,
  TraceEvent,
} from "./types.js";

/**
 * Standard topology protocols.
 *
 * Each protocol is a pure reducer: given the compiled harness, the binding, the
 * instruction, and the outcomes of every action executed so far, it returns the
 * next batch of actions. Actions returned together are independent and may run
 * concurrently; the topology runner in `@generic-ai/core` executes them, records
 * one {@link ProtocolActionOutcome} per action, and calls `reduce` again until
 * the protocol reports `done`, `failed`, or `blocked`.
 *
 * Reducers never perform side effects, so the same inputs always produce the
 * same actions. Action `idempotencyKey`s are stable across reductions; runners
 * skip any action whose key already has an outcome.
 */

const DEFAULT_MAX_CONTEXT_CHARS = 12_000;
const DEFAULT_VERIFIER_MAX_ITERATIONS = 3;

const VERDICT_INSTRUCTION =
  'End your response with a line "VERDICT: PASS" if the work is acceptable as-is, or "VERDICT: FAIL" followed by the concrete problems that must be fixed.';

interface ParsedActorDirectives {
  readonly verdict?: ProtocolActorVerdict;
  readonly data?: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract machine-readable directives from an actor's text output.
 *
 * Recognised forms:
 * - a `VERDICT: PASS` / `VERDICT: FAIL` line (the last one wins), and
 * - the last fenced ```json block whose body is a JSON object. Its `verdict`
 *   field, when present, overrides the line form.
 */
export function parseActorDirectives(outputText: string | undefined): ParsedActorDirectives {
  if (outputText === undefined || outputText.length === 0) {
    return {};
  }

  let verdict: ProtocolActorVerdict | undefined;
  for (const match of outputText.matchAll(/^\s*\**\s*VERDICT\s*\**\s*:\s*\**\s*(PASS|FAIL)\b/gim)) {
    verdict = match[1]?.toUpperCase() === "PASS" ? "pass" : "fail";
  }

  let data: JsonObject | undefined;
  for (const match of outputText.matchAll(/```json\s*\n([\s\S]*?)```/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (isJsonObject(parsed)) {
        data = parsed;
      }
    } catch {
      // Ignore malformed blocks; an earlier valid block still counts.
    }
  }

  const dataVerdict = data?.["verdict"];
  if (typeof dataVerdict === "string") {
    const normalized = dataVerdict.trim().toLowerCase();
    if (normalized === "pass" || normalized === "fail") {
      verdict = normalized;
    }
  }

  return {
    ...(verdict === undefined ? {} : { verdict }),
    ...(data === undefined ? {} : { data }),
  };
}

function actorByRole(
  compiled: CompiledHarness,
  role: string,
  candidates?: readonly string[],
): string | undefined {
  const pool =
    candidates === undefined || candidates.length === 0
      ? compiled.agents
      : compiled.agents.filter((agent) => candidates.includes(agent.id));
  return pool.find((agent) => agent.role === role)?.id;
}

function actorExists(compiled: CompiledHarness, actorRef: string | undefined): actorRef is string {
  return actorRef !== undefined && compiled.agents.some((agent) => agent.id === actorRef);
}

function actorById(compiled: CompiledHarness, actorRef: string): CompiledActor | undefined {
  return compiled.agents.find((agent) => agent.id === actorRef);
}

function hasCompleted(events: readonly TraceEvent[]): boolean {
  return events.some(
    (event) => event.type === "trial.completed" || event.type === "benchmark.completed",
  );
}

function resolveBinding(
  compiled: CompiledHarness,
  protocol: string,
  binding: ProtocolBindingSpec | undefined,
): ProtocolBindingSpec | undefined {
  return binding ?? compiled.protocols.find((candidate) => candidate.protocol === protocol);
}

function configString(config: JsonObject | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function configNumber(config: JsonObject | undefined, key: string): number | undefined {
  const value = config?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function configStrings(config: JsonObject | undefined, key: string): readonly string[] | undefined {
  const value = config?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function action(input: {
  readonly id: string;
  readonly kind: ProtocolAction["kind"];
  readonly actorRef?: string;
  readonly payload?: ProtocolAction["payload"];
}): ProtocolAction {
  return Object.freeze({
    id: input.id,
    idempotencyKey: input.id,
    kind: input.kind,
    ...(input.actorRef === undefined ? {} : { actorRef: input.actorRef }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
}

function summary(
  status: ProtocolState["status"],
  actions: readonly ProtocolAction[],
  notes?: readonly string[],
): ProtocolSummary {
  return Object.freeze({
    status,
    actionCount: actions.length,
    blockerCount: status === "blocked" ? 1 : 0,
    ...(notes === undefined || notes.length === 0 ? {} : { notes: Object.freeze([...notes]) }),
  });
}

function state(status: ProtocolState["status"], data?: JsonObject): ProtocolState {
  return Object.freeze({ status, ...(data === undefined ? {} : { data }) });
}

type ReduceResult = Awaited<ReturnType<ProtocolPlugin["reduce"]>>;

function result(
  status: ProtocolState["status"],
  actions: readonly ProtocolAction[],
  options: {
    readonly output?: string;
    readonly notes?: readonly string[];
    readonly data?: JsonObject;
  } = {},
): ReduceResult {
  const data: Record<string, JsonValue> = { ...(options.data ?? {}) };
  if (options.output !== undefined) {
    data["output"] = options.output;
  }
  if (options.notes !== undefined && options.notes.length > 0) {
    data["notes"] = [...options.notes];
  }
  const nextState = state(status, Object.keys(data).length === 0 ? undefined : data);
  return Object.freeze({
    state: nextState,
    actions: Object.freeze([...actions]),
    summary: summary(status, actions, options.notes),
  });
}

function completedResult(): ReduceResult {
  return result("done", []);
}

function latestOutcome(
  outcomes: readonly ProtocolActionOutcome[],
  key: string,
): ProtocolActionOutcome | undefined {
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index];
    if (outcome?.idempotencyKey === key) {
      return outcome;
    }
  }
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.max(0, maxChars - 40);
  return `${text.slice(0, head)}\n…[truncated ${text.length - head} chars]`;
}

function contextBlock(
  entries: readonly { readonly label: string; readonly text: string | undefined }[],
  maxChars: number,
): string {
  const usable = entries.filter((entry) => entry.text !== undefined && entry.text.length > 0);
  if (usable.length === 0) {
    return "";
  }
  const perEntry = Math.max(500, Math.floor(maxChars / usable.length));
  return usable
    .map((entry) => `### ${entry.label}\n${truncate(entry.text ?? "", perEntry)}`)
    .join("\n\n");
}

function maxContextChars(binding: ProtocolBindingSpec | undefined): number {
  return configNumber(binding?.config, "maxContextChars") ?? DEFAULT_MAX_CONTEXT_CHARS;
}

function failureText(outcome: ProtocolActionOutcome): string {
  return outcome.failureMessage ?? (outcome.status === "skipped" ? "skipped" : "failed");
}

function requireActors(
  compiled: CompiledHarness,
  roles: readonly string[],
): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const role of roles) {
    if (actorByRole(compiled, role) === undefined) {
      diagnostics.push({
        severity: "error",
        code: "missing_protocol_actor",
        message: `Protocol requires an actor with role "${role}".`,
        path: "agents",
      });
    }
  }
  return Object.freeze(diagnostics);
}

function missingConfiguredActor(
  bindingId: string,
  key: string,
  actorRef: string,
): CompileDiagnostic {
  return {
    severity: "error",
    code: "missing_protocol_actor",
    message: `Protocol binding "${bindingId}" config.${key} references unknown actor "${actorRef}".`,
    path: `protocols.${bindingId}.config.${key}`,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function pipelineStages(
  compiled: CompiledHarness,
  binding: ProtocolBindingSpec | undefined,
): readonly string[] {
  const configured = configStrings(binding?.config, "stages");
  if (configured !== undefined) {
    return configured;
  }
  if (binding !== undefined && binding.actorRefs.length > 0) {
    return binding.actorRefs;
  }
  const implementer = actorByRole(compiled, "implementer");
  return implementer === undefined ? [] : [implementer];
}

export function createPipelineProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-pipeline",
      name: "Pipeline Protocol",
      version: "0.2.0",
      protocol: "pipeline",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) => {
      const binding = resolveBinding(compiled, "pipeline", undefined);
      const configured = configStrings(binding?.config, "stages");
      if (binding !== undefined && configured !== undefined) {
        return configured
          .filter((actorRef) => !actorExists(compiled, actorRef))
          .map((actorRef) => missingConfiguredActor(binding.id, "stages", actorRef));
      }
      if (binding !== undefined && binding.actorRefs.length > 0) {
        return [];
      }
      return requireActors(compiled, ["implementer"]);
    },
    reduce: async (input: ProtocolReduceInput) => {
      const { compiled, events } = input;
      if (hasCompleted(events)) {
        return completedResult();
      }

      const binding = resolveBinding(compiled, "pipeline", input.binding);
      const stages = pipelineStages(compiled, binding).filter((actorRef) =>
        actorExists(compiled, actorRef),
      );
      if (stages.length === 0) {
        return result("blocked", [], { notes: ["Pipeline has no executable stages."] });
      }

      const outcomes = input.outcomes ?? [];
      const maxChars = maxContextChars(binding);
      const prior: { label: string; text: string | undefined }[] = [];
      for (const [index, actorRef] of stages.entries()) {
        const key = `${compiled.id}:pipeline:stage-${index + 1}:${actorRef}`;
        const outcome = latestOutcome(outcomes, key);
        if (outcome === undefined) {
          const isLast = index === stages.length - 1;
          const actor = actorById(compiled, actorRef);
          return result("ready", [
            action({
              id: key,
              kind: "invoke_actor",
              actorRef,
              payload: {
                protocol: "pipeline",
                stage: index + 1,
                stageCount: stages.length,
                phase: actor?.role ?? actorRef,
                task: [
                  `You are stage ${index + 1} of ${stages.length} in a pipeline.`,
                  index === 0
                    ? "Start the work on the task below."
                    : "Continue from the previous stages' handoffs included as context.",
                  isLast
                    ? "You are the final stage: produce the final deliverable for the task."
                    : "Produce a concrete handoff for the next stage.",
                  'If the work you received is not acceptable and cannot be fixed in this stage, end with "VERDICT: FAIL" and the reason.',
                ].join(" "),
                context: contextBlock(prior, maxChars),
              },
            }),
          ]);
        }
        if (outcome.status !== "succeeded") {
          return result("failed", [], {
            notes: [`Pipeline stage ${index + 1} (${actorRef}) ${failureText(outcome)}.`],
          });
        }
        if (outcome.verdict === "fail") {
          return result("failed", [], {
            output: outcome.outputText ?? "",
            notes: [`Pipeline stage ${index + 1} (${actorRef}) rejected the work.`],
          });
        }
        prior.push({ label: `Stage ${index + 1}: ${actorRef}`, text: outcome.outputText });
      }

      const lastText = prior[prior.length - 1]?.text ?? "";
      return result("done", [], { output: lastText });
    },
  };
  return Object.freeze(plugin);
}

// ---------------------------------------------------------------------------
// Verifier loop
// ---------------------------------------------------------------------------

interface VerifierLoopActors {
  readonly solver?: string;
  readonly critic?: string;
  readonly repairer?: string;
}

function verifierLoopActors(
  compiled: CompiledHarness,
  binding: ProtocolBindingSpec | undefined,
): VerifierLoopActors {
  const pick = (role: string): string | undefined =>
    configString(binding?.config, role) ?? actorByRole(compiled, role, binding?.actorRefs);
  const solver = pick("solver");
  const critic = pick("critic");
  const repairer = pick("repairer") ?? solver;
  return {
    ...(solver === undefined ? {} : { solver }),
    ...(critic === undefined ? {} : { critic }),
    ...(repairer === undefined ? {} : { repairer }),
  };
}

export function createVerifierLoopProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-verifier-loop",
      name: "Verifier Loop Protocol",
      version: "0.2.0",
      protocol: "verifier-loop",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) => {
      const binding = resolveBinding(compiled, "verifier-loop", undefined);
      const actors = verifierLoopActors(compiled, binding);
      const diagnostics: CompileDiagnostic[] = [];
      for (const role of ["solver", "critic"] as const) {
        const actorRef = actors[role];
        if (actorRef === undefined) {
          diagnostics.push(...requireActors(compiled, [role]));
        } else if (binding !== undefined && !actorExists(compiled, actorRef)) {
          diagnostics.push(missingConfiguredActor(binding.id, role, actorRef));
        }
      }
      return Object.freeze(diagnostics);
    },
    reduce: async (input: ProtocolReduceInput) => {
      const { compiled, events } = input;
      if (hasCompleted(events)) {
        return completedResult();
      }

      const binding = resolveBinding(compiled, "verifier-loop", input.binding);
      const { solver, critic, repairer } = verifierLoopActors(compiled, binding);
      if (!actorExists(compiled, solver) || !actorExists(compiled, critic)) {
        return result("blocked", [], {
          notes: ["Verifier loop requires solver and critic actors."],
        });
      }
      const repairActor = actorExists(compiled, repairer) ? repairer : solver;
      const maxIterations = Math.max(
        1,
        Math.floor(
          configNumber(binding?.config, "maxIterations") ?? DEFAULT_VERIFIER_MAX_ITERATIONS,
        ),
      );
      const maxChars = maxContextChars(binding);
      const outcomes = input.outcomes ?? [];
      const prefix = `${compiled.id}:verifier-loop`;

      let candidate: ProtocolActionOutcome | undefined;
      let candidateLabel = "Candidate";
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const produceKey =
          iteration === 1
            ? `${prefix}:solve:${solver}`
            : `${prefix}:repair-${iteration - 1}:${repairActor}`;
        const producer = iteration === 1 ? solver : repairActor;
        const produced = latestOutcome(outcomes, produceKey);
        if (produced === undefined) {
          const previousReview =
            iteration === 1
              ? undefined
              : latestOutcome(outcomes, `${prefix}:review-${iteration - 1}:${critic}`);
          return result("ready", [
            action({
              id: produceKey,
              kind: "invoke_actor",
              actorRef: producer,
              payload: {
                protocol: "verifier-loop",
                loopRole: iteration === 1 ? "solver" : "repairer",
                iteration,
                phase: iteration === 1 ? "solve" : "repair",
                task:
                  iteration === 1
                    ? "Solve the task below. Your result will be reviewed by a critic."
                    : "The critic rejected the previous candidate. Fix every problem the critique lists and return the complete corrected result.",
                context:
                  iteration === 1
                    ? ""
                    : contextBlock(
                        [
                          { label: candidateLabel, text: candidate?.outputText },
                          { label: "Critique", text: previousReview?.outputText },
                        ],
                        maxChars,
                      ),
              },
            }),
          ]);
        }
        if (produced.status !== "succeeded") {
          return result("failed", [], {
            notes: [
              `Verifier loop ${producer} ${failureText(produced)} in iteration ${iteration}.`,
            ],
          });
        }
        candidate = produced;
        candidateLabel = iteration === 1 ? "Candidate" : `Candidate (repair ${iteration - 1})`;

        const reviewKey = `${prefix}:review-${iteration}:${critic}`;
        const review = latestOutcome(outcomes, reviewKey);
        if (review === undefined) {
          return result("ready", [
            action({
              id: reviewKey,
              kind: "review_artifact",
              actorRef: critic,
              payload: {
                protocol: "verifier-loop",
                loopRole: "critic",
                iteration,
                phase: "review",
                task: `Review the candidate result below against the task. Check it independently instead of trusting the author's claims. ${VERDICT_INSTRUCTION}`,
                context: contextBlock(
                  [{ label: candidateLabel, text: candidate.outputText }],
                  maxChars,
                ),
              },
            }),
          ]);
        }
        if (review.status !== "succeeded") {
          return result("failed", [], {
            notes: [`Verifier loop critic ${failureText(review)} in iteration ${iteration}.`],
          });
        }
        if (review.verdict === "pass") {
          return result("done", [], {
            output: candidate.outputText ?? "",
            data: { iterations: iteration },
          });
        }
      }

      return result("failed", [], {
        output: candidate?.outputText ?? "",
        notes: [`Critic did not accept a candidate within ${maxIterations} iteration(s).`],
        data: { iterations: maxIterations },
      });
    },
  };
  return Object.freeze(plugin);
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

function hierarchyManager(
  compiled: CompiledHarness,
  binding: ProtocolBindingSpec | undefined,
): string | undefined {
  return (
    configString(binding?.config, "manager") ?? actorByRole(compiled, "manager", binding?.actorRefs)
  );
}

function hierarchyDelegatees(
  compiled: CompiledHarness,
  binding: ProtocolBindingSpec | undefined,
  manager: string,
): readonly string[] {
  const configured = configStrings(binding?.config, "delegatees");
  if (configured !== undefined) {
    return configured.filter((actorRef) => actorRef !== manager);
  }
  const related = compiled.relationships
    .filter(
      (relationship) =>
        relationship.kind === "delegates_to" && relationship.fromAgentRef === manager,
    )
    .map((relationship) => relationship.toAgentRef);
  if (related.length > 0) {
    return [...new Set(related)];
  }
  if (binding !== undefined && binding.actorRefs.length > 0) {
    return binding.actorRefs.filter((actorRef) => actorRef !== manager);
  }
  return compiled.agents.map((agent) => agent.id).filter((actorRef) => actorRef !== manager);
}

interface Assignment {
  readonly actorRef: string;
  readonly task: string;
}

function planAssignments(
  plan: ProtocolActionOutcome,
  delegatees: readonly string[],
  instruction: string,
): readonly Assignment[] {
  const raw = plan.data?.["assignments"];
  const assignments: Assignment[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isJsonObject(entry)) {
        continue;
      }
      const actorRef = entry["actorRef"] ?? entry["agent"] ?? entry["actor"];
      const task = entry["task"];
      if (typeof actorRef === "string" && delegatees.includes(actorRef)) {
        assignments.push({
          actorRef,
          task: typeof task === "string" && task.length > 0 ? task : instruction,
        });
      }
    }
  }
  if (assignments.length > 0) {
    return assignments;
  }
  return delegatees.map((actorRef) => ({
    actorRef,
    task: "Carry out your part of the task below, following the manager's plan included as context.",
  }));
}

export function createHierarchyProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-hierarchy",
      name: "Hierarchy Protocol",
      version: "0.2.0",
      protocol: "hierarchy",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) => {
      const binding = resolveBinding(compiled, "hierarchy", undefined);
      const manager = hierarchyManager(compiled, binding);
      if (manager === undefined) {
        return requireActors(compiled, ["manager"]);
      }
      const diagnostics: CompileDiagnostic[] = [];
      if (binding !== undefined && !actorExists(compiled, manager)) {
        diagnostics.push(missingConfiguredActor(binding.id, "manager", manager));
      }
      const delegatees = hierarchyDelegatees(compiled, binding, manager);
      for (const actorRef of delegatees) {
        if (binding !== undefined && !actorExists(compiled, actorRef)) {
          diagnostics.push(missingConfiguredActor(binding.id, "delegatees", actorRef));
        }
      }
      if (delegatees.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "missing_protocol_actor",
          message: "Hierarchy protocol requires at least one actor for the manager to delegate to.",
          path: "agents",
        });
      }
      return Object.freeze(diagnostics);
    },
    reduce: async (input: ProtocolReduceInput) => {
      const { compiled, events } = input;
      if (hasCompleted(events)) {
        return completedResult();
      }

      const binding = resolveBinding(compiled, "hierarchy", input.binding);
      const manager = hierarchyManager(compiled, binding);
      if (!actorExists(compiled, manager)) {
        return result("blocked", [], { notes: ["Hierarchy protocol requires a manager actor."] });
      }
      const delegatees = hierarchyDelegatees(compiled, binding, manager).filter((actorRef) =>
        actorExists(compiled, actorRef),
      );
      if (delegatees.length === 0) {
        return result("blocked", [], { notes: ["Hierarchy manager has nobody to delegate to."] });
      }

      const outcomes = input.outcomes ?? [];
      const maxChars = maxContextChars(binding);
      const prefix = `${compiled.id}:hierarchy`;
      const planKey = `${prefix}:plan:${manager}`;
      const plan = latestOutcome(outcomes, planKey);
      if (plan === undefined) {
        return result("ready", [
          action({
            id: planKey,
            kind: "invoke_actor",
            actorRef: manager,
            payload: {
              protocol: "hierarchy",
              phase: "plan",
              task: [
                "You manage a team. Break the task below into assignments for your reports and do not do the work yourself.",
                `Your reports are: ${delegatees.join(", ")}.`,
                'Return the assignments in a fenced ```json block shaped like {"assignments":[{"actorRef":"<report id>","task":"<focused task>"}]}. Omit reports that have nothing to do.',
              ].join(" "),
              context: "",
            },
          }),
        ]);
      }
      if (plan.status !== "succeeded") {
        return result("failed", [], { notes: [`Hierarchy manager plan ${failureText(plan)}.`] });
      }

      const assignments = planAssignments(plan, delegatees, input.instruction ?? "");
      const delegateActions: ProtocolAction[] = [];
      const reports: { label: string; text: string | undefined }[] = [];
      const notes: string[] = [];
      for (const [index, assignment] of assignments.entries()) {
        const key = `${prefix}:delegate-${index + 1}:${assignment.actorRef}`;
        const outcome = latestOutcome(outcomes, key);
        if (outcome === undefined) {
          delegateActions.push(
            action({
              id: key,
              kind: "delegate_work",
              actorRef: assignment.actorRef,
              payload: {
                protocol: "hierarchy",
                phase: "delegate",
                assignedBy: manager,
                task: assignment.task,
                context: contextBlock([{ label: "Manager plan", text: plan.outputText }], maxChars),
              },
            }),
          );
          continue;
        }
        if (outcome.status === "succeeded") {
          reports.push({ label: `Report from ${assignment.actorRef}`, text: outcome.outputText });
        } else {
          const note = `Delegate ${assignment.actorRef} ${failureText(outcome)}.`;
          notes.push(note);
          reports.push({ label: `Report from ${assignment.actorRef}`, text: `[${note}]` });
        }
      }
      if (delegateActions.length > 0) {
        return result("ready", delegateActions);
      }

      const synthesizeKey = `${prefix}:synthesize:${manager}`;
      const synthesis = latestOutcome(outcomes, synthesizeKey);
      if (synthesis === undefined) {
        return result(
          "ready",
          [
            action({
              id: synthesizeKey,
              kind: "invoke_actor",
              actorRef: manager,
              payload: {
                protocol: "hierarchy",
                phase: "synthesize",
                task: "Your reports have finished. Combine their work into the final result for the task below, and call out any gaps or failed assignments.",
                context: contextBlock(reports, maxChars),
              },
            }),
          ],
          { notes },
        );
      }
      if (synthesis.status !== "succeeded") {
        return result("failed", [], {
          notes: [...notes, `Hierarchy manager synthesis ${failureText(synthesis)}.`],
        });
      }
      return result("done", [], { output: synthesis.outputText ?? "", notes });
    },
  };
  return Object.freeze(plugin);
}

// ---------------------------------------------------------------------------
// Squad
// ---------------------------------------------------------------------------

interface WorkItem {
  readonly id: string;
  readonly task: string;
}

function normalizeWorkItems(raw: JsonValue | undefined): readonly WorkItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: WorkItem[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    let id: string | undefined;
    let task: string | undefined;
    if (typeof entry === "string") {
      task = entry;
    } else if (isJsonObject(entry)) {
      task = typeof entry["task"] === "string" ? entry["task"] : undefined;
      id = typeof entry["id"] === "string" ? entry["id"] : undefined;
    }
    if (task === undefined || task.trim().length === 0) {
      continue;
    }
    let itemId = (id ?? `item-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, "-");
    while (seen.has(itemId)) {
      itemId = `${itemId}-dup`;
    }
    seen.add(itemId);
    items.push({ id: itemId, task });
  }
  return items;
}

function squadMembers(
  compiled: CompiledHarness,
  binding: ProtocolBindingSpec | undefined,
): readonly string[] {
  const refs =
    binding !== undefined && binding.actorRefs.length > 0
      ? binding.actorRefs
      : compiled.agents.map((agent) => agent.id);
  return refs.filter((actorRef) => actorExists(compiled, actorRef));
}

export function createSquadProtocol(): ProtocolPlugin {
  const plugin: ProtocolPlugin = {
    manifest: {
      id: "@generic-ai/protocol-squad",
      name: "Squad Protocol",
      version: "0.2.0",
      protocol: "squad",
    },
    initialize: async () => state("ready"),
    validate: async (compiled) =>
      compiled.spaces.some((space) => space.visibility === "shared")
        ? []
        : [
            {
              severity: "error",
              code: "missing_shared_space",
              message: "Squad protocol requires at least one shared space.",
              path: "spaces",
            },
          ],
    reduce: async (input: ProtocolReduceInput) => {
      const { compiled, events } = input;
      if (hasCompleted(events)) {
        return completedResult();
      }

      const binding = resolveBinding(compiled, "squad", input.binding);
      const members = squadMembers(compiled, binding);
      if (members.length === 0) {
        return result("blocked", [], { notes: ["Squad protocol has no members."] });
      }
      const space =
        configString(binding?.config, "space") ??
        compiled.spaces.find((candidate) => candidate.visibility === "shared")?.id ??
        "shared";
      const outcomes = input.outcomes ?? [];
      const maxChars = maxContextChars(binding);
      const prefix = `${compiled.id}:squad`;

      let items = normalizeWorkItems(binding?.config?.["workItems"]);
      if (items.length === 0) {
        const lead = configString(binding?.config, "lead") ?? members[0] ?? "";
        const decomposeKey = `${prefix}:decompose:${lead}`;
        const decomposition = latestOutcome(outcomes, decomposeKey);
        if (decomposition === undefined) {
          return result("ready", [
            action({
              id: decomposeKey,
              kind: "invoke_actor",
              actorRef: lead,
              payload: {
                protocol: "squad",
                phase: "decompose",
                space,
                task: [
                  `Split the task below into independent work items that ${members.length} squad member(s) can claim in parallel.`,
                  'Return them in a fenced ```json block shaped like {"workItems":[{"id":"short-id","task":"<self-contained task>"}]}.',
                ].join(" "),
                context: "",
              },
            }),
          ]);
        }
        if (decomposition.status !== "succeeded") {
          return result("failed", [], {
            notes: [`Squad decomposition by ${lead} ${failureText(decomposition)}.`],
          });
        }
        items = normalizeWorkItems(decomposition.data?.["workItems"]);
        if (items.length === 0) {
          items = [{ id: "item-1", task: input.instruction ?? "Complete the task." }];
        }
      }

      const board: { label: string; text: string | undefined }[] = [];
      const pending: WorkItem[] = [];
      const failures: string[] = [];
      for (const item of items) {
        const outcome = outcomes.find(
          (candidate) =>
            candidate.payload?.["workItemId"] === item.id &&
            candidate.idempotencyKey.startsWith(`${prefix}:claim:`),
        );
        if (outcome === undefined) {
          pending.push(item);
        } else if (outcome.status === "succeeded") {
          board.push({
            label: `${item.id} (by ${outcome.actorRef ?? "?"})`,
            text: outcome.outputText,
          });
        } else {
          failures.push(`Work item ${item.id} ${failureText(outcome)}.`);
          board.push({ label: `${item.id} (failed)`, text: `[${failureText(outcome)}]` });
        }
      }

      if (pending.length > 0) {
        const batch = pending.slice(0, members.length);
        const sharedBoard = contextBlock(board, maxChars);
        const actions = batch.map((item, index) => {
          const actorRef = members[index % members.length] ?? members[0] ?? "";
          return action({
            id: `${prefix}:claim:${item.id}:${actorRef}`,
            kind: "claim_work",
            actorRef,
            payload: {
              protocol: "squad",
              phase: "claim",
              space,
              workItemId: item.id,
              task: `You claimed work item "${item.id}" from the shared ${space} space: ${item.task}`,
              context: sharedBoard,
            },
          });
        });
        return result("ready", actions, { notes: failures });
      }

      const output = board.map((entry) => `### ${entry.label}\n${entry.text ?? ""}`).join("\n\n");
      return result(failures.length === 0 ? "done" : "failed", [], {
        output,
        notes: failures,
        data: { workItemCount: items.length },
      });
    },
  };
  return Object.freeze(plugin);
}

export const STANDARD_PROTOCOLS = Object.freeze([
  createPipelineProtocol(),
  createVerifierLoopProtocol(),
  createHierarchyProtocol(),
  createSquadProtocol(),
]);
