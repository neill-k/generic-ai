import { describe, expect, it } from "vitest";

const versionCheck = await import("./check-node-version.mjs");

describe("check-node-version", () => {
  it("accepts Node 24 and newer releases", () => {
    expect(versionCheck.isSupportedNodeVersion("24.0.0")).toBe(true);
    expect(versionCheck.isSupportedNodeVersion("25.1.0")).toBe(true);
  });

  it("rejects older Node releases with a clear remediation path", () => {
    expect(versionCheck.isSupportedNodeVersion("23.11.1")).toBe(false);

    const message = versionCheck.formatNodeVersionError("v23.11.1");
    expect(message).toContain("Unsupported Node.js version: v23.11.1.");
    expect(message).toContain("requires Node.js >=24.0.0");
    expect(message).toContain("nvm use");
  });
});
