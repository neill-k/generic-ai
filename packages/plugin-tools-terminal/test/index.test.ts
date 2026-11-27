import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BashOperations } from "@generic-ai/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  commandLimitScript,
  createTerminalToolPlugin,
  kind,
  name,
  resolveTerminalCwd,
  TerminalToolError,
  wrapCommandForUser,
  wrapProcessForUser,
} from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-terminal-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-tools-terminal", () => {
  it("creates a terminal plugin with a pi bash tool anchored to the workspace root", async () => {
    await withTempRoot(async (root) => {
      const plugin = createTerminalToolPlugin({ root });

      expect(plugin.name).toBe(name);
      expect(plugin.kind).toBe(kind);
      expect(plugin.root).toBe(root);
      expect(plugin.unrestrictedLocal).toBe(true);
      expect(plugin.tool).toMatchObject({
        name: "bash",
      });
    });
  });

  it("runs configured commands and captures streamed output", async () => {
    await withTempRoot(async (root) => {
      const operations: BashOperations = {
        exec: async (command, cwd, options) => {
          options.onData(Buffer.from(`${command}\n${cwd}`));
          return { exitCode: 0 };
        },
      };
      const plugin = createTerminalToolPlugin({ root, operations });
      const result = await plugin.run({
        command: "pwd",
      });

      expect(result.exitCode).toBe(0);
      expect(result.cwd).toBe(root);
      expect(result.command).toBe("pwd");
      expect(result.output).toContain("pwd");
      expect(result.output).toContain(root);
    });
  });

  it("does not forward ambient process secrets unless explicitly requested", async () => {
    await withTempRoot(async (root) => {
      const secretKey = "GENERIC_AI_TERMINAL_SECRET_FOR_TEST";
      process.env[secretKey] = "do-not-forward";
      try {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const operations: BashOperations = {
          exec: async (_command, _cwd, options) => {
            capturedEnv = options.env;
            return { exitCode: 0 };
          },
        };

        await createTerminalToolPlugin({ root, operations }).run({ command: "env" });
        expect(capturedEnv?.[secretKey]).toBeUndefined();
        expect(capturedEnv?.["PATH"] ?? capturedEnv?.["Path"]).toBeDefined();

        await createTerminalToolPlugin({
          root,
          operations,
          inheritProcessEnv: true,
        }).run({ command: "env" });
        expect(capturedEnv?.[secretKey]).toBe("do-not-forward");
      } finally {
        delete process.env[secretKey];
      }
    });
  });

  it("keeps ambient process secrets out of commands the agent tool runs", async () => {
    await withTempRoot(async (root) => {
      const secrets = {
        ANTHROPIC_API_KEY: "sk-ant-terminal-probe",
        DATABASE_URL: "postgres://probe:hunter2@db/app",
        GENERIC_AI_SECRETS_KEY: "secrets-key-terminal-probe",
        GENERIC_AI_OWNER_SETUP_TOKEN: "setup-token-terminal-probe",
      };
      Object.assign(process.env, secrets);
      try {
        const runEnv = async (plugin: ReturnType<typeof createTerminalToolPlugin>) => {
          const result = await plugin.tool.execute("probe", { command: "env" });
          return JSON.stringify(result.content);
        };

        const output = await runEnv(createTerminalToolPlugin({ root }));
        for (const value of Object.values(secrets)) {
          expect(output).not.toContain(value);
        }
        expect(output).toContain("PATH=");

        const inherited = await runEnv(createTerminalToolPlugin({ root, inheritProcessEnv: true }));
        expect(inherited).toContain(secrets.ANTHROPIC_API_KEY);
      } finally {
        for (const key of Object.keys(secrets)) {
          delete process.env[key];
        }
      }
    });
  });

  it("resolves explicit working directories inside the workspace", async () => {
    await withTempRoot(async (root) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
      await expect(resolveTerminalCwd(root, "workspace/shared")).resolves.toBe(
        path.join(root, "workspace", "shared"),
      );
      await expect(resolveTerminalCwd(root, "..")).rejects.toThrow(/escapes the workspace root/i);
    });
  });

  it("emits structured timeout and native error envelopes", async () => {
    await withTempRoot(async (root) => {
      const timeoutOperations: BashOperations = {
        exec: async () => ({ exitCode: null }),
      };
      const timeoutResult = await createTerminalToolPlugin({
        root,
        operations: timeoutOperations,
      }).run({
        command: "sleep 10",
        timeoutMs: 1000,
      });

      expect(timeoutResult.timedOut).toBe(true);
      expect(timeoutResult.error).toMatchObject({
        kind: "timeout",
        retryable: true,
        timeoutBudget: {
          totalMs: 1000,
          remainingMs: 0,
          exhausted: true,
        },
      });

      const failingOperations: BashOperations = {
        exec: async () => {
          throw new Error("spawn ENOENT");
        },
      };
      await expect(
        createTerminalToolPlugin({ root, operations: failingOperations }).run({
          command: "missing-binary",
        }),
      ).rejects.toBeInstanceOf(TerminalToolError);
    });
  });
});

