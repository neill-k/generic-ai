// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/trust-manager.ts and
// project-trust.ts). Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// Project trust decides whether a repository's own resources (`.generic-ai/extensions`, skills,
// prompts, settings) may load. Extensions run with the process's permissions, so a cloned
// repository should not get to run code before someone says it may.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { canonicalizePath, getPathComparisonKey, resolvePath } from "@generic-ai/tools";

import { stripBom } from "./frontmatter.js";
import { CONFIG_DIR_NAME } from "./source-info.js";

/** `true` trusted, `false` not trusted, `null` no decision. */
export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
  /** The directory the decision was saved for: `cwd` or one of its ancestors. */
  readonly path: string;
  readonly decision: boolean;
}

export interface ProjectTrustUpdate {
  readonly path: string;
  /** `null` removes the saved decision. */
  readonly decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
  readonly label: string;
  readonly trusted: boolean;
  /** Decisions to save when this option is picked; none for a session-only choice. */
  readonly updates: readonly ProjectTrustUpdate[];
  readonly savedPath?: string;
}

/** What to do for an undecided project that has trust-requiring resources. */
export type DefaultProjectTrust = "always" | "never" | "ask";

/** Entries under `<cwd>/.generic-ai` that only load for a trusted project. */
export const TRUST_REQUIRING_PROJECT_RESOURCES = [
  "settings.json",
  "mcp.json",
  "extensions",
  "skills",
  "prompts",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

type TrustFile = Record<string, boolean | null | undefined>;

function normalizeCwd(cwd: string): string {
  return canonicalizePath(resolvePath(cwd));
}

function pathsEqual(left: string, right: string): boolean {
  return getPathComparisonKey(left) === getPathComparisonKey(right);
}

/** Keys naming `path`: usually one, several on Windows when saved with different casing. */
function trustFileKeys(data: TrustFile, path: string): string[] {
  return Object.keys(data).filter((key) => pathsEqual(key, path));
}

function nearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
  let current = normalizeCwd(cwd);
  while (true) {
    for (const key of trustFileKeys(data, current)) {
      const value = data[key];
      if (value === true || value === false) {
        return { path: key, decision: value };
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** The parent of `cwd`, offered as "trust the parent folder"; `undefined` at the root. */
export function getProjectTrustParentPath(cwd: string): string | undefined {
  const trustPath = normalizeCwd(cwd);
  const parent = dirname(trustPath);
  return parent === trustPath ? undefined : parent;
}

/**
 * The choices a host can offer: trust, trust the parent folder, do not trust, and (with
 * `includeSessionOnly`) session-only variants that save nothing.
 */
export function getProjectTrustOptions(
  cwd: string,
  options?: { readonly includeSessionOnly?: boolean },
): ProjectTrustOption[] {
  const trustPath = normalizeCwd(cwd);
  const choices: ProjectTrustOption[] = [
    {
      label: "Trust",
      trusted: true,
      updates: [{ path: trustPath, decision: true }],
      savedPath: trustPath,
    },
  ];
  const parent = getProjectTrustParentPath(cwd);
  if (parent !== undefined) {
    choices.push({
      label: `Trust parent folder (${parent})`,
      trusted: true,
      updates: [
        { path: parent, decision: true },
        { path: trustPath, decision: null },
      ],
      savedPath: parent,
    });
  }
  if (options?.includeSessionOnly === true) {
    choices.push({ label: "Trust (this session only)", trusted: true, updates: [] });
  }
  choices.push({
    label: "Do not trust",
    trusted: false,
    updates: [{ path: trustPath, decision: false }],
    savedPath: trustPath,
  });
  if (options?.includeSessionOnly === true) {
    choices.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
  }
  return choices;
}

function readTrustFile(path: string): TrustFile {
  if (!existsSync(path)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read trust store ${path}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${path}: expected an object`);
  }
  const data: TrustFile = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== true && value !== false && value !== null) {
      throw new Error(
        `Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`,
      );
    }
    data[key] = value;
  }
  return data;
}

function writeTrustFile(path: string, data: TrustFile): void {
  const sorted: TrustFile = {};
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) {
      sorted[key] = value;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  // Write a temporary file and rename it, so a reader never sees half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
  renameSync(temporary, path);
}

const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 20;
/** A lock older than this was left by a crashed process. */
const STALE_LOCK_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Hold a `<path>.lock` directory around `task`, so concurrent processes don't lose updates. */
function withTrustFileLock<T>(path: string, task: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          rmdirSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error(`Timed out waiting for the lock on trust store ${path}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return task();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // Already removed as stale by another process.
    }
  }
}

/**
 * Whether `cwd` has project resources that only load when the project is trusted: any of
 * `TRUST_REQUIRING_PROJECT_RESOURCES` under `<cwd>/.generic-ai`. `AGENTS.md` and other context
 * files are instructions, not code, and do not count.
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
  const configDir = join(normalizeCwd(cwd), CONFIG_DIR_NAME);
  return TRUST_REQUIRING_PROJECT_RESOURCES.some((entry) => existsSync(join(configDir, entry)));
}

/**
 * Saved trust decisions in `<agentDir>/trust.json`, keyed by directory. A decision applies to the
 * directory and everything below it unless a nearer directory has its own.
 */
export class ProjectTrustStore {
  readonly path: string;

  constructor(agentDir: string) {
    this.path = join(resolvePath(agentDir), "trust.json");
  }

  get(cwd: string): ProjectTrustDecision {
    return this.getEntry(cwd)?.decision ?? null;
  }

  getEntry(cwd: string): ProjectTrustStoreEntry | null {
    return withTrustFileLock(this.path, () => nearestTrustEntry(readTrustFile(this.path), cwd));
  }

  set(cwd: string, decision: ProjectTrustDecision): void {
    this.setMany([{ path: cwd, decision }]);
  }

  setMany(updates: readonly ProjectTrustUpdate[]): void {
    withTrustFileLock(this.path, () => {
      const data = readTrustFile(this.path);
      for (const { path, decision } of updates) {
        const key = normalizeCwd(path);
        for (const existing of trustFileKeys(data, key)) {
          delete data[existing];
        }
        if (decision !== null) {
          data[key] = decision;
        }
      }
      writeTrustFile(this.path, data);
    });
  }
}

export interface ResolveProjectTrustedOptions {
  readonly cwd: string;
  readonly store: ProjectTrustStore;
  /** Skip everything else and use this answer (a `--trust` flag, say). */
  readonly trustOverride?: boolean | undefined;
  /** For an undecided project with trust-requiring resources. Defaults to `"ask"`. */
  readonly defaultProjectTrust?: DefaultProjectTrust | undefined;
  /**
   * Ask someone. Return the picked option (its updates are saved) or `undefined` to refuse.
   * Without it, `"ask"` means not trusted.
   */
  readonly ask?:
    | ((
        prompt: string,
        options: readonly ProjectTrustOption[],
      ) => Promise<ProjectTrustOption | undefined> | ProjectTrustOption | undefined)
    | undefined;
}

/** The question pi shows before loading a project's resources. */
export function formatProjectTrustPrompt(cwd: string): string {
  return `Trust project folder?\n${normalizeCwd(cwd)}\n\nThis allows the agent to load ${CONFIG_DIR_NAME} settings and resources and run project extensions.`;
}

/**
 * Decide whether to trust `cwd`, as pi does: an override wins; a project without trust-requiring
 * resources is trusted unless a "do not trust" decision is saved; otherwise the saved decision,
 * then `defaultProjectTrust`, then `ask`.
 */
export async function resolveProjectTrusted(
  options: ResolveProjectTrustedOptions,
): Promise<boolean> {
  if (options.trustOverride !== undefined) {
    return options.trustOverride;
  }
  if (!hasTrustRequiringProjectResources(options.cwd)) {
    return options.store.get(options.cwd) ?? true;
  }
  const saved = options.store.get(options.cwd);
  if (saved !== null) {
    return saved;
  }
  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return true;
    case "never":
      return false;
    case "ask":
      break;
  }
  if (options.ask === undefined) {
    return false;
  }
  const choices = getProjectTrustOptions(options.cwd, { includeSessionOnly: true });
  const picked = await options.ask(formatProjectTrustPrompt(options.cwd), choices);
  if (picked === undefined) {
    return false;
  }
  if (picked.updates.length > 0) {
    options.store.setMany(picked.updates);
  }
  return picked.trusted;
}
