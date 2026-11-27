import { randomBytes } from "node:crypto";

import type { StorageContract } from "@generic-ai/sdk";

/**
 * The refused-actions list (design decision 37). Agents never wait for the owner: an action
 * outside the owner's permissions is refused on the spot, the agent finds another route, and the
 * refusal lands here for the owner to read whenever they like. Network refusals from the egress
 * proxy land here too.
 *
 * Records live in the host's own storage, which agents cannot reach.
 */
export interface RefusedAction {
  readonly id: string;
  readonly at: string;
  /** `network`: the egress proxy refused a connection. `permission`: a tool call was refused. */
  readonly kind: "network" | "permission";
  readonly agentId?: string;
  readonly taskId?: string;
  /** The permission category or `network`. */
  readonly category: string;
  /** What was tried: a tool name, or `CONNECT host:port`. */
  readonly action: string;
  readonly reason: string;
}

export type RefusedActionInput = Omit<RefusedAction, "id" | "at">;

export interface RefusalLog {
  record(input: RefusedActionInput): Promise<RefusedAction>;
  /** Newest first. */
  list(options?: { readonly limit?: number }): Promise<readonly RefusedAction[]>;
}

export const REFUSALS_NAMESPACE = "generic-corp-owner";
const COLLECTION = "refusals";
/** Only the newest refusals are kept. */
export const REFUSALS_KEPT = 500;

export function createRefusalLog(
  kv: StorageContract,
  options: { readonly now?: () => Date; readonly keep?: number } = {},
): RefusalLog {
  const now = options.now ?? (() => new Date());
  const keep = options.keep ?? REFUSALS_KEPT;
  const all = async () =>
    (await kv.list({ namespace: REFUSALS_NAMESPACE, collection: COLLECTION }))
      .map((record) => record.value as RefusedAction)
      .sort((left, right) => right.id.localeCompare(left.id));
  let writes = 0;

  return {
    async record(input) {
      const at = now();
      const entry: RefusedAction = {
        // Sortable: time first, then randomness for refusals in the same millisecond.
        id: `${at.getTime().toString().padStart(15, "0")}-${randomBytes(4).toString("hex")}`,
        at: at.toISOString(),
        ...input,
      };
      await kv.set({
        key: { namespace: REFUSALS_NAMESPACE, collection: COLLECTION, id: entry.id },
        value: entry,
        updatedAt: entry.at,
      });
      writes += 1;
      if (writes % 50 === 1) {
        const stale = (await all()).slice(keep);
        for (const old of stale) {
          await kv.delete({ namespace: REFUSALS_NAMESPACE, collection: COLLECTION, id: old.id });
        }
      }
      return entry;
    },
    async list(listOptions = {}) {
      const limit = Math.max(1, Math.min(listOptions.limit ?? 100, keep));
      return (await all()).slice(0, limit);
    },
  };
}
