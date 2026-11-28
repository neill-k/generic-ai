import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Keeps the deploy files (Dockerfile, compose, Railway config) in step with
 * the code they point at, so a rename breaks a test instead of a deploy.
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");
const read = (file: string) => readFileSync(path.join(repoRoot, file), "utf8");

/** Maps a `dist/*.js` path used by the image back to its TypeScript source. */
function sourceFor(distPath: string): string {
  return distPath.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
}

describe("deploy packaging", () => {
  const dockerfile = read("apps/generic-corp/Dockerfile");
  const railway = read("railway.toml");
  const compose = read("apps/generic-corp/compose.yaml");

  it("pins the same Playwright MCP release as the browser connector", () => {
    const connectors = read("packages/plugin-mcp/src/connectors.ts");
    const pinned = /PLAYWRIGHT_MCP_PACKAGE = "([^"]+)"/.exec(connectors)?.[1];
    const baked = /ARG PLAYWRIGHT_MCP_PACKAGE=(\S+)/.exec(dockerfile)?.[1];

    expect(pinned).toBeDefined();
    expect(baked).toBe(pinned);
  });

  it("starts the server and runs migrations from files the build produces", () => {
    const cmd = /^CMD \["node", "([^"]+)"\]/m.exec(dockerfile)?.[1];
    const preDeploy = /preDeployCommand = \["node ([^"]+)"\]/.exec(railway)?.[1];
    const composeMigrate = /command: \["node", "([^"]+)"\]/.exec(compose)?.[1];

    expect(cmd).toBe("apps/generic-corp/dist/run.js");
    expect(preDeploy).toBe("apps/generic-corp/dist/migrate.js");
    expect(composeMigrate).toBe(preDeploy);
    for (const distPath of [cmd, preDeploy]) {
      expect(existsSync(path.join(repoRoot, sourceFor(distPath ?? "")))).toBe(true);
    }
  });

  it("builds the Dockerfile Railway is pointed at", () => {
    const dockerfilePath = /dockerfilePath = "([^"]+)"/.exec(railway)?.[1];
    expect(dockerfilePath).toBe("apps/generic-corp/Dockerfile");
  });

  it("health checks hit the routes the server serves", () => {
    const server = read("apps/generic-corp/src/server.ts");
    expect(server).toContain('app.get("/health"');
    expect(server).toContain('app.get("/ready"');
    expect(railway).toMatch(/healthcheckPath = "\/ready"/);
    expect(dockerfile).toContain("/health'");
    expect(compose).toContain("/ready'");
  });

  it("listens on all interfaces and keeps agent data on the volume", () => {
    expect(dockerfile).toMatch(/GENERIC_CORP_HOST=0\.0\.0\.0/);
    expect(dockerfile).toMatch(/GENERIC_CORP_DATA_DIR=\/data/);
    // Railway rejects a Dockerfile VOLUME; Compose and Railway mount /data themselves.
    expect(dockerfile).not.toMatch(/^VOLUME/m);
    expect(compose).toContain("generic-corp-data:/data");
  });

  it("installs the binaries the agent tools shell out to", () => {
    for (const pkg of ["bash", "git", "python3", "ripgrep", "fd-find", "tini"]) {
      expect(dockerfile).toMatch(new RegExp(`\\b${pkg}\\b`));
    }
  });
});
