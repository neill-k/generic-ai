import { spawn } from "node:child_process";
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
  SANDBOX_WORKSPACE_MOUNT_PATH,
  SandboxConfigurationError,
  SandboxSessionConflictError,
  createDockerCliSandboxOperations,
  createSandboxTerminalPlugin,
  isDockerDaemonReachable,
  name,
  SANDBOX_DEFAULT_IMAGES,
  SANDBOX_OUTPUT_MOUNT_PATH,
  sandboxTerminalConfigSchema,
  sandboxTerminalPluginContract,
  sandboxTerminalPluginDefinition,
  SandboxArtifactSyncError,
  SandboxUnavailableError,
  validateSessionId,
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
  copyHandler?: (containerId: string, sourcePath: string, destinationPath: string) => Promise<void>;

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
    (
      candidate,
    ): candidate is Extract<
      SandboxDockerCreateContainerRequest["mounts"][number],
      { source: string }
    > => "source" in candidate && candidate.target === "/workspace",
  );
  expect(mount).toBeDefined();
  if (mount === undefined) {
    throw new Error("Expected a /workspace bind mount.");
  }
  return mount;
}

function getOutputMount(docker: FakeDockerOperations) {
  const mount = docker.created[0]?.mounts.find(
    (
      candidate,
    ): candidate is Extract<
      SandboxDockerCreateContainerRequest["mounts"][number],
      { type: "tmpfs" }
    > =>
      "type" in candidate &&
      candidate.type === "tmpfs" &&
      candidate.target === SANDBOX_OUTPUT_MOUNT_PATH,
  );
  expect(mount).toBeDefined();
  if (mount === undefined) {
    throw new Error("Expected a /workspace-output tmpfs mount.");
  }
  return mount;
}

function expectCopiedSandboxOutput(
  docker: FakeDockerOperations,
  containerId: string,
): { readonly containerId: string; readonly sourcePath: string; readonly destinationPath: string } {
  expect(docker.copied).toHaveLength(1);
  const copyCall = docker.copied[0];
  expect(copyCall).toBeDefined();
  if (copyCall === undefined) {
    throw new Error("Expected sandbox output to be copied from the container.");
  }
  expect(copyCall.containerId).toBe(containerId);
  expect(copyCall.sourcePath).toBe(SANDBOX_OUTPUT_MOUNT_PATH);
  expect(
    copyCall.destinationPath.startsWith(path.join(os.tmpdir(), "generic-ai-sandbox-artifacts-")),
  ).toBe(true);
  return copyCall;
}

interface ExternalCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runExternal(
  command: string,
  args: readonly string[],
): Promise<ExternalCommandResult> {
  return new Promise<ExternalCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

function splitOutputLines(output: string): readonly string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function listSandboxContainerIds(sessionId: string): Promise<readonly string[]> {
  const result = await runExternal("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=generic-ai.sandbox.session=${sessionId}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to list sandbox containers for "${sessionId}": ${result.stderr || result.stdout}`,
    );
  }

  return splitOutputLines(result.stdout);
}

async function expectNoSandboxDockerResources(
  sessionId: string,
  options: {
    readonly allowlist?: boolean;
  } = {},
): Promise<void> {
  expect(await listSandboxContainerIds(sessionId)).toEqual([]);
  if (options.allowlist === true) {
    expect(await listSandboxContainerIds(`${sessionId}-allowlist-proxy`)).toEqual([]);
  }

  const result = await runExternal("docker", [
    "network",
    "inspect",
    `${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-${sessionId}`,
  ]);
  expect(result.exitCode).not.toBe(0);
}

