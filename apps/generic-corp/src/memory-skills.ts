import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HarnessEntry } from "@generic-ai/continual";

import type { CompanyHarvest } from "./harvest.js";
import { agentScope, type CompanyMemory } from "./memory.js";

/**
 * Saved procedures (skill entries in an agent's memory) as skill folders the agent can load and
 * run. Before each turn the folder `.agents/memory-skills/` in the agent's home is rebuilt from
 * memory, the way company skills are mirrored: an agent's edits to it never stick, and undoing the
 * change that made a skill removes it from the next turn.
 *
 * A skill made from a harvested script names it in `metadata.harvestId`; the script is copied from
 * the host's harvest folder into the skill's `scripts/` folder, and `{script}` in the skill's
 * command is replaced with the script's path from the company root.
 */
export const MEMORY_SKILLS_DIR = path.join(".agents", "memory-skills");

/** A skill folder name under the Agent Skills rules: lowercase letters, digits and hyphens. */
export function skillName(id: string): string {
  const name = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return name.length === 0 ? "procedure" : name;
}

/** Where a skill's script sits, relative to the company root. */
export function skillScriptPath(agentId: string, entryId: string, fileName: string): string {
  return path.posix.join(
    "agents",
    agentId,
    ".agents",
    "memory-skills",
    skillName(entryId),
    "scripts",
    fileName,
  );
}

/** The skill's command with `{script}` filled in. */
export function skillCommand(
  agentId: string,
  entry: HarnessEntry,
  fileName?: string,
): string | undefined {
  const command = entry.reference["command"];
  if (typeof command !== "string") {
    return undefined;
  }
  return fileName === undefined
    ? command
    : command.replaceAll("{script}", skillScriptPath(agentId, entry.id, fileName));
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** Rebuilds an agent's memory skills folder. Returns the skill names written. */
export async function syncMemorySkills(input: {
  readonly memory: CompanyMemory;
  readonly harvest?: CompanyHarvest;
  readonly agentId: string;
  readonly home: string;
}): Promise<readonly string[]> {
  const dir = path.join(input.home, MEMORY_SKILLS_DIR);
  await rm(dir, { recursive: true, force: true });
  const state = await input.memory.read(agentScope(input.agentId));
  const skills = Object.values(state.entries.skill);
  if (skills.length === 0) {
    return [];
  }
  const written: string[] = [];
  for (const entry of skills) {
    const name = skillName(entry.id);
    const skillDir = path.join(dir, name);
    await mkdir(path.join(skillDir, "scripts"), { recursive: true });
    const harvestId = entry.metadata["harvestId"];
    let fileName =
      typeof entry.metadata["scriptFile"] === "string" ? entry.metadata["scriptFile"] : undefined;
    if (typeof harvestId === "string" && input.harvest !== undefined) {
      const script = await input.harvest.get(harvestId);
      const content = script === undefined ? undefined : await input.harvest.read(harvestId);
      if (script !== undefined && content !== undefined) {
        fileName = script.fileName;
        const target = path.join(skillDir, "scripts", fileName);
        await writeFile(target, content);
        await chmod(target, 0o755);
      }
    }
    const command = skillCommand(input.agentId, entry, fileName);
    const args = Object.keys(entry.arguments).length === 0 ? undefined : entry.arguments;
    const body = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(oneLine(`${entry.title}. ${entry.content}`, 900))}`,
      "---",
      "",
      `# ${entry.title}`,
      "",
      entry.content,
      "",
      ...(command === undefined ? [] : ["## Run", "", "```bash", command, "```", ""]),
      ...(args === undefined
        ? []
        : ["## Arguments", "", "```json", JSON.stringify(args, null, 2), "```", ""]),
      "This procedure was saved in your memory. This folder is rebuilt from your memory before each turn, so edits here do not stick.",
      "",
    ].join("\n");
    await writeFile(path.join(skillDir, "SKILL.md"), body);
    written.push(name);
  }
  return written;
}
