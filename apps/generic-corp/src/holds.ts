import type { AgentHold, DelegationCascade } from "@generic-ai/plugin-delegation";
import type { StorageContract } from "@generic-ai/sdk";

/**
 * Holds on work (decisions 15 and 33). The owner can pause the whole company or one agent;
 * other parts of the app (spending and plan limits) register their own hold sources. The
 * delegation cascade asks `holdFor` before each turn and at the end of each step: a held agent
 * starts nothing new and a running turn stops after its current step. When a hold may have
 * lifted, `changed()` gives the waiting work a fresh turn.
 */
export interface PauseState {
  readonly company?: { readonly since: string };
  readonly agents: Readonly<Record<string, { readonly since: string }>>;
}

export type HoldSource = (
  agentId: string,
) => Promise<AgentHold | undefined> | AgentHold | undefined;

export interface CompanyHolds {
  holdFor(agentId: string): Promise<AgentHold | undefined>;
  pauseState(): Promise<PauseState>;
  pauseCompany(paused: boolean): Promise<PauseState>;
  pauseAgent(agentId: string, paused: boolean): Promise<PauseState>;
  /** Adds a hold source, such as spending limits. Returns a function that removes it. */
  register(source: HoldSource): () => void;
  /** Call when a hold may have lifted; held work whose hold is gone gets a fresh turn. */
  changed(): Promise<number>;
  /** Set once the cascade exists. */
  attach(cascade: DelegationCascade): void;
}

const KEY = { namespace: "generic-corp", collection: "pause", id: "state" };

export const COMPANY_PAUSE_REASON = "Paused. You paused the company; work resumes when you say so.";
export const AGENT_PAUSE_REASON = "Paused. You paused this agent; work resumes when you say so.";

export function createCompanyHolds(options: {
  readonly kv: StorageContract;
  readonly now?: () => Date;
}): CompanyHolds {
  const now = options.now ?? (() => new Date());
  const sources = new Set<HoldSource>();
  let cascade: DelegationCascade | undefined;
  let cached: PauseState | undefined;

  async function load(): Promise<PauseState> {
    if (cached === undefined) {
      cached = (await options.kv.get<PauseState>(KEY))?.value ?? { agents: {} };
    }
    return cached;
  }

  async function save(state: PauseState): Promise<PauseState> {
    cached = state;
    await options.kv.set({ key: KEY, value: state, updatedAt: now().toISOString() });
    return state;
  }

  const changed = async () => (cascade === undefined ? 0 : cascade.resumeHeld());

  return {
    async holdFor(agentId) {
      const state = await load();
      if (state.company !== undefined) {
        return { kind: "owner-pause", reason: COMPANY_PAUSE_REASON };
      }
      if (state.agents[agentId] !== undefined) {
        return { kind: "owner-pause", reason: AGENT_PAUSE_REASON };
      }
      for (const source of sources) {
        const hold = await source(agentId);
        if (hold !== undefined) {
          return hold;
        }
      }
      return undefined;
    },

    pauseState: load,

    async pauseCompany(paused) {
      const state = await load();
      const { company: _company, ...rest } = state;
      const next = await save(
        paused ? { ...rest, company: state.company ?? { since: now().toISOString() } } : rest,
      );
      if (!paused) {
        await changed();
      }
      return next;
    },

    async pauseAgent(agentId, paused) {
      const state = await load();
      const { [agentId]: _current, ...others } = state.agents;
      const agents = paused
        ? { ...others, [agentId]: state.agents[agentId] ?? { since: now().toISOString() } }
        : others;
      const next = await save({ ...state, agents });
      if (!paused) {
        await changed();
      }
      return next;
    },

    register(source) {
      sources.add(source);
      return () => {
        sources.delete(source);
      };
    },

    changed,

    attach(value) {
      cascade = value;
    },
  };
}
