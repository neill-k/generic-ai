// The continual harness stores: a global store shared across sessions and a session's local store,
// and the refine flow over them. Adapted from Prime Agent's `session_engine/refine.rs`
// (PrimeIntellect-ai/prime-agent).
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { resolve } from "node:path";

import type { Model } from "@generic-ai/ai";

import {
  applyRefinementPlan,
  planRefinement,
  type RefinementPlan,
  type RefineOptions,
  type RefinerCall,
} from "./executor.js";
import {
  appendRefinementHistory,
  type HarnessScope,
  type HarnessState,
  harnessStatePath,
  inferRefinementResultScope,
  loadHarnessState,
  loadRefinementHistory,
  mergeHarnessStates,
  mergeRefinementHistory,
  type RefinementResult,
  saveHarnessState,
} from "./state.js";

export interface ContinualHarnessStores {
  /** Shared by every session, for example `<agent dir>/harness`. */
  readonly globalDir: string;
  /** This session's own store. Without one, only global refinements can be made. */
  readonly localDir?: string;
}

export interface HarnessSnapshot {
  readonly state: HarnessState;
  readonly history: readonly RefinementResult[];
}

export const LOCAL_REFINEMENT_NEEDS_SESSION =
  "Local harness refinement requires a persisted session; use global refinement instead.";

/** The merged state and history the agent sees: global entries plus this session's own. */
export async function loadContinualHarness(
  stores: ContinualHarnessStores,
): Promise<HarnessSnapshot> {
  const global = await loadHarnessState(stores.globalDir, "global");
  const local =
    stores.localDir === undefined ? undefined : await loadHarnessState(stores.localDir, "local");
  const globalHistory = await loadRefinementHistory(stores.globalDir, "global");
  const localHistory =
    stores.localDir === undefined ? [] : await loadRefinementHistory(stores.localDir, "local");
  return {
    state: mergeHarnessStates(global, local),
    history: mergeRefinementHistory(globalHistory, localHistory),
  };
}

function storeDir(stores: ContinualHarnessStores, scope: HarnessScope): string {
  if (scope === "global") {
    return stores.globalDir;
  }
  if (stores.localDir === undefined) {
    throw new Error(LOCAL_REFINEMENT_NEEDS_SESSION);
  }
  return stores.localDir;
}

/** Drops the display-only `local:` and `global:` prefixes from planned edit ids. */
export function stripDisplayPrefixes(plan: RefinementPlan): RefinementPlan {
  return {
    ...plan,
    proposal: {
      ...plan.proposal,
      edits: plan.proposal.edits.map((edit) => {
        const id = edit.id;
        if (id === undefined) {
          return edit;
        }
        const stripped = id.startsWith("local:")
          ? id.slice(6)
          : id.startsWith("global:")
            ? id.slice(7)
            : id;
        return { ...edit, id: stripped };
      }),
    },
  };
}

export interface RunRefinementInput {
  readonly stores: ContinualHarnessStores;
  readonly conversationText: string;
  readonly model: Model;
  readonly options?: RefineOptions;
  readonly call?: RefinerCall;
  readonly now?: Date;
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after any earlier task on the same store in this process. */
async function serialized<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  try {
    return await next;
  } finally {
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  }
}

/**
 * The full refine flow: plan (a model pass, or a rollback), reload the target store, apply with a
 * stale check against the state read before planning, save, and append to that store's history.
 */
export async function runRefinement(input: RunRefinementInput): Promise<RefinementResult> {
  const options = input.options ?? {};
  const requested: HarnessScope = options.global === true ? "global" : "local";
  if (options.rollbackId === undefined && requested === "local") {
    storeDir(input.stores, "local");
  }
  const globalState = await loadHarnessState(input.stores.globalDir, "global");
  const planningState =
    requested === "global"
      ? globalState
      : mergeHarnessStates(
          globalState,
          input.stores.localDir === undefined
            ? undefined
            : await loadHarnessState(input.stores.localDir, "local"),
        );
  const history = mergeRefinementHistory(
    await loadRefinementHistory(input.stores.globalDir, "global"),
    input.stores.localDir === undefined
      ? []
      : await loadRefinementHistory(input.stores.localDir, "local"),
  );
  const rollbackTarget =
    options.rollbackId === undefined
      ? undefined
      : history.find((item) => item.id === options.rollbackId);
  const baselineScope =
    (rollbackTarget === undefined ? undefined : inferRefinementResultScope(rollbackTarget)) ??
    requested;
  const baselineState = await loadHarnessState(
    storeDir(input.stores, baselineScope),
    baselineScope,
  );
  const plan = stripDisplayPrefixes(
    await planRefinement({
      conversationText: input.conversationText,
      state: planningState,
      history,
      model: input.model,
      options,
      ...(input.call === undefined ? {} : { call: input.call }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  );
  const targetScope = plan.rollbackScope ?? requested;
  const targetDir = storeDir(input.stores, targetScope);
  if (rollbackTarget !== undefined && rollbackTarget.harnessStatePath.length > 0) {
    const recorded = resolve(rollbackTarget.harnessStatePath);
    const current = resolve(harnessStatePath(targetDir));
    if (recorded !== current) {
      throw new Error(
        `Refinement ${rollbackTarget.id} was recorded against the harness store ${recorded}, not this session's current store ${current}; the rollback is refused rather than edit a store the refinement never touched.`,
      );
    }
  }
  return serialized(targetDir, async () => {
    const state = await loadHarnessState(targetDir, targetScope);
    const applied = applyRefinementPlan(state, plan, options, baselineState);
    const path = await saveHarnessState(targetDir, state);
    const result: RefinementResult = { ...applied, harnessStatePath: path, scope: targetScope };
    await appendRefinementHistory(targetDir, result);
    return result;
  });
}

/** A `/refine` command: `/refine [--global] [instructions]` or `/refine rollback <id>`. */
export interface RefineCommand {
  readonly options: RefineOptions;
}

/** Parses a `/refine` prompt. Returns undefined when the text is not a refine command. */
export function parseRefineCommand(text: string): RefineCommand | undefined {
  const match = /^\/refine(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  let rest = (match[1] ?? "").trim();
  let global = false;
  if (/^--global(\s|$)/.test(rest)) {
    global = true;
    rest = rest.slice("--global".length).trim();
  }
  const rollback = /^rollback\s+(\S+)\s*$/.exec(rest);
  if (rollback !== null) {
    return { options: { rollbackId: rollback[1] as string, ...(global ? { global } : {}) } };
  }
  return {
    options: { ...(global ? { global } : {}), ...(rest.length > 0 ? { instructions: rest } : {}) },
  };
}
