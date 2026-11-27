// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/extensions/loader.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePath } from "@generic-ai/tools";

import { ExtensionRunner, type ExtensionRunnerOptions } from "./runner.js";
import type { Extension, ExtensionFactory } from "./types.js";

/** Directory name for project-local extensions: `<cwd>/.generic-ai/extensions`. */
export const EXTENSIONS_CONFIG_DIR = ".generic-ai";

const EXTENSION_FILE = /\.(ts|mts|js|mjs)$/;
const INDEX_FILES = ["index.ts", "index.mts", "index.js", "index.mjs"];

export interface LoadExtensionError {
  readonly path: string;
  readonly error: string;
}

export interface LoadExtensionsResult {
  readonly runner: ExtensionRunner;
  readonly extensions: readonly Extension[];
  readonly errors: readonly LoadExtensionError[];
}

/** Entries a `package.json` declares under `genericAi.extensions`, resolved and filtered to existing files. */
function manifestEntries(dir: string): string[] | undefined {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
  const declared = (manifest as { genericAi?: { extensions?: unknown } } | null)?.genericAi
    ?.extensions;
  if (!Array.isArray(declared)) {
    return undefined;
  }
  const entries = declared
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolve(dir, entry))
    .filter((entry) => existsSync(entry));
  return entries.length > 0 ? entries : undefined;
}

/**
 * Entry points of an extension directory: the files its `package.json` lists under
 * `genericAi.extensions`, else its `index.ts` / `index.js` (TypeScript first), else none.
 */
export function resolveExtensionEntries(dir: string): string[] | undefined {
  const fromManifest = manifestEntries(dir);
  if (fromManifest !== undefined) {
    return fromManifest;
  }
  for (const name of INDEX_FILES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return [candidate];
    }
  }
  return undefined;
}

/**
 * Discover extensions in a directory, one level deep: direct `.ts`/`.js` files, and subdirectories
 * with a manifest or an index file.
 */
export function discoverExtensionsInDir(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const discovered: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(entryPath);
        isFile = stats.isFile();
        isDirectory = stats.isDirectory();
      } catch {
        continue;
      }
    }
    if (isFile && EXTENSION_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      discovered.push(entryPath);
    } else if (isDirectory) {
      discovered.push(...(resolveExtensionEntries(entryPath) ?? []));
    }
  }
  return discovered;
}

export interface DiscoverExtensionsOptions {
  readonly cwd: string;
  /** Agent directory; `<agentDir>/extensions` is searched. */
  readonly agentDir?: string | undefined;
  /** Extra files or directories. */
  readonly paths?: readonly string[] | undefined;
  /** Search `<cwd>/.generic-ai/extensions` and `<agentDir>/extensions`. Defaults to true. */
  readonly includeDefaults?: boolean | undefined;
  /**
   * Include `<cwd>/.generic-ai/extensions` with the defaults. Defaults to true; pass the project's
   * trust (`resolveProjectTrusted` in `@generic-ai/resources`) so an untrusted repository's
   * extensions never run.
   */
  readonly includeProjectExtensions?: boolean | undefined;
}

/** Extension entry points from the project, the agent directory, and explicit paths, without duplicates. */
export function discoverExtensions(options: DiscoverExtensionsOptions): string[] {
  const cwd = resolvePath(options.cwd);
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (paths: readonly string[]) => {
    for (const path of paths) {
      const key = resolve(path);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(key);
      }
    }
  };
  if (options.includeDefaults !== false) {
    if (options.includeProjectExtensions !== false) {
      add(discoverExtensionsInDir(join(cwd, EXTENSIONS_CONFIG_DIR, "extensions")));
    }
    if (options.agentDir !== undefined) {
      add(discoverExtensionsInDir(join(resolvePath(options.agentDir), "extensions")));
    }
  }
  for (const raw of options.paths ?? []) {
    const path = resolvePath(raw, cwd, { trim: true });
    if (existsSync(path) && statSync(path).isDirectory()) {
      add(resolveExtensionEntries(path) ?? discoverExtensionsInDir(path));
    } else {
      add([path]);
    }
  }
  return found;
}

/** Import an extension module and return its default-export factory. */
export async function importExtensionFactory(path: string): Promise<ExtensionFactory> {
  if (!existsSync(path)) {
    throw new Error(`Extension file not found: ${path}`);
  }
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (typeof module.default !== "function") {
    throw new Error(`Extension ${path} has no default export function.`);
  }
  return module.default as ExtensionFactory;
}

/**
 * Load extension files into a new runner. A file that fails to import or throws while it
 * initialises is reported in `errors` and skipped; the others still load. TypeScript files load
 * through Node's type stripping, so they must use erasable syntax only.
 */
export async function loadExtensions(
  paths: readonly string[],
  options: ExtensionRunnerOptions & {
    /** Inline factories, loaded after the files as `<inline:N>`. */
    readonly factories?: readonly ExtensionFactory[] | undefined;
  } = {},
): Promise<LoadExtensionsResult> {
  const runner = new ExtensionRunner(options);
  const errors: LoadExtensionError[] = [];
  for (const path of paths) {
    try {
      const factory = await importExtensionFactory(path);
      await runner.load(factory, path);
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [index, factory] of (options.factories ?? []).entries()) {
    const path = `<inline:${index + 1}>`;
    try {
      await runner.load(factory, path);
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { runner, extensions: runner.extensions, errors };
}

/** Discover extensions (see `discoverExtensions`) and load them. */
export async function discoverAndLoadExtensions(
  options: DiscoverExtensionsOptions & {
    readonly factories?: readonly ExtensionFactory[] | undefined;
  },
): Promise<LoadExtensionsResult> {
  return loadExtensions(discoverExtensions(options), {
    cwd: options.cwd,
    ...(options.factories === undefined ? {} : { factories: options.factories }),
  });
}
