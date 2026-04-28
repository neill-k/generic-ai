import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceFileTools } from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-files-"));
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

describe("@generic-ai/plugin-tools-files", () => {
  it("reads, writes, edits, lists, finds, and greps files inside the workspace", async () => {
    await withTempRoot(async (root) => {
      const files = createWorkspaceFileTools({ root });

      await files.writeText("workspace/shared/notes.md", "# Notes\nhello world\nskills and MCP");
      await files.writeText("workspace/shared/todo.txt", "terminal tools\nmemory");

      expect(await files.readText("workspace/shared/notes.md")).toContain("hello world");

      const edit = await files.editText("workspace/shared/todo.txt", [
        {
          oldText: "memory",
          newText: "persistent memory",
        },
      ]);

      expect(edit.changes).toBe(1);
      expect(edit.content).toContain("persistent memory");

      const listed = await files.list("workspace/shared");
      expect(listed.map((entry) => entry.path).sort()).toEqual([
        "workspace/shared/notes.md",
        "workspace/shared/todo.txt",
      ]);

      expect(await files.find("*.md")).toEqual(["workspace/shared/notes.md"]);

      expect(await files.grep("hello", { path: "workspace/shared" })).toEqual([
        {
          path: "workspace/shared/notes.md",
          line: 2,
          text: "hello world",
          before: [],
          after: [],
        },
      ]);

      expect(files.piTools).toHaveLength(6);
    });
  });

  it("rejects writes through a symlinked parent before creating directories", async () => {
    await withTempRoot(async (root) => {
      const outside = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-files-outside-"));
      tempRoots.push(outside);
      const linkPath = path.join(root, "workspace", "escape");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(linkPath), { recursive: true });

      try {
        await symlink(outside, linkPath, "dir");
      } catch (error) {
        if (
          error instanceof Error &&
          ("code" in error ? error.code === "EPERM" || error.code === "EACCES" : false)
        ) {
          return;
        }
        throw error;
      }

      const files = createWorkspaceFileTools({ root });
      await expect(files.writeText("workspace/escape/nested/file.txt", "nope")).rejects.toThrow(
        /escapes the workspace root/i,
      );
      await expect(lstat(path.join(outside, "nested"))).rejects.toThrow();
    });
  });
});
