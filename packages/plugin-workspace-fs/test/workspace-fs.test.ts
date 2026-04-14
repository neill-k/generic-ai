import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceFs,
  createWorkspaceLayout,
  ensureAgentWorkspaceStructure,
  ensureRecommendedWorkspaceStructure,
  resolveWorkspacePath,
} from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-workspace-fs-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

async function expectDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  expect(info.isDirectory()).toBe(true);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-workspace-fs", () => {
  it("builds the canonical layout from a file URL root", async () => {
    await withTempRoot(async (root) => {
      const layout = createWorkspaceLayout(pathToFileURL(root));

      expect(layout).toEqual({
        root,
        framework: path.join(root, ".generic-ai"),
        agents: path.join(root, ".generic-ai", "agents"),
        plugins: path.join(root, ".generic-ai", "plugins"),
        skills: path.join(root, ".agents", "skills"),
        workspace: path.join(root, "workspace"),
        workspaceAgents: path.join(root, "workspace", "agents"),
        shared: path.join(root, "workspace", "shared"),
      });
    });
  });

  it("keeps resolved paths inside the workspace root", async () => {
    await withTempRoot(async (root) => {
      const workspace = createWorkspaceFs(root);

      expect(workspace.resolvePath("workspace", "shared", "notes.md")).toBe(
        path.join(root, "workspace", "shared", "notes.md"),
      );
      expect(resolveWorkspacePath(root, "workspace", "agents")).toBe(path.join(root, "workspace", "agents"));
      expect(() => workspace.resolvePath("..", "outside")).toThrow(/escapes the workspace root/i);
      expect(() => workspace.createAgentWorkspaceLayout("../escape")).toThrow(/single relative path segment/i);
    });
  });

  it("ensures the recommended workspace tree on disk", async () => {
    await withTempRoot(async (root) => {
      const layout = await ensureRecommendedWorkspaceStructure(root);

      await expectDirectory(layout.framework);
      await expectDirectory(layout.agents);
      await expectDirectory(layout.plugins);
      await expectDirectory(layout.skills);
      await expectDirectory(layout.workspace);
      await expectDirectory(layout.workspaceAgents);
      await expectDirectory(layout.shared);
    });
  });

  it("creates an agent workspace with memory and results directories", async () => {
    await withTempRoot(async (root) => {
      const agentLayout = await ensureAgentWorkspaceStructure(root, "primary");

      await expectDirectory(agentLayout.root);
      await expectDirectory(agentLayout.memory);
      await expectDirectory(agentLayout.results);

      const entries = await readdir(agentLayout.root);
      expect(entries.sort()).toEqual(["memory", "results"]);
    });
  });
});
