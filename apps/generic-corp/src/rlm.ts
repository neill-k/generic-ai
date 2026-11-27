import { spawnSync } from "node:child_process";

import type { NativeAgentHarnessOptions } from "@generic-ai/core";
import { type TerminalRunAsUser, wrapProcessForUser } from "@generic-ai/plugin-tools-terminal";

import type { AgentIsolation } from "./isolation.js";

/**
 * Every role gets a persistent Python workspace, the `python` tool (`@generic-ai/rlm`, borrowed
 * from Prime Agent's RLM): large inputs live in variables, code calls smaller models and the
 * agent's other tools, and only what it prints comes back. It needs Python 3 on the host, which
 * the image installs.
 *
 * `GENERIC_CORP_RLM=auto` (the default) turns it on when Python 3 runs, `on` requires it, `off`
 * leaves it out. `GENERIC_CORP_RLM_MODEL` names the default sub-model for `rlm.llm` as
 * `provider/id`; without it, sub-calls use the role's own model.
 */
export const RLM_ENV = Object.freeze({
  mode: "GENERIC_CORP_RLM",
  model: "GENERIC_CORP_RLM_MODEL",
  python: "GENERIC_AI_PYTHON",
});

export type CompanyRlmOption = Exclude<NativeAgentHarnessOptions["rlm"], boolean | undefined>;

export interface CompanyRlm {
  /** The harness option, or `undefined` when the workspace is off. */
  readonly option?: CompanyRlmOption;
  /** One log line saying whether roles have the workspace, and why not. */
  readonly description: string;
}

export class CompanyRlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyRlmError";
  }
}

/** Reports why `python` cannot run, if it cannot. */
export type PythonCheck = (python: string) => string | undefined;

export const checkPython: PythonCheck = (python) => {
  const result = spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3, 9)"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  });
  if (result.error !== undefined) return result.error.message;
  if (result.status !== 0) {
    return (result.stderr || `exit ${result.status ?? result.signal}`).trim() || "Python too old";
  }
  return undefined;
};

/**
 * The run-as launch for the kernel: the same user, environment allowlist and limits as agent
 * shell commands, except the per-process CPU limit, since the kernel lives for the whole turn.
 */
export function kernelRunAs(runAs: TerminalRunAsUser): TerminalRunAsUser {
  return {
    ...runAs,
    limits: runAs.limits === false ? false : { ...runAs.limits, cpuSeconds: null },
  };
}

export interface ResolveCompanyRlmOptions {
  /**
   * Extra environment for one agent's kernel, on top of the agent-command allowlist: the egress
   * proxy settings, so code in the workspace reaches the network the way that agent's shell
   * commands do, and no other way.
   */
  readonly agentEnv?: (agentId: string) => Readonly<Record<string, string>>;
  readonly check?: PythonCheck;
}

/** Decides whether roles get the Python workspace, and how its kernel runs. */
export function resolveCompanyRlm(
  env: NodeJS.ProcessEnv,
  isolation: AgentIsolation,
  options: ResolveCompanyRlmOptions = {},
): CompanyRlm {
  const check = options.check ?? checkPython;
  const mode = (env[RLM_ENV.mode] ?? "auto").trim().toLowerCase() || "auto";
  if (mode !== "auto" && mode !== "on" && mode !== "off") {
    throw new CompanyRlmError(`${RLM_ENV.mode} must be auto, on or off, not "${mode}".`);
  }
  if (mode === "off") {
    return { description: `Roles have no Python workspace: ${RLM_ENV.mode} is off.` };
  }
  const python = env[RLM_ENV.python]?.trim() || "python3";
  const failure = check(python);
  if (failure !== undefined) {
    const reason = `cannot run ${python}: ${failure}`;
    if (mode === "on") {
      throw new CompanyRlmError(`${RLM_ENV.mode} is on but the server ${reason}`);
    }
    return { description: `Roles have no Python workspace: the server ${reason}` };
  }
  const model = env[RLM_ENV.model]?.trim();
  const runAs = isolation.runAs === undefined ? undefined : kernelRunAs(isolation.runAs);
  const option: CompanyRlmOption = {
    python,
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(options.agentEnv === undefined ? {} : { agentEnv: options.agentEnv }),
    ...(runAs === undefined
      ? {}
      : {
          // The session's cwd is the agent's working root, which is also HOME for its shell commands.
          launch: (launch) => ({
            ...wrapProcessForUser(launch, runAs, launch.cwd),
            cwd: launch.cwd,
          }),
        }),
  };
  return {
    option,
    description:
      runAs === undefined
        ? "Roles have a Python workspace (the python tool), running as the server's own OS user."
        : `Roles have a Python workspace (the python tool), running as the OS user "${runAs.user}".`,
  };
}
