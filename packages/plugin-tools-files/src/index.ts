import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withAgentHarnessToolEffects, type WorkspaceEntry } from "@generic-ai/sdk";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@generic-ai/tools";
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

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Reads a path the way the tools in `@generic-ai/tools` do: `@` prefix, `~`, odd spaces. */
function normalizeToolPath(input: string, root: string): string {
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) {
    value = value.slice(1);
  }
  if (value === "~" || value.startsWith("~/")) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return path.resolve(root, value);
}

/** The error an agent sees for a path outside its workspace. */
export class WorkspaceBoundaryError extends Error {
  constructor(requested: string, root: string) {
    super(
      `Path "${requested}" is outside the agent's workspace (${root}). File tools only reach files under the workspace; use a relative path.`,
    );
    this.name = "WorkspaceBoundaryError";
  }
}

/**
 * Keeps an agent-facing file tool inside `root`. The tools in `@generic-ai/tools` accept any
 * absolute path and run in the server process, so without this an agent could read the server's
 * own files (including `/proc/self/environ`, which holds its API keys and database URL) or write
 * into other agents' homes. Every `path` argument is resolved, symlinks included, and refused when
 * it lands outside the root. The tool then gets the resolved path rather than the agent's, which
 * narrows (but cannot close) the window in which an agent's shell could swap a directory for a
 * symlink between the check and the read. Closing it needs the kernel to resolve the path
 * (`openat2` with `RESOLVE_BENEATH`), which Node does not expose.
 */
/** `<tmpdir>/generic-ai-<tool>-<16 hex>.<ext>`: where the shell tool saves output it truncated. */
const TOOL_OUTPUT_FILE = /^generic-ai-[a-z]+-[0-9a-f]{16}\.[a-z]+$/;

/**
 * Whether `candidate` is a full-output file the server's own tools wrote, which the shell tool
 * points the agent at when it truncates a command's output. Only a regular file (not a link) in
 * the temp directory, named like one and owned by the server's user, qualifies; the temp
 * directory is sticky, so no other user can swap it.
 */
async function isServerToolOutputFile(candidate: string): Promise<boolean> {
  if (path.dirname(candidate) !== os.tmpdir() || !TOOL_OUTPUT_FILE.test(path.basename(candidate))) {
    return false;
  }
  try {
    const info = await lstat(candidate);
    return info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid());
  } catch {
    return false;
  }
}

function confineToWorkspace<T extends { execute: (...args: never[]) => unknown }>(
  tool: T,
  root: string,
  options: { readonly allowToolOutput?: boolean } = {},
): T {
  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
    ...rest: unknown[]
  ) => unknown;
  const confined = async (id: string, params: unknown, ...rest: unknown[]) => {
    const record = (params ?? {}) as Record<string, unknown>;
    const requested = typeof record["path"] === "string" ? record["path"] : ".";
    const candidate = normalizeToolPath(requested, root);
    let resolved: string;
    try {
      resolved = await resolveSafeWorkspacePath(root, candidate);
    } catch {
      if (options.allowToolOutput !== true || !(await isServerToolOutputFile(candidate))) {
        throw new WorkspaceBoundaryError(requested, root);
      }
      resolved = candidate;
    }
    return execute.call(tool, id, { ...record, path: resolved }, ...rest);
  };
  return { ...tool, execute: confined } as T;
}

export function createWorkspaceFileTools(options: WorkspaceFileToolsOptions): WorkspaceFileTools {
  const workspace = createWorkspaceFs(options.root);
  const piTools = Object.freeze([
    withAgentHarnessToolEffects(
      confineToWorkspace(createReadTool(workspace.root), workspace.root, {
        allowToolOutput: true,
      }),
      {
        id: "files.read",
        label: "Read file",
        effects: ["fs.read"],
        reversibility: "reversible-cheap",
        retrySemantics: "safe-to-retry",
      },
    ),
    withAgentHarnessToolEffects(
      confineToWorkspace(createWriteTool(workspace.root), workspace.root),
      {
        id: "files.write",
        label: "Write file",
        effects: ["fs.write"],
        reversibility: "irreversible",
        retrySemantics: "retry-may-duplicate",
      },
    ),
    withAgentHarnessToolEffects(
      confineToWorkspace(createEditTool(workspace.root), workspace.root),
      {
        id: "files.edit",
        label: "Edit file",
        effects: ["fs.read", "fs.write"],
        reversibility: "reversible-with-cost",
        retrySemantics: "idempotency-key-required",
      },
    ),
    withAgentHarnessToolEffects(
      confineToWorkspace(createFindTool(workspace.root), workspace.root),
      {
        id: "files.find",
        label: "Find files",
        effects: ["fs.read"],
        reversibility: "reversible-cheap",
        retrySemantics: "safe-to-retry",
      },
    ),
    withAgentHarnessToolEffects(
      confineToWorkspace(createGrepTool(workspace.root), workspace.root),
      {
        id: "files.grep",
        label: "Search file contents",
        effects: ["fs.read"],
        reversibility: "reversible-cheap",
        retrySemantics: "safe-to-retry",
      },
    ),
    withAgentHarnessToolEffects(confineToWorkspace(createLsTool(workspace.root), workspace.root), {
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
