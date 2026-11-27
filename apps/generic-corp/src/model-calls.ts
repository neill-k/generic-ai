import type { CanonicalEvent, ModelUsage, RunStoreContract } from "@generic-ai/sdk";

/**
 * Model calls outside agent turns: the rubric judge, the impossibility reviewer, the preference
 * scanner and dreaming. Each is saved as a small run with one `usage.recorded` event, so it counts
 * on the usage page and, through the metered run store, toward spending limits like any turn.
 *
 * The owner runs the company on his Claude plan, where every call draws on the same usage limit,
 * so no call goes uncounted.
 */
export const MODEL_CALL_RUN_KIND = "model-call";

export type ModelCallPurpose = "rubric-judge" | "impossibility-review" | "preferences" | "dreaming";

export interface ModelCallRecord {
  /** The agent the call was for; company-wide work (the preference scanner) leaves it out. */
  readonly agentId?: string;
  /** The owner request it belongs to, for cost per finished goal. */
  readonly rootTaskId?: string;
  readonly purpose: ModelCallPurpose;
  /** `provider/model`. */
  readonly model: string;
  readonly usage: ModelUsage;
}

export interface ModelCallLog {
  record(call: ModelCallRecord): Promise<void>;
}

export function createModelCallLog(options: {
  /** Pass the metered run store so the spend reaches the limits. */
  readonly runStore: RunStoreContract;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}): ModelCallLog {
  const now = options.now ?? (() => new Date());
  let counter = 0;
  return {
    async record(call) {
      if (call.usage.totalTokens <= 0 && call.usage.cost.total <= 0) {
        return;
      }
      counter += 1;
      const at = now().toISOString();
      const runId = `model-call-${now().getTime()}-${counter}`;
      const slash = call.model.indexOf("/");
      const provider = slash > 0 ? call.model.slice(0, slash) : "unknown";
      const model = slash > 0 ? call.model.slice(slash + 1) : call.model;
      const scopeId = `model-call/${call.purpose}`;
      try {
        await options.runStore.saveRun({
          envelope: {
            kind: "run-envelope",
            runId,
            rootScopeId: scopeId,
            ...(call.agentId === undefined ? {} : { rootAgentId: call.agentId }),
            mode: "sync",
            status: "succeeded",
            timestamps: { createdAt: at, startedAt: at, completedAt: at },
            eventStream: { kind: "event-stream-reference", streamId: runId },
          },
          metadata: {
            kind: MODEL_CALL_RUN_KIND,
            purpose: call.purpose,
            ...(call.agentId === undefined ? {} : { agentId: call.agentId }),
            ...(call.rootTaskId === undefined ? {} : { input: { rootTaskId: call.rootTaskId } }),
          },
        });
        const event = {
          eventId: `${runId}:1`,
          sequence: 1,
          occurredAt: at,
          name: "usage.recorded",
          origin: { namespace: "core" },
          scopeId,
          runId,
          rootSessionId: runId,
          sessionId: call.agentId ?? runId,
          data: {
            provider,
            model,
            usage: call.usage,
            purpose: call.purpose,
            ...(call.agentId === undefined ? {} : { agentId: call.agentId }),
          },
        } as unknown as CanonicalEvent;
        await options.runStore.appendEvents(runId, [event]);
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}

/**
 * Wraps a side call so its outcome reaches the plan limit, as agent turns' outcomes do: a call
 * that fails on the plan's usage limit marks the plan limited, and one that gets through resets
 * the backoff.
 */
export function withPlanObserver<I, O>(
  call: (input: I) => O | PromiseLike<O>,
  modelOf: (input: I) => string,
  observe: (model: string, error?: unknown) => Promise<void>,
): (input: I) => Promise<O> {
  return async (input) => {
    let result: O;
    try {
      result = await call(input);
    } catch (error) {
      await observe(modelOf(input), error);
      throw error;
    }
    await observe(modelOf(input));
    return result;
  };
}
