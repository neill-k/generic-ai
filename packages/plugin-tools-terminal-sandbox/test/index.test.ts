import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPluginHost } from "@generic-ai/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDockerCliSandboxOperations,
  createSandboxTerminalPlugin,
  isDockerDaemonReachable,
  name,
  SANDBOX_DEFAULT_IMAGES,
  sandboxTerminalConfigSchema,
  sandboxTerminalPluginContract,
  sandboxTerminalPluginDefinition,
  SandboxUnavailableError,
  type SandboxDockerCreateContainerRequest,
  type SandboxDockerExecRequest,
  type SandboxDockerExecResult,
  type SandboxDockerOperations,
} from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-terminal-sandbox-"));
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

class FakeDockerOperations implements SandboxDockerOperations {
  readonly created: SandboxDockerCreateContainerRequest[] = [];
  readonly execCalls: SandboxDockerExecRequest[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  available = true;
  execResult: SandboxDockerExecResult = {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  };

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async ensureImage(): Promise<void> {
    return;
  }

  async createContainer(request: SandboxDockerCreateContainerRequest): Promise<string> {
    this.created.push(request);
    return `container-${request.sessionId}`;
  }

  async startContainer(): Promise<void> {
    return;
  }

  async exec(request: SandboxDockerExecRequest): Promise<SandboxDockerExecResult> {
    this.execCalls.push(request);
    return this.execResult;
  }

  async stopContainer(containerId: string): Promise<void> {
    this.stopped.push(containerId);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.removed.push(containerId);
  }
}

describe("@generic-ai/plugin-tools-terminal-sandbox", () => {
  it("parses config with sensible defaults", () => {
    expect(sandboxTerminalConfigSchema.parse({})).toEqual({
      backend: "docker",
      defaultRuntime: "bash",
      images: SANDBOX_DEFAULT_IMAGES,
      defaultPolicy: {
        resources: {
          timeoutMs: 300_000,
          memoryMb: 1024,
          cpuCores: 1,
          diskMb: 512,
        },
        network: {
          mode: "isolated",
        },
        files: {
          mode: "readonly-mount",
          outputDir: path.join("workspace", "shared", "sandbox-results"),
        },
      },
      ensureImages: true,
    });
  });

  it("registers a plugin-host compatible manifest", () => {
    const host = createPluginHost();
    host.register({
      manifest: {
        id: "@generic-ai/plugin-workspace-fs",
      },
    });
    host.register(sandboxTerminalPluginDefinition);

    expect(host.validate()).toEqual([]);
    expect(host.list().map((plugin) => plugin.manifest.id)).toContain(name);
    expect(sandboxTerminalPluginContract.manifest.dependencies).toEqual([
      { id: "@generic-ai/plugin-workspace-fs" },
    ]);
  });

  it("creates a reusable Docker-backed session and executes commands inside it", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "session-123",
      });

      const session = await plugin.createSession({
        runtime: "node",
        workspaceRoot: root,
      });
      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "node -e \"console.log('hello')\"",
      });

      expect(session.containerId).toBe("container-session-123");
      expect(plugin.listSessions()).toHaveLength(1);
      expect(docker.created[0]?.image).toBe("node:24-bookworm-slim");
      expect(docker.created[0]?.networkMode).toBe("none");
      expect(result.status).toBe("succeeded");
      expect(result.stdout).toBe("ok\n");
      expect(result.output).toBe("ok\n");
    });
  });

  it("destroys ephemeral sessions created through run()", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "ephemeral-1",
      });

      const result = await plugin.run({
        runtime: "python",
        command: "python -c \"print('hello')\"",
      });

      expect(result.status).toBe("succeeded");
      expect(plugin.listSessions()).toHaveLength(0);
      expect(docker.stopped).toEqual(["container-ephemeral-1"]);
      expect(docker.removed).toEqual(["container-ephemeral-1"]);
    });
  });

  it("fails cleanly when Docker is unavailable", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.available = false;
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
      });

      await expect(
        plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
        }),
      ).rejects.toBeInstanceOf(SandboxUnavailableError);
    });
  });

  it("can probe Docker CLI availability without crashing when the daemon is down", async () => {
    const docker = createDockerCliSandboxOperations();
    await expect(docker.isAvailable()).resolves.toBeTypeOf("boolean");
  });

  it("runs a real Python command and cleans up when Docker is reachable", async () => {
    if (!(await isDockerDaemonReachable())) {
      return;
    }

    await withTempRoot(async (root) => {
      const plugin = createSandboxTerminalPlugin({
        root,
        sessionIdFactory: () => "integration-1",
      });
      const session = await plugin.createSession({
        runtime: "python",
        workspaceRoot: root,
      });

      try {
        const result = await plugin.exec({
          sessionId: session.sessionId,
          command: "python -c \"print('sandbox-ok')\"",
        });

        expect(result.stdout).toContain("sandbox-ok");
        expect(result.exitCode).toBe(0);
      } finally {
        await plugin.destroy(session.sessionId);
      }

      expect(plugin.listSessions()).toHaveLength(0);
    });
  });
});
