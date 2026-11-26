// Agent tools over a goal driver. They mirror Prime Agent's `goal` skill (`goal.get`, `goal.create`,
// `goal.complete`) and its host handler (PrimeIntellect-ai/prime-agent). Completion can be checked by
// host-owned validators, which the agent cannot edit.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import type { AgentTool, AgentToolResult } from "@generic-ai/agent";
import { Type } from "@sinclair/typebox";

import type { GoalDriver } from "./goal-driver.js";
import {
  COMPLETE_GOAL_TOOL,
  type GoalHostResponse,
  type GoalState,
  goalHostResponse,
} from "./goals.js";

export const GET_GOAL_TOOL = "get_goal";
export const CREATE_GOAL_TOOL = "create_goal";
export { COMPLETE_GOAL_TOOL };

/** The host's verdict on a completion claim. */
export interface GoalVerification {
  readonly passed: boolean;
  /** What failed, shown to the agent when the claim is refused. */
  readonly feedback?: string | undefined;
}

export interface GoalToolsOptions {
  /** Let the agent start a goal. Default true. */
  readonly create?: boolean | undefined;
  /**
   * Host validators run when the agent claims the goal is complete. A failed check leaves the goal
   * active and returns the feedback, so the agent keeps working.
   */
  readonly verify?: ((goal: GoalState) => Promise<GoalVerification> | GoalVerification) | undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: tools carry their own parameter and detail types.
export type GoalTool = AgentTool<any, any> & {
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

function result<T>(value: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

export function createGoal(
  driver: GoalDriver,
  objective: string,
  tokenBudget?: number,
  goalId?: string,
): GoalState {
  switch (driver.state.status) {
    case "active":
      throw new Error(
        `cannot create a new goal because this thread already has an active goal; call ${COMPLETE_GOAL_TOOL} when it is achieved, or ask the user to clear it`,
      );
    case "paused":
      throw new Error(
        "cannot create a new goal because a paused goal exists; ask the user to resume or clear it",
      );
    case "budget_limited":
      throw new Error(
        "cannot create a new goal because a budget-limited goal exists; ask the user to resume or clear it",
      );
    default:
      return driver.start(objective, tokenBudget, goalId);
  }
}

export interface CompleteGoalResult extends GoalHostResponse {
  readonly verified?: false;
  readonly feedback?: string;
}

export async function completeGoal(
  driver: GoalDriver,
  verify?: GoalToolsOptions["verify"],
): Promise<CompleteGoalResult> {
  if (driver.state.objective === undefined || driver.state.status === "idle") {
    throw new Error("cannot complete goal because this thread has no goal");
  }
  if (verify !== undefined && driver.state.status === "active") {
    const verdict = await verify(driver.stateWithCreationElapsed());
    if (!verdict.passed) {
      return {
        ...goalHostResponse(driver.stateWithCreationElapsed(), false),
        verified: false,
        feedback:
          verdict.feedback ??
          "The host's checks did not pass. The goal stays active; keep working.",
      };
    }
  }
  driver.complete();
  return goalHostResponse(driver.stateWithCreationElapsed(), true);
}

export function createGoalTools(driver: GoalDriver, options: GoalToolsOptions = {}): GoalTool[] {
  const tools: GoalTool[] = [
    {
      name: GET_GOAL_TOOL,
      label: "Get goal",
      description:
        "Read the persistent thread goal: its objective, status, token budget and usage, remaining tokens, and the completion budget report.",
      parameters: Type.Object({}),
      execute: async () => result(goalHostResponse(driver.stateWithCreationElapsed(), false)),
    },
  ];
  if (options.create ?? true) {
    tools.push({
      name: CREATE_GOAL_TOOL,
      label: "Create goal",
      description:
        "Start a persistent thread goal that the harness keeps you working on across turns until it is complete. Only when the user or instructions explicitly ask for a long-running goal. Fails while another goal is active, paused or budget-limited.",
      parameters: Type.Object({
        objective: Type.String({ description: "The objective (at most 4000 characters)." }),
        token_budget: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Token budget. Only when one is explicitly requested.",
          }),
        ),
      }),
      execute: async (_id, params) =>
        result(goalHostResponse(createGoal(driver, params.objective, params.token_budget), false)),
    });
  }
  tools.push({
    name: COMPLETE_GOAL_TOOL,
    label: "Complete goal",
    description:
      "Mark the thread goal achieved. Only when every requirement of the objective is met and verified, not because the budget is nearly spent or you are stopping. The host may check the claim first and refuse it.",
    promptSnippet: "mark the persistent thread goal achieved once it is fully done",
    promptGuidelines: [
      `While a thread goal is active the harness keeps continuing it; call ${COMPLETE_GOAL_TOOL} once it is actually achieved instead of only saying so.`,
      "When the result has a completion budget report, give that usage to the user.",
    ],
    parameters: Type.Object({}),
    execute: async () => result(await completeGoal(driver, options.verify)),
  });
  return tools;
}
