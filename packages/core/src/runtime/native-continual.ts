import { basename, dirname, join } from "node:path";

import type { Agent, AgentTool, StreamFn } from "@generic-ai/agent";
import type { AssistantMessage, Model } from "@generic-ai/ai";
import {
  type AutoRefineGates,
  autoRefineInstructions,
  type ContinualHarnessStores,
  createContinualTools,
  createRefinerCall,
  formatHarnessStateForPrompt,
  formatRefinementNotice,
  type HarnessState,
  harnessQueryTermsFromText,
  loadContinualHarness,
  type RefinementResult,
  type RefineOptions,
  type RefinerCall,
  resolveAutoRefineGates,
  reviewAutoRefine,
  runRefinement,
} from "@generic-ai/continual";
import {
  type CustomMessage,
  convertToLlm,
  type SessionManager,
  serializeConversation,
} from "@generic-ai/session";

/**
 * The continual harness for a native session (Prime Agent's `/refine`; see
 * `docs/continual-harness.md`): supplemental prompt notes, memories, skills and subagent specs
 * that the agent refines from evidence, kept in a global store shared by sessions and a local
 * store of the session's own.
 */
export interface NativeSessionContinual {
  /** The global store, shared by every session (for example `<agent dir>/harness`). */
  readonly globalDir: string;
  /**
   * This session's own store. Defaults to `<session file>.harness` next to the session's JSONL
   * file; an in-memory session without one can only make global refinements.
   */
  readonly localDir?: string;
  /**
   * Automatic refinement: a short review after a compaction and every `turnInterval` assistant
   * turns (default 25, at most once per `cooldownMs`, default 20 minutes) decides whether to
   * refine the local store. On by default; `false` turns it off.
   */
  readonly autoRefine?: Partial<AutoRefineGates> | false;
  /** The model for refinement passes. Defaults to the session's model. */
  readonly model?: Model;
  /** Entries per kind shown in the system prompt. Default 3. */
  readonly maxEntriesPerKind?: number;
}

export const REFINEMENT_NOTICE_CUSTOM_TYPE = "refinement_notice";

export type RefinementSource = "user" | "auto";

export interface SessionContinual {
  readonly tools: AgentTool[];
  /** The harness block for the system prompt, ranked by relevance to `query`. */
  promptSection(query: string): string;
  /** Counts assistant turns for the automatic review. */
  bindAgent(agent: Agent): () => void;
  /** Arms the automatic review after a compaction. */
  markCompacted(): void;
  /** Runs refinements the agent asked for, then the automatic review when it is due. */
  afterPrompt(agent: Agent): Promise<readonly RefinementResult[]>;
  /** Runs one refinement now (a `/refine` command). */
  refine(agent: Agent, options: RefineOptions, source: RefinementSource): Promise<RefinementResult>;
}

export function defaultLocalHarnessDir(sessionFile: string): string {
  return join(dirname(sessionFile), `${basename(sessionFile, ".jsonl")}.harness`);
}

