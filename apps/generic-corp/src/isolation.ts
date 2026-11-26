import { spawnSync } from "node:child_process";

import type { TerminalRunAsUser } from "@generic-ai/plugin-tools-terminal";

/**
 * Whether agent shell commands run as their own OS user (`user`) or as the server's (`shared`).
 *
 * The image creates an `agent` user and lets the server's user run commands as it through sudo
 * (see the Dockerfile and DEPLOY.md). As `agent`, a command cannot read the server's files on the
 * data volume, the environment of the server or of anything it starts (MCP servers included), or
 * change the server's processes.
 */
export const AGENT_ISOLATION_ENV = Object.freeze({
  user: "GENERIC_CORP_AGENT_USER",
  mode: "GENERIC_CORP_AGENT_ISOLATION",
});

export type AgentIsolationPolicy = "auto" | "required" | "off";

export interface AgentIsolation {
  readonly mode: "user" | "shared";
  /** The OS user agent commands run as, in `user` mode. */
  readonly user?: string;
  /** Why commands share the server's user, in `shared` mode. */
  readonly reason?: string;
  /** Terminal option for agent commands, in `user` mode. */
  readonly runAs?: TerminalRunAsUser;
}

export class AgentIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentIsolationError";
  }
}

/** Runs `true` as `user` the way agent commands run, and reports why it failed, if it did. */
export type RunAsCheck = (user: string) => string | undefined;

export const checkRunAs: RunAsCheck = (user) => {
  const result = spawnSync(
    "sudo",
    ["-n", "-u", user, "--", "setpriv", "--pdeathsig", "TERM", "--", "true"],
    { encoding: "utf8", timeout: 10_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } },
  );
  if (result.error !== undefined) {
    return result.error.message;
  }
  if (result.status !== 0) {
    return (result.stderr || `exit ${result.status ?? result.signal}`).trim();
  }
  return undefined;
};

function readPolicy(value: string | undefined): AgentIsolationPolicy {
  const policy = (value ?? "auto").trim().toLowerCase() || "auto";
  if (policy === "auto" || policy === "required" || policy === "off") {
    return policy;
  }
  throw new AgentIsolationError(
    `${AGENT_ISOLATION_ENV.mode} must be auto, required or off, not "${value}".`,
  );
}

/**
 * Decides how agent commands run. With `GENERIC_CORP_AGENT_USER` set, commands run as that user
 * when the server can switch to it. `GENERIC_CORP_AGENT_ISOLATION=required` refuses to start
 * otherwise; `auto` (the default) falls back to the server's user with a reason; `off` never
 * switches.
 */
export function resolveAgentIsolation(
  env: NodeJS.ProcessEnv,
  check: RunAsCheck = checkRunAs,
): AgentIsolation {
  const policy = readPolicy(env[AGENT_ISOLATION_ENV.mode]);
  const user = env[AGENT_ISOLATION_ENV.user]?.trim();
  if (policy === "off") {
    return { mode: "shared", reason: `${AGENT_ISOLATION_ENV.mode} is off.` };
  }
  if (user === undefined || user.length === 0) {
    if (policy === "required") {
      throw new AgentIsolationError(
        `${AGENT_ISOLATION_ENV.mode} is required but ${AGENT_ISOLATION_ENV.user} is not set.`,
      );
    }
    return { mode: "shared", reason: `${AGENT_ISOLATION_ENV.user} is not set.` };
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) {
    throw new AgentIsolationError(`${AGENT_ISOLATION_ENV.user} "${user}" is not a user name.`);
  }
  const failure = check(user);
  if (failure !== undefined) {
    const reason = `cannot run commands as ${user}: ${failure}`;
    if (policy === "required") {
      throw new AgentIsolationError(`Agent isolation is required but the server ${reason}`);
    }
    return { mode: "shared", reason: `The server ${reason}` };
  }
  return { mode: "user", user, runAs: { user } };
}

/** One log line describing how agent commands run. */
export function describeAgentIsolation(isolation: AgentIsolation): string {
  return isolation.mode === "user"
    ? `Agent commands run as the OS user "${isolation.user}".`
    : `WARNING: agent commands run as the server's own OS user, so they can read and change the server's files. ${isolation.reason ?? ""}`.trim();
}
