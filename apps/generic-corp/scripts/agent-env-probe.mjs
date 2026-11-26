// Checks, inside the production image, that a command an agent runs cannot
// see the server's secrets. Used by smoke-image.sh:
//
//   docker exec -u node <container> node apps/generic-corp/scripts/agent-env-probe.mjs VALUE...
//
// It runs one command through the same terminal tool the agents use, from a
// process holding the same environment as the server. The command prints its
// own environment and every /proc/<pid>/environ it can read, which covers the
// server process and this probe. It also asks the agents' file tools, which run
// inside the server process, for /proc/self/environ and other files outside the
// agent's workspace; they must refuse. Exits 1 if any VALUE shows up or a file
// tool reaches outside the workspace.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import { createTerminalToolPlugin } from "@generic-ai/plugin-tools-terminal";

const secrets = process.argv.slice(2).filter((value) => value.length > 0);
if (secrets.length === 0) {
  console.error("usage: agent-env-probe.mjs SECRET_VALUE...");
  process.exit(2);
}

const root = await mkdtemp(path.join(tmpdir(), "agent-env-probe-"));
const terminal = createTerminalToolPlugin({ root });
const command = [
  "echo '--- env'",
  "env",
  "if tr '\\0' '\\n' < /proc/self/environ >/dev/null 2>&1; then echo SELF_ENVIRON_READABLE; fi",
  "echo '--- /proc/*/environ'",
  'for p in /proc/[0-9]*; do if tr "\\0" "\\n" < "$p/environ" 2>/dev/null; then echo; echo "(read $p: $(tr "\\0" " " < "$p/cmdline" | cut -c1-80))"; fi; done',
].join("; ");
const result = await terminal.tool.execute("probe", { command });
const output = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");

// Split the output into sources: the command's own environment, then one
// block per /proc/<pid>/environ it could read (each ends with its "(read ...)" line).
const [ownEnv = "", procPart = ""] = output.split("--- /proc/*/environ");
const sources = [{ name: "the command's environment", text: ownEnv }];
const pieces = procPart.split(/^(\(read [^\n]*\))$/m);
for (let index = 1; index < pieces.length; index += 2) {
  sources.push({ name: pieces[index] ?? "", text: pieces[index - 1] ?? "" });
}
const leaks = sources.flatMap((source) =>
  secrets
    .map((value, index) => ({ index, source: source.name, found: source.text.includes(value) }))
    .filter((entry) => entry.found),
);
const readable = sources.slice(1).map((source) => source.name);
// Control: the command must be able to read its own environ, or the /proc
// check above proved nothing.
if (!ownEnv.includes("SELF_ENVIRON_READABLE")) {
  console.error(
    "Probe could not read any /proc/<pid>/environ, so the /proc check is not meaningful.",
  );
  process.exit(1);
}
console.log(`Agent command could read its own environ and ${readable.length} other(s):`);
for (const name of readable) console.log(`  ${name}`);
if (leaks.length > 0) {
  for (const leak of leaks) {
    console.error(`LEAK: secret #${leak.index + 1} is visible in ${leak.source}.`);
  }
  process.exit(1);
}
console.log(`None of the ${secrets.length} secret values reached the agent command.`);

// The file tools run in the server process, so /proc/self/environ is the
// server's own environment. Each must refuse paths outside the workspace.
const files = createWorkspaceFileTools({ root });
const fileTool = (name) => files.piTools.find((tool) => tool.name === name);
const attempts = [
  ["read", { path: "/proc/self/environ" }],
  ["grep", { pattern: ".", path: "/proc/self" }],
  ["ls", { path: "/" }],
  ["write", { path: path.join(tmpdir(), "agent-env-probe-planted.txt"), content: "planted" }],
];
let escaped = false;
for (const [name, params] of attempts) {
  try {
    const result = await fileTool(name).execute("probe", params);
    const text = JSON.stringify(result.content);
    const leaked = secrets.filter((value) => text.includes(value)).length;
    console.error(
      `ESCAPE: the ${name} tool reached ${params.path}${leaked ? ` and returned ${leaked} secret value(s)` : ""}.`,
    );
    escaped = true;
  } catch (error) {
    if (!String(error?.message).includes("outside the agent's workspace")) {
      console.error(`ESCAPE?: the ${name} tool failed for another reason: ${error?.message}`);
      escaped = true;
    }
  }
}
if (escaped) {
  process.exit(1);
}
console.log(`The file tools refused all ${attempts.length} paths outside the workspace.`);
