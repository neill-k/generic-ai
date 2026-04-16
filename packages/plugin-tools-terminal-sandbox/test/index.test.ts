import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPluginHost } from "@generic-ai/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX,
  SANDBOX_ALLOWLIST_PROXY_ALIAS,
  SANDBOX_ALLOWLIST_PROXY_IMAGE,
  SANDBOX_ALLOWLIST_PROXY_PORT,
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
  type SandboxDockerCreateNetworkRequest,
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
  readonly createdNetworks: SandboxDockerCreateNetworkRequest[] = [];
  readonly connectedNetworks: Array<{
    containerId: string;
    networkName: string;
    aliases?: readonly string[];
  }> = [];
  readonly execCalls: SandboxDockerExecRequest[] = [];
  readonly stopped: Array<{ containerId: string; graceMs?: number }> = [];
  readonly removed: string[] = [];
  readonly removedNetworks: string[] = [];
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
  copyHandler?: (
    containerId: string,
    sourcePath: string,
    destinationPath: string,
  ) => Promise<void>;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async ensureImage(): Promise<void> {
    return;
  }

  async createNetwork(request: SandboxDockerCreateNetworkRequest): Promise<string> {
    this.createdNetworks.push(request);
    return request.name;
  }

  async connectContainerToNetwork(
    containerId: string,
    networkName: string,
    aliases?: readonly string[],
  ): Promise<void> {
    this.connectedNetworks.push({ containerId, networkName, aliases });
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

  async removeNetwork(networkName: string): Promise<void> {
    this.removedNetworks.push(networkName);
  }

  async copyFromContainer(
    containerId: string,
    sourcePath: string,
    destinationPath: string,
  ): Promise<void> {
    this.copied.push({ containerId, sourcePath, destinationPath });
    if (this.copyHandler !== undefined) {
      await this.copyHandler(containerId, sourcePath, destinationPath);
    }
  }

  async inspectContainer(): Promise<SandboxContainerState | undefined> {
    return this.containerState;
  }

  async readUsageSnapshot(): Promise<SandboxContainerUsageSnapshot | undefined> {
    return this.usageSnapshots.shift();
  }
}

