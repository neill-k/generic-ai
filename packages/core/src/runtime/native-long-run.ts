import type { Agent, AgentTool } from "@generic-ai/agent";
import type { AssistantMessage } from "@generic-ai/ai";
import {
  type AutonomousConfig,
  AutonomousDriver,
  captureGitWorktreeSnapshot,
  createAutonomousRuntimeState,
  createGoal,
  createGoalTools,
  createShellGateRunner,
  formatProcessExit,
  GOAL_STATE_CUSTOM_TYPE,
  type GateRunner,
  GoalDriver,
  type GoalState,
  isPersistedGoalState,
  LongRunController,
  MAX_GOAL_OBJECTIVE_CHARS,
  truncateGateOutput,
} from "@generic-ai/autonomy";
import {
  describeGoalForAgent,
  type GoalCheck,
  type GoalEvidence,
  type GoalValidationReport,
  type GoalValidatorSpec,
  type RunGoalValidatorsOptions,
  runGoalValidators,
  type SealedGoal,
  sealGoal,
} from "@generic-ai/sdk";
import type { SessionManager } from "@generic-ai/session";

/**
 * A persistent thread goal for a native session (see `@generic-ai/autonomy` and `docs/goals.md`).
 * While it is active the session keeps continuing until the agent completes it with
 * `complete_goal`, its token budget runs out, or turns stop making progress.
 *
 * Completion is decided by the SDK goal runner, the same one delegated tasks and team workflows
 * use: `complete_goal` runs the goal's validators (plus the autonomous gate commands) through
 * `runGoalValidators`, and an INCOMPLETE report keeps the goal active and sends its feedback back.
 */
export interface NativeSessionGoal {
  /**
   * The SDK goal this session pursues. Its id, objective, definition of done and checks become the
   * thread goal, and its validators decide `complete_goal`.
   */
  readonly spec?: SealedGoal;
  /** Judges and host checks for the goal's validators, as for the topology runner. */
  readonly validation?: Omit<RunGoalValidatorsOptions, "signal">;
  /** Evidence beyond the session's output and trace, such as metrics or artifacts. */
  readonly collectEvidence?: () => GoalEvidence | Promise<GoalEvidence>;
  /**
   * A plain objective, for a session without an SDK goal. Ignored when `spec` is given. Without
   * either, a goal restored from the session continues and the agent may start one with
   * `create_goal`.
   */
  readonly objective?: string;
  readonly tokenBudget?: number;
  /** Give the agent `create_goal`. Defaults to true without `spec` and false with it. */
  readonly allowCreate?: boolean;
  /** Wait out the backoff after turns without progress instead of stopping. Defaults to true. */
  readonly waitForBackoff?: boolean;
}

/**
 * Autonomous mode for a native session: with no human input, the session continues until its
 * goal's checks pass or a limit is reached. Gate commands become `check` validators of the goal and
 * run through the SDK goal runner, in the clean agent-command environment unless
 * `inheritProcessEnv` is set.
 */
export interface NativeSessionAutonomous extends Omit<AutonomousConfig, "enabled"> {
  /** Runs gate commands. Defaults to a shell runner in the session's working directory. */
  readonly gateRunner?: GateRunner;
  readonly inheritProcessEnv?: boolean;
}

export interface SessionLongRun {
  readonly controller: LongRunController;
  readonly tools: readonly AgentTool[];
  readonly goal: GoalDriver | undefined;
  readonly autonomous: AutonomousDriver | undefined;
  /** The SDK goal whose validators decide completion, when there is one. */
  readonly completionGoal: SealedGoal | undefined;
  bindAgent(agent: Agent): () => void;
}

const SESSION_GATES_GOAL_ID = "session-quality-gates";

function latestGoalState(sessionManager: SessionManager): GoalState | undefined {
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === GOAL_STATE_CUSTOM_TYPE &&
      isPersistedGoalState(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function latestAssistantOf(sessionManager: SessionManager): AssistantMessage | undefined {
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && (entry.message as { role?: string }).role === "assistant") {
      return entry.message as unknown as AssistantMessage;
    }
  }
  return undefined;
}

function commandCheckRef(command: string): string {
  return `command:${command}`;
}

/** A host check that passes when a shell command exits 0. */
function commandCheck(command: string, runner: GateRunner, timeoutMs: number): GoalCheck {
  return async () => {
    const result = await runner.runGate(command, timeoutMs);
    const passed = result.status === 0 && result.error === undefined && !result.timedOut;
    const output = truncateGateOutput(
      [result.stdout, result.stderr]
        .filter((text) => text.length > 0)
        .join("\n")
        .trim(),
      result.outputTruncated,
    );
    return {
      passed,
      message: passed
        ? `\`${command}\` exited with code 0.`
        : `\`${command}\` ${formatProcessExit(result)}.${output.length === 0 ? "" : `\nOutput:\n${output}`}`,
      ...(passed ? {} : { fix: "Fix the failure, then finish again." }),
    };
  };
}

/** The goal text the agent sees: the SDK goal's description, or its objective when that is too long. */
function threadObjective(goal: SealedGoal): string {
  const described = describeGoalForAgent(goal);
  return [...described].length <= MAX_GOAL_OBJECTIVE_CHARS
    ? described
    : [...goal.spec.objective].slice(0, MAX_GOAL_OBJECTIVE_CHARS).join("");
}

/**
 * One sealed SDK goal holding everything that decides completion: the given goal's validators
 * and a `check` validator per gate command.
 */
