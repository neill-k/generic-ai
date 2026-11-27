import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PythonKernel } from "@generic-ai/rlm";
import { afterEach, describe, expect, it } from "vitest";

import { CompanyRlmError, kernelRunAs, resolveCompanyRlm } from "./rlm.js";

const ok = () => undefined;
const shared = { mode: "shared" as const, reason: "test" };
const isolated = { mode: "user" as const, user: "agent", runAs: { user: "agent" } };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("company Python workspace", () => {
  it("is on by default when Python runs, and off when asked", () => {
    const on = resolveCompanyRlm({}, shared, { check: ok });
    expect(on.option).toMatchObject({ python: "python3" });
    expect(on.option?.launch).toBeUndefined();
    expect(on.description).toContain("server's own OS user");

    const off = resolveCompanyRlm({ GENERIC_CORP_RLM: "off" }, shared, { check: ok });
    expect(off.option).toBeUndefined();
    expect(off.description).toContain("off");

    const named = resolveCompanyRlm(
      {
        GENERIC_CORP_RLM_MODEL: "anthropic/claude-haiku-4-5",
        GENERIC_AI_PYTHON: "/usr/bin/python3",
      },
      shared,
      { check: ok },
    );
    expect(named.option).toMatchObject({
      python: "/usr/bin/python3",
      model: "anthropic/claude-haiku-4-5",
    });
  });

  it("leaves the workspace out without Python, unless it is required", () => {
    const missing = () => "spawn python3 ENOENT";
    const auto = resolveCompanyRlm({}, shared, { check: missing });
    expect(auto.option).toBeUndefined();
    expect(auto.description).toContain("ENOENT");
    expect(() => resolveCompanyRlm({ GENERIC_CORP_RLM: "on" }, shared, { check: missing })).toThrow(
      CompanyRlmError,
    );
    expect(() => resolveCompanyRlm({ GENERIC_CORP_RLM: "maybe" }, shared, { check: ok })).toThrow(
      /auto, on or off/,
    );
  });

  it("runs the kernel as the agent user with the command limits, minus the CPU cap", () => {
    const rlm = resolveCompanyRlm({}, isolated, { check: ok });
    expect(rlm.description).toContain('"agent"');
    const launch = rlm.option?.launch?.({
      command: "python3",
      args: ["-u", "/app/kernel.py"],
      env: { PATH: "/usr/bin", GENERIC_AI_SECRET_X: "never" },
      cwd: "/data/agents/ceo",
    });
    expect(launch?.command).toBe("/bin/bash");
    expect(launch?.cwd).toBe("/data/agents/ceo");
    expect(launch?.env["HOME"]).toBe("/data/agents/ceo");
    expect(launch?.env["USER"]).toBe("agent");
    const script = launch?.args[1] ?? "";
    expect(script).toMatch(/^exec 'sudo' -n -u agent /);
    expect(script).toContain("ulimit -d");
    expect(script).not.toContain("ulimit -t");
    expect(script).not.toContain("never");

    expect(kernelRunAs({ user: "agent", limits: false }).limits).toBe(false);
    expect(kernelRunAs({ user: "agent", limits: { memoryMiB: 512 } }).limits).toEqual({
      memoryMiB: 512,
      cpuSeconds: null,
    });
  });

  // Needs a user the test host can sudo to, e.g. GENERIC_AI_TEST_RUN_AS_USER=agent, and python3.
  // The image smoke test checks the image has both.
  const runAsUser = process.env["GENERIC_AI_TEST_RUN_AS_USER"];
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(runAsUser === undefined || !hasPython)(
    "keeps a kernel's variables across cells while it runs as the agent user",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "generic-corp-rlm-"));
      roots.push(root);
      await chmod(root, 0o777);
      const isolation = {
        mode: "user" as const,
        user: runAsUser as string,
        runAs: { user: runAsUser as string },
      };
      const rlm = resolveCompanyRlm({}, isolation);
      const kernel = new PythonKernel({
        cwd: root,
        ...(rlm.option?.launch === undefined ? {} : { launch: rlm.option.launch }),
      });
      try {
        await kernel.execute("import getpass, os, resource\nx = 41");
        const run = await kernel.execute(
          "print(getpass.getuser(), os.environ['HOME'], x + 1, resource.getrlimit(resource.RLIMIT_CPU)[0])",
        );
        expect(run.status).toBe("ok");
        const text = run.output.map((part) => part.text).join("");
        expect(text.trim()).toBe(`${runAsUser} ${root} 42 -1`);
      } finally {
        await kernel.dispose();
      }
    },
    30_000,
  );
});
