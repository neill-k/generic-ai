import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runReferenceExample } from "./index.js";

const providerKeyName = "GENERIC_AI_PROVIDER_API_KEY";
const workspaceRootName = "GENERIC_AI_WORKSPACE_ROOT";

export interface StarterExampleCliOptions {
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}

export async function runStarterExampleCli(options: StarterExampleCliOptions = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const providerKey = env[providerKeyName];

  if (!providerKey) {
    throw new Error(
      `${providerKeyName} must be set before running the starter example. The current harness is local-only, but the fresh-clone path keeps the provider key in place for the real execution route.`,
    );
  }

  const workspaceRoot =
    env[workspaceRootName] ??
    (await mkdtemp(path.join(os.tmpdir(), "generic-ai-starter-")));
  const topic = options.args?.join(" ").trim() || "the Generic AI starter stack";
  const result = await runReferenceExample({ root: workspaceRoot }, topic);

  log(
    [
      `Workspace: ${workspaceRoot}`,
      `Bootstrap: ${result.bootstrapDescription}`,
      `Summary: ${result.delegatedSummary}`,
      `Skills: ${result.skillNames.join(", ") || "none"}`,
      `MCP servers: ${result.mcpServers.join(", ") || "none"}`,
      `Transport: ${result.transportHealth.transport} (streaming: ${result.transportHealth.streaming})`,
    ].join("\n"),
  );

  return result;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  runStarterExampleCli({ args: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
