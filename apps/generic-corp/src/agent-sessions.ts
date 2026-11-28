import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentHarnessRunSession, AgentTaskExecutionInput } from "@generic-ai/sdk";

/**
 * One saved session per agent per goal (decision 16), and turns that pick up where they stopped
 * (decision 30).
 *
 * Every turn an agent takes on a goal reads and appends to the same session file, so the agent
 * keeps its working context across tasks on that goal; the native runtime compacts it when it gets
 * long. The files live under `<root>/<agentId>/<rootTaskId>.jsonl`, outside the agent's home, so an
 * agent cannot edit its own history.
 *
 * While a turn runs, a small marker file next to the session names its task. If the process stops
 * mid-turn (a restart, a crash) or the turn fails in a way the queue retries, the marker stays, and
 * the next attempt at the same task resumes the session from its last completed step instead of
 * sending the prompt again. A turn that finishes, fails for good, or was stopped for making no
 * progress clears the marker, so the next turn starts from a fresh prompt.
 */
export interface AgentSessionFiles {
  /** Where this agent's session for this goal is kept. */
  sessionFile(input: Pick<AgentTaskExecutionInput, "agentId" | "rootTaskId">): string;
  /** Called as a turn starts: the session to use, resuming when an earlier attempt was cut off. */
  begin(input: AgentTaskExecutionInput): Promise<AgentHarnessRunSession>;
  /**
   * Called when a turn returns. `resumable` keeps the marker so the next attempt resumes; otherwise
   * it is cleared.
   */
  settle(input: AgentTaskExecutionInput, resumable: boolean): Promise<void>;
}

/**
 * Where a turn on the Claude plan keeps its Claude Agent SDK session id, next to the session file.
 * The SDK keeps the conversation itself, so on that path this file stands for the session.
 */
export function sdkSessionSidecar(sessionFile: string): string {
  return `${sessionFile}.claude-agent-sdk.json`;
}

interface TurnMarker {
  readonly taskId: string;
  readonly attemptRunId: string;
  readonly startedAt: string;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length === 0 ? "_" : cleaned.slice(0, 200);
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readMarker(file: string): Promise<TurnMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TurnMarker>;
    return typeof parsed.taskId === "string" ? (parsed as TurnMarker) : undefined;
  } catch {
    return undefined;
  }
}

export function createAgentSessionFiles(
  root: string,
  now: () => Date = () => new Date(),
): AgentSessionFiles {
  const sessionFile = (input: Pick<AgentTaskExecutionInput, "agentId" | "rootTaskId">) =>
    path.join(root, safeName(input.agentId), `${safeName(input.rootTaskId)}.jsonl`);
  const markerFile = (input: Pick<AgentTaskExecutionInput, "agentId" | "rootTaskId">) =>
    path.join(root, safeName(input.agentId), `${safeName(input.rootTaskId)}.turn.json`);

  return {
    sessionFile,

    async begin(input) {
      const file = sessionFile(input);
      const marker = markerFile(input);
      await mkdir(path.dirname(file), { recursive: true });
      const previous = await readMarker(marker);
      const resume =
        previous?.taskId === input.taskId &&
        ((await exists(file)) || (await exists(sdkSessionSidecar(file))));
      const next: TurnMarker = {
        taskId: input.taskId,
        attemptRunId: input.attemptRunId,
        startedAt: now().toISOString(),
      };
      await writeFile(marker, `${JSON.stringify(next)}\n`, "utf8");
      return resume ? { file, resume: true } : { file };
    },

    async settle(input, resumable) {
      if (resumable) {
        return;
      }
      const marker = markerFile(input);
      const current = await readMarker(marker);
      if (current === undefined || current.taskId === input.taskId) {
        await rm(marker, { force: true });
      }
    },
  };
}
