import type { StorageContract } from "@generic-ai/sdk";

import {
  type CompanyConfig,
  DEFAULT_QUALITY_MODELS,
  modelFor,
  QUALITY_LEVELS,
  type QualityLevel,
} from "./company.js";

/**
 * The per-agent quality dial (design decision 22): the owner sets each agent to best, balanced
 * or cheap, and each step is a model. An agent left alone runs on the model the company file
 * gives it. The setting lives in host storage, which no agent tool can reach, and is read on
 * every turn, so a change applies from the agent's next turn.
 */

export const QUALITY_NAMESPACE = "generic-corp-owner";
const QUALITY_COLLECTION = "agent-quality";

export class QualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityError";
  }
}

export interface AgentQualityView {
  readonly agentId: string;
  /** The owner's setting, when there is one. */
  readonly level?: QualityLevel;
  /** The model the agent runs on now. */
  readonly model: string;
  /** The model from the company file, used when no level is set. */
  readonly defaultModel: string;
  /** The step `defaultModel` matches, if any, so the screen can show where "default" sits. */
  readonly defaultLevel?: QualityLevel;
  readonly updatedAt?: string;
}

export interface QualitySettingsView {
  /** The model behind each step, best first. */
  readonly levels: ReadonlyArray<{ readonly level: QualityLevel; readonly model: string }>;
  readonly agents: readonly AgentQualityView[];
}

interface StoredQuality {
  readonly level: QualityLevel;
  readonly updatedAt: string;
  readonly updatedBy?: string;
}

export interface QualityStore {
  /** The model behind each step. */
  readonly models: Readonly<Record<QualityLevel, string>>;
  /** The model this agent should run on. Synchronous: every turn reads it. */
  modelFor(agentId: string): string;
  levelOf(agentId: string): QualityLevel | undefined;
  view(agentId: string): AgentQualityView;
  /** Sets an agent's step, or clears it with `undefined` so the company file's model applies. */
  set(
    agentId: string,
    level: QualityLevel | undefined,
    updatedBy?: string,
  ): Promise<AgentQualityView>;
}

export function parseQualityLevel(value: unknown): QualityLevel | undefined {
  if (value === null || value === undefined || value === "default") {
    return undefined;
  }
  if (typeof value === "string" && QUALITY_LEVELS.includes(value as QualityLevel)) {
    return value as QualityLevel;
  }
  throw new QualityError(`Quality must be one of ${QUALITY_LEVELS.join(", ")}, or default.`);
}

/** Opens the quality store, reading every agent's setting once and caching it. */
export async function openQualityStore(
  kv: StorageContract,
  company: CompanyConfig,
  now: () => Date = () => new Date(),
): Promise<QualityStore> {
  const models: Record<QualityLevel, string> = {
    ...DEFAULT_QUALITY_MODELS,
    ...company.qualityModels,
  };
  const settings = new Map<string, StoredQuality>();
  for (const record of await kv.list({
    namespace: QUALITY_NAMESPACE,
    collection: QUALITY_COLLECTION,
  })) {
    const value = record.value as Partial<StoredQuality> | undefined;
    if (value !== undefined && QUALITY_LEVELS.includes(value.level as QualityLevel)) {
      settings.set(record.key.id, value as StoredQuality);
    }
  }

  const defaultModelOf = (agentId: string) => modelFor(company, agentId);
  const levelOfModel = (model: string) => QUALITY_LEVELS.find((level) => models[level] === model);

  const view = (agentId: string): AgentQualityView => {
    const stored = settings.get(agentId);
    const defaultModel = defaultModelOf(agentId);
    const defaultLevel = levelOfModel(defaultModel);
    return {
      agentId,
      ...(stored === undefined ? {} : { level: stored.level, updatedAt: stored.updatedAt }),
      model: stored === undefined ? defaultModel : models[stored.level],
      defaultModel,
      ...(defaultLevel === undefined ? {} : { defaultLevel }),
    };
  };

  return {
    models,
    modelFor: (agentId) => view(agentId).model,
    levelOf: (agentId) => settings.get(agentId)?.level,
    view,
    async set(agentId, level, updatedBy) {
      if (!company.agents.some((agent) => agent.id === agentId)) {
        throw new QualityError(`Agent ${agentId} was not found.`);
      }
      const key = { namespace: QUALITY_NAMESPACE, collection: QUALITY_COLLECTION, id: agentId };
      if (level === undefined) {
        await kv.delete(key);
        settings.delete(agentId);
      } else {
        const value: StoredQuality = {
          level,
          updatedAt: now().toISOString(),
          ...(updatedBy === undefined ? {} : { updatedBy }),
        };
        await kv.set({ key, value, updatedAt: value.updatedAt });
        settings.set(agentId, value);
      }
      return view(agentId);
    },
  };
}

/** Everything the quality screen shows. */
export function describeQuality(store: QualityStore, company: CompanyConfig): QualitySettingsView {
  return {
    levels: QUALITY_LEVELS.map((level) => ({ level, model: store.models[level] })),
    agents: company.agents.map((agent) => store.view(agent.id)),
  };
}
