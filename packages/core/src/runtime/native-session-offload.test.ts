import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Context,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@generic-ai/ai";
import { loadSkillsFromDir } from "@generic-ai/resources";
import { sealGoal } from "@generic-ai/sdk";
import { createWriteTool } from "@generic-ai/tools";
import { afterEach, describe, expect, it } from "vitest";

import { runCapabilityNativeAgentSession } from "./native-session.js";
import { promoteScriptToSkill, readHarvestManifest } from "./script-harvest.js";

const registrations: FauxProviderRegistration[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.unregister();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function provider() {
  const registration = registerFauxProvider({ models: [{ id: "offload" }] });
  registrations.push(registration);
  return registration;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "native-offload-"));
  dirs.push(dir);
  return dir;
}

function lastToolResultText(context: Context): string {
  const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
  if (result === undefined || typeof result.content === "string") {
    return "";
  }
  return result.content.map((block) => ("text" in block ? block.text : "")).join("");
}

describe("native session offloading", () => {
  it("offloads a long tool result and runs a tool batch", async () => {
    const faux = provider();
    const cwd = tempDir();
    writeFileSync(join(cwd, "big.txt"), "line\n".repeat(6000));
    writeFileSync(join(cwd, "small.txt"), "tiny");
    let batchText = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("tool_batch", {
          calls: [
            { tool: "big", arguments: {} },
            { tool: "small", arguments: {} },
          ],
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        batchText = lastToolResultText(context);
        return fauxAssistantMessage("Read both.");
      },
    ]);
    const fileTool = (name: string, file: string) => ({
      name,
      label: name,
      description: `Read ${file}`,
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text" as const, text: readFileSync(join(cwd, file), "utf8") }],
        details: {},
      }),
    });

    const result = await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: {
        customTools: [fileTool("big", "big.txt"), fileTool("small", "small.txt")],
      } as never,
      prompt: "Read both files.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      toolBatch: true,
    });

    expect(result.failureMessage).toBeUndefined();
    expect(batchText).toContain("## 1. big\nline");
    expect(batchText).toContain("[Result offloaded: 30000 characters saved to");
    expect(batchText).toContain("## 2. small\ntiny");
    expect(batchText.length).toBeLessThan(3000);
    const offloaded = result.events.filter((event) =>
      event.name.endsWith("native.tool_result_offloaded"),
    );
    expect(offloaded).toHaveLength(1);
    const path = (offloaded[0]?.data as { path: string }).path;
    expect(readFileSync(path, "utf8")).toBe("line\n".repeat(6000));
    rmSync(path, { force: true });
  });
});

describe("script harvesting", () => {
  it("saves the scripts of a run that passes its validators and promotes one to a skill", async () => {
    const faux = provider();
    const cwd = tempDir();
    const harvestDir = tempDir();
    const skillsDir = tempDir();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("write", {
            path: "scripts/count-lines.sh",
            content: '#!/usr/bin/env bash\nwc -l "$2"\n',
          }),
          fauxToolCall("write", { path: "notes.md", content: "not a script" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("complete_goal", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Counted."),
    ]);
    const spec = sealGoal({
      id: "count-lines",
      objective: "Write a line-counting script",
      definitionOfDone: ["scripts/count-lines.sh exists"],
      validators: [{ kind: "check", id: "exists", checkRef: "exists" }],
    });

    const result = await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: { customTools: [createWriteTool(cwd)] } as never,
      prompt: "Write the script.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      goal: {
        spec,
        validation: {
          checks: {
            exists: () => ({ passed: statSync(join(cwd, "scripts/count-lines.sh")).isFile() }),
          },
        },
      },
      harvest: { dir: harvestDir },
    });

    expect(result.failureMessage).toBeUndefined();
    expect(result.goal?.status).toBe("complete");
    expect(result.harvestedScripts?.map((script) => script.sourcePath)).toEqual([
      "scripts/count-lines.sh",
    ]);
    const manifest = await readHarvestManifest(harvestDir);
    expect(manifest.scripts).toHaveLength(1);
    const saved = manifest.scripts[0];
    expect(saved).toMatchObject({ goalId: "count-lines", name: "count-lines.sh" });
    expect(readFileSync(saved?.savedPath ?? "", "utf8")).toContain("wc -l");
    expect(result.events.some((event) => event.name.endsWith("native.scripts_harvested"))).toBe(
      true,
    );

    const promoted = await promoteScriptToSkill({
      scriptPath: saved?.savedPath ?? "",
      skillsDir,
      name: "count-lines",
      description: "Count the lines in a file.",
      flags: [{ name: "file", value: "PATH", description: "The file to count.", required: true }],
    });
    const skill = readFileSync(promoted.skillFile, "utf8");
    expect(skill).toContain("bash scripts/count-lines.sh --file <PATH>");
    expect(skill).toContain("- `--file <PATH>` (required): The file to count.");
    expect(statSync(promoted.scriptFile).mode & 0o111).not.toBe(0);
    const loaded = loadSkillsFromDir({ dir: skillsDir, source: "test" });
    expect(loaded.skills.map((entry) => entry.name)).toEqual(["count-lines"]);
    await expect(
      promoteScriptToSkill({
        scriptPath: saved?.savedPath ?? "",
        skillsDir,
        name: "count-lines",
        description: "again",
      }),
    ).rejects.toThrow("already exists");
    await expect(
      promoteScriptToSkill({ scriptPath: "x", skillsDir, name: "Bad Name", description: "x" }),
    ).rejects.toThrow("invalid skill name");
  });

  it("saves nothing when the run does not pass", async () => {
    const faux = provider();
    const cwd = tempDir();
    const harvestDir = tempDir();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "run.py", content: "print(1)\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done without completing."),
    ]);

    const result = await runCapabilityNativeAgentSession({
      cwd,
      model: faux.getModel(),
      capabilities: { customTools: [createWriteTool(cwd)] } as never,
      prompt: "Write it.",
      turnMode: "single-turn",
      compaction: false,
      retry: false,
      harvest: { dir: harvestDir },
    });

    expect(result.harvestedScripts).toBeUndefined();
    expect((await readHarvestManifest(harvestDir)).scripts).toEqual([]);
  });
});
