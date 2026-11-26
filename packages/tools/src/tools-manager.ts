import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { getBinDir } from "./config.js";

/**
 * Locate a search helper binary (`rg` for grep, `fd` for find).
 *
 * Unlike pi, this never downloads binaries: it looks in `getBinDir()` and on PATH only. Callers fall
 * back to a built-in implementation when the binary is missing.
 */
const BINARY_NAMES: Record<"fd" | "rg", readonly string[]> = {
  rg: ["rg"],
  fd: ["fd", "fdfind"],
};

function commandExists(command: string): boolean {
  const result = spawnSync(platform() === "win32" ? "where" : "which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function getToolPath(tool: "fd" | "rg"): string | null {
  const suffix = platform() === "win32" ? ".exe" : "";
  for (const name of BINARY_NAMES[tool]) {
    const local = join(getBinDir(), name + suffix);
    if (existsSync(local)) {
      return local;
    }
  }
  for (const name of BINARY_NAMES[tool]) {
    if (commandExists(name)) {
      return name;
    }
  }
  return null;
}

const cache = new Map<string, string | undefined>();

export async function ensureTool(tool: "fd" | "rg"): Promise<string | undefined> {
  if (!cache.has(tool)) {
    cache.set(tool, getToolPath(tool) ?? undefined);
  }
  return cache.get(tool);
}

/** Forget cached lookups (tests). */
export function resetToolPathCache(): void {
  cache.clear();
}
