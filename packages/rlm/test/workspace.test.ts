// The Python workspace against a real interpreter. Sub-model calls go to the faux provider; no
// test reaches a real model. Cases follow Prime Agent's test_repl.py (persistent namespace,
// trailing expression, top-level await, tracebacks with cell source, interrupt, host bridge,
// snapshot and restore) where they apply.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@generic-ai/agent";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "@generic-ai/ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createRlmWorkspace, type RlmWorkspace, type RlmWorkspaceOptions } from "../src/index.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const workspaces: RlmWorkspace[] = [];
const registrations: FauxProviderRegistration[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
  for (const registration of registrations.splice(0)) registration.unregister();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "generic-ai-rlm-"));
  dirs.push(dir);
  return dir;
}

function workspace(options: Partial<RlmWorkspaceOptions> = {}): RlmWorkspace {
  const created = createRlmWorkspace({ cwd: tempDir(), ...options });
  workspaces.push(created);
  return created;
}

async function run(target: RlmWorkspace, code: string, timeoutSeconds?: number) {
  const result = await target.tool.execute(
    "call",
    timeoutSeconds === undefined ? { code } : { code, timeout_seconds: timeoutSeconds },
  );
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return { text, details: result.details, isError: result.isError === true };
}

describe.skipIf(!hasPython)("python workspace", () => {
  it("keeps variables between calls and shows a trailing expression", async () => {
    const target = workspace();
    expect((await run(target, "numbers = list(range(10))\nprint('loaded')")).text).toBe("loaded");
    const second = await run(target, "sum(numbers)");
    expect(second.text).toBe("Out: 45");
    expect(second.details.status).toBe("ok");
    expect((await run(target, "x = 1")).text).toBe("[no output]");
  });

  it("runs top-level await and keeps background tasks alive between calls", async () => {
    const target = workspace();
    await run(
      target,
      "results = []\nasync def later():\n    await asyncio.sleep(0.05)\n    results.append('done')\ntask = asyncio.ensure_future(later())",
    );
    expect((await run(target, "await asyncio.sleep(0.2)\nresults")).text).toBe("Out: ['done']");
  });

  it("reports errors with the cell's source line and keeps the workspace", async () => {
    const target = workspace();
    await run(target, "kept = 'yes'");
    const failed = await run(target, "value = 1\nvalue / 0");
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('File "<cell-2>", line 2');
    expect(failed.text).toContain("value / 0");
    expect(failed.text).toContain("ZeroDivisionError: division by zero");
    expect(failed.text).not.toContain("kernel.py");
    expect((await run(target, "kept")).text).toBe("Out: 'yes'");
  });

  it("captures subprocess output and refuses to exit the kernel", async () => {
    const target = workspace();
    const raw = await run(
      target,
      "import subprocess\nsubprocess.run(['echo', 'from child'])\nNone",
    );
    expect(raw.text).toContain("from child");
    const exited = await run(target, "import sys\nsys.exit(3)");
    expect(exited.isError).toBe(true);
    expect(exited.text).toContain("SystemExit is not allowed");
    expect((await run(target, "1 + 1")).text).toBe("Out: 2");
  });

  it("interrupts a cell past its timeout, in synchronous code or at an await", async () => {
    const target = workspace();
    await run(target, "survivor = 42");
    const spinning = await run(target, "while True:\n    pass", 1);
    expect(spinning.isError).toBe(true);
    expect(spinning.details.timedOut).toBe(true);
    expect(spinning.text).toContain("KeyboardInterrupt");
    const sleeping = await run(target, "await asyncio.sleep(30)", 1);
    expect(sleeping.details.timedOut).toBe(true);
    expect((await run(target, "survivor")).text).toBe("Out: 42");
  });

  it("stops a cell when the tool call is aborted", async () => {
    const target = workspace();
    await run(target, "ready = True");
    const controller = new AbortController();
    const pending = target.tool.execute(
      "call",
      { code: "import time\ntime.sleep(30)" },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "KeyboardInterrupt",
    );
  });

  it("cuts long output, keeping its head and tail", async () => {
    const target = workspace({ maxOutputChars: 1_000 });
    const result = await run(target, "print('A' * 5000 + 'END')");
    expect(result.details.truncated).toBe(true);
    expect(result.details.outputChars).toBe(5003);
    expect(result.text).toContain("characters cut");
    expect(result.text.endsWith("END")).toBe(true);
    expect(result.text.length).toBeLessThan(1_200);
  });

  it("starts with the given variables so large inputs never enter the conversation", async () => {
    const document = "line\n".repeat(50_000);
    const target = workspace({ variables: { document, meta: { pages: 3 } } });
    const result = await run(target, "len(document.splitlines()), meta['pages']");
    expect(result.text).toBe("Out: (50000, 3)");
    await target.setVariables({ extra: [1, 2] });
    expect((await run(target, "extra")).text).toBe("Out: [1, 2]");
  });

  it("calls sub-models from code through rlm.llm and rlm.llm_batch", async () => {
    const provider = registerFauxProvider({ models: [{ id: "small" }, { id: "large" }] });
    registrations.push(provider);
    const small = provider.getModel("small");
    const large = provider.getModel("large");
    if (small === undefined || large === undefined) throw new Error("faux models missing");
    const seen: string[] = [];
    provider.setResponses([
      (context, _options, _state, model) => {
        seen.push(`${model.id}:${JSON.stringify(context.messages[0]?.content)}`);
        return fauxAssistantMessage("SUMMARY-1");
      },
      fauxAssistantMessage("chunk answer"),
      fauxAssistantMessage("chunk answer"),
      fauxAssistantMessage("chunk answer"),
    ]);
    const responses: string[] = [];
    const target = workspace({
      variables: { chunks: ["a", "b", "c"] },
      llm: {
        model: small,
        resolveModel: (reference) =>
          reference === `${provider.provider}/large` ? large : undefined,
        models: () => [small, large],
        onResponse: (_message, model) => {
          responses.push(model.id);
        },
      },
    });
    const one = await run(target, "await rlm.llm('Summarise this', system='Be brief')");
    expect(one.text).toBe("Out: 'SUMMARY-1'");
    expect(seen[0]).toBe('small:"Summarise this"');
    const many = await run(
      target,
      `answers = await rlm.llm_batch([f'Read {c}' for c in chunks], model='${provider.provider}/large')\nlen(answers), answers[0]`,
    );
    expect(many.text).toBe("Out: (3, 'chunk answer')");
    expect(many.details.llmCalls).toBe(3);
    expect(responses).toEqual(["small", "large", "large", "large"]);
    const listed = await run(target, "[m['id'] for m in await rlm.models()]");
    expect(listed.text).toBe("Out: ['small', 'large']");
    const unknown = await run(target, "await rlm.llm('x', model='nope/none')");
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('RLMHostError: rlm.llm: unknown model "nope/none"');
  });

  it("raises in code when a sub-model call fails", async () => {
    const provider = registerFauxProvider({ models: [{ id: "small" }] });
    registrations.push(provider);
    provider.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
    ]);
    const target = workspace({ llm: { model: provider.getModel() } });
    const result = await run(
      target,
      "try:\n    await rlm.llm('hi')\nexcept Exception as e:\n    print(type(e).__name__, e)",
    );
    expect(result.text).toBe("RLMHostError rlm.llm: overloaded");
  });

  it("calls the agent's other tools through rlm.tool without showing their output", async () => {
    const big = "x".repeat(100_000);
    const fetchTool: AgentTool = {
      name: "fetch_doc",
      label: "Fetch",
      description: "Fetch a document.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params: { id: string }) => ({
        content: [{ type: "text", text: `${params.id}:${big}` }],
        details: { id: params.id },
      }),
    };
    const failing: AgentTool = {
      name: "broken",
      label: "Broken",
      description: "Always fails.",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("no luck");
      },
    };
    let target: RlmWorkspace | undefined;
    target = workspace({ tools: () => [fetchTool, failing, ...(target ? [target.tool] : [])] });
    const result = await run(
      target,
      "doc = await rlm.tool('fetch_doc', id='d1')\nlen(doc.text), doc.details, doc.is_error",
    );
    expect(result.text).toBe("Out: (100003, {'id': 'd1'}, False)");
    expect(result.details.toolCalls).toBe(1);
    expect((await run(target, "(await rlm.tool('broken')).is_error")).text).toBe("Out: True");
    expect((await run(target, "[t['name'] for t in await rlm.tools()]")).text).toBe(
      "Out: ['fetch_doc', 'broken']",
    );
    const missing = await run(target, "await rlm.tool('python', code='1')");
    expect(missing.text).toContain('no tool named "python"');
  });

  it("reads the conversation as data through rlm.messages", async () => {
    const target = workspace({
      getMessages: () => [
        { role: "user", content: "first question", timestamp: 1 },
        {
          role: "user",
          content: [{ type: "text", text: "second question" }],
          timestamp: 2,
        },
      ],
    });
    const result = await run(
      target,
      "[(m['index'], m['text']) for m in await rlm.messages(start=-1)]",
    );
    expect(result.text).toBe("Out: [(1, 'second question')]");
  });

  it("saves variables on dispose and restores them in a new workspace", async () => {
    const snapshotPath = join(tempDir(), "state", "workspace.pkl");
    const first = createRlmWorkspace({ cwd: tempDir(), snapshotPath });
    await run(first, "kept = {'a': [1, 2]}\nf = lambda: 1");
    await first.dispose();
    const second = workspace({ snapshotPath });
    expect((await run(second, "kept")).text).toBe("Out: {'a': [1, 2]}");
    expect((await run(second, "'f' in globals()")).text).toBe("Out: False");
  });

  it("runs calls one at a time even when the agent calls it in parallel", async () => {
    const target = workspace();
    await run(target, "log = []");
    await Promise.all([
      run(target, "import time\nlog.append('a1'); time.sleep(0.1); log.append('a2')"),
      run(target, "log.append('b1'); log.append('b2')"),
    ]);
    expect((await run(target, "log")).text).toBe("Out: ['a1', 'a2', 'b1', 'b2']");
  });

  it("explains a missing Python", async () => {
    const target = workspace({ python: "python-does-not-exist-anywhere" });
    await expect(run(target, "1")).rejects.toThrow("Python not found");
  });
});
