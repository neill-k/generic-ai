import { delimiter } from "node:path";

import { getBinDir } from "./config.js";

/**
 * Variables a command the agent runs may see by default: where to find binaries and the home and
 * temp directories, the shell, user and locale, and the terminal type. Everything else in the
 * server's environment (provider API keys, database URLs, tokens) is left out.
 *
 * This deliberately differs from pi, whose bash tool passes the whole environment.
 */
export const AGENT_COMMAND_ENV_KEYS: ReadonlySet<string> = new Set([
  "CI",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "Path",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "windir",
]);

export interface AgentCommandEnvOptions {
  /** Pass the whole source environment instead of the allowlist. Default false. */
  readonly inheritProcessEnv?: boolean | undefined;
  /** Extra variable names to pass through. */
  readonly allow?: Iterable<string> | undefined;
}

/**
 * The environment for a command an agent runs: the allowlisted variables of `source` (and any
 * `LC_*` locale variables), with the tools' own bin directory on `PATH`. With
 * `inheritProcessEnv`, the whole of `source` instead.
 */
export function getAgentCommandEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: AgentCommandEnvOptions = {},
): NodeJS.ProcessEnv {
  const extra = new Set(options.allow ?? []);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (
      options.inheritProcessEnv === true ||
      AGENT_COMMAND_ENV_KEYS.has(key) ||
      extra.has(key) ||
      key.startsWith("LC_")
    ) {
      env[key] = value;
    }
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const binDir = getBinDir();
  if (!entries.includes(binDir)) {
    env[pathKey] = [binDir, ...entries].join(delimiter);
  }
  return env;
}