const liveDockerReachable = await isDockerDaemonReachable();
const liveIt = (liveDockerReachable ? it : it.skip) as typeof it;

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
      docker.copyHandler = async (_containerId, sourcePath, destinationPath) => {
        expect(sourcePath).toBe(SANDBOX_OUTPUT_MOUNT_PATH);
        const copiedOutputRoot = path.join(
          destinationPath,
          path.basename(SANDBOX_OUTPUT_MOUNT_PATH),
        );
        await mkdir(path.join(copiedOutputRoot, "logs"), { recursive: true });
        await writeFile(path.join(copiedOutputRoot, "result.json"), '{"ok":true}\n', "utf8");
        await writeFile(path.join(copiedOutputRoot, "logs", "stderr.txt"), "warn\n", "utf8");
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
      expect(docker.created[0]?.readOnlyRootfs).toBe(true);
      const workspaceMount = getWorkspaceMount(docker);
      expect(
        await readFile(
          path.join(workspaceMount.source, "workspace", "shared", "input.txt"),
          "utf8",
        ),
      ).toBe("source\n");
      expect(docker.created[0]?.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: "/workspace", readOnly: true }),
          expect.objectContaining({
            target: SANDBOX_OUTPUT_MOUNT_PATH,
            type: "tmpfs",
            sizeMb: 100,
          }),
          expect.objectContaining({
            type: "tmpfs",
            target: "/tmp",
          }),
          expect.objectContaining({
            type: "tmpfs",
            target: "/var/tmp",
          }),
        ]),
      );
      expect(docker.created[0]?.mounts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: path.join(root, "workspace", "shared", "sandbox-results", "session-123"),
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
        maxMemoryMb: 64,
        diskWrittenMb: 2,
      });
      expectCopiedSandboxOutput(docker, "container-session-123");
      expect(result.generatedFiles).toEqual(result.artifacts);
    });
  });

  it("omits previous sandbox outputs from readonly workspace snapshots", async () => {
    await withTempRoot(async (root) => {
      await mkdir(path.join(root, "workspace", "shared", "sandbox-results", "old-run"), {
        recursive: true,
      });
      await writeFile(path.join(root, "workspace", "shared", "input.txt"), "source\n", "utf8");
      await writeFile(
        path.join(root, "workspace", "shared", "sandbox-results", "old-run", "artifact.txt"),
        "old artifact\n",
        "utf8",
      );

      const docker = new FakeDockerOperations();
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "session-with-old-output",
      });

      await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
      });

      const workspaceMount = getWorkspaceMount(docker);
      expect(
        await readFile(
          path.join(workspaceMount.source, "workspace", "shared", "input.txt"),
          "utf8",
        ),
      ).toBe("source\n");
      await expect(
        readFile(
          path.join(
            workspaceMount.source,
            "workspace",
            "shared",
            "sandbox-results",
            "old-run",
            "artifact.txt",
          ),
          "utf8",
        ),
      ).rejects.toThrow();
    });
  });

  it("fails successful executions that exceed the sandbox disk policy", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.usageSnapshots = [
        {
          diskWrittenMb: 0,
        },
        {
          diskWrittenMb: 8,
        },
      ];
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "disk-limit-1",
      });

      const result = await plugin.run({
        runtime: "bash",
        command: "printf oversized",
        policy: {
          resources: {
            diskMb: 4,
          },
        },
      });

      expect(result.status).toBe("failed");
      expect(result.stderr.toLowerCase()).toContain("no space");
      expect(result.resourceUsage).toEqual(
        expect.objectContaining({
          diskWrittenMb: 8,
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
      expect(getOutputMount(docker).sizeMb).toBe(32);
      expectCopiedSandboxOutput(docker, "container-ephemeral-1");
      expect(docker.stopped).toEqual([
        { containerId: "container-ephemeral-1", graceMs: undefined },
      ]);
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
            GENERIC_AI_PROXY_CONFIG: expect.stringContaining(
              "/generic-ai-network-proxy/config.json",
            ),
          }),
          readOnlyRootfs: true,
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
      expect(
        docker.execCalls.some(
          (call) =>
            call.containerId === "container-allowlist-1-allowlist-proxy" &&
            call.signal !== undefined,
        ),
      ).toBe(true);

      await plugin.destroy(session.sessionId);

      expect(docker.removed).toEqual(
        expect.arrayContaining(["container-allowlist-1", "container-allowlist-1-allowlist-proxy"]),
      );
      expect(docker.removedNetworks).toEqual([
        `${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-allowlist-1`,
      ]);
    });
  });

  it("surfaces blocked allowlist destinations in stderr", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
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
      docker.execResult = {
        exitCode: 1,
        stdout: "",
        stderr: "proxy denied\n",
      };

      const proxyCreate = docker.created[0];
      if (proxyCreate?.mounts === undefined) {
        throw new Error("Expected allowlist proxy mounts.");
      }
      const logMount = proxyCreate.mounts.find(
        (mount): mount is Extract<(typeof proxyCreate.mounts)[number], { source: string }> =>
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

      await writeFile(
        path.join(logMount.source, "blocked.log"),
        [
          "2026-04-16T10:00:00.000Z openai.com:443 blocked-connect",
          "2026-04-16T10:00:01.000Z example.org:443 blocked-connect",
          "",
        ].join("\n"),
        "utf8",
      );

      const nextResult = await plugin.exec({
        sessionId: session.sessionId,
        command: "python -c \"print('still nope')\"",
      });

      expect(nextResult.stderr).not.toContain("openai.com:443");
      expect(nextResult.stderr).toContain("example.org:443");
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
      expect(
        await readFile(
          path.join(workspaceMount.source, "workspace", "shared", "source.txt"),
          "utf8",
        ),
      ).toBe("seed\n");
      await expect(
        readFile(path.join(workspaceMount.source, "workspace", "shared", "ignored.txt"), "utf8"),
      ).rejects.toThrow();

      docker.execHandler = async () => {
        await mkdir(path.join(workspaceMount.source, "reports"), { recursive: true });
        await writeFile(
          path.join(workspaceMount.source, "reports", "summary.txt"),
          "copied\n",
          "utf8",
        );
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
      const outsideRoot = await mkdtemp(
        path.join(os.tmpdir(), "plugin-tools-terminal-sandbox-outside-"),
      );
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
        ).rejects.toThrow(/symbolic link|escapes the workspace root/i);
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("blocks copy-mode symlinks even when they target inside the workspace root", async () => {
    await withTempRoot(async (root) => {
      await mkdir(path.join(root, "target"), { recursive: true });
      await writeFile(path.join(root, "target", "source.txt"), "safe\n", "utf8");
      try {
        await symlink(path.join(root, "target", "source.txt"), path.join(root, "alias.txt"));
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
              copyInPaths: ["alias.txt"],
            },
          },
        }),
      ).rejects.toThrow(/symbolic link/i);
    });
  });

  it.each([
    {
      label: "copyIn parent traversal",
      buildPolicy: (_root: string) => ({
        files: {
          mode: "copy" as const,
          copyInPaths: ["../escape.txt"],
        },
      }),
    },
    {
      label: "copyIn absolute path",
      buildPolicy: (root: string) => ({
        files: {
          mode: "copy" as const,
          copyInPaths: [path.join(root, "workspace", "shared", "source.txt")],
        },
      }),
    },
    {
      label: "copyIn Windows drive path",
      buildPolicy: (_root: string) => ({
        files: {
          mode: "copy" as const,
          copyInPaths: ["C:\\Users\\neill\\workspace\\secret.txt"],
        },
      }),
    },
    {
      label: "copyIn Windows UNC path",
      buildPolicy: (_root: string) => ({
        files: {
          mode: "copy" as const,
          copyInPaths: ["\\\\server\\share\\secret.txt"],
        },
      }),
    },
    {
      label: "copyOut parent traversal",
      buildPolicy: (_root: string) => ({
        files: {
          mode: "copy" as const,
          copyInPaths: ["workspace/shared/source.txt"],
          copyOutPaths: ["../allowlist-proxy/config.json"],
        },
      }),
    },
    {
      label: "copyOut absolute path",
      buildPolicy: (root: string) => ({
        files: {
          mode: "copy" as const,
          copyInPaths: ["workspace/shared/source.txt"],
          copyOutPaths: [path.join(root, "outside.txt")],
        },
      }),
    },
    {
      label: "outputDir parent traversal",
      buildPolicy: (_root: string) => ({
        files: {
          mode: "readonly-mount" as const,
          outputDir: path.join("..", "outside"),
        },
      }),
    },
  ])("rejects $label escape attempts", async ({ buildPolicy }) => {
    await withTempRoot(async (root) => {
      await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
      await writeFile(path.join(root, "workspace", "shared", "source.txt"), "seed\n", "utf8");

      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: new FakeDockerOperations(),
      });

      await expect(
        plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
          policy: buildPolicy(root),
        }),
      ).rejects.toThrow(
        /workspace-relative|escapes the workspace root|Windows drive|Windows UNC|Workspace path/i,
      );
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

  it("returns an unavailable SandboxExecutionResult when Docker drops during exec", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.execHandler = async () => {
        throw new SandboxUnavailableError("Docker daemon became unavailable.");
      };

      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "unavailable-1",
      });
      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
      });

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "echo hello",
      });

      expect(result.status).toBe("unavailable");
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain("Docker daemon became unavailable");
      expect(result.unrestrictedLocal).toBe(false);
    });
  });

  it("does not mask non-daemon artifact sync failures", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.copyHandler = async () => {
        throw new SandboxArtifactSyncError(
          "artifact sync failed because the output mount is missing.",
        );
      };
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "artifact-copy-fail-1",
      });
      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
      });

      await expect(
        plugin.exec({
          sessionId: session.sessionId,
          command: "true",
        }),
      ).rejects.toBeInstanceOf(SandboxArtifactSyncError);
    });
  });

  it("continues without artifacts when Docker becomes unavailable during artifact sync", async () => {
    await withTempRoot(async (root) => {
      const docker = new FakeDockerOperations();
      docker.copyHandler = async () => {
        throw new SandboxUnavailableError("Docker daemon became unavailable during artifact sync.");
      };
      const plugin = createSandboxTerminalPlugin({
        root,
        dockerOperations: docker,
        sessionIdFactory: () => "artifact-unavailable-1",
      });
      const session = await plugin.createSession({
        runtime: "bash",
        workspaceRoot: root,
      });

      const result = await plugin.exec({
        sessionId: session.sessionId,
        command: "true",
      });

      expect(result.status).toBe("succeeded");
      expect(result.artifacts).toEqual([]);
    });
  });

  it("can probe Docker CLI availability without crashing when the daemon is down", async () => {
    const docker = createDockerCliSandboxOperations();
    await expect(docker.isAvailable()).resolves.toBeTypeOf("boolean");
  });

  liveIt(
    "runs real Python and Node commands and cleans up their sandbox resources",
    async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({ root });

        const pythonResult = await plugin.run({
          sessionId: "integration-python-live",
          runtime: "python",
          command: "python -c \"print('sandbox-python-ok')\"",
        });
        expect(pythonResult.status).toBe("succeeded");
        expect(pythonResult.stdout).toContain("sandbox-python-ok");

        const nodeResult = await plugin.run({
          sessionId: "integration-node-live",
          runtime: "node",
          command: "node -e \"console.log('sandbox-node-ok')\"",
        });
        expect(nodeResult.status).toBe("succeeded");
        expect(nodeResult.stdout).toContain("sandbox-node-ok");

        expect(plugin.listSessions()).toHaveLength(0);
        await expectNoSandboxDockerResources("integration-python-live");
        await expectNoSandboxDockerResources("integration-node-live");
      });
    },
    60_000,
  );

  liveIt(
    "enforces resource stress commands with structured failures and cleanup",
    async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({ root });
        const stressRuns = [
          {
            sessionId: "resource-memory-live",
            runtime: "python" as const,
            command:
              'python -c "chunks=[]\nwhile True:\n chunks.append(bytearray(8 * 1024 * 1024))"',
            policy: {
              resources: {
                memoryMb: 48,
                timeoutMs: 10_000,
              },
            },
            assertResult(result: Awaited<ReturnType<typeof plugin.run>>) {
              expect(result.status).toBe("oom");
              expect(result.stderr).toMatch(/memory limit|memoryMb|killed/i);
            },
          },
          {
            sessionId: "resource-cpu-live",
            runtime: "python" as const,
            command: 'python -c "while True: pass"',
            policy: {
              resources: {
                timeoutMs: 100,
                timeoutGraceMs: 100,
              },
            },
            assertResult(result: Awaited<ReturnType<typeof plugin.run>>) {
              expect(result.status).toBe("timed_out");
              expect(result.stderr).toMatch(/timed out/i);
            },
          },
          {
            sessionId: "resource-fork-live",
            runtime: "bash" as const,
            command: "i=0; while [ $i -lt 32 ]; do sh -c 'sleep 60' & i=$((i+1)); done; wait",
            policy: {
              resources: {
                timeoutMs: 250,
                timeoutGraceMs: 250,
              },
            },
            assertResult(result: Awaited<ReturnType<typeof plugin.run>>) {
              expect(result.status).toBe("timed_out");
              expect(result.stderr).toMatch(/timed out/i);
            },
          },
          {
            sessionId: "resource-disk-live",
            runtime: "bash" as const,
            command:
              'dd if=/dev/zero of="$GENERIC_AI_SANDBOX_OUTPUT_DIR/fill.bin" bs=1M count=32 status=none',
            policy: {
              resources: {
                diskMb: 4,
                timeoutMs: 10_000,
              },
            },
            assertResult(result: Awaited<ReturnType<typeof plugin.run>>) {
              expect(result.status).toBe("failed");
              expect(result.stderr.toLowerCase()).toContain("no space");
            },
          },
        ];

        for (const stressRun of stressRuns) {
          const result = await plugin.run({
            sessionId: stressRun.sessionId,
            runtime: stressRun.runtime,
            command: stressRun.command,
            policy: stressRun.policy,
          });
          stressRun.assertResult(result);
          await expectNoSandboxDockerResources(stressRun.sessionId);
        }
      });
    },
    90_000,
  );

  liveIt(
    "enforces isolated, allowlist, and open network modes in live Docker runs",
    async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({ root });
        const pythonFetch = (url: string) =>
          `python -c "import urllib.request; print(urllib.request.urlopen('${url}', timeout=10).status)"`;
        const allowedUrl = "https://example.com";
        const blockedUrl = "https://example.org";

        const isolatedResult = await plugin.run({
          sessionId: "network-isolated-live",
          runtime: "python",
          command: pythonFetch(allowedUrl),
          policy: {
            network: {
              mode: "isolated",
            },
          },
        });
        expect(isolatedResult.status).toBe("failed");
        await expectNoSandboxDockerResources("network-isolated-live");

        const allowlistedResult = await plugin.run({
          sessionId: "network-allowlist-pass-live",
          runtime: "python",
          command: pythonFetch(allowedUrl),
          policy: {
            network: {
              mode: "allowlist",
              allowlist: ["example.com"],
            },
          },
        });
        expect(allowlistedResult.status).toBe("succeeded");
        expect(allowlistedResult.stdout).toContain("200");
        await expectNoSandboxDockerResources("network-allowlist-pass-live", { allowlist: true });

        const blockedAllowlistResult = await plugin.run({
          sessionId: "network-allowlist-block-live",
          runtime: "python",
          command: pythonFetch(blockedUrl),
          policy: {
            network: {
              mode: "allowlist",
              allowlist: ["example.com"],
            },
          },
        });
        expect(blockedAllowlistResult.status).toBe("failed");
        expect(blockedAllowlistResult.stderr).toContain("example.org:443");
        await expectNoSandboxDockerResources("network-allowlist-block-live", { allowlist: true });

        const openResult = await plugin.run({
          sessionId: "network-open-live",
          runtime: "python",
          command: pythonFetch(allowedUrl),
          policy: {
            network: {
              mode: "open",
            },
          },
        });
        expect(openResult.status).toBe("succeeded");
        expect(openResult.stdout).toContain("200");
        await expectNoSandboxDockerResources("network-open-live");
      });
    },
    90_000,
  );

  liveIt(
    "reads staged workspace files, extracts output artifacts, and rejects writes to the readonly mount",
    async () => {
      await withTempRoot(async (root) => {
        await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
        await writeFile(
          path.join(root, "workspace", "shared", "note.txt"),
          "sandbox-input\n",
          "utf8",
        );

        const plugin = createSandboxTerminalPlugin({ root });
        const result = await plugin.run({
          sessionId: "integration-readonly-live",
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
        await expectNoSandboxDockerResources("integration-readonly-live");
      });
    },
    60_000,
  );

  liveIt(
    "runs three sandboxes concurrently without interference and leaves no orphaned resources",
    async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({ root });
        const runs = [
          { sessionId: "parallel-live-1", label: "alpha" },
          { sessionId: "parallel-live-2", label: "beta" },
          { sessionId: "parallel-live-3", label: "gamma" },
        ];

        const results = await Promise.all(
          runs.map(({ sessionId, label }) =>
            plugin.run({
              sessionId,
              runtime: "node",
              command: `node -e "const fs = require('node:fs'); const dir = process.env.GENERIC_AI_SANDBOX_OUTPUT_DIR; fs.writeFileSync(dir + '/${label}.txt', '${label}\\n', 'utf8'); console.log('${label}');"`,
            }),
          ),
        );

        expect(results.map((result) => result.status)).toEqual([
          "succeeded",
          "succeeded",
          "succeeded",
        ]);
        expect(results.map((result) => result.stdout.trim()).sort()).toEqual([
          "alpha",
          "beta",
          "gamma",
        ]);

        for (const { sessionId, label } of runs) {
          const artifactPath = path.join(
            root,
            "workspace",
            "shared",
            "sandbox-results",
            sessionId,
            `${label}.txt`,
          );
          expect(await readFile(artifactPath, "utf8")).toBe(`${label}\n`);
          await expectNoSandboxDockerResources(sessionId);
        }

        expect(plugin.listSessions()).toHaveLength(0);
      });
    },
    90_000,
  );

  describe("validateSessionId", () => {
    it("accepts the Docker-safe character set", () => {
      expect(() => validateSessionId("abc-123_XYZ")).not.toThrow();
      expect(() => validateSessionId("0")).not.toThrow();
      expect(() => validateSessionId("a".repeat(63))).not.toThrow();
    });

    it("rejects empty, path-separated, non-ASCII, or over-long ids", () => {
      expect(() => validateSessionId("")).toThrow(SandboxConfigurationError);
      expect(() => validateSessionId("foo/bar")).toThrow(SandboxConfigurationError);
      expect(() => validateSessionId("foo\\bar")).toThrow(SandboxConfigurationError);
      expect(() => validateSessionId("-leading-dash")).toThrow(SandboxConfigurationError);
      expect(() => validateSessionId("..")).toThrow(SandboxConfigurationError);
      expect(() => validateSessionId("a".repeat(64))).toThrow(SandboxConfigurationError);
      expect(() => validateSessionId("sesión")).toThrow(SandboxConfigurationError);
    });
  });

  describe("P1 hardening", () => {
    it("rejects caller-supplied session ids containing path separators", async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: new FakeDockerOperations(),
        });

        await expect(
          plugin.createSession({
            runtime: "bash",
            workspaceRoot: root,
            sessionId: "path/with/separator",
          }),
        ).rejects.toBeInstanceOf(SandboxConfigurationError);
      });
    });

    it("throws SandboxSessionConflictError when creating a duplicate session id", async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: new FakeDockerOperations(),
          sessionIdFactory: () => "duplicate-test",
        });

        await plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
          sessionId: "duplicate-test",
        });

        await expect(
          plugin.createSession({
            runtime: "bash",
            workspaceRoot: root,
            sessionId: "duplicate-test",
          }),
        ).rejects.toBeInstanceOf(SandboxSessionConflictError);
      });
    });

    it("treats run() as an ephemeral create→exec→destroy even when sessionId is provided", async () => {
      await withTempRoot(async (root) => {
        const docker = new FakeDockerOperations();
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: docker,
          sessionIdFactory: () => "unused",
        });

        const result = await plugin.run({
          runtime: "bash",
          command: "true",
          sessionId: "ephemeral-supplied",
        });

        expect(result.status).toBe("succeeded");
        expect(docker.created[0]?.sessionId).toBe("ephemeral-supplied");
        expect(docker.removed).toContain("container-ephemeral-supplied");
        expect(plugin.listSessions()).toHaveLength(0);
      });
    });

    it("run() with a colliding sessionId surfaces SandboxSessionConflictError", async () => {
      await withTempRoot(async (root) => {
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: new FakeDockerOperations(),
        });

        await plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
          sessionId: "busy",
        });

        await expect(
          plugin.run({ runtime: "bash", command: "true", sessionId: "busy" }),
        ).rejects.toBeInstanceOf(SandboxSessionConflictError);
      });
    });

    it("run() without a sessionId creates and destroys an ephemeral session", async () => {
      await withTempRoot(async (root) => {
        const docker = new FakeDockerOperations();
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: docker,
          sessionIdFactory: () => "auto-ephemeral",
        });

        const result = await plugin.run({
          runtime: "bash",
          command: "echo hi",
        });

        expect(result.status).toBe("succeeded");
        expect(docker.created[0]?.sessionId).toBe("auto-ephemeral");
        expect(docker.removed).toContain("container-auto-ephemeral");
        expect(plugin.listSessions()).toHaveLength(0);
      });
    });

    it("short-circuits exec when the caller signal is already aborted without invoking docker.exec", async () => {
      await withTempRoot(async (root) => {
        const docker = new FakeDockerOperations();
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: docker,
          sessionIdFactory: () => "aborted-1",
        });

        const session = await plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
        });

        const abortController = new AbortController();
        abortController.abort();

        const result = await plugin.exec({
          sessionId: session.sessionId,
          command: "echo hi",
          signal: abortController.signal,
        });

        expect(result.status).toBe("signaled");
        expect(result.stderr).toContain("aborted");
        expect(docker.execCalls).toHaveLength(0);
      });
    });

    it("forwards the caller signal into docker.exec", async () => {
      await withTempRoot(async (root) => {
        const docker = new FakeDockerOperations();
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: docker,
          sessionIdFactory: () => "signal-forward-1",
        });

        const session = await plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
        });

        const abortController = new AbortController();
        await plugin.exec({
          sessionId: session.sessionId,
          command: "true",
          signal: abortController.signal,
        });

        const userExecCall = docker.execCalls.find((call) => call.command === "true");
        expect(userExecCall?.signal).toBeDefined();
      });
    });

    it('file mode "none" does not bind-mount the workspace and backs /workspace with a tmpfs', async () => {
      await withTempRoot(async (root) => {
        await writeFile(path.join(root, "secret.txt"), "sekret\n", "utf8");
        const docker = new FakeDockerOperations();
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: docker,
          sessionIdFactory: () => "no-mount-1",
        });

        await plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
          policy: {
            files: {
              mode: "none",
            },
          },
        });

        const mounts = docker.created[0]?.mounts ?? [];
        const workspaceBindMount = mounts.find(
          (mount): mount is Extract<(typeof mounts)[number], { source: string }> =>
            "source" in mount && mount.target === SANDBOX_WORKSPACE_MOUNT_PATH,
        );
        expect(workspaceBindMount).toBeUndefined();

        const workspaceTmpfsMount = mounts.find(
          (mount): mount is Extract<(typeof mounts)[number], { type: "tmpfs" }> =>
            "type" in mount &&
            mount.type === "tmpfs" &&
            mount.target === SANDBOX_WORKSPACE_MOUNT_PATH,
        );
        expect(workspaceTmpfsMount).toBeDefined();
      });
    });

    it('file mode "readonly-mount" bind-mounts the staging dir read-only', async () => {
      await withTempRoot(async (root) => {
        const docker = new FakeDockerOperations();
        const plugin = createSandboxTerminalPlugin({
          root,
          dockerOperations: docker,
          sessionIdFactory: () => "ro-mount-1",
        });

        await plugin.createSession({
          runtime: "bash",
          workspaceRoot: root,
        });

        const workspaceMount = getWorkspaceMount(docker);
        expect(workspaceMount.readOnly).toBe(true);
      });
    });

    it("refuses to copy symlinks out of the staging area", async () => {
      await withTempRoot(async (root) => {
        const outsideRoot = await mkdtemp(
          path.join(os.tmpdir(), "plugin-tools-terminal-sandbox-outside-"),
        );
        try {
          await writeFile(path.join(outsideRoot, "secret.txt"), "secret\n", "utf8");
          await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
          await writeFile(path.join(root, "workspace", "shared", "source.txt"), "seed\n", "utf8");

          const docker = new FakeDockerOperations();
          const plugin = createSandboxTerminalPlugin({
            root,
            dockerOperations: docker,
            sessionIdFactory: () => "symlink-copy-1",
          });

          const session = await plugin.createSession({
            runtime: "bash",
            workspaceRoot: root,
            policy: {
              files: {
                mode: "copy",
                copyInPaths: ["workspace/shared/source.txt"],
                copyOutPaths: ["leak"],
              },
            },
          });

          const workspaceMount = getWorkspaceMount(docker);
          try {
            await symlink(
              path.join(outsideRoot, "secret.txt"),
              path.join(workspaceMount.source, "leak"),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") {
              return; // Windows without symlink privilege
            }
            throw error;
          }

          await expect(
            plugin.exec({
              sessionId: session.sessionId,
              command: "true",
            }),
          ).rejects.toBeInstanceOf(SandboxConfigurationError);
        } finally {
          await rm(outsideRoot, { recursive: true, force: true });
        }
      });
    });

    it("runProcess-backed Docker probe returns a boolean even when the binary is missing", async () => {
      const docker = createDockerCliSandboxOperations("generic-ai-missing-docker-binary");
      await expect(docker.isAvailable()).resolves.toBe(false);
    });
  });
});
