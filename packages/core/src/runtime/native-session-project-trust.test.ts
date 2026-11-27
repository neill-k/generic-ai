import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, fauxAssistantMessage, registerFauxProvider } from "@generic-ai/ai";
import { ProjectTrustStore } from "@generic-ai/resources";
import { afterEach, describe, expect, it } from "vitest";

import { type NativeSessionExtensions, runCapabilityNativeAgentSession } from "./native-session.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-trust-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".generic-ai", "extensions"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, ".generic-ai", "extensions", "probe.ts"),
    `export default function (api) {
  api.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nPROJECT EXTENSION LOADED" }));
}
`,
  );
  const faux = registerFauxProvider({ models: [{ id: "trust" }] });
  cleanups.push(() => {
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  });
  return { cwd, agentDir, faux };
}

async function loadsProjectExtension(
  setup: ReturnType<typeof project>,
  projectTrust: NativeSessionExtensions["projectTrust"],
): Promise<{ loaded: boolean; trustEvent: unknown }> {
  let systemPrompt = "";
  setup.faux.setResponses([
    (context: Context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("ok");
    },
  ]);
  const result = await runCapabilityNativeAgentSession({
    cwd: setup.cwd,
    model: setup.faux.getModel(),
    capabilities: {} as never,
    prompt: "hi",
    turnMode: "single-turn",
    compaction: false,
    retry: false,
    extensions: { discover: true, ...(projectTrust === undefined ? {} : { projectTrust }) },
  });
  const trustEvent = result.events.find((event) => event.name.endsWith("native.project_trust"));
  return { loaded: systemPrompt.includes("PROJECT EXTENSION LOADED"), trustEvent };
}

describe("native session project trust", () => {
  it("loads project extensions when trust is not configured or true", async () => {
    const setup = project();
    expect((await loadsProjectExtension(setup, undefined)).loaded).toBe(true);
    expect((await loadsProjectExtension(setup, true)).loaded).toBe(true);
  });

  it("skips project extensions for an untrusted project", async () => {
    const setup = project();
    const outcome = await loadsProjectExtension(setup, false);
    expect(outcome.loaded).toBe(false);
    expect(JSON.stringify(outcome.trustEvent)).toContain('"trusted":false');
  });

  it("resolves trust from the saved decision, the default, and the ask callback", async () => {
    const setup = project();
    const store = new ProjectTrustStore(setup.agentDir);
    // Undecided with nobody to ask: not trusted.
    expect((await loadsProjectExtension(setup, { agentDir: setup.agentDir })).loaded).toBe(false);
    expect(
      (await loadsProjectExtension(setup, { agentDir: setup.agentDir, default: "always" })).loaded,
    ).toBe(true);
    const asked = await loadsProjectExtension(setup, {
      agentDir: setup.agentDir,
      ask: (_prompt, options) => options.find((option) => option.label === "Trust"),
    });
    expect(asked.loaded).toBe(true);
    expect(store.get(setup.cwd)).toBe(true);
    store.set(setup.cwd, false);
    expect(
      (await loadsProjectExtension(setup, { agentDir: setup.agentDir, default: "always" })).loaded,
    ).toBe(false);
  });
});
