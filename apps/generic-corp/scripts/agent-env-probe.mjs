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
//
// When the image runs agent commands as their own user (GENERIC_CORP_AGENT_USER,
// resolved the way the server does), the probe also starts a non-node child
// holding the secrets, as an MCP server launched with uvx would, and checks the
// command cannot read the server's files on the data volume, can work in its
// home, and is killed with everything it started on a timeout. Set
// PROBE_EXPECT_ISOLATION=user to fail when commands share the server's user.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import { createTerminalToolPlugin } from "@generic-ai/plugin-tools-terminal";

import { describeAgentIsolation, resolveAgentIsolation } from "../dist/isolation.js";

const secrets = process.argv.slice(2).filter((value) => value.length > 0);
if (secrets.length === 0) {
  console.error("usage: agent-env-probe.mjs SECRET_VALUE...");
  process.exit(2);
}

const isolation = resolveAgentIsolation(process.env);
console.log(describeAgentIsolation(isolation));
if (process.env.PROBE_EXPECT_ISOLATION === "user" && isolation.mode !== "user") {
  console.error("Expected agent commands to run as their own user.");
  process.exit(1);
}
const dataDir = process.env.GENERIC_CORP_DATA_DIR ?? tmpdir();
let root;
if (isolation.mode === "user") {
  // Like a real agent home: under the company folder the entrypoint shares with `agent`.
  await mkdir(path.join(dataDir, "company", "agents"), { recursive: true });
  root = await mkdtemp(path.join(dataDir, "company", "agents", "probe-"));
  await chmod(root, 0o2770); // mkdtemp makes it 0700; agent homes are group-shared.
} else {
  root = await mkdtemp(path.join(tmpdir(), "agent-env-probe-"));
}
const terminal = createTerminalToolPlugin({
  root,
  ...(isolation.runAs === undefined ? {} : { runAs: isolation.runAs }),
});
// A child of the server that is not node (like an MCP server started with uvx)
// and holds the same secrets: its /proc/<pid>/environ must stay unreadable.
const sidecar = spawn("sleep", ["120"], { env: process.env, stdio: "ignore" });
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
sidecar.kill();
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

if (isolation.mode === "user") {
  const serverFile = path.join(dataDir, `.agent-env-probe-${process.pid}`);
  await writeFile(serverFile, "server-only\n");
  const check = await terminal.run({
    command: [
      'echo "USER=$(id -un)"',
      `if cat ${serverFile} >/dev/null 2>&1; then echo SERVER_FILE=readable; else echo SERVER_FILE=denied; fi`,
      `if touch ${dataDir}/.agent-planted 2>/dev/null; then echo DATA_WRITE=allowed; else echo DATA_WRITE=denied; fi`,
      "echo agent-wrote > agent-file.txt && echo HOME_WRITE=ok",
    ].join("; "),
  });
  await rm(serverFile, { force: true });
  const expected = [
    `USER=${isolation.user}`,
    "SERVER_FILE=denied",
    "DATA_WRITE=denied",
    "HOME_WRITE=ok",
  ];
  const missing = expected.filter((line) => !check.output.includes(line));
  if (missing.length > 0) {
    console.error(
      `Agent command isolation failed (missing ${missing.join(", ")}):\n${check.output}`,
    );
    process.exit(1);
  }
  if ((await readFile(path.join(root, "agent-file.txt"), "utf8")) !== "agent-wrote\n") {
    console.error("The server cannot read what the agent command wrote in its home.");
    process.exit(1);
  }

  // A timed-out command and everything it started are killed, although the
  // server's user may not signal the agent's processes itself.
  const marker = `agent-env-probe-${process.pid}`;
  await terminal
    .run({
      command: `bash -c 'sleep 301; true' ${marker} & bash -c 'sleep 302; true' ${marker}`,
      timeoutMs: 1000,
    })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const survivors = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (cmdline.includes(marker)) survivors.push(pid);
  }
  if (survivors.length > 0) {
    console.error(`A timed-out agent command left processes running: ${survivors.join(", ")}`);
    process.exit(1);
  }
  await rm(root, { recursive: true, force: true });
  console.log(
    `Agent commands run as ${isolation.user}: no access to server files, home writable, killed on timeout.`,
  );
}