export async function createSessionContinual(input: {
  readonly options: NativeSessionContinual | undefined;
  readonly sessionManager: SessionManager;
  readonly model: Model;
  readonly apiKey?: string;
  readonly streamFn?: StreamFn;
  readonly signal?: AbortSignal;
  readonly onRefined: (result: RefinementResult, source: RefinementSource) => void | Promise<void>;
  readonly onError: (error: unknown, source: RefinementSource) => void | Promise<void>;
  readonly onUsage?: (message: AssistantMessage, purpose: string) => void | Promise<void>;
}): Promise<SessionContinual | undefined> {
  const options = input.options;
  if (options === undefined) {
    return undefined;
  }
  const sessionFile = input.sessionManager.getSessionFile();
  const localDir =
    options.localDir ??
    (sessionFile === undefined ? undefined : defaultLocalHarnessDir(sessionFile));
  const stores: ContinualHarnessStores = {
    globalDir: options.globalDir,
    ...(localDir === undefined ? {} : { localDir }),
  };
  let state: HarnessState = (await loadContinualHarness(stores)).state;
  const reload = async () => {
    state = (await loadContinualHarness(stores)).state;
  };
  const model = options.model ?? input.model;
  const apiKey = input.apiKey;
  const baseCall: RefinerCall =
    input.streamFn === undefined
      ? createRefinerCall({
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : async (requestModel, systemPrompt, userPrompt) => {
          const stream = await (input.streamFn as StreamFn)(
            requestModel,
            {
              systemPrompt,
              messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
            },
            {
              maxTokens: requestModel.maxTokens,
              ...(apiKey === undefined ? {} : { apiKey }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            },
          );
          return stream.result();
        };
  const call =
    (purpose: string): RefinerCall =>
    async (requestModel, systemPrompt, userPrompt) => {
      const reply = await baseCall(requestModel, systemPrompt, userPrompt);
      await input.onUsage?.(reply, purpose);
      return reply;
    };
  const gates =
    options.autoRefine === false ? undefined : resolveAutoRefineGates(options.autoRefine);
  const pending: RefineOptions[] = [];
  let compacted = false;
  let turnsSinceReview = 0;
  let lastReviewAt: number | undefined;

  const conversation = (agent: Agent) =>
    serializeConversation(convertToLlm([...agent.state.messages]));

  const deliver = (agent: Agent, result: RefinementResult, source: RefinementSource) => {
    if (!result.appliedEdits.some((edit) => edit.applied)) {
      return;
    }
    const content = `[${source}-refinement]\n\n${formatRefinementNotice(result)}`;
    const details = {
      refinementId: result.id,
      summary: result.summary,
      scope: result.scope ?? "local",
      source,
      ...(result.rollbackOf === undefined ? {} : { rollbackOf: result.rollbackOf }),
    };
    input.sessionManager.appendCustomMessageEntry(
      REFINEMENT_NOTICE_CUSTOM_TYPE,
      content,
      false,
      details,
    );
    const notice: CustomMessage = {
      role: "custom",
      customType: REFINEMENT_NOTICE_CUSTOM_TYPE,
      content,
      display: false,
      details,
      timestamp: Date.now(),
    };
    agent.state.messages = [...agent.state.messages, notice];
  };

  const refine = async (agent: Agent, refineOptions: RefineOptions, source: RefinementSource) => {
    const result = await runRefinement({
      stores,
      conversationText: conversation(agent),
      model,
      options: refineOptions,
      call: call("refinement"),
    });
    await reload();
    deliver(agent, result, source);
    await input.onRefined(result, source);
    return result;
  };

  const autoReason = (): string | undefined => {
    if (gates === undefined || !gates.enabled || stores.localDir === undefined) {
      return undefined;
    }
    if (lastReviewAt !== undefined && Date.now() - lastReviewAt < gates.cooldownMs) {
      return undefined;
    }
    if (compacted && gates.compact) {
      return "compact";
    }
    return turnsSinceReview >= gates.turnInterval ? "turn interval" : undefined;
  };

  return {
    tools: createContinualTools({
      state: () => state,
      onRefine: (refineOptions) => pending.push(refineOptions),
      localAvailable: stores.localDir !== undefined,
    }) as AgentTool[],
    promptSection: (query) =>
      formatHarnessStateForPrompt(state, {
        queryTerms: harnessQueryTermsFromText(query),
        ...(options.maxEntriesPerKind === undefined
          ? {}
          : { maxEntriesPerKind: options.maxEntriesPerKind }),
      }),
    bindAgent: (agent) =>
      agent.subscribe((event) => {
        if (
          event.type === "message_end" &&
          "role" in event.message &&
          event.message.role === "assistant"
        ) {
          turnsSinceReview += 1;
        }
      }),
    markCompacted: () => {
      compacted = true;
    },
    afterPrompt: async (agent) => {
      const results: RefinementResult[] = [];
      while (pending.length > 0) {
        const next = pending.shift() as RefineOptions;
        try {
          results.push(await refine(agent, next, "user"));
        } catch (error) {
          await input.onError(error, "user");
        }
      }
      const reason = autoReason();
      if (reason === undefined) {
        return results;
      }
      const turns = turnsSinceReview;
      compacted = false;
      turnsSinceReview = 0;
      lastReviewAt = Date.now();
      try {
        const loaded = await loadContinualHarness(stores);
        const review = await reviewAutoRefine({
          conversationText: conversation(agent),
          state: loaded.state,
          history: loaded.history,
          model,
          reason,
          turnsSinceLastReview: turns,
          call: call("refinement_review"),
        });
        if (review.shouldRefine) {
          results.push(
            await refine(agent, { instructions: autoRefineInstructions(reason, review) }, "auto"),
          );
        }
      } catch (error) {
        await input.onError(error, "auto");
      }
      return results;
    },
    refine,
  };
}
