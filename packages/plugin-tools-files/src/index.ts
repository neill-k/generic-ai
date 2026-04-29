import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  withAgentHarnessToolEffects,
  type WorkspaceEntry,
} from "@generic-ai/sdk";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@generic-ai/sdk/pi";
import {
  createWorkspaceFs,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";

export const name = "@generic-ai/plugin-tools-files" as const;
export const kind = "tools-files" as const;

export interface FileEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface FileEditResult {
  readonly path: string;
  readonly content: string;
  readonly changes: number;
}

export interface FileFindOptions {
  readonly path?: string;
  readonly limit?: number;
}

export interface FileGrepOptions extends FileFindOptions {
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly literal?: boolean;
  readonly context?: number;
}

export interface FileGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface WorkspaceFileToolsOptions {
  readonly root: WorkspaceRootInput;
}

export interface WorkspaceFileTools {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly piTools: readonly (
    | ReturnType<typeof createReadTool>
    | ReturnType<typeof createWriteTool>
    | ReturnType<typeof createEditTool>
    | ReturnType<typeof createFindTool>
    | ReturnType<typeof createGrepTool>
    | ReturnType<typeof createLsTool>
  )[];
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, content: string): Promise<void>;
  editText(filePath: string, edits: readonly FileEdit[]): Promise<FileEditResult>;
  list(directoryPath?: string): Promise<readonly WorkspaceEntry[]>;
  find(pattern: string, options?: FileFindOptions): Promise<readonly string[]>;
  grep(pattern: string, options?: FileGrepOptions): Promise<readonly FileGrepMatch[]>;
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative === "" ? "." : relative.replaceAll("\\", "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createGlobMatcher(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  const expression = normalized
    .split("*")
    .map((segment) => segment.split("?").map(escapeRegex).join("."))
    .join(".*");

  return new RegExp(`^${expression}$`, "i");
}

function matchesPattern(candidate: string, pattern: string): boolean {
  const normalizedCandidate = candidate.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/").trim();

  if (normalizedPattern.length === 0) {
    return false;
  }

  if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
    return createGlobMatcher(normalizedPattern).test(normalizedCandidate);
  }

  const lowercasePattern = normalizedPattern.toLowerCase();
  return (
    normalizedCandidate.toLowerCase().includes(lowercasePattern) ||
    path.basename(normalizedCandidate).toLowerCase().includes(lowercasePattern)
  );
}

