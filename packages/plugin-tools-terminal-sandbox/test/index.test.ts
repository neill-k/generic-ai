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
  SANDBOX_OUTPUT_MOUNT_PATH,
  sandboxTerminalConfigSchema,
  sandboxTerminalPluginContract,
  sandboxTerminalPluginDefinition,
  SandboxUnavailableError,
  type SandboxContainerState,
  type SandboxContainerUsageSnapshot,
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
  readonly stopped: Array<{ containerId: string; graceMs?: number }> = [];
  readonly removed: string[] = [];
  readonly copied: Array<{ containerId: string; sourcePath: string; destinationPath: string }> = [];
  available = true;
  execResult: SandboxDockerExecResult = {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  };
  usageSnapshots: SandboxContainerUsageSnapshot[] = [
    {
      cpuTimeMs: 100,
      peakMemoryMb: 48,
      diskWrittenMb: 1,
    },
    {
      cpuTimeMs: 140,
      peakMemoryMb: 64,
      diskWrittenMb: 2,
    },
  ];
  containerState: SandboxContainerState | undefined = {
    running: true,
    oomKilled: false,
  };
  execHandler?: (request: SandboxDockerExecRequest) => Promise<SandboxDockerExecResult>;
  stopHandler?: (containerId: string, graceMs?: number) => Promise<void>;

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
    if (this.execHandler !== undefined) {
      return this.execHandler(request);
    }
    return this.execResult;
  }

  async stopContainer(containerId: string, graceMs?: number): Promise<void> {
    this.stopped.push({ containerId, graceMs });
    if (this.stopHandler !== undefined) {
      await this.stopHandler(containerId, graceMs);
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    this.removed.push(containerId);
  }

  async copyFromContainer(
    containerId: string,
    sourcePath: string,
    destinationPath: string,
  ): Promise<void> {
    this.copied.push({ containerId, sourcePath, destinationPath });
  }

  async inspectContainer(): Promise<SandboxContainerState | undefined> {
    return this.containerState;
  }

  async readUsageSnapshot(): Promise<SandboxContainerUsageSnapshot | undefined> {
    return this.usageSnapshots.shift();
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
          timeoutMs: 30_000,
          timeoutGraceMs: 5_000,
          memoryMb: 512,
          cpuCores: 1,
          diskMb: 100,
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
      expect(docker.created[0]?.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: root,
            target: "/workspace",
            readOnly: true,
          }),
          expect.objectContaining({
            type: "tmpfs",
            target: SANDBOX_OUTPUT_MOUNT_PATH,
            sizeMb: 100,
          }),
        ]),
      );
      expect(result.status).toBe("succeeded");
      expect(result.stdout).toBe("ok\n");
      expect(result.output).toBe("ok\n");
      expect(result.resourceUsage).toEqual({
        wallClockMs: expect.any(Number),
        cpuTimeMs: 40,
        peakMemoryMb: 64,
        diskWrittenMb: 2,
      });
      expect(docker.copied[0]).toEqual(
        expect.objectContaining({
          containerId: "container-session-123",
          sourcePath: `${SANDBOX_OUTPUT_MOUNT_PATH}/.`,
        }),
      );
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
        policy: {
          resources: {
            cpuCores: 0.5,
            memoryMb: 256,
            diskMb: 32,
            timeoutMs: 5_000,
          },
        },
      });

      expect(result.status).toBe("succeeded");
      expect(plugin.listSessions()).toHaveLength(0);
      expect(docker.created[0]?.cpus).toBe(0.5);
      expect(docker.created[0]?.memoryMb).toBe(256);
      expect(docker.created[0]?.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tmpfs",
            target: SANDBOX_OUTPUT_MOUNT_PATH,
            sizeMb: 32,
          }),
        ]),
      );
      expect(docker.stopped).toEqual([{ containerId: "container-ephemeral-1", graceMs: undefined }]);
      expect(docker.removed).toEqual(["container-ephemeral-1"]);
    });
  });

  it("enforces timeouts with a Docker stop grace period and clears the session", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      let resolveExec: ((value: SandboxDockerExecResult) => void) | undefined;
      docker.execHandler = async () =>
        new Promise<SandboxDockerExecResult>((resolve) => {
          resolveExec = resolve;
        });
      docker.stopHandler = async () => {
        docker.containerState = {
          running: false,
          oomKilled: false,
        };
        resolveExec?.({
          exitCode: 137,
          stdout: "",
          stderr: "",
        });
      };

      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "timeout-1",
      });
      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
        policy: {
          resources: {
            timeoutMs: 5,
            timeoutGraceMs: 2_500,
          },
        },
      });

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "sleep 10",
      });

      expect(result.status).toBe("timed_out");
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toMatch(/timed out after 5ms/i);
      expect(result.stderr).toMatch(/2500ms/i);
      expect(docker.stopped).toEqual(
        expect.arrayContaining([{ containerId: "container-timeout-1", graceMs: 2_500 }]),
      );
      expect(plugin.listSessions()).toHaveLength(0);
      expect(docker.removed).toEqual(["container-timeout-1"]);
    });
  });

  it("reports OOM failures with actionable memory guidance", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.execResult = {
        exitCode: 137,
        stdout: "",
        stderr: "Killed\n",
      };
      docker.containerState = {
        running: true,
        oomKilled: true,
      };

      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "oom-1",
      });
      const session = await plugin.createSession({
        runtime: "python",
        workspaceRoot: root,
        policy: {
          resources: {
            memoryMb: 256,
          },
        },
      });

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "python -c \"print('boom')\"",
      });

      expect(result.status).toBe("oom");
      expect(result.stderr).toMatch(/256MiB memory limit/i);
      expect(result.stderr).toMatch(/memoryMb/i);
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
