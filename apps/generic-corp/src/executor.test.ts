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
import { createCompanyTaskExecutor } from "./executor.js";
import { createCompanyRuntime } from "./runtime.js";
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

describe("saved sessions per agent per goal", () => {
  function turnInput(dataDir: string, taskId: string, prompt: string, attempt: number) {
    return {
      taskId,
      attemptRunId: `${taskId}-attempt-${attempt}`,
      rootTaskId: "goal-1",
      agentId: "engineer",
      role: "engineer",
      model: "faux/ic-model",
      prompt,
      workspaceRoot: path.join(dataDir, "home"),
    };
  }

  function userTexts(context: { messages: readonly unknown[] }): string[] {
    return context.messages.flatMap((message) => {
      const { role, content } = message as { role: string; content: unknown };
      if (role !== "user") return [];
      if (typeof content === "string") return [content];
      return (content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "");
    });
  }

  it("keeps one conversation per agent per goal and resumes a cut-off turn", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-sessions-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const storage = await openCompanyStorage({ sqlitePath: path.join(dataDir, "company.sqlite") });
    cleanups.push(() => storage.close());
    const { provider, resolveModel } = fauxModels();
    const seen: string[][] = [];
    let reachedCrash: () => void = () => {};
    const crashed = new Promise<void>((resolve) => {
      reachedCrash = resolve;
    });
    let releaseCrash: () => void = () => {};
    provider.setResponses([
      // Task A finishes in one step.
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage(
          [fauxToolCall("stop_and_respond", { response: "Task A done." })],
          { stopReason: "toolUse" },
        );
      },
      // Task B writes a file, then the process stops while the next model call is in flight.
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "b" })], {
          stopReason: "toolUse",
        });
      },
      async () => {
        reachedCrash();
        await new Promise<void>((resolve) => {
          releaseCrash = resolve;
        });
        throw new Error("the old process is gone");
      },
      // The retry resumes from the saved step instead of sending task B's prompt again.
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage(
          [fauxToolCall("stop_and_respond", { response: "Task B done." })],
          { stopReason: "toolUse" },
        );
      },
    ]);
    const executorOptions = {
      runStore: storage.runStore,
      artifactsRoot: path.join(dataDir, "artifacts"),
      sessionsRoot: path.join(dataDir, "sessions"),
      native: { resolveModel },
      noProgress: false,
    } as const;
    const executor = createCompanyTaskExecutor(executorOptions);

    const a = await executor(turnInput(dataDir, "task-a", "Do task A.", 1));
    expect(a.status).toBe("succeeded");
    const abandoned = executor(turnInput(dataDir, "task-b", "Do task B.", 1)).catch(
      () => undefined,
    );
    await crashed;

    // A restarted server picks the task up again and resumes the saved session.
    const restarted = createCompanyTaskExecutor(executorOptions);
    const b2 = await restarted(turnInput(dataDir, "task-b", "Do task B.", 2));
    expect(b2.status).toBe("succeeded");
    expect(b2.outputText).toBe("Task B done.");
    releaseCrash();
    await abandoned;

    // Task B's turn saw task A's conversation, and the retry did not resend task B's prompt.
    expect(seen[1]?.some((text) => text.includes("Do task A."))).toBe(true);
    const lastSeen = seen[2] ?? [];
    expect(lastSeen.filter((text) => text.includes("Do task B.")).length).toBe(1);
    expect(await readFile(path.join(dataDir, "home", "b.txt"), "utf8")).toBe("b");
  });
});
