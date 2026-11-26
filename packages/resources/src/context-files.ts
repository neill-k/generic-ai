// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/resource-loader.ts,
// system-prompt.ts and footer-data-provider.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { stripBom } from "./frontmatter.js";

/** A project instructions file (`AGENTS.md` and friends) and its contents. */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
}

/** File names checked in each directory, first match wins. */
export const CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

export interface LoadProjectContextFilesOptions {
  /** Directory the agent works in. Context files are read from it and each of its ancestors. */
  readonly cwd: string;
  /** Global agent directory; its context file, if any, comes first. */
  readonly agentDir?: string;
  /**
   * Stop climbing at this directory (inclusive). Without it the walk goes to the filesystem root,
   * as pi does. Servers that run agents in a workspace set it to the workspace root so the
   * server's own instructions never reach the agent.
   */
  readonly stopAt?: string;
}

function loadContextFileFromDir(dir: string): ContextFile | null {
  for (const filename of CONTEXT_FILE_NAMES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      if (!statSync(filePath).isFile()) {
        continue;
      }
      return { path: filePath, content: stripBom(readFileSync(filePath, "utf-8")) };
    } catch {
      // An unreadable candidate is skipped like a missing one.
    }
  }
  return null;
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathsEqual(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function isPathWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

interface GitPaths {
  readonly repoDir: string;
  readonly commonGitDir: string;
}

function findGitPaths(cwd: string): GitPaths | null {
  let dir = cwd;
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            if (!existsSync(join(gitDir, "HEAD"))) return null;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir;
            return { repoDir: dir, commonGitDir };
          }
        } else if (stat.isDirectory()) {
          if (!existsSync(join(gitPath, "HEAD"))) return null;
          return { repoDir: dir, commonGitDir: gitPath };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both occupy the
 * same logical repository scope, so loading both applies that context twice. Returns undefined
 * when nothing is shadowed. Canonicalized, because git writes `gitdir:` targets in realpath form.
 */
function findShadowedContextFile(cwd: string): string | undefined {
  const gitPaths = findGitPaths(cwd);
  if (!gitPaths) return undefined;
  const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
  const worktreeRoot = canonicalizePath(gitPaths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);
  // False for an ordinary repo and for a sibling worktree, whose main repo is not an ancestor.
  if (!isPathWithin(mainRepoRoot, worktreeRoot) || pathsEqual(worktreeRoot, mainRepoRoot)) {
    return undefined;
  }
  // Only a main repo checked out from the same repo (not a bare layout or a submodule).
  if (!pathsEqual(canonicalizePath(join(mainRepoRoot, ".git")), commonGitDir)) return undefined;
  const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
  return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

/**
 * Load project instruction files: the global agent directory's first, then one per directory
 * from the outermost ancestor down to `cwd`. Each directory contributes its first match from
 * `CONTEXT_FILE_NAMES`, so `AGENTS.override.md` replaces that directory's `AGENTS.md`.
 */
export function loadProjectContextFiles(options: LoadProjectContextFilesOptions): ContextFile[] {
  const resolvedCwd = resolve(options.cwd);
  const stopAt = options.stopAt === undefined ? undefined : resolve(options.stopAt);
  const contextFiles: ContextFile[] = [];
  const seenPaths = new Set<string>();

  if (options.agentDir !== undefined) {
    const globalContext = loadContextFileFromDir(resolve(options.agentDir));
    if (globalContext) {
      contextFiles.push(globalContext);
      seenPaths.add(globalContext.path);
    }
  }

  const ancestorContextFiles: ContextFile[] = [];
  const shadowedContextFile = findShadowedContextFile(resolvedCwd);
  let currentDir = resolvedCwd;

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    // Compare the directory's real path, not the file's: a worktree AGENTS.md that symlinks to
    // the main repo's file resolves to the shadowed path itself.
    const isShadowed =
      shadowedContextFile !== undefined &&
      contextFile !== null &&
      pathsEqual(
        join(canonicalizePath(currentDir), basename(contextFile.path)),
        shadowedContextFile,
      );
    if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    if (stopAt !== undefined && pathsEqual(currentDir, stopAt)) break;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorContextFiles);
  return contextFiles;
}

/** Render context files as the system prompt's project context section, in pi's format. */
export function formatContextFilesForPrompt(contextFiles: readonly ContextFile[]): string {
  if (contextFiles.length === 0) {
    return "";
  }
  return [
    "Project-specific instructions and guidelines:",
    ...contextFiles.map(
      ({ path, content }) =>
        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
    ),
  ].join("\n\n");
}
