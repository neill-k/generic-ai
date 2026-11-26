// Ported from Prime Agent's refinement tests (`crates/pa-core/src/refinement/{mod,planner,
// ranking,executor}.rs`, PrimeIntellect-ai/prime-agent, MIT).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Model } from "@generic-ai/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendRefinementHistory,
  applyRefinementProposal,
  autoRefineInstructions,
  createContinualTools,
  emptyHarnessState,
  formatHarnessStateForPrompt,
  formatRefinementNotice,
  generateRefinementId,
  type HarnessEntry,
  type HarnessScope,
  harnessQueryTermIdf,
  harnessQueryTerms,
  harnessQueryTermsFromText,
  historyForPrompt,
  inferRefinementResultScope,
  loadContinualHarness,
  loadHarnessState,
  loadRefinementHistory,
  mergeHarnessStates,
  mergeRefinementHistory,
  overviewForPrompt,
  parseProposal,
  parseRefineCommand,
  planRefinement,
  REFINEMENT_SYSTEM_PROMPT,
  type RefinementEdit,
  type RefinementKind,
  type RefinementResult,
  type RefinerCall,
  resolveAutoRefineGates,
  reviewAutoRefine,
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  rollbackProposal,
  runRefinement,
  saveHarnessState,
  scoreHarnessEntryForQuery,
  TRUNCATED_JSON_ERROR,
  validateEdit,
} from "../src/index.js";

function entry(
  id: string,
  kind: RefinementKind,
  scope: HarnessScope,
  content: string,
  extra: Partial<HarnessEntry> = {},
): HarnessEntry {
  return {
    id,
    kind,
    title: `Entry ${id}`,
    content,
    path: "general",
    scope,
    reference: {},
    arguments: {},
    metadata: {},
    source: "refine",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...extra,
  };
}

function memoryEdit(id: string, title: string, content: string): RefinementEdit {
  return { action: "create", kind: "memory", id, title, content };
}

const model: Model = {
  id: "test-model",
  name: "Test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

function reply(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider down" } : {}),
    timestamp: 0,
  };
}

interface Captured {
  model: Model;
  system: string;
  user: string;
}

