// Adapted from pi (badlogic/pi-mono, packages/coding-agent/test/resource-loader.test.ts and
// system-prompt.test.ts). Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
// pi's loader-level cases (DefaultResourceLoader, noContextFiles) are exercised here through
// loadProjectContextFiles directly; `stopAt` is a Generic AI addition.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatContextFilesForPrompt, loadProjectContextFiles } from "../src/context-files.js";

let tempDir: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "generic-ai-context-files-"));
  cwd = join(tempDir, "project");
  agentDir = join(tempDir, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadProjectContextFiles", () => {
  it("discovers AGENTS.md context files", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

    const files = loadProjectContextFiles({ cwd, agentDir });

    expect(files).toContainEqual({
      path: join(cwd, "AGENTS.md"),
      content: "# Project Guidelines\n\nBe helpful.",
    });
  });

  it("prefers AGENTS.override.md within each directory while preserving ancestor layering", () => {
    const nestedCwd = join(cwd, "service");
    mkdirSync(nestedCwd);
    writeFileSync(join(agentDir, "AGENTS.md"), "global instructions");
    writeFileSync(join(agentDir, "AGENTS.override.md"), "global override");
    writeFileSync(join(cwd, "AGENTS.md"), "project instructions");
    writeFileSync(join(nestedCwd, "AGENTS.md"), "service instructions");
    writeFileSync(join(nestedCwd, "AGENTS.override.md"), "service override");

    expect(loadProjectContextFiles({ cwd: nestedCwd, agentDir })).toEqual([
      { path: join(agentDir, "AGENTS.override.md"), content: "global override" },
      { path: join(cwd, "AGENTS.md"), content: "project instructions" },
      { path: join(nestedCwd, "AGENTS.override.md"), content: "service override" },
    ]);
  });

  it("ignores context file candidates that are directories", () => {
    mkdirSync(join(cwd, "AGENTS.override.md"));
    mkdirSync(join(cwd, "AGENTS.md"));
    writeFileSync(join(cwd, "CLAUDE.md"), "Fallback instructions");

    expect(loadProjectContextFiles({ cwd, agentDir })).toContainEqual({
      path: join(cwd, "CLAUDE.md"),
      content: "Fallback instructions",
    });
  });

  it("strips a byte-order mark", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "﻿instructions");

    expect(loadProjectContextFiles({ cwd, stopAt: cwd })).toEqual([
      { path: join(cwd, "AGENTS.md"), content: "instructions" },
    ]);
  });

  it("stops climbing at stopAt", () => {
    const leaf = join(cwd, "src");
    mkdirSync(leaf);
    writeFileSync(join(tempDir, "AGENTS.md"), "server instructions");
    writeFileSync(join(cwd, "AGENTS.md"), "workspace instructions");
    writeFileSync(join(leaf, "AGENTS.md"), "leaf instructions");

    const files = loadProjectContextFiles({ cwd: leaf, stopAt: cwd });

    expect(files.map((file) => file.content)).toEqual([
      "workspace instructions",
      "leaf instructions",
    ]);
  });

  it("works without a global agent directory", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "project instructions");

    expect(loadProjectContextFiles({ cwd, stopAt: cwd })).toEqual([
      { path: join(cwd, "AGENTS.md"), content: "project instructions" },
    ]);
  });
});

