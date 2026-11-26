import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBashTool, getAgentCommandEnv } from "../src/index.js";

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-native-probe",
  OPENAI_API_KEY: "sk-openai-native-probe",
  DATABASE_URL: "postgres://probe:hunter2@db/app",
  GENERIC_AI_SECRETS_KEY: "secrets-key-native-probe",
  GENERIC_AI_OWNER_SETUP_TOKEN: "setup-token-native-probe",
};

function outputText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

describe("getAgentCommandEnv", () => {
  it("keeps paths, locale and user variables and drops everything else", () => {
    const env = getAgentCommandEnv({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      TMPDIR: "/tmp",
      USER: "node",
      ...SECRETS,
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_CTYPE", "PATH", "TMPDIR", "USER"]);
    expect(env["PATH"]?.split(delimiter)).toContain("/usr/bin");
    expect(
      getAgentCommandEnv({ PATH: "/usr/bin", EXTRA: "x" }, { allow: ["EXTRA"] })["EXTRA"],
    ).toBe("x");
    expect(
      getAgentCommandEnv({ PATH: "/usr/bin", ...SECRETS }, { inheritProcessEnv: true })[
        "DATABASE_URL"
      ],
    ).toBe(SECRETS.DATABASE_URL);
  });
});

describe("bash tool environment", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "generic-ai-bash-env-"));
    Object.assign(process.env, SECRETS);
  });

  afterEach(() => {
    for (const key of Object.keys(SECRETS)) {
      delete process.env[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not let an agent command see secrets in the server's environment", async () => {
    const output = outputText(await createBashTool(dir).execute("probe", { command: "env" }));
    for (const value of Object.values(SECRETS)) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain("PATH=");
  });

  it("passes a spawn hook the clean environment", async () => {
    let seen: NodeJS.ProcessEnv = {};
    const bash = createBashTool(dir, {
      spawnHook: (context) => {
        seen = context.env;
        return context;
      },
    });
    await bash.execute("probe", { command: "true" });
    expect(seen["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(seen["PATH"]).toBeDefined();
  });

  it("passes the whole environment only when asked", async () => {
    const output = outputText(
      await createBashTool(dir, { inheritProcessEnv: true }).execute("probe", { command: "env" }),
    );
    expect(output).toContain(SECRETS.ANTHROPIC_API_KEY);
  });
});