function seam(text: string, captured: Captured[] = []): RefinerCall {
  return async (requestModel, system, user) => {
    captured.push({ model: requestModel, system, user });
    return reply(text);
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "continual-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state", () => {
  it("round-trips and reads a missing or malformed file as empty", async () => {
    expect(await loadHarnessState(dir, "local")).toEqual(emptyHarnessState());
    await writeFile(join(dir, "harness_state.json"), "{not json");
    expect(await loadHarnessState(dir, "local")).toEqual(emptyHarnessState());
    const state = emptyHarnessState();
    state.entries.memory["m1"] = entry("m1", "memory", "local", "fact");
    const path = await saveHarnessState(dir, state);
    expect(path).toBe(join(dir, "harness_state.json"));
    expect(await loadHarnessState(dir, "local")).toEqual(state);
  });

  it("fills in defaults and drops records without an id or title", async () => {
    await writeFile(
      join(dir, "harness_state.json"),
      JSON.stringify({
        entries: { memory: { a: { id: "a", title: "A" }, b: { title: "no id" } } },
      }),
    );
    const state = await loadHarnessState(dir, "global");
    expect(Object.keys(state.entries.memory)).toEqual(["a"]);
    expect(state.entries.memory["a"]).toMatchObject({
      kind: "memory",
      path: "general",
      scope: "global",
      version: 1,
      source: "refine",
    });
  });

  it("prefixes a local id that collides with a global one", () => {
    const global = emptyHarnessState();
    global.entries.memory["m1"] = entry("m1", "memory", "global", "global fact");
    const local = emptyHarnessState();
    local.entries.memory["m1"] = entry("m1", "memory", "local", "local fact");
    local.entries.memory["m2"] = entry("m2", "memory", "local", "local only");
    const merged = mergeHarnessStates(global, local);
    expect(Object.keys(merged.entries.memory)).toHaveLength(3);
    expect(merged.entries.memory["m1"]?.scope).toBe("global");
    expect(merged.entries.memory["local:m1"]?.scope).toBe("local");
    expect(merged.entries.memory["m2"]?.content).toBe("local only");
  });

  it("appends, loads and merges history", async () => {
    const result: RefinementResult = {
      id: "r1",
      summary: "add a memory",
      rationale: "reused twice",
      expectedOutcome: "faster routing",
      appliedEdits: [],
      harnessStatePath: join(dir, "harness_state.json"),
    };
    await appendRefinementHistory(dir, result);
    await writeFile(join(dir, "refinement_history.jsonl"), "torn line\n", { flag: "a" });
    const loaded = await loadRefinementHistory(dir, "global");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.scope).toBe("global");
    const merged = mergeRefinementHistory(loaded, [{ ...result, summary: "session version" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.summary).toBe("session version");
    expect(merged[0]?.scope).toBe("global");
  });

  it("formats a notice and infers the scope from the edits", () => {
    const result: RefinementResult = {
      id: "r1",
      summary: "created a memory about the flaky test",
      rationale: "",
      expectedOutcome: "",
      appliedEdits: [
        {
          action: "create",
          kind: "memory",
          id: "m1",
          after: entry("m1", "memory", "global", "dup tests are flaky"),
          applied: true,
        },
      ],
      harnessStatePath: "",
    };
    const body = formatRefinementNotice(result);
    expect(body.startsWith("created a memory about the flaky test")).toBe(true);
    expect(body).toContain("- create memory [global:m1] Entry m1: dup tests are flaky");
    expect(inferRefinementResultScope(result)).toBe("global");
  });
});

describe("planner", () => {
  it("extracts JSON and diagnoses truncation", () => {
    expect(parseProposal('{"summary":"ok","edits":[]}').summary).toBe("ok");
    expect(parseProposal('```json\n{"summary":"fenced"}\n```').summary).toBe("fenced");
    expect(parseProposal('Here you go:\n{"summary":"sliced"}\nAll set.').summary).toBe("sliced");
    expect(() => parseProposal('{"summary":"cut","edits":[{"action":"cre')).toThrow(
      TRUNCATED_JSON_ERROR,
    );
    expect(() => parseProposal("no json here")).toThrow("Refiner did not return a JSON object");
  });

  it("validates edits", () => {
    expect(validateEdit({ kind: "memory", title: "t", content: "c" }, undefined)).toBeDefined();
    expect(
      validateEdit(
        { action: "update", kind: "prompt", id: "base_system_prompt", title: "t", content: "c" },
        undefined,
      ),
    ).toBe("base system prompt is not editable");
    const skill: RefinementEdit = {
      action: "create",
      kind: "skill",
      title: "Skill",
      content: "Does things",
    };
    expect(validateEdit(skill, undefined)).toContain("skill requires arguments");
    expect(validateEdit({ ...skill, arguments: {} }, undefined)).toContain(
      "skill requires a reference",
    );
    expect(
      validateEdit(
        { ...skill, arguments: {}, reference: { type: "command", command: "bash x.sh" } },
        undefined,
      ),
    ).toBeUndefined();
    expect(
      validateEdit({ ...skill, arguments: {}, reference: { type: "skill", name: "x" } }, undefined),
    ).toBeUndefined();
    expect(
      validateEdit({ ...skill, arguments: {}, reference: { type: "python" } }, undefined),
    ).toContain("reference.type must be command or skill");
  });

  it("applies create, update and delete, and rolls back", () => {
    const state = emptyHarnessState();
    const result = applyRefinementProposal(
      state,
      {
        summary: "add a memory",
        rationale: "used twice",
        expectedOutcome: "faster",
        edits: [memoryEdit("m1", "Fact", "builds are green")],
      },
      { id: "r1", scope: "local" },
    );
    expect(result.appliedEdits[0]?.applied).toBe(true);
    expect(state.entries.memory["m1"]).toMatchObject({
      content: "builds are green",
      version: 1,
      scope: "local",
    });
    const duplicate = applyRefinementProposal(
      state,
      {
        summary: "again",
        rationale: "",
        expectedOutcome: "",
        edits: [memoryEdit("m1", "Fact", "again")],
      },
      { id: "r2" },
    );
    expect(duplicate.appliedEdits[0]?.applied).toBe(false);
    expect(duplicate.appliedEdits[0]?.error).toBe("entry already exists");
    applyRefinementProposal(
      state,
      {
        summary: "update",
        rationale: "",
        expectedOutcome: "",
        edits: [{ ...memoryEdit("m1", "Fact", "updated fact"), action: "update" }],
      },
      { id: "r3" },
    );
    expect(state.entries.memory["m1"]?.version).toBe(2);
    const rolled = applyRefinementProposal(state, rollbackProposal(result), {
      id: "r4",
      rollbackOf: "r1",
    });
    expect(rolled.appliedEdits[0]?.applied).toBe(true);
    expect(state.entries.memory["m1"]).toBeUndefined();
    expect(state.refinements.map((event) => event.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("refuses an edit to an entry that changed during planning", () => {
    const baseline = emptyHarnessState();
    baseline.entries.memory["m1"] = entry("m1", "memory", "local", "old");
    const state = emptyHarnessState();
    state.entries.memory["m1"] = entry("m1", "memory", "local", "changed by someone else");
    const result = applyRefinementProposal(
      state,
      {
        summary: "update",
        rationale: "",
        expectedOutcome: "",
        edits: [{ ...memoryEdit("m1", "Fact", "new"), action: "update" }],
      },
      { id: "r1", baselineState: baseline },
    );
    expect(result.appliedEdits[0]?.error).toBe("entry changed during refinement planning");
    expect(state.entries.memory["m1"]?.content).toBe("changed by someone else");
  });
});

describe("ranking", () => {
  it("splits words of four or more characters and CJK bigrams", () => {
    expect(harnessQueryTerms("Fix the flaky Deploy deploy test")).toEqual([
      "flaky",
      "deploy",
      "test",
    ]);
    expect(harnessQueryTerms("部署失败")).toEqual(["部署", "署失", "失败"]);
    expect(harnessQueryTerms("run 部 tests")).toEqual(["部", "tests"]);
  });

  it("weights terms by field coverage", () => {
    const terms = harnessQueryTermsFromText("deploy");
    const titleOnly = entry("a", "memory", "local", "other", { title: "deploy notes" });
    const both = entry("b", "memory", "local", "deploy steps", { title: "deploy notes" });
    expect(scoreHarnessEntryForQuery(titleOnly, terms)).toBe(1);
    expect(scoreHarnessEntryForQuery(both, terms)).toBe(1.5);
    expect(scoreHarnessEntryForQuery(both, new Map())).toBe(0);
  });

  it("discounts terms common across the ranked entries", () => {
    const entries = [
      entry("a", "memory", "local", "deploy staging"),
      entry("b", "memory", "local", "deploy production"),
      entry("c", "memory", "local", "rotate keys"),
    ];
    const idf = harnessQueryTermIdf(entries, harnessQueryTermsFromText("deploy staging missing"));
    expect(idf.get("deploy")).toBeCloseTo(Math.log(1 + 3 / 2));
    expect(idf.get("staging")).toBeCloseTo(Math.log(1 + 3));
    expect(idf.has("missing")).toBe(false);
  });

  it("renders kinds, ranked entries, overflow and refinements", () => {
    const state = emptyHarnessState();
    for (const id of ["a", "b", "c", "d"]) {
      state.entries.memory[id] = entry(id, "memory", "global", `fact ${id}`);
    }
    state.entries.memory["z"] = entry("z", "memory", "local", "the deploy runbook");
    state.entries.skill["s"] = entry("s", "skill", "global", "checks", {
      reference: { type: "command", command: "bash check.sh" },
      arguments: { since: { type: "string" } },
    });
    state.entries.subagent["w"] = entry("w", "subagent", "global", "a reviewer");
    state.refinements.push({
      id: "r1",
      trigger: "learned something",
      changes: ["create memory:a"],
      evidence: "",
      outcome: "better",
      created_at: "",
    });
    const text = formatHarnessStateForPrompt(state, {
      queryTerms: harnessQueryTermsFromText("deploy"),
    });
    expect(text.startsWith("# Continual Harness State")).toBe(true);
    expect(text).toContain(
      "memory: 5\n(entries ranked by relevance to the current task)\n- [local:z]",
    );
    expect(text).toContain("- +2 more memory entries");
    expect(text).toContain(
      '- [global:s] Entry s (general, v1) ref={"type":"command","command":"bash check.sh"} args={"since":{"type":"string"}}: checks',
    );
    expect(text).toContain("subagent: 1 (start a spec");
    expect(text).toContain(
      "recent refinements: 1\n- [r1] learned something: create memory:a; outcome: better",
    );
    expect(formatHarnessStateForPrompt(emptyHarnessState())).toContain(
      "No saved harness entries yet.",
    );
  });
});

describe("executor", () => {
  it("mints canonical refinement ids", () => {
    expect(generateRefinementId(new Date("2026-11-26T15:04:05.678Z"))).toBe(
      "refine_20261126150405678",
    );
  });

  it("renders the overview and history sections", () => {
    const state = emptyHarnessState();
    state.entries.memory["m1"] = entry("m1", "memory", "local", "a  spaced\nfact");
    expect(overviewForPrompt(state)).toContain(
      "memory: 1\n- [local:m1] Entry m1 (general, v1): a spaced fact",
    );
    expect(historyForPrompt([])).toBe("No prior refinement history.");
    expect(
      historyForPrompt([
        {
          id: "r2",
          summary: "undo",
          rationale: "",
          expectedOutcome: "reverted",
          appliedEdits: [{ action: "delete", kind: "memory", id: "m1", applied: true }],
          harnessStatePath: "",
          rollbackOf: "r1",
        },
      ]),
    ).toBe("[r2] rollbackOf=r1 undo\napplied delete memory:m1\nExpected outcome: reverted");
  });

  it("plans with its own system prompt and rolls back without a model call", async () => {
    const captured: Captured[] = [];
    const plan = await planRefinement({
      conversationText: "user: remember the flaky test",
      state: emptyHarnessState(),
      history: [],
      model,
      options: { instructions: "capture it" },
      call: seam('{"summary":"add","edits":[]}', captured),
    });
    expect(plan.proposal.summary).toBe("add");
    expect(captured[0]?.system).toBe(REFINEMENT_SYSTEM_PROMPT);
    expect(captured[0]?.model.maxTokens).toBe(32_000);
    expect(captured[0]?.user).toContain("<user_refine_instructions>\ncapture it");
    expect(captured[0]?.user).toContain("Requested refinement scope: local.");
    const target: RefinementResult = {
      id: "r1",
      summary: "s",
      rationale: "",
      expectedOutcome: "",
      appliedEdits: [
        {
          action: "create",
          kind: "memory",
          id: "m1",
          after: entry("m1", "memory", "global", "x"),
          applied: true,
        },
      ],
      harnessStatePath: "",
    };
    const rollback = await planRefinement({
      conversationText: "",
      state: emptyHarnessState(),
      history: [target],
      model,
      options: { rollbackId: "r1" },
      call: async () => {
        throw new Error("no model call expected");
      },
    });
    expect(rollback.rollbackOf).toBe("r1");
    expect(rollback.rollbackScope).toBe("global");
    expect(rollback.proposal.edits[0]).toMatchObject({ action: "delete", id: "m1" });
    await expect(
      planRefinement({
        conversationText: "",
        state: emptyHarnessState(),
        history: [],
        model,
        options: { rollbackId: "nope" },
      }),
    ).rejects.toThrow("Refinement nope not found");
  });

  it("reports a cut-off or failed reply", async () => {
    const base = { conversationText: "x", state: emptyHarnessState(), history: [], model };
    await expect(
      planRefinement({ ...base, call: async () => reply("{", "length") }),
    ).rejects.toThrow("Refinement failed: the model hit its output limit (32000 tokens");
    await expect(planRefinement({ ...base, call: async () => reply("", "error") })).rejects.toThrow(
      "Refinement failed: provider down",
    );
  });

  it("parses the auto-refine review verdict", async () => {
    const captured: Captured[] = [];
    const review = await reviewAutoRefine({
      conversationText: "x",
      state: emptyHarnessState(),
      history: [],
      model,
      reason: "compact",
      turnsSinceLastReview: 3,
      call: seam(
        '{"shouldRefine":true,"rationale":"reusable tactic","instructions":"record it"}',
        captured,
      ),
    });
    expect(review).toEqual({
      shouldRefine: true,
      rationale: "reusable tactic",
      instructions: "record it",
    });
    expect(captured[0]?.system).toBe(AUTO_REFINE_REVIEW_SYSTEM_PROMPT);
    expect(captured[0]?.model.maxTokens).toBe(4096);
    expect(captured[0]?.user).toContain("compact; 3 assistant turns since last auto-refine review");
    expect(autoRefineInstructions("compact", review)).toBe(
      "Automatic refine review triggered by compact. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: reusable tactic\n\nReviewer instructions: record it",
    );
  });

  it("resolves auto-refine gates with defaults and clamps", () => {
    expect(resolveAutoRefineGates()).toEqual({
      enabled: true,
      turnInterval: 25,
      compact: true,
      cooldownMs: 20 * 60 * 1000,
    });
    expect(
      resolveAutoRefineGates({ enabled: false, turnInterval: 0, compact: false, cooldownMs: 5 }),
    ).toEqual({
      enabled: false,
      turnInterval: 1,
      compact: false,
      cooldownMs: 5,
    });
  });
});

describe("stores", () => {
  const proposal = (edits: unknown[]) =>
    JSON.stringify({
      summary: "learned",
      rationale: "seen twice",
      expectedOutcome: "better",
      edits,
    });

  it("refines the local store, keeps global entries read-only context, and rolls back", async () => {
    const stores = { globalDir: join(dir, "global"), localDir: join(dir, "local") };
    const global = emptyHarnessState();
    global.entries.memory["g1"] = entry("g1", "memory", "global", "global fact");
    await saveHarnessState(stores.globalDir, global);
    const captured: Captured[] = [];
    const result = await runRefinement({
      stores,
      conversationText: "user: tests are flaky on CI",
      model,
      call: seam(
        proposal([{ action: "create", kind: "memory", title: "Flaky CI", content: "retry once" }]),
        captured,
      ),
    });
    expect(captured[0]?.user).toContain("[global:g1]");
    expect(result.scope).toBe("local");
    expect(result.harnessStatePath).toBe(join(stores.localDir, "harness_state.json"));
    const snapshot = await loadContinualHarness(stores);
    expect(snapshot.state.entries.memory["flaky_ci"]?.content).toBe("retry once");
    expect(snapshot.state.entries.memory["g1"]?.scope).toBe("global");
    expect(snapshot.history.map((item) => item.id)).toEqual([result.id]);
    expect(
      JSON.parse(await readFile(join(stores.localDir, "refinement_history.jsonl"), "utf8")),
    ).toMatchObject({
      id: result.id,
    });

    const rollback = await runRefinement({
      stores,
      conversationText: "",
      model,
      options: { rollbackId: result.id },
      now: new Date(Date.now() + 1000),
    });
    expect(rollback.rollbackOf).toBe(result.id);
    expect((await loadContinualHarness(stores)).state.entries.memory["flaky_ci"]).toBeUndefined();
  });

  it("strips display prefixes and writes global refinements to the global store", async () => {
    const stores = { globalDir: join(dir, "global"), localDir: join(dir, "local") };
    const local = emptyHarnessState();
    local.entries.memory["m1"] = entry("m1", "memory", "local", "old");
    await saveHarnessState(stores.localDir, local);
    const updated = await runRefinement({
      stores,
      conversationText: "x",
      model,
      call: seam(
        proposal([
          { action: "update", kind: "memory", id: "local:m1", title: "M", content: "new" },
        ]),
      ),
    });
    expect(updated.appliedEdits[0]?.applied).toBe(true);
    expect((await loadHarnessState(stores.localDir, "local")).entries.memory["m1"]?.content).toBe(
      "new",
    );

    const globalResult = await runRefinement({
      stores,
      conversationText: "x",
      model,
      options: { global: true },
      call: seam(proposal([memoryEdit("pref", "Preference", "use pnpm")])),
    });
    expect(globalResult.scope).toBe("global");
    expect((await loadHarnessState(stores.globalDir, "global")).entries.memory["pref"]?.scope).toBe(
      "global",
    );
  });

  it("refuses a local refinement without a local store", async () => {
    await expect(
      runRefinement({ stores: { globalDir: dir }, conversationText: "x", model, call: seam("{}") }),
    ).rejects.toThrow("Local harness refinement requires a persisted session");
  });

  it("parses /refine commands", () => {
    expect(parseRefineCommand("hello")).toBeUndefined();
    expect(parseRefineCommand("/refinement")).toBeUndefined();
    expect(parseRefineCommand("/refine")).toEqual({ options: {} });
    expect(parseRefineCommand("/refine --global keep it short")).toEqual({
      options: { global: true, instructions: "keep it short" },
    });
    expect(parseRefineCommand("/refine rollback refine_123")).toEqual({
      options: { rollbackId: "refine_123" },
    });
  });
});

describe("tools", () => {
  it("schedules refinements and reads and searches entries", async () => {
    const state = emptyHarnessState();
    state.entries.memory["deploy"] = entry("deploy", "memory", "global", "deploy with railway up");
    state.entries.memory["local:keys"] = entry("keys", "memory", "local", "rotate keys monthly");
    const requests: unknown[] = [];
    const tools = createContinualTools({
      state: () => state,
      onRefine: (options) => requests.push(options),
      localAvailable: false,
    });
    const [refine, read, search] = tools;
    await expect(refine?.execute("1", {})).rejects.toThrow("no local harness store");
    const scheduled = await refine?.execute("2", { global: true, instructions: "note it" });
    expect(scheduled?.content[0]).toMatchObject({ text: expect.stringContaining("global") });
    expect(requests).toEqual([{ global: true, instructions: "note it" }]);
    const full = await read?.execute("3", { id: "global:deploy" });
    expect(full?.content[0]).toMatchObject({
      text: expect.stringContaining("deploy with railway up"),
    });
    const local = await read?.execute("4", { id: "local:keys" });
    expect(local?.details).toMatchObject({ id: "keys" });
    await expect(read?.execute("5", { id: "missing" })).rejects.toThrow(
      'no harness entry "missing"',
    );
    const hits = await search?.execute("6", { query: "railway deploy" });
    expect(hits?.details).toEqual([{ id: "deploy", kind: "memory", scope: "global" }]);
  });
});