function buildCompletionGoal(
  spec: SealedGoal | undefined,
  commands: readonly string[],
  timeoutMs: number,
): SealedGoal | undefined {
  if (commands.length === 0) {
    return spec;
  }
  const gates: GoalValidatorSpec[] = commands.map((command, index) => ({
    kind: "check",
    id: `gate-${index + 1}`,
    description: `\`${command}\` exits with code 0`,
    checkRef: commandCheckRef(command),
    timeoutMs,
  }));
  return sealGoal({
    ...(spec?.spec ?? {
      id: SESSION_GATES_GOAL_ID,
      objective: "Finish the task so every quality gate passes.",
      definitionOfDone: commands.map((command) => `\`${command}\` exits with code 0.`),
    }),
    validators: [...(spec?.spec.validators ?? []), ...gates],
  });
}

export function createSessionLongRun(input: {
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly goal?: NativeSessionGoal | boolean | undefined;
  readonly autonomous?: NativeSessionAutonomous | boolean | undefined;
  /** The session's own evidence: its output and the trace of its events. */
  readonly evidence: () => GoalEvidence;
  readonly signal?: AbortSignal | undefined;
  /** Called with every validation report, for events and evals. */
  readonly onValidation?: (report: GoalValidationReport) => void | Promise<void>;
}): SessionLongRun | undefined {
  const goalOptions = input.goal === true ? {} : input.goal === false ? undefined : input.goal;
  const autonomousOptions =
    input.autonomous === true ? {} : input.autonomous === false ? undefined : input.autonomous;
  if (goalOptions === undefined && autonomousOptions === undefined) {
    return undefined;
  }

  const commands = autonomousOptions?.gates?.commands ?? [];
  const gateTimeoutMs = autonomousOptions?.gates?.timeoutMs ?? 5 * 60 * 1000;
  const gateRunner =
    autonomousOptions?.gateRunner ??
    createShellGateRunner({
      cwd: input.cwd,
      inheritProcessEnv: autonomousOptions?.inheritProcessEnv === true,
      snapshots: false,
    });
  const completionGoal = buildCompletionGoal(goalOptions?.spec, commands, gateTimeoutMs);
  const checks: Record<string, GoalCheck> = {
    ...(goalOptions?.validation?.checks ?? {}),
    ...Object.fromEntries(
      commands.map((command) => [
        commandCheckRef(command),
        commandCheck(command, gateRunner, gateTimeoutMs),
      ]),
    ),
  };
  const validate = async (): Promise<GoalValidationReport | undefined> => {
    if (completionGoal === undefined) {
      return undefined;
    }
    const custom = (await goalOptions?.collectEvidence?.()) ?? {};
    const report = await runGoalValidators(
      completionGoal,
      { ...input.evidence(), ...custom },
      {
        ...(goalOptions?.validation ?? {}),
        checks,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    await input.onValidation?.(report);
    return report;
  };

  let goal: GoalDriver | undefined;
  const tools: AgentTool[] = [];
  if (goalOptions !== undefined) {
    const persist = (state: GoalState) => {
      input.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, state);
    };
    const restored = latestGoalState(input.sessionManager);
    goal =
      restored === undefined
        ? new GoalDriver({ persist })
        : GoalDriver.restore(restored, {
            persist,
            lastTurn: latestAssistantOf(input.sessionManager),
          });
    const pending = ["active", "paused", "budget_limited"].includes(goal.state.status);
    const spec = goalOptions.spec;
    if (spec !== undefined) {
      // A pending goal for the same SDK goal continues; anything else is replaced by it.
      if (!pending || goal.state.goalId !== spec.spec.id) {
        if (pending) {
          goal.clear();
        }
        createGoal(goal, threadObjective(spec), goalOptions.tokenBudget, spec.spec.id);
      }
    } else if (goalOptions.objective !== undefined && !pending) {
      createGoal(goal, goalOptions.objective, goalOptions.tokenBudget);
    }
    tools.push(
      ...(createGoalTools(goal, {
        create: goalOptions.allowCreate ?? spec === undefined,
        verify: async () => {
          const report = await validate();
          return report === undefined
            ? { passed: true }
            : { passed: report.complete, feedback: report.feedback };
        },
      }) as AgentTool[]),
    );
  }

  let autonomous: AutonomousDriver | undefined;
  if (autonomousOptions !== undefined) {
    const {
      gateRunner: _runner,
      inheritProcessEnv: _inherit,
      gates,
      ...config
    } = autonomousOptions;
    const gateLabel =
      completionGoal === undefined ? undefined : `validate goal ${completionGoal.spec.id}`;
    autonomous = new AutonomousDriver(
      createAutonomousRuntimeState({
        ...config,
        enabled: true,
        gates: {
          ...(gates ?? {}),
          // One gate: the SDK goal runner over every validator, gate commands included.
          commands: gateLabel === undefined ? [] : [gateLabel],
        },
      }),
      {
        runGate: async () => {
          const report = await validate();
          return {
            status: report === undefined || report.complete ? 0 : 1,
            stdout: report?.feedback ?? "",
            stderr: "",
            ...(report === undefined || report.complete ? {} : { error: "did not pass" }),
            timedOut: false,
            outputTruncated: false,
          };
        },
        captureSnapshot: () => captureGitWorktreeSnapshot(input.cwd),
      },
    );
  }

  const controller = new LongRunController({
    goal,
    autonomous,
    ...(goalOptions?.waitForBackoff === undefined
      ? {}
      : { waitForBackoff: goalOptions.waitForBackoff }),
  });
  let counter = 0;
  return {
    controller,
    tools,
    goal,
    autonomous,
    completionGoal,
    bindAgent: (agent) =>
      agent.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") {
          return;
        }
        const message = event.message as AssistantMessage;
        counter += 1;
        controller.accountMessage(message, message.responseId ?? `${message.timestamp}:${counter}`);
      }),
  };
}
