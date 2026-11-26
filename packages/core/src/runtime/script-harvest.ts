import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Agent } from "@generic-ai/agent";

/**
 * Script harvesting (NOVA's second principle). When a native session's run passes its goal's
 * validators, the scripts the agent wrote during it are saved, so the work that succeeded can be
 * reused instead of re-derived by the model. A saved script can then be promoted into a skill with
 * documented flags ({@link promoteScriptToSkill}); see `docs/offloading.md`.
 */
export interface NativeSessionHarvest {
  /** Where harvested scripts and their `manifest.json` are kept. */
  readonly dir: string;
  /**
   * Which written files are scripts. Defaults to `.sh`, `.bash`, `.py`, `.js`, `.mjs`, `.cjs` and
   * `.ts` files, and any file under a `scripts/` or `bin/` folder.
   */
  readonly isScript?: (workspacePath: string) => boolean;
}

export interface HarvestedScript {
  /** The file name the script is saved under. */
  readonly name: string;
  /** Where the agent wrote it, relative to the session's working directory. */
  readonly sourcePath: string;
  readonly savedPath: string;
  readonly sha256: string;
  readonly goalId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly harvestedAt: string;
}

export interface HarvestManifest {
  readonly version: 1;
  readonly scripts: readonly HarvestedScript[];
}

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".js", ".mjs", ".cjs", ".ts"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const MAX_SCRIPT_BYTES = 256 * 1024;

export function isScriptPath(workspacePath: string): boolean {
  const parts = workspacePath.split(/[\\/]/);
  return (
    SCRIPT_EXTENSIONS.has(extname(workspacePath).toLowerCase()) ||
    parts.slice(0, -1).some((part) => part === "scripts" || part === "bin")
  );
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "goal";
}

export async function readHarvestManifest(dir: string): Promise<HarvestManifest> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    ) as HarvestManifest;
    return parsed.version === 1 && Array.isArray(parsed.scripts)
      ? parsed
      : { version: 1, scripts: [] };
  } catch {
    return { version: 1, scripts: [] };
  }
}

export interface ScriptHarvest {
  /** Tracks the files the agent writes, until the returned function is called. */
  bindAgent(agent: Agent): () => void;
  /** Workspace-relative paths of the scripts written so far. */
  written(): readonly string[];
  /** Saves the scripts written so far. Unchanged copies of saved scripts are not saved twice. */
  harvest(input: {
    readonly goalId: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<HarvestedScript[]>;
}

export function createScriptHarvest(input: {
  readonly cwd: string;
  readonly options: NativeSessionHarvest;
  readonly now?: () => Date;
}): ScriptHarvest {
  const root = resolve(input.cwd);
  const isScript = input.options.isScript ?? isScriptPath;
  const written = new Set<string>();
  const now = input.now ?? (() => new Date());

  const record = (rawPath: unknown) => {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return;
    }
    const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
    const inside = relative(root, absolute);
    if (inside.startsWith("..") || isAbsolute(inside) || inside.length === 0) {
      return;
    }
    if (isScript(inside)) {
      written.add(inside);
    }
  };

  return {
    bindAgent: (agent) => {
      const pending = new Map<string, unknown>();
      return agent.subscribe((event) => {
        if (event.type === "tool_execution_start" && WRITE_TOOLS.has(event.toolName)) {
          pending.set(event.toolCallId, (event.args as { path?: unknown } | undefined)?.path);
        } else if (event.type === "tool_execution_end" && pending.has(event.toolCallId)) {
          const path = pending.get(event.toolCallId);
          pending.delete(event.toolCallId);
          if (!event.isError) {
            record(path);
          }
        }
      });
    },
    written: () => [...written],
    harvest: async ({ goalId, runId, sessionId }) => {
      if (written.size === 0) {
        return [];
      }
      const dir = resolve(input.options.dir);
      const manifest = await readHarvestManifest(dir);
      const known = new Set(manifest.scripts.map((script) => `${script.goalId}:${script.sha256}`));
      const harvested: HarvestedScript[] = [];
      const goalDir = join(dir, safeSegment(goalId));
      for (const sourcePath of [...written].sort()) {
        let content: Buffer;
        try {
          content = await readFile(join(root, sourcePath));
        } catch {
          continue;
        }
        if (content.byteLength > MAX_SCRIPT_BYTES) {
          continue;
        }
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (known.has(`${goalId}:${sha256}`)) {
          continue;
        }
        known.add(`${goalId}:${sha256}`);
        const base = basename(sourcePath);
        const taken = manifest.scripts.some(
          (script) => script.goalId === goalId && script.name === base,
        );
        const extension = extname(base);
        const name = taken
          ? `${base.slice(0, base.length - extension.length)}-${sha256.slice(0, 8)}${extension}`
          : base;
        const savedPath = join(goalDir, name);
        await mkdir(goalDir, { recursive: true });
        await writeFile(savedPath, content, { mode: 0o644 });
        harvested.push({
          name,
          sourcePath: sourcePath.split(sep).join("/"),
          savedPath,
          sha256,
          goalId,
          runId,
          sessionId,
          harvestedAt: now().toISOString(),
        });
      }
      if (harvested.length > 0) {
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "manifest.json"),
          `${JSON.stringify({ version: 1, scripts: [...manifest.scripts, ...harvested] }, null, 2)}\n`,
        );
      }
      return harvested;
    },
  };
}

