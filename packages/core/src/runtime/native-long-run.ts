import type { Agent, AgentTool } from "@generic-ai/agent";
import type { AssistantMessage } from "@generic-ai/ai";
import {
  AutonomousDriver,
  type AutonomousConfig,
  createAutonomousRuntimeState,
  createGoal,
  createGoalTools,
  createShellGateRunner,
  GOAL_STATE_CUSTOM_TYPE,
  type GateRunner,
  GoalDriver,
  type GoalState,
  type GoalVerification,
  isPersistedGoalState,
  LongRunController,
} from "@generic-ai/autonomy";
import type { SessionManager } from "@generic-ai/session";

/**
 * A persistent thread goal for a native session (see `@generic-ai/autonomy`). While it is active the
 * session keeps continuing until the agent completes it with `complete_goal`, its token budget runs
 * out, or turns stop making progress.
 */
export interface NativeSessionGoal {
  /**
   * Start this goal when the session has no pending one. Without it, a goal restored from the
   * session continues, and the agent may start one with `create_goal`.
   */
  readonly objective?: string;
  readonly tokenBudget?: number;
  /** Give the agent `create_goal`. Defaults to true. */
  readonly allowCreate?: boolean;
  /**
   * Host-owned checks run when the agent claims the goal is complete. A failed check keeps the goal
   * active and shows the agent the feedback; the agent cannot change these checks.
   */
  readonly verify?: (goal: GoalState) => Promise<GoalVerification> | GoalVerification;
  /** Wait out the backoff after turns without progress instead of stopping. Defaults to true. */
  readonly waitForBackoff?: boolean;
}

/**
 * Autonomous mode for a native session: with no human input, the session continues until its
 * quality gates pass or a limit is reached. Gate commands run in the clean agent-command
 * environment unless `inheritProcessEnv` is set.
 */
export interface NativeSessionAutonomous extends Omit<AutonomousConfig, "enabled"> {
  readonly gateRunner?: GateRunner;
  readonly inheritProcessEnv?: boolean;
}

export interface SessionLongRun {
  readonly controller: LongRunController;
  readonly tools: readonly AgentTool[];
  readonly goal: GoalDriver | undefined;
  readonly autonomous: AutonomousDriver | undefined;
  bindAgent(agent: Agent): () => void;
}

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

export function createSessionLongRun(input: {
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly goal?: NativeSessionGoal | boolean | undefined;
  readonly autonomous?: NativeSessionAutonomous | boolean | undefined;
}): SessionLongRun | undefined {
  const goalOptions = input.goal === true ? {} : input.goal === false ? undefined : input.goal;
  const autonomousOptions =
    input.autonomous === true ? {} : input.autonomous === false ? undefined : input.autonomous;
  if (goalOptions === undefined && autonomousOptions === undefined) {
    return undefined;
  }
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
    if (goalOptions.objective !== undefined && !pending) {
      createGoal(goal, goalOptions.objective, goalOptions.tokenBudget);
    }
    tools.push(
      ...(createGoalTools(goal, {
        create: goalOptions.allowCreate ?? true,
        ...(goalOptions.verify === undefined ? {} : { verify: goalOptions.verify }),
      }) as AgentTool[]),
    );
  }
  let autonomous: AutonomousDriver | undefined;
  if (autonomousOptions !== undefined) {
    const { gateRunner, inheritProcessEnv, ...config } = autonomousOptions;
    autonomous = new AutonomousDriver(
      createAutonomousRuntimeState({ ...config, enabled: true }),
      gateRunner ??
        createShellGateRunner({ cwd: input.cwd, inheritProcessEnv: inheritProcessEnv === true }),
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