async function walkFiles(absolutePath: string): Promise<string[]> {
  // Use lstat so a symlinked root is not silently followed. Callers should
  // already have validated the path via resolveSafeWorkspacePath, but we
  // defensively skip symlinked entries during recursion as well.
  const info = await lstat(absolutePath);

  if (info.isSymbolicLink()) {
    return [];
  }

  if (!info.isDirectory()) {
    return info.isFile() ? [absolutePath] : [];
  }

  const files: string[] = [];
  const entries = await readdir(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function toSearchExpression(pattern: string, options: FileGrepOptions): RegExp {
  const source = options.literal ? escapeRegex(pattern) : pattern;
  return new RegExp(source, options.ignoreCase ? "gi" : "g");
}

export function createWorkspaceFileTools(options: WorkspaceFileToolsOptions): WorkspaceFileTools {
  const workspace = createWorkspaceFs(options.root);
  const piTools = Object.freeze([
    withAgentHarnessToolEffects(createReadTool(workspace.root), {
      id: "files.read",
      label: "Read file",
      effects: ["fs.read"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    }),
    withAgentHarnessToolEffects(createWriteTool(workspace.root), {
      id: "files.write",
      label: "Write file",
      effects: ["fs.write"],
      reversibility: "irreversible",
      retrySemantics: "retry-may-duplicate",
    }),
    withAgentHarnessToolEffects(createEditTool(workspace.root), {
      id: "files.edit",
      label: "Edit file",
      effects: ["fs.read", "fs.write"],
      reversibility: "reversible-with-cost",
      retrySemantics: "idempotency-key-required",
    }),
    withAgentHarnessToolEffects(createFindTool(workspace.root), {
      id: "files.find",
      label: "Find files",
      effects: ["fs.read"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    }),
    withAgentHarnessToolEffects(createGrepTool(workspace.root), {
      id: "files.grep",
      label: "Search file contents",
      effects: ["fs.read"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    }),
    withAgentHarnessToolEffects(createLsTool(workspace.root), {
      id: "files.list",
      label: "List files",
      effects: ["fs.read"],
      reversibility: "reversible-cheap",
      retrySemantics: "safe-to-retry",
    }),
  ]);

  async function resolveExistingPath(targetPath?: string): Promise<string> {
    return targetPath === undefined || targetPath.trim().length === 0
      ? resolveSafeWorkspacePath(workspace.root)
      : resolveSafeWorkspacePath(workspace.root, targetPath);
  }

  async function resolveWritablePath(filePath: string): Promise<string> {
    const absolutePath = await resolveSafeWorkspacePath(workspace.root, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    return resolveSafeWorkspacePath(workspace.root, filePath);
  }

  return Object.freeze({
    name,
    kind,
    root: workspace.root,
    piTools,
    async readText(filePath: string): Promise<string> {
      return readFile(await resolveSafeWorkspacePath(workspace.root, filePath), "utf8");
    },
    async writeText(filePath: string, content: string): Promise<void> {
      const absolutePath = await resolveWritablePath(filePath);
      await writeFile(absolutePath, content, "utf8");
    },
    async editText(filePath: string, edits: readonly FileEdit[]): Promise<FileEditResult> {
      const absolutePath = await resolveSafeWorkspacePath(workspace.root, filePath);
      let content = await readFile(absolutePath, "utf8");
      let changes = 0;

      for (const edit of edits) {
        const index = content.indexOf(edit.oldText);
        if (index === -1) {
          throw new Error(`Could not find the requested text in ${filePath}.`);
        }

        content = `${content.slice(0, index)}${edit.newText}${content.slice(index + edit.oldText.length)}`;
        changes += 1;
      }

      await writeFile(absolutePath, content, "utf8");

      return Object.freeze({
        path: normalizeRelativePath(workspace.root, absolutePath),
        content,
        changes,
      });
    },
    async list(directoryPath?: string): Promise<readonly WorkspaceEntry[]> {
      const absolutePath = await resolveExistingPath(directoryPath);
      const entries = await readdir(absolutePath, { withFileTypes: true });

      return entries.map((entry) => ({
        path: normalizeRelativePath(workspace.root, path.join(absolutePath, entry.name)),
        kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      }));
    },
    async find(pattern: string, searchOptions: FileFindOptions = {}): Promise<readonly string[]> {
      const absolutePath = await resolveExistingPath(searchOptions.path);
      const files = await walkFiles(absolutePath);
      const results: string[] = [];

      for (const filePath of files) {
        const relativePath = normalizeRelativePath(workspace.root, filePath);
        if (!matchesPattern(relativePath, pattern)) {
          continue;
        }

        results.push(relativePath);
        if (results.length >= (searchOptions.limit ?? 50)) {
          break;
        }
      }

      return results;
    },
    async grep(
      pattern: string,
      grepOptions: FileGrepOptions = {},
    ): Promise<readonly FileGrepMatch[]> {
      const absolutePath = await resolveExistingPath(grepOptions.path);
      const expression = toSearchExpression(pattern, grepOptions);
      const files = await walkFiles(absolutePath);
      const matches: FileGrepMatch[] = [];
      const context = grepOptions.context ?? 0;

      for (const filePath of files) {
        const relativePath = normalizeRelativePath(workspace.root, filePath);
        if (grepOptions.glob && !matchesPattern(relativePath, grepOptions.glob)) {
          continue;
        }

        const fileContents = await readFile(filePath, "utf8");
        const lines = fileContents.split(/\r?\n/);

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) {
            continue;
          }

          expression.lastIndex = 0;
          if (!expression.test(line)) {
            continue;
          }

          matches.push({
            path: relativePath,
            line: lineIndex + 1,
            text: line,
            before: lines.slice(Math.max(0, lineIndex - context), lineIndex),
            after: lines.slice(lineIndex + 1, lineIndex + 1 + context),
          });

          if (matches.length >= (grepOptions.limit ?? 50)) {
            return matches;
          }
        }
      }

      return matches;
    },
  });
}