describe("running agent commands as another OS user", () => {
  it("wraps every command in sudo with only allowlisted variable names, never values", async () => {
    await withTempRoot(async (root) => {
      process.env["GENERIC_AI_TERMINAL_RUN_AS_SECRET"] = "run-as-secret-value";
      try {
        const calls: { command: string; env: NodeJS.ProcessEnv | undefined }[] = [];
        const operations: BashOperations = {
          exec: async (command, _cwd, options) => {
            calls.push({ command, env: options.env });
            return { exitCode: 0 };
          },
        };
        const plugin = createTerminalToolPlugin({
          root,
          operations,
          runAs: { user: "agent", sudoPath: "/usr/bin/sudo" },
        });
        await plugin.run({ command: "echo 'hi' && id" });
        await plugin.tool.execute("call", { command: "whoami" });

        for (const call of calls) {
          expect(call.command).toMatch(
            /^exec '\/usr\/bin\/sudo' -n -u agent --preserve-env=[A-Z_,]+ -- 'setpriv' --pdeathsig TERM -- /,
          );
          expect(call.command).not.toContain("run-as-secret-value");
          expect(call.env?.["HOME"]).toBe(root);
          expect(call.env?.["USER"]).toBe("agent");
          expect(call.env?.["GENERIC_AI_TERMINAL_RUN_AS_SECRET"]).toBeUndefined();
        }
        expect(calls[0]?.command).toContain(`'echo '\\''hi'\\'' && id'`);
        expect(calls[1]?.command.endsWith("'whoami'")).toBe(true);
      } finally {
        delete process.env["GENERIC_AI_TERMINAL_RUN_AS_SECRET"];
      }
    });
  });

  it("limits each command's memory, CPU, files and processes unless turned off", () => {
    const wrapped = wrapCommandForUser("make", {}, { user: "agent" }, "/work");
    for (const flag of ["-c 0", "-d 4194304", "-t 3600", "-f 4194304", "-n 4096", "-u 1024"]) {
      expect(wrapped.command).toContain(`ulimit ${flag} 2>/dev/null`);
    }
    expect(wrapped.command).toContain("nice -n 10 ");

    const custom = wrapCommandForUser(
      "make",
      {},
      { user: "agent", limits: { memoryMiB: 512, cpuSeconds: null, niceness: 0 } },
      "/work",
    );
    expect(custom.command).toContain("ulimit -d 524288");
    expect(custom.command).not.toContain("ulimit -t");
    expect(custom.command).not.toContain("nice -n");

    const off = wrapCommandForUser("make", {}, { user: "agent", limits: false }, "/work");
    expect(off.command).not.toContain("ulimit -d");
    expect(() =>
      wrapCommandForUser("make", {}, { user: "agent", limits: { memoryMiB: -1 } }, "/work"),
    ).toThrow(/Invalid command limit memoryMiB/);
    expect(() => commandLimitScript({ niceness: 25 })).toThrow(/niceness/);
  });

  it("wraps a long-lived process so it keeps its stdin", () => {
    const wrapped = wrapProcessForUser(
      { command: "python3", args: ["-u", "/opt/it's/kernel.py"], env: { PATH: "/usr/bin" } },
      { user: "agent", limits: { cpuSeconds: null } },
      "/work",
    );
    expect(wrapped.command).toBe("/bin/bash");
    expect(wrapped.args[0]).toBe("-c");
    const script = wrapped.args[1] ?? "";
    expect(script).toMatch(/^exec 'sudo' -n -u agent /);
    expect(script).toContain("exec 3<&0");
    expect(script).toContain("<&3 3<&- & wait");
    expect(script).not.toContain("ulimit -t");
    expect(script).toContain("exec");
    expect(wrapped.env["HOME"]).toBe("/work");
    // Plain commands still get no stdin.
    expect(wrapCommandForUser("cat", {}, { user: "agent" }, "/work").command).not.toContain("3<&0");
  });

  it("refuses to combine runAs with the server's whole environment", async () => {
    expect(() =>
      createTerminalToolPlugin({
        root: os.tmpdir(),
        runAs: { user: "agent" },
        inheritProcessEnv: true,
      }),
    ).toThrow(/runAs cannot be combined/);
    await expect(
      createTerminalToolPlugin({ root: os.tmpdir(), runAs: { user: "a; rm" } }).run({
        command: "x",
      }),
    ).rejects.toThrow(/Invalid runAs user/);
  });

  // Runs only where the test host has a user the current user can sudo to, for example
  // `GENERIC_AI_TEST_RUN_AS_USER=agent`. The image smoke test covers it on every build.
  const runAsUser = process.env["GENERIC_AI_TEST_RUN_AS_USER"];
  it.skipIf(runAsUser === undefined)(
    "runs commands as the other user and kills them on timeout",
    async () => {
      await withTempRoot(async (root) => {
        await chmod(root, 0o777);
        const plugin = createTerminalToolPlugin({ root, runAs: { user: runAsUser as string } });
        const who = await plugin.run({ command: 'id -un; echo "$HOME"; umask' });
        expect(who.exitCode).toBe(0);
        expect(who.output.split("\n").slice(0, 3)).toEqual([runAsUser, root, "0007"]);
        expect((await plugin.run({ command: "exit 7" })).exitCode).toBe(7);
        const limits = await plugin.run({ command: "ulimit -d; ulimit -u; nice" });
        expect(limits.output.split("\n").slice(0, 3)).toEqual(["4194304", "1024", "10"]);
        const raise = await plugin.run({ command: "ulimit -d unlimited" });
        expect(raise.exitCode).not.toBe(0);

        const marker = `generic-ai-run-as-${process.pid}-${Date.now()}`;
        await plugin
          .run({ command: `sleep 300 & sleep 301; echo ${marker}`, timeoutMs: 1000 })
          .catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const left = await createTerminalToolPlugin({ root }).run({
          command: `pgrep -u ${runAsUser} -f 'sleep 30[01]' || true`,
        });
        expect(left.output.trim()).toBe("");
      });
    },
    20_000,
  );

  it.skipIf(runAsUser === undefined)(
    "runs a long-lived process as the other user with its stdin",
    async () => {
      await withTempRoot(async (root) => {
        await chmod(root, 0o777);
        const wrapped = wrapProcessForUser(
          {
            command: "/bin/sh",
            args: ["-c", 'read line; echo "$(id -un):$line"'],
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          },
          { user: runAsUser as string },
          root,
        );
        const child = spawn(wrapped.command, [...wrapped.args], {
          cwd: root,
          env: wrapped.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += String(chunk);
        });
        child.stdin.end("hello\n");
        await new Promise((resolve) => child.on("close", resolve));
        expect(out.trim()).toBe(`${runAsUser}:hello`);
      });
    },
    20_000,
  );
});
