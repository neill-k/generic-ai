import { homedir } from "node:os";
import { join } from "node:path";

/** Directory for managed helper binaries (searched before PATH). Override with GENERIC_AI_BIN_DIR. */
export function getBinDir(): string {
  return process.env["GENERIC_AI_BIN_DIR"] ?? join(homedir(), ".generic-ai", "bin");
}