describe("loadProjectContextFiles - nested worktree dedup", () => {
  // A linked-worktree skeleton (no git binary needed): the main repo's `.git/worktrees/<name>/`
  // holds `HEAD` plus a `commondir` pointing back at the main `.git`, and the worktree carries a
  // `.git` file whose `gitdir:` resolves to it.
  const linkWorktree = (mainDir: string, worktreeDir: string, name: string) => {
    const gitDir = join(mainDir, ".git", "worktrees", name);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(mainDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feat\n");
    writeFileSync(join(gitDir, "commondir"), "../..");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
  };

  const setupNestedWorktree = () => {
    const outer = join(tempDir, "outer");
    const main = join(outer, "main");
    const worktree = join(main, "worktrees", "feat");
    const worktreeSrc = join(worktree, "src");
    mkdirSync(worktreeSrc, { recursive: true });
    linkWorktree(main, worktree, "feat");
    return { outer, main, worktree, worktreeSrc };
  };

  it("skips the main repo's duplicate when the worktree root has its own context", () => {
    const { main, worktree, worktreeSrc } = setupNestedWorktree();
    writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
    writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

    const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

    expect(files.map((f) => f.content)).toEqual(["worktree instructions"]);
  });

  it("loads the worktree's context once when it symlinks to the main repo's file", () => {
    const { main, worktree, worktreeSrc } = setupNestedWorktree();
    writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
    symlinkSync(join(main, "AGENTS.md"), join(worktree, "AGENTS.md"));

    const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

    expect(files.map((f) => f.path)).toEqual([join(worktree, "AGENTS.md")]);
  });

  it("skips the main repo's duplicate when the main repo's file is a symlink", () => {
    const { outer, main, worktree, worktreeSrc } = setupNestedWorktree();
    const shared = join(outer, "shared-agents.md");
    writeFileSync(shared, "shared instructions");
    symlinkSync(shared, join(main, "AGENTS.md"));
    symlinkSync(shared, join(worktree, "AGENTS.md"));

    const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

    expect(files.map((f) => f.path)).toEqual([join(worktree, "AGENTS.md")]);
  });

  it("still inherits the main repo's context when the worktree root has none", () => {
    const { main, worktreeSrc } = setupNestedWorktree();
    writeFileSync(join(main, "AGENTS.md"), "main repo instructions");

    const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

    expect(files.map((f) => f.content)).toEqual(["main repo instructions"]);
  });

  it("only skips the same filename, not a differently named context file", () => {
    const { main, worktree, worktreeSrc } = setupNestedWorktree();
    writeFileSync(join(main, "CLAUDE.md"), "main repo instructions");
    writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

    const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

    expect(files.map((f) => f.content)).toEqual([
      "main repo instructions",
      "worktree instructions",
    ]);
  });

  it("does not skip the container's context in a bare layout (proj/.bare + proj/main)", () => {
    const proj = join(tempDir, "proj");
    const bare = join(proj, ".bare");
    const worktree = join(proj, "main");
    const worktreeGitDir = join(bare, "worktrees", "main");
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(worktreeGitDir, "commondir"), "../..");
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(proj, "AGENTS.md"), "container instructions");
    writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

    const files = loadProjectContextFiles({ cwd: worktree, agentDir });

    expect(files.map((f) => f.content)).toEqual([
      "container instructions",
      "worktree instructions",
    ]);
  });

  it("keeps loading ancestors above the main repo", () => {
    const { outer, main, worktree, worktreeSrc } = setupNestedWorktree();
    writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
    writeFileSync(join(main, "AGENTS.md"), "main repo instructions");
    writeFileSync(join(worktree, "AGENTS.md"), "worktree instructions");

    const files = loadProjectContextFiles({ cwd: worktreeSrc, agentDir });

    expect(files.map((f) => f.content)).toEqual(["outer instructions", "worktree instructions"]);
  });

  it("does not skip anything for a sibling worktree (main repo is not an ancestor)", () => {
    const outer = join(tempDir, "outer");
    const main = join(outer, "main");
    const sib = join(outer, "sib-feat");
    const sibSrc = join(sib, "src");
    mkdirSync(sibSrc, { recursive: true });
    mkdirSync(main, { recursive: true });
    writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
    writeFileSync(join(sib, "AGENTS.md"), "sibling worktree instructions");
    linkWorktree(main, sib, "sib");

    const files = loadProjectContextFiles({ cwd: sibSrc, agentDir });

    expect(files.map((f) => f.content)).toEqual([
      "outer instructions",
      "sibling worktree instructions",
    ]);
  });

  it("does not skip the superproject's context from inside a submodule", () => {
    const sup = join(tempDir, "super");
    const sub = join(sup, "vendor", "lib");
    const subSrc = join(sub, "src");
    mkdirSync(subSrc, { recursive: true });
    writeFileSync(join(sup, "AGENTS.md"), "superproject instructions");
    writeFileSync(join(sub, "AGENTS.md"), "submodule instructions");
    const subGitDir = join(sup, ".git", "modules", "vendor", "lib");
    mkdirSync(subGitDir, { recursive: true });
    writeFileSync(join(subGitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(sub, ".git"), `gitdir: ${subGitDir}\n`);

    const files = loadProjectContextFiles({ cwd: subSrc, agentDir });

    expect(files.map((f) => f.content)).toEqual([
      "superproject instructions",
      "submodule instructions",
    ]);
  });

  it("keeps climbing past an ordinary repo root", () => {
    const outer = join(tempDir, "outer");
    const repo = join(outer, "repo");
    const leaf = join(repo, "src");
    mkdirSync(leaf, { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(outer, "AGENTS.md"), "outer instructions");
    writeFileSync(join(repo, "AGENTS.md"), "repo instructions");
    writeFileSync(join(leaf, "AGENTS.md"), "leaf instructions");

    const files = loadProjectContextFiles({ cwd: leaf, agentDir });

    expect(files.map((f) => f.content)).toEqual([
      "outer instructions",
      "repo instructions",
      "leaf instructions",
    ]);
  });
});

describe("formatContextFilesForPrompt", () => {
  it("renders project instructions in pi's format", () => {
    expect(
      formatContextFilesForPrompt([{ path: "/tmp/AGENTS.md", content: "Project instructions." }]),
    ).toBe(
      'Project-specific instructions and guidelines:\n\n<project_instructions path="/tmp/AGENTS.md">\nProject instructions.\n</project_instructions>',
    );
  });

  it("renders nothing for no files", () => {
    expect(formatContextFilesForPrompt([])).toBe("");
  });
});
