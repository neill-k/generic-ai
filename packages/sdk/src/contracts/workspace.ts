import type { Awaitable } from "./shared.js";

export type WorkspaceEntryKind = "file" | "directory" | "symlink";

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly size?: number;
  readonly modifiedAt?: string;
}

export interface WorkspaceLayout {
  readonly root: string;
  readonly framework: string;
  readonly agents: string;
  readonly plugins: string;
  readonly skills: string;
  readonly shared: string;
}

export interface WorkspaceContract {
  readonly kind: "workspace";
  readonly root: string;
  readonly layout: WorkspaceLayout;
  resolvePath(...segments: readonly string[]): string;
  exists(path: string): Awaitable<boolean>;
  mkdir(path: string, recursive?: boolean): Awaitable<void>;
  readText(path: string): Awaitable<string>;
  writeText(path: string, content: string): Awaitable<void>;
  readBinary(path: string): Awaitable<Uint8Array>;
  writeBinary(path: string, content: Uint8Array): Awaitable<void>;
  list(path?: string): Awaitable<readonly WorkspaceEntry[]>;
  remove(path: string, recursive?: boolean): Awaitable<void>;
}

