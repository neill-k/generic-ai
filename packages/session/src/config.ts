import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "generic-ai";

/** Root directory for agent state. Override with GENERIC_AI_AGENT_DIR. */
export function getAgentDir(): string {
  return process.env["GENERIC_AI_AGENT_DIR"] ?? join(homedir(), ".generic-ai", "agent");
}

/** Directory that holds one folder of session files per working directory. */
export function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}
