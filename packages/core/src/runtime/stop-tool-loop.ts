import { defineTool } from "@generic-ai/sdk";
import { Type } from "@sinclair/typebox";

export const STOP_AND_RESPOND_TOOL_NAME = "stop_and_respond" as const;
export const DEFAULT_STOP_TOOL_MAX_TURNS = Number.POSITIVE_INFINITY;

export type AgentTurnMode = "stop-tool-loop" | "single-turn";

export interface StopAndRespondState {
  stopped: boolean;
  response?: string;
  status?: "completed" | "blocked" | "failed";
}

export interface StopToolLoopResult {
  readonly stopped: boolean;
  readonly outputText?: string;
  readonly status?: StopAndRespondState["status"];
  readonly turnCount: number;
}

export interface StopToolLoopOptions<TPromptOptions> {
  readonly prompt: string;
  readonly promptOptions?: TPromptOptions | undefined;
  readonly maxTurns?: number | undefined;
  readonly state: StopAndRespondState;
  readonly runPrompt: (prompt: string, options?: TPromptOptions) => Promise<void>;
}

function normalizeMaxTurns(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_STOP_TOOL_MAX_TURNS;
  }

  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error("stop-tool loop maxTurns must be a positive integer.");
  }

  return value;
}

function requireResponse(value: string | undefined): string {
  const response = value?.trim();
  if (response === undefined || response.length === 0) {
    throw new Error(`${STOP_AND_RESPOND_TOOL_NAME} requires a non-empty response.`);
  }

  return response;
}

function createTextResult(
  summary: string,
  details: Record<string, unknown>,
  terminate = false,
) {
  return {
    content: [{ type: "text" as const, text: summary }],
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}

export function createStopAndRespondTool(state: StopAndRespondState) {
  return defineTool({
    name: STOP_AND_RESPOND_TOOL_NAME,
    label: "Stop And Respond",
    description:
      "Stop the current agent loop and return the final user-facing response.",
    promptSnippet: "stop the agent loop and respond to the user",
    promptGuidelines: [
      "Call this tool exactly once when the task is complete, blocked, or failed.",
      "Put the final user-facing response in the response field.",
      "Do not call this tool until useful tool work and verification are complete, unless you are blocked.",
    ],
    parameters: Type.Object({
      response: Type.String({
        minLength: 1,
        description: "Final user-facing response to return after the agent loop stops.",
      }),
      status: Type.Optional(
        Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")], {
          description: "Terminal status for the agent loop.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const response = requireResponse(params.response);
      state.stopped = true;
      state.response = response;
      state.status = params.status ?? "completed";

      return createTextResult("Agent loop stopped; final response captured.", {
        status: state.status,
      }, true);
    },
  });
}

export function wrapStopToolPrompt(prompt: string): string {
  return [
    "You are running as a Generic AI autonomous agent.",
    `The run is a loop. Work through the task with the available tools, and call ${STOP_AND_RESPOND_TOOL_NAME} only when you are ready to stop and return a final response.`,
    "Plain assistant messages do not stop the run. If you respond without the stop tool, the conversation will be fed back to you for another turn.",
    "",
    "User task:",
    prompt,
  ].join("\n");
}

export function stopToolContinuationPrompt(turn: number, maxTurns: number): string {
  const turnLabel = Number.isFinite(maxTurns)
    ? `This is loop turn ${turn} of ${maxTurns}.`
    : `This is loop turn ${turn}; no maximum turn limit is configured.`;

  return [
    `Continue the same task. ${turnLabel}`,
    `Review the conversation so far. If the task is complete, blocked, or failed, call ${STOP_AND_RESPOND_TOOL_NAME} with the final response.`,
    `Do not finish with a plain assistant message; only ${STOP_AND_RESPOND_TOOL_NAME} stops this run.`,
  ].join("\n");
}

export async function runStopToolLoop<TPromptOptions>(
  options: StopToolLoopOptions<TPromptOptions>,
): Promise<StopToolLoopResult> {
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const prompt =
      turn === 1
        ? wrapStopToolPrompt(options.prompt)
        : stopToolContinuationPrompt(turn, maxTurns);

    await options.runPrompt(prompt, options.promptOptions);

    if (options.state.stopped) {
      return {
        stopped: true,
        turnCount: turn,
        ...(options.state.response === undefined ? {} : { outputText: options.state.response }),
        ...(options.state.status === undefined ? {} : { status: options.state.status }),
      };
    }
  }

  return {
    stopped: false,
    turnCount: maxTurns,
  };
}
