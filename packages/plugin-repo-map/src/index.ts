import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { defineTool, withAgentHarnessToolEffects, type ToolDefinition } from "@generic-ai/sdk";
import {
  createWorkspaceLayout,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";
import { Type } from "@sinclair/typebox";

export const name = "@generic-ai/plugin-repo-map" as const;
export const kind = "repo-map" as const;

export interface RepoMapOptions {
  readonly root: WorkspaceRootInput;
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly includeExtensions?: readonly string[];
  readonly excludeDirs?: readonly string[];
}

export interface RepoMapFileEntry {
  readonly path: string;
  readonly extension: string;
  readonly sizeBytes: number;
}

export interface RepoMapPackageSummary {
  readonly path: string;
  readonly name?: string;
  readonly scripts: readonly string[];
  readonly dependencies: readonly string[];
}

export interface RepoMapSnapshot {
  readonly root: string;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly files: readonly RepoMapFileEntry[];
  readonly packages: readonly RepoMapPackageSummary[];
  readonly topLevelDirs: readonly string[];
}

export interface RepoMapPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly tool: ToolDefinition;
  snapshot(options?: RepoMapSnapshotOptions): Promise<RepoMapSnapshot>;
}

export interface RepoMapSnapshotOptions {
  readonly path?: string;
  readonly maxFiles?: number;
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);

function normalizeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative.length === 0 ? "." : relative.replaceAll("\\", "/");
}

function isPackageJson(relativePath: string): boolean {
  return relativePath === "package.json" || relativePath.endsWith("/package.json");
}

function shouldIncludeFile(
  relativePath: string,
  includeExtensions: readonly string[] | undefined,
): boolean {
  if (includeExtensions === undefined || includeExtensions.length === 0) {
    return true;
  }

  const extension = path.extname(relativePath).toLowerCase();
  return includeExtensions.includes(extension);
}

async function readPackageSummary(
  root: string,
  relativePath: string,
): Promise<RepoMapPackageSummary | undefined> {
  try {
    const raw = await readFile(path.join(root, relativePath), "utf8");
    const parsed = JSON.parse(raw) as {
      readonly name?: unknown;
      readonly scripts?: unknown;
      readonly dependencies?: unknown;
      readonly devDependencies?: unknown;
    };
    const scripts =
      parsed.scripts && typeof parsed.scripts === "object"
        ? Object.keys(parsed.scripts).sort()
        : [];
    const dependencies = [
      ...(parsed.dependencies && typeof parsed.dependencies === "object"
        ? Object.keys(parsed.dependencies)
        : []),
      ...(parsed.devDependencies && typeof parsed.devDependencies === "object"
        ? Object.keys(parsed.devDependencies)
        : []),
    ]
      .filter((dependency, index, dependencies) => dependencies.indexOf(dependency) === index)
      .sort();

    return Object.freeze({
      path: relativePath,
      ...(typeof parsed.name === "string" && parsed.name.length > 0 ? { name: parsed.name } : {}),
      scripts: Object.freeze(scripts),
      dependencies: Object.freeze(dependencies),
    });
  } catch {
    return undefined;
  }
}

async function walkRepo(input: {
  readonly root: string;
  readonly absolutePath: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly excludeDirs: ReadonlySet<string>;
  readonly includeExtensions?: readonly string[];
  readonly files: RepoMapFileEntry[];
  readonly packages: RepoMapPackageSummary[];
}): Promise<void> {
  if (input.files.length >= input.maxFiles || input.depth > input.maxDepth) {
    return;
  }

  const info = await lstat(input.absolutePath);
  if (info.isSymbolicLink()) {
    return;
  }

  if (info.isFile()) {
    const relativePath = normalizeRelativePath(input.root, input.absolutePath);
    if (!shouldIncludeFile(relativePath, input.includeExtensions)) {
      return;
    }

    input.files.push(
      Object.freeze({
        path: relativePath,
        extension: path.extname(relativePath).toLowerCase(),
        sizeBytes: info.size,
      }),
    );

    if (isPackageJson(relativePath)) {
      const summary = await readPackageSummary(input.root, relativePath);
      if (summary !== undefined) {
        input.packages.push(summary);
      }
    }
    return;
  }

  if (!info.isDirectory()) {
    return;
  }

  const entries = (await readdir(input.absolutePath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    if (input.files.length >= input.maxFiles) {
      return;
    }

    if (entry.isDirectory() && input.excludeDirs.has(entry.name)) {
      continue;
    }

    await walkRepo({
      ...input,
      absolutePath: path.join(input.absolutePath, entry.name),
      depth: input.depth + 1,
    });
  }
}

async function topLevelDirs(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return Object.freeze(
    entries
      .filter((entry) => entry.isDirectory() && !DEFAULT_EXCLUDE_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort(),
  );
}

export function createRepoMapPlugin(options: RepoMapOptions): RepoMapPlugin {
  const layout = createWorkspaceLayout(options.root);
  const maxFiles = options.maxFiles ?? 300;
  const maxDepth = options.maxDepth ?? 8;
  const excludeDirs = new Set([...(options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS)]);

  async function snapshot(snapshotOptions: RepoMapSnapshotOptions = {}): Promise<RepoMapSnapshot> {
    const root =
      snapshotOptions.path === undefined
        ? layout.root
        : await resolveSafeWorkspacePath(layout.root, snapshotOptions.path);
    const effectiveMaxFiles = snapshotOptions.maxFiles ?? maxFiles;
    const files: RepoMapFileEntry[] = [];
    const packages: RepoMapPackageSummary[] = [];
    await walkRepo({
      root: layout.root,
      absolutePath: root,
      depth: 0,
      maxDepth,
      maxFiles: effectiveMaxFiles,
      excludeDirs,
      ...(options.includeExtensions === undefined
        ? {}
        : { includeExtensions: options.includeExtensions }),
      files,
      packages,
    });

    files.sort((left, right) => left.path.localeCompare(right.path));
    packages.sort((left, right) => left.path.localeCompare(right.path));

    return Object.freeze({
      root: layout.root,
      fileCount: files.length,
      truncated: files.length >= effectiveMaxFiles,
      files: Object.freeze(files),
      packages: Object.freeze(packages),
      topLevelDirs: await topLevelDirs(layout.root),
    });
  }

  const tool = withAgentHarnessToolEffects(
    defineTool({
      name: "repo_map",
      label: "Repo Map",
      description: "Build a deterministic compact map of the current repository.",
      promptSnippet: "inspect a compact deterministic repository map",
      promptGuidelines: [
        "Use repo_map early to orient before broad file reads.",
        "Prefer targeted reads after the map identifies relevant files.",
      ],
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            description: "Optional workspace-relative subdirectory to map.",
          }),
        ),
        maxFiles: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const result = await snapshot({
          ...(params.path === undefined ? {} : { path: params.path }),
          ...(params.maxFiles === undefined ? {} : { maxFiles: params.maxFiles }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Mapped ${result.fileCount} files${result.truncated ? " (truncated)" : ""}.`,
            },
          ],
          details: result,
        };
      },
    }),
    ["repo.inspect", "fs.read"],
  );

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    tool,
    snapshot,
  });
}
