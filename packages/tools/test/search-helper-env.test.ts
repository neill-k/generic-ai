import { describe, expect, it } from "vitest";
import { getSearchHelperEnv } from "../src/shell.js";

describe("getSearchHelperEnv", () => {
  it("passes locale and paths to rg and fd but never host secrets", () => {
    const env = getSearchHelperEnv({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      TMPDIR: "/tmp",
      ANTHROPIC_API_KEY: "sk-ant-probe",
      DATABASE_URL: "postgres://probe@db/app",
      GENERIC_AI_SECRETS_KEY: "probe",
      GENERIC_AI_OWNER_SETUP_TOKEN: "probe",
      RIPGREP_CONFIG_PATH: "/tmp/agent-written-rgrc",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      TMPDIR: "/tmp",
    });
  });
});
