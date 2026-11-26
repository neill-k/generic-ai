import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

describe("agent-facing file tools stay inside the workspace", () => {
  type PiTool = {
    readonly name: string;
    execute(id: string, params: Record<string, unknown>): Promise<{ content: unknown }>;
  };
  const tool = (files: ReturnType<typeof createWorkspaceFileTools>, toolName: string) => {
    const found = (files.piTools as readonly unknown[]).find(
      (candidate) => (candidate as PiTool).name === toolName,
    );
    if (found === undefined) throw new Error(`no ${toolName} tool`);
    return found as PiTool;
  };
  const text = (result: { content: unknown }) => JSON.stringify(result.content);

  async function withOutside<T>(run: (root: string, outside: string) => Promise<T>): Promise<T> {
    return withTempRoot(async (root) => {
      const outside = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-files-outside-"));
      tempRoots.push(outside);
      await writeFile(path.join(outside, "server-secret.txt"), "server-only-value\n");
      const home = path.join(root, "agent");
      await mkdir(home);
      return run(home, outside);
    });
  }

  it("refuses absolute paths outside the workspace for every tool", async () => {
    await withOutside(async (home, outside) => {
      const files = createWorkspaceFileTools({ root: home });
      const secret = path.join(outside, "server-secret.txt");
      await expect(tool(files, "read").execute("1", { path: secret })).rejects.toThrow(
        /outside the agent's workspace/,
      );
      await expect(
        tool(files, "read").execute("1", { path: "/proc/self/environ" }),
      ).rejects.toThrow(/outside the agent's workspace/);
      await expect(
        tool(files, "write").execute("1", {
          path: path.join(outside, "planted.txt"),
          content: "x",
        }),
      ).rejects.toThrow(/outside the agent's workspace/);
      await expect(
        tool(files, "edit").execute("1", {
          path: secret,
          edits: [{ oldText: "server", newText: "agent" }],
        }),
      ).rejects.toThrow(/outside the agent's workspace/);
      for (const name of ["ls", "find", "grep"]) {
        const params = name === "ls" ? { path: outside } : { pattern: "server", path: outside };
        await expect(tool(files, name).execute("1", params)).rejects.toThrow(
          /outside the agent's workspace/,
        );
      }
      await expect(tool(files, "read").execute("1", { path: "../../etc/passwd" })).rejects.toThrow(
        /outside the agent's workspace/,
      );
      expect(await readFile(secret, "utf8")).toBe("server-only-value\n");
    });
  });

  it("refuses symlinks that point outside the workspace", async () => {
    await withOutside(async (home, outside) => {
      const files = createWorkspaceFileTools({ root: home });
      await symlink(path.join(outside, "server-secret.txt"), path.join(home, "link.txt"));
      await symlink(outside, path.join(home, "linked-dir"));
      await expect(tool(files, "read").execute("1", { path: "link.txt" })).rejects.toThrow(
        /outside the agent's workspace/,
      );
      await expect(
        tool(files, "write").execute("1", { path: "linked-dir/planted.txt", content: "x" }),
      ).rejects.toThrow(/outside the agent's workspace/);
      await expect(tool(files, "ls").execute("1", { path: "linked-dir" })).rejects.toThrow(
        /outside the agent's workspace/,
      );
    });
  });

  it("still works on relative and absolute paths inside the workspace", async () => {
    await withOutside(async (home) => {
      const files = createWorkspaceFileTools({ root: home });
      await tool(files, "write").execute("1", { path: "notes/a.md", content: "inside value\n" });
      expect(text(await tool(files, "read").execute("1", { path: "notes/a.md" }))).toContain(
        "inside value",
      );
      expect(
        text(await tool(files, "read").execute("1", { path: path.join(home, "notes", "a.md") })),
      ).toContain("inside value");
      expect(text(await tool(files, "ls").execute("1", {}))).toContain("notes");
      expect(text(await tool(files, "grep").execute("1", { pattern: "inside" }))).toContain("a.md");
    });
  });
});
