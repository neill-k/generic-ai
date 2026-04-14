import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentSkillsPlugin } from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string, userDir: string, globalDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-agent-skills-"));
  tempRoots.push(root);

  const userDir = path.join(root, "user-skills");
  const globalDir = path.join(root, "global-skills");

  try {
    await mkdir(userDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });
    return await run(root, userDir, globalDir);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(directory, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

Use this skill when ${description}.`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-agent-skills", () => {
  it("loads project, user, and global skills with deterministic precedence", async () => {
    await withTempRoot(async (root, userDir, globalDir) => {
      await writeSkill(path.join(root, ".agents", "skills"), "shared-skill", "project wins");
      await writeSkill(userDir, "shared-skill", "user loses");
      await writeSkill(globalDir, "global-only", "global fallback");

      const plugin = createAgentSkillsPlugin({
        root,
        userDir,
        globalDir,
      });
      const snapshot = await plugin.load();

      expect(snapshot.sources.map((source) => source.kind)).toEqual(["project", "user", "global"]);
      expect(snapshot.skills.map((skill) => skill.name)).toEqual(["shared-skill", "global-only"]);
      expect(snapshot.skills[0]?.description).toBe("project wins");
      expect(snapshot.prompt).toContain("shared-skill");
      expect(snapshot.prompt).toContain("global-only");
    });
  });
});
