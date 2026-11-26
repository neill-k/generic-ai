import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureGitWorktreeSnapshot, createShellGateRunner } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env["GENERIC_AI_GATE_TEST_SECRET"];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-gates-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe.skipIf(process.platform === "win32")("shell gate runner", () => {
  it("runs gates and reports exit codes, output and timeouts", async () => {
    const runner = createShellGateRunner({ cwd: tempDir(), snapshots: false });
    expect((await runner.runGate("echo ok", 5_000)).status).toBe(0);
    const failed = await runner.runGate("echo broken >&2; exit 3", 5_000);
    expect(failed.status).toBe(3);
    expect(failed.stderr.trim()).toBe("broken");
    const slow = await runner.runGate("sleep 5", 100);
    expect(slow.timedOut).toBe(true);
  });

  it("does not let a gate see a secret set in the server's environment", async () => {
    process.env["GENERIC_AI_GATE_TEST_SECRET"] = "hunter2";
    const clean = createShellGateRunner({ cwd: tempDir(), snapshots: false });
    const result = await clean.runGate("env", 5_000);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("hunter2");
    expect(result.stdout).toContain("PATH=");
    const inherited = createShellGateRunner({
      cwd: tempDir(),
      snapshots: false,
      inheritProcessEnv: true,
    });
    expect((await inherited.runGate("env", 5_000)).stdout).toContain("hunter2");
  });

  it("fingerprints the git working tree", async () => {
    const cwd = tempDir();
    git(cwd, "init", "-q");
    git(
      cwd,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const empty = await captureGitWorktreeSnapshot(cwd);
    expect(empty).toBeDefined();
    writeFileSync(join(cwd, "a.txt"), "one");
    const first = await captureGitWorktreeSnapshot(cwd);
    expect(first?.status).toContain("?? a.txt");
    expect(first?.untrackedHash).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(cwd, "a.txt"), "two");
    const second = await captureGitWorktreeSnapshot(cwd);
    expect(second?.untrackedHash).not.toBe(first?.untrackedHash);
    expect(await captureGitWorktreeSnapshot(join(cwd, "missing"))).toBeUndefined();
    expect(await captureGitWorktreeSnapshot(tempDir())).toBeUndefined();
  });
});
