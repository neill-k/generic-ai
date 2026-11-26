import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  registerFauxProvider,
} from "@generic-ai/ai";
import { afterEach, describe, expect, it } from "vitest";

import { createCompanyRuntime } from "./runtime.js";
import { createCompanyTaskExecutor } from "./executor.js";
import { openCompanyStorage } from "./storage.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function fauxModels() {
  const provider: FauxProviderRegistration = registerFauxProvider({
    models: [{ id: "ceo-model" }, { id: "ic-model" }],
  });
  cleanups.push(() => provider.unregister());
  const resolveModel = (ref: string): Model => {
    const model = provider.getModel(ref.split("/").at(-1) ?? ref);
    if (model === undefined) {
      throw new Error(`unknown model ${ref}`);
    }
    return model;
  };
  return { provider, resolveModel };
}

describe("company task executor on the native runtime", () => {
  it("runs each agent on its tier's model, in its home, and persists the harness runs", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-exec-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const storage = await openCompanyStorage({ sqlitePath: path.join(dataDir, "company.sqlite") });
    cleanups.push(() => storage.close());

    const { provider, resolveModel } = fauxModels();
    const seenModels: string[] = [];
    provider.setResponses([
      // CEO turn 1: delegate to the engineer.
      (_context, _options, _state, model) => {
        seenModels.push(model.id);
        return fauxAssistantMessage(
          [
            fauxToolCall("stop_and_respond", {
              response:
                'Handing this over.\n```json\n{"delegate_task": [{"to": "engineer", "task": "Write hello.txt"}]}\n```',
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      // Engineer: write a file in its workspace, then answer.
      (_context, _options, _state, model) => {
        seenModels.push(model.id);
        return fauxAssistantMessage(
          [fauxToolCall("write", { path: "workspace/hello.txt", content: "hello" })],
          { stopReason: "toolUse" },
        );
      },
      () =>
        fauxAssistantMessage([fauxToolCall("stop_and_respond", { response: "Wrote hello.txt." })], {
          stopReason: "toolUse",
        }),
      // CEO turn 2: report back.
      (_context, _options, _state, model) => {
        seenModels.push(model.id);
        return fauxAssistantMessage(
          [fauxToolCall("stop_and_respond", { response: "Done: the engineer wrote hello.txt." })],
          { stopReason: "toolUse" },
        );
      },
    ]);

    const executor = createCompanyTaskExecutor({
      runStore: storage.runStore,
      artifactsRoot: path.join(dataDir, "artifacts"),
      native: { resolveModel },
    });
    const runtime = createCompanyRuntime({
      company: {
        name: "Faux Corp",
        models: { ceo: "faux/ceo-model", vp: "faux/ic-model", ic: "faux/ic-model" },
        agents: [
          { id: "ceo", role: "ceo" },
          { id: "engineer", role: "engineer", reportsTo: "ceo" },
        ],
      },
      storage,
      agentsRoot: path.join(dataDir, "agents"),
      executor,
    });
    await runtime.initialize();
    const { thread, task } = await runtime.sendMessage({ text: "Say hello in a file." });
    await runtime.cascade.drain();

    const settled = await runtime.cascade.get(task.taskId);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.outputText).toBe("Done: the engineer wrote hello.txt.");
    expect(seenModels).toEqual(["ceo-model", "ic-model", "ceo-model"]);

    const engineer = await runtime.directory.require("engineer");
    expect(await readFile(path.join(engineer.homePath, "workspace", "hello.txt"), "utf8")).toBe(
      "hello",
    );

    // Each turn's harness run is persisted with its events, linked to the task.
    const runId = settled?.runIds[0] as string;
    const run = await storage.runStore.getRun(runId);
    expect(run?.metadata?.["kind"]).toBe("agent-harness-run");
    expect((await storage.runStore.readEvents(runId)).length).toBeGreaterThan(0);

    const view = await runtime.getThread(thread.threadId);
    expect(view?.exchanges[0]?.reply.text).toBe("Done: the engineer wrote hello.txt.");
  });
});
