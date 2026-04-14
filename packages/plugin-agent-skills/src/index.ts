import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type LoadSkillsResult,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import {
  createWorkspaceLayout,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";

export const name = "@generic-ai/plugin-agent-skills" as const;
export const kind = "agent-skills" as const;

export type SkillSourceKind = "project" | "custom" | "user" | "global";

export interface SkillSource {
  readonly kind: SkillSourceKind;
  readonly dir: string;
  readonly source: string;
}

export interface AgentSkillsOptions {
  readonly root: WorkspaceRootInput;
  readonly skillDirs?: readonly string[];
  readonly includeProject?: boolean;
  readonly includeUser?: boolean;
  readonly includeGlobal?: boolean;
  readonly userDir?: string;
  readonly globalDir?: string;
}

export interface AgentSkillsSnapshot {
  readonly sources: readonly SkillSource[];
  readonly skills: readonly Skill[];
  readonly diagnostics: LoadSkillsResult["diagnostics"];
  readonly prompt: string;
}

export interface AgentSkillsPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  discoverSources(): Promise<readonly SkillSource[]>;
  load(): Promise<AgentSkillsSnapshot>;
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

function defaultUserSkillsDir(): string {
  return path.join(os.homedir(), ".generic-ai", "skills");
}

function defaultGlobalSkillsDir(): string {
  const codexHome = process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "skills");
}

function dedupeSkills(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  const deduped: Skill[] = [];

  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(skill);
  }

  return deduped;
}

export function createAgentSkillsPlugin(options: AgentSkillsOptions): AgentSkillsPlugin {
  const layout = createWorkspaceLayout(options.root);
  const userDir = path.resolve(options.userDir ?? defaultUserSkillsDir());
  const globalDir = path.resolve(options.globalDir ?? defaultGlobalSkillsDir());
  const customDirs = (options.skillDirs ?? []).map((directory) => path.resolve(directory));

  async function discoverSources(): Promise<readonly SkillSource[]> {
    const candidates: SkillSource[] = [];

    if (options.includeProject !== false) {
      candidates.push({
        kind: "project",
        dir: layout.skills,
        source: "project",
      });
    }

    for (const [index, directory] of customDirs.entries()) {
      candidates.push({
        kind: "custom",
        dir: directory,
        source: `custom:${index + 1}`,
      });
    }

    if (options.includeUser !== false) {
      candidates.push({
        kind: "user",
        dir: userDir,
        source: "user",
      });
    }

    if (options.includeGlobal !== false) {
      candidates.push({
        kind: "global",
        dir: globalDir,
        source: "global",
      });
    }

    const discovered: SkillSource[] = [];

    for (const candidate of candidates) {
      if (await directoryExists(candidate.dir)) {
        discovered.push(candidate);
      }
    }

    return discovered;
  }

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    discoverSources,
    async load(): Promise<AgentSkillsSnapshot> {
      const sources = await discoverSources();
      const diagnostics: LoadSkillsResult["diagnostics"] = [];
      const skills: Skill[] = [];

      for (const source of sources) {
        const loaded = loadSkillsFromDir({
          dir: source.dir,
          source: source.source,
        });

        diagnostics.push(...loaded.diagnostics);
        skills.push(...loaded.skills);
      }

      const dedupedSkills = dedupeSkills(skills);

      return Object.freeze({
        sources,
        skills: dedupedSkills,
        diagnostics,
        prompt: formatSkillsForPrompt(dedupedSkills),
      });
    },
  });
}
