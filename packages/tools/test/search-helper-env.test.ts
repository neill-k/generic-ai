import { describe, expect, it } from "vitest";
import { getAgentCommandEnv } from "../src/env.js";

describe("search helper environment", () => {
  it("passes locale and paths to rg and fd but never host secrets", () => {
    const env = getAgentCommandEnv({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-probe",
      DATABASE_URL: "postgres://probe@db/app",
      GENERIC_AI_SECRETS_KEY: "probe",
      GENERIC_AI_OWNER_SETUP_TOKEN: "probe",
      RIPGREP_CONFIG_PATH: "/tmp/agent-written-rgrc",
    });

    expect(env["PATH"]).toContain("/usr/bin");
    expect(env).toMatchObject({ HOME: "/home/node", LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8" });
    for (const key of [
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
      "GENERIC_AI_SECRETS_KEY",
      "GENERIC_AI_OWNER_SETUP_TOKEN",
      "RIPGREP_CONFIG_PATH",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});
