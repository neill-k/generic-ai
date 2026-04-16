import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionCheck = await import(pathToFileURL(resolve(__dirname, "check-node-version.mjs")).href);

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