export interface SkillFlag {
  /** The flag without dashes, for example `since`. */
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  /** Shown in the usage line, for example `DATE`. Omit for a boolean switch. */
  readonly value?: string;
}

export interface PromoteScriptOptions {
  /** A harvested script's saved path, or any script file. */
  readonly scriptPath: string;
  /** The skills folder the new skill goes in. */
  readonly skillsDir: string;
  /** Lowercase letters, digits and single hyphens, at most 64 characters. */
  readonly name: string;
  /** What the skill does and when to use it, at most 1024 characters. */
  readonly description: string;
  readonly flags?: readonly SkillFlag[];
  /** Extra guidance for the agent, in Markdown. */
  readonly notes?: string;
  /** Replace an existing skill with this name. Default false. */
  readonly overwrite?: boolean;
}

export interface PromotedSkill {
  readonly name: string;
  readonly skillFile: string;
  readonly scriptFile: string;
}

function runner(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".py":
      return "python3 ";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "node ";
    case ".ts":
      return "npx tsx ";
    case ".sh":
    case ".bash":
      return "bash ";
    default:
      return "";
  }
}

/**
 * Turns a script into a skill: `<skillsDir>/<name>/SKILL.md` describing the command and its flags,
 * with the script under `scripts/`. Agents that load the skills folder see it in their skill list.
 */
export async function promoteScriptToSkill(options: PromoteScriptOptions): Promise<PromotedSkill> {
  const name = options.name;
  if (
    name.length === 0 ||
    name.length > 64 ||
    !/^[a-z0-9-]+$/.test(name) ||
    name.startsWith("-") ||
    name.endsWith("-") ||
    name.includes("--")
  ) {
    throw new Error(
      `invalid skill name "${name}": use lowercase letters, digits and single hyphens, at most 64 characters`,
    );
  }
  const description = options.description.replace(/\s+/g, " ").trim();
  if (description.length === 0 || description.length > 1024) {
    throw new Error("a skill description must be 1 to 1024 characters");
  }
  for (const flag of options.flags ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(flag.name)) {
      throw new Error(`invalid flag name "${flag.name}"`);
    }
  }
  const skillDir = join(resolve(options.skillsDir), name);
  const skillFile = join(skillDir, "SKILL.md");
  if (options.overwrite !== true) {
    try {
      await readFile(skillFile);
      throw new Error(`skill "${name}" already exists; pass overwrite to replace it`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  const fileName = basename(options.scriptPath);
  const scriptFile = join(skillDir, "scripts", fileName);
  await mkdir(dirname(scriptFile), { recursive: true });
  await copyFile(options.scriptPath, scriptFile);
  await chmod(scriptFile, 0o755);
  const flags = options.flags ?? [];
  const usage = [
    `${runner(fileName)}scripts/${fileName}`,
    ...flags.map((flag) => {
      const text = `--${flag.name}${flag.value === undefined ? "" : ` <${flag.value}>`}`;
      return flag.required === true ? text : `[${text}]`;
    }),
  ].join(" ");
  const body = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
    "## Usage",
    "",
    "Run from this skill's folder:",
    "",
    "```",
    usage,
    "```",
    ...(flags.length === 0
      ? []
      : [
          "",
          "## Flags",
          "",
          ...flags.map(
            (flag) =>
              `- \`--${flag.name}${flag.value === undefined ? "" : ` <${flag.value}>`}\`${flag.required === true ? " (required)" : ""}: ${flag.description}`,
          ),
        ]),
    ...(options.notes === undefined ? [] : ["", "## Notes", "", options.notes.trim()]),
    "",
  ].join("\n");
  await writeFile(skillFile, body);
  return { name, skillFile, scriptFile };
}
