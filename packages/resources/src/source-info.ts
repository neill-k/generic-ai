// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/diagnostics.ts and core/source-info.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import { canonicalizePath, getPathComparisonKey } from "@generic-ai/tools";

/** Directory name for project-local resources: `<cwd>/.generic-ai/skills`, `<cwd>/.generic-ai/prompts`. */
export const CONFIG_DIR_NAME = ".generic-ai";

export interface ResourceCollision {
  readonly resourceType: "extension" | "skill" | "prompt";
  readonly name: string;
  readonly winnerPath: string;
  readonly loserPath: string;
  readonly winnerSource?: string;
  readonly loserSource?: string;
}

export interface ResourceDiagnostic {
  readonly type: "warning" | "error" | "collision";
  readonly message: string;
  readonly path?: string;
  readonly collision?: ResourceCollision;
}

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

/** Where a resource came from. */
export interface SourceInfo {
  readonly path: string;
  readonly source: string;
  readonly scope: SourceScope;
  readonly origin: SourceOrigin;
  readonly baseDir?: string;
}

/** Prefix of built-in resource paths, such as `builtin:read`. */
export const BUILTIN_PATH_PREFIX = "builtin:";

export function isSyntheticPath(path: string): boolean {
  return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

/** Key for deduplicating resource paths: synthetic paths as-is, file paths via realpath and platform casing. */
export function getResourcePathKey(path: string): string {
  return isSyntheticPath(path) ? path : getPathComparisonKey(canonicalizePath(path));
}

export function createSyntheticSourceInfo(
  path: string,
  options: {
    readonly source: string;
    readonly scope?: SourceScope | undefined;
    readonly origin?: SourceOrigin | undefined;
    readonly baseDir?: string | undefined;
  },
): SourceInfo {
  return {
    path,
    source: options.source,
    scope: options.scope ?? "temporary",
    origin: options.origin ?? "top-level",
    ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
  };
}