function getWorkspaceMount(docker: FakeDockerOperations) {
  const mount = docker.created[0]?.mounts.find(
    (candidate): candidate is Extract<SandboxDockerCreateContainerRequest["mounts"][number], { source: string }> =>
      "source" in candidate && candidate.target === "/workspace",
  );
  expect(mount).toBeDefined();
  if (mount === undefined) {
    throw new Error("Expected a /workspace bind mount.");
  }
  return mount;
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
          maxInputBytes: 256 * 1024 * 1024,
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
      await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
      await writeFile(path.join(root, "workspace", "shared", "input.txt"), "source\n", "utf8");

      const docker = new FakeDockerOperations();
      docker.copyHandler = async (_containerId, _sourcePath, destinationPath) => {
        await mkdir(path.join(destinationPath, "logs"), { recursive: true });
        await writeFile(path.join(destinationPath, "result.json"), "{\"ok\":true}\n", "utf8");
        await writeFile(path.join(destinationPath, "logs", "stderr.txt"), "warn\n", "utf8");
      };
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
      const workspaceMount = getWorkspaceMount(docker);
      expect(await readFile(path.join(workspaceMount.source, "workspace", "shared", "input.txt"), "utf8")).toBe(
        "source\n",
      );
      expect(docker.created[0]?.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: "/workspace", readOnly: true }),
          expect.objectContaining({
            type: "tmpfs",
            target: SANDBOX_OUTPUT_MOUNT_PATH,
            sizeMb: 100,
          }),
        ]),
      );
      expect(result.status).toBe("succeeded");
      expect(result.image).toBe("node:24-bookworm-slim");
      expect(result.cwd).toBe(root);
      expect(result.sandboxCwd).toBe("/workspace");
      expect(result.stdout).toBe("ok\n");
      expect(result.output).toBe("ok\n");
      expect(result.unrestrictedLocal).toBe(false);
      expect(result.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "result.json",
            sizeBytes: 12,
          }),
          expect.objectContaining({
            path: "logs/stderr.txt",
            sizeBytes: 5,
          }),
        ]),
      );
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
      expect(result.generatedFiles).toEqual(result.artifacts);
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

  it("requires an allowlist when allowlist network mode is selected", async () => {
    await withTempRoot(async (root) => {
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: new FakeDockerOperations(),
      });

      await expect(
        plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
          policy: {
            network: {
              mode: "allowlist",
            },
          },
        }),
      ).rejects.toThrow(/allowlist/i);
    });
  });

  it("creates an allowlist proxy sidecar and injects protected proxy env vars", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "allowlist-1",
      });

      const session = await plugin.createSession({
        runtime: "python",
        workspaceRoot: root,
        policy: {
          network: {
            mode: "allowlist",
            allowlist: ["example.com", "api.example.com:8443"],
          },
        },
      });

      expect(session.containerId).toBe("container-allowlist-1");
      expect(docker.createdNetworks).toEqual([
        {
          name: `${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-allowlist-1`,
          internal: true,
        },
      ]);
      expect(docker.created).toHaveLength(2);
      expect(docker.created[0]).toEqual(
        expect.objectContaining({
          image: SANDBOX_ALLOWLIST_PROXY_IMAGE,
          networkName: `${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-allowlist-1`,
          networkAliases: [SANDBOX_ALLOWLIST_PROXY_ALIAS],
          env: expect.objectContaining({
            GENERIC_AI_PROXY_CONFIG: expect.stringContaining("/generic-ai-network-proxy/config.json"),
          }),
          command: ["node", "/generic-ai-network-proxy/proxy.mjs"],
        }),
      );
      expect(docker.connectedNetworks).toEqual([
        {
          containerId: "container-allowlist-1-allowlist-proxy",
          networkName: "bridge",
          aliases: undefined,
        },
      ]);
      expect(docker.created[1]).toEqual(
        expect.objectContaining({
          networkName: `${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-allowlist-1`,
          env: expect.objectContaining({
            HTTP_PROXY: `http://${SANDBOX_ALLOWLIST_PROXY_ALIAS}:${SANDBOX_ALLOWLIST_PROXY_PORT}`,
            HTTPS_PROXY: `http://${SANDBOX_ALLOWLIST_PROXY_ALIAS}:${SANDBOX_ALLOWLIST_PROXY_PORT}`,
            GENERIC_AI_SANDBOX_OUTPUT_DIR: SANDBOX_OUTPUT_MOUNT_PATH,
          }),
        }),
      );

      await plugin.destroy(session.sessionId);

      expect(docker.removed).toEqual(
        expect.arrayContaining(["container-allowlist-1", "container-allowlist-1-allowlist-proxy"]),
      );
      expect(docker.removedNetworks).toEqual([`${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-allowlist-1`]);
    });
  });

  it("surfaces blocked allowlist destinations in stderr", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.execResult = {
        exitCode: 1,
        stdout: "",
        stderr: "proxy denied\n",
      };
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "allowlist-log-1",
      });

      const session = await plugin.createSession({
        runtime: "python",
        workspaceRoot: root,
        policy: {
          network: {
            mode: "allowlist",
            allowlist: ["example.com"],
          },
        },
      });

      const proxyCreate = docker.created[0];
      if (proxyCreate?.mounts === undefined) {
        throw new Error("Expected allowlist proxy mounts.");
      }
      const logMount = proxyCreate.mounts.find(
        (mount): mount is Extract<typeof proxyCreate.mounts[number], { source: string }> =>
          "source" in mount && mount.target === "/generic-ai-network-logs",
      );
      expect(logMount).toBeDefined();
      if (logMount === undefined) {
        throw new Error("Expected allowlist proxy log mount.");
      }

      await mkdir(logMount.source, { recursive: true });
      await writeFile(
        path.join(logMount.source, "blocked.log"),
        "2026-04-16T10:00:00.000Z openai.com:443 blocked-connect\n",
        "utf8",
      );

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "python -c \"print('nope')\"",
      });

      expect(result.status).toBe("failed");
      expect(result.stderr).toContain("Blocked outbound network attempts");
      expect(result.stderr).toContain("openai.com:443");
    });
  });

  it("stages only requested copy-mode inputs and mirrors requested outputs back to generatedFiles", async () => {
    await withTempRoot(async (root) => {
      await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
      await writeFile(path.join(root, "workspace", "shared", "source.txt"), "seed\n", "utf8");
      await writeFile(path.join(root, "workspace", "shared", "ignored.txt"), "skip\n", "utf8");

      const docker = new FakeDockerOperations();
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "copy-1",
      });

      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
        policy: {
          files: {
            mode: "copy",
            maxInputBytes: 1_024,
            copyInPaths: ["workspace/shared/source.txt"],
            copyOutPaths: ["workspace/shared/derived.txt", "reports"],
          },
        },
      });

      const workspaceMount = getWorkspaceMount(docker);
      expect(workspaceMount.readOnly).toBeUndefined();
      expect(await readFile(path.join(workspaceMount.source, "workspace", "shared", "source.txt"), "utf8")).toBe(
        "seed\n",
      );
      await expect(
        readFile(path.join(workspaceMount.source, "workspace", "shared", "ignored.txt"), "utf8"),
      ).rejects.toThrow();

      docker.execHandler = async () => {
        await mkdir(path.join(workspaceMount.source, "reports"), { recursive: true });
        await writeFile(path.join(workspaceMount.source, "reports", "summary.txt"), "copied\n", "utf8");
        await writeFile(
          path.join(workspaceMount.source, "workspace", "shared", "derived.txt"),
          "derived\n",
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: "copied\n",
          stderr: "",
        };
      };

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "printf copied",
      });

      expect(result.status).toBe("succeeded");
      expect(result.generatedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "reports/summary.txt",
            sizeBytes: 7,
          }),
          expect.objectContaining({
            path: "workspace/shared/derived.txt",
            sizeBytes: 8,
          }),
        ]),
      );
    });
  });

  it("rejects readonly workspace snapshots that exceed maxInputBytes", async () => {
    await withTempRoot(async (root) => {
      await writeFile(path.join(root, "oversized.txt"), "1234567890", "utf8");

      const docker = new FakeDockerOperations();
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
      });

      await expect(
        plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
          policy: {
            files: {
              mode: "readonly-mount",
              maxInputBytes: 4,
            },
          },
        }),
      ).rejects.toThrow(/maxInputBytes/i);
      expect(docker.created).toHaveLength(0);
    });
  });

  it("blocks copy-mode symlink traversal outside the workspace root", async () => {
    await withTempRoot(async (root) => {
      const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-terminal-sandbox-outside-"));
      try {
        await writeFile(path.join(outsideRoot, "secret.txt"), "secret\n", "utf8");
        try {
          await symlink(path.join(outsideRoot, "secret.txt"), path.join(root, "escape.txt"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") {
            return;
          }
          throw error;
        }

        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: new FakeDockerOperations(),
        });

        await expect(
          plugin.createSession({
            runtime: "bash",
            workspaceRoot: root,
            policy: {
              files: {
                mode: "copy",
                copyInPaths: ["escape.txt"],
              },
            },
          }),
        ).rejects.toThrow(/escapes the workspace root/i);
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("reports non-timeout command failures without masking the exit code", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.execResult = {
        exitCode: 2,
        stdout: "",
        stderr: "boom\n",
      };
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "failure-1",
      });
      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
      });

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "exit 2",
      });

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(2);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toBe("boom");
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

  it("truncates stdout and stderr independently when maxOutputBytes is configured", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.execResult = {
        exitCode: 0,
        stdout: "😀😀",
        stderr: "abcdefghij",
      };
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "truncate-1",
      });
      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
        policy: {
          resources: {
            maxOutputBytes: 5,
          },
        },
      });

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "printf 'ignored'",
      });

      expect(result.truncated).toBe(true);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
      expect(result.stdout).toBe("😀");
      expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(5);
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

  it("enforces isolated, allowlist, and open network modes in live Docker runs", async () => {
    if (!(await isDockerDaemonReachable())) {
      return;
    }

    await withTempRoot(async (root) => {
      const plugin = createSandboxTerminalPlugin({
        root,
        sessionIdFactory: () => "network-live",
      });

      const pythonFetch = (url: string) =>
        `python -c "import urllib.request; print(urllib.request.urlopen('${url}', timeout=10).status)"`;

      const isolatedResult = await plugin.run({
        runtime: "python",
        command: pythonFetch("http://example.com"),
        policy: {
          network: {
            mode: "isolated",
          },
        },
      });
      expect(isolatedResult.status).toBe("failed");

      const allowlistedResult = await plugin.run({
        runtime: "python",
        command: pythonFetch("http://example.com"),
        policy: {
          network: {
            mode: "allowlist",
            allowlist: ["example.com"],
          },
        },
      });
      expect(allowlistedResult.status).toBe("succeeded");
      expect(allowlistedResult.stdout).toContain("200");

      const blockedAllowlistResult = await plugin.run({
        runtime: "python",
        command: pythonFetch("http://example.org"),
        policy: {
          network: {
            mode: "allowlist",
            allowlist: ["example.com"],
          },
        },
      });
      expect(blockedAllowlistResult.status).toBe("failed");
      expect(blockedAllowlistResult.stderr).toContain("example.org:80");

      const openResult = await plugin.run({
        runtime: "python",
        command: pythonFetch("http://example.com"),
        policy: {
          network: {
            mode: "open",
          },
        },
      });
      expect(openResult.status).toBe("succeeded");
      expect(openResult.stdout).toContain("200");
    });
  });

  it("reads staged workspace files, extracts output artifacts, and rejects writes to the readonly mount in live Docker runs", async () => {
    if (!(await isDockerDaemonReachable())) {
      return;
    }

    await withTempRoot(async (root) => {
      await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
      await writeFile(path.join(root, "workspace", "shared", "note.txt"), "sandbox-input\n", "utf8");

      const plugin = createSandboxTerminalPlugin({
        root,
        sessionIdFactory: () => "integration-readonly-1",
      });

      const result = await plugin.run({
        runtime: "bash",
        command: [
          "cat /workspace/workspace/shared/note.txt",
          "printf 'artifact\\n' > \"$GENERIC_AI_SANDBOX_OUTPUT_DIR/live.txt\"",
          "printf 'mutate\\n' > /workspace/workspace/shared/note.txt",
        ].join(" && "),
      });

      expect(result.stdout).toContain("sandbox-input");
      expect(result.status).toBe("failed");
      expect(result.stderr.toLowerCase()).toContain("read-only");
      expect(result.generatedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "live.txt",
          }),
        ]),
      );
    });
  });
});
