import type { AgentDirectory, SeedAgentsResult } from "@generic-ai/plugin-delegation";
import type { AgentHarnessHostTool, JsonObject, StorageContract } from "@generic-ai/sdk";

import { type CompanyAgentConfig, type CompanyConfig, companyAgentSeeds } from "./company.js";

/**
 * The CEO designs the org chart as the work needs (decision 51): it can hire, change and retire
 * agents. The owner can overrule any of it. The company config is the starting org; changes are
 * kept as an overlay on top of it, so a restart keeps them and the config stays as written.
 */
export type OrgActor = "ceo" | "owner";
export type OrgAction = "hire" | "change" | "retire" | "overrule";

/** An agent as the overlay sees it: the config fields the CEO may set, plus whether it is retired. */
export interface OrgAgent {
  readonly id: string;
  readonly role: string;
  readonly title?: string;
  readonly reportsTo?: string;
  readonly instructions?: string;
  readonly retired?: boolean;
}

interface OverlayEntry extends OrgAgent {
  /** Who set this agent last. The CEO leaves alone what the owner set. */
  readonly setBy: OrgActor;
}

export interface OrgChange {
  readonly id: string;
  readonly at: string;
  readonly by: OrgActor;
  readonly action: OrgAction;
  readonly agentId: string;
  /** In the product's own words, for the owner. */
  readonly summary: string;
  readonly reason?: string;
  /** The agent before this change; undefined when it did not exist. */
  readonly before?: OrgAgent;
  readonly after?: OrgAgent;
  /** Set once the owner overruled this change. */
  readonly overruledAt?: string;
  /** For an overrule: the change it undid. */
  readonly undoes?: string;
}

interface OrgState {
  readonly agents: Readonly<Record<string, OverlayEntry>>;
  readonly changes: readonly OrgChange[];
}

export class OrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgError";
  }
}

export interface CompanyOrg {
  /** The org chart after every change, as company config agents. */
  agents(): Promise<readonly CompanyAgentConfig[]>;
  /** Seeds the agent directory with the current org. Run at startup and after each change. */
  apply(): Promise<SeedAgentsResult>;
  hire(by: OrgActor, input: Omit<OrgAgent, "retired">, reason?: string): Promise<OrgChange>;
  change(
    by: OrgActor,
    agentId: string,
    fields: Partial<Pick<OrgAgent, "title" | "role" | "reportsTo" | "instructions">>,
    reason?: string,
  ): Promise<OrgChange>;
  retire(by: OrgActor, agentId: string, reason?: string): Promise<OrgChange>;
  /** Undoes a change and puts the agent back as it was. The owner's word is final. */
  overrule(changeId: string): Promise<OrgChange>;
  /** Newest first. */
  changes(options?: { readonly limit?: number }): Promise<readonly OrgChange[]>;
  /** The CEO's tools for hiring, changing and retiring. */
  tools(): AgentHarnessHostTool[];
}

const KEY = { namespace: "generic-corp", collection: "org", id: "overlay" };
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_CHANGES = 500;
const MAX_INSTRUCTIONS = 8000;

export function createCompanyOrg(options: {
  readonly kv: StorageContract;
  readonly company: CompanyConfig;
  readonly directory: AgentDirectory;
  readonly ceoId: string;
  /** Agents with work in progress cannot be retired until it is done. */
  readonly activeTaskCount: (agentId: string) => Promise<number>;
  readonly onChange?: (change: OrgChange) => void;
  readonly now?: () => Date;
  readonly createId?: () => string;
}): CompanyOrg {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const configAgents = new Map(options.company.agents.map((agent) => [agent.id, agent]));
  let cached: OrgState | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<OrgState> {
    if (cached === undefined) {
      cached = (await options.kv.get<OrgState>(KEY))?.value ?? { agents: {}, changes: [] };
    }
    return cached;
  }

  async function save(state: OrgState): Promise<void> {
    cached = state;
    await options.kv.set({ key: KEY, value: state, updatedAt: now().toISOString() });
  }

  /** One change at a time, so two hires cannot race. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  function current(state: OrgState, id: string): OrgAgent | undefined {
    const entry = state.agents[id];
    if (entry !== undefined) {
      const { setBy: _setBy, ...agent } = entry;
      return agent;
    }
    const config = configAgents.get(id);
    return config === undefined ? undefined : fromConfig(config);
  }

  function effective(state: OrgState): CompanyAgentConfig[] {
    const result: CompanyAgentConfig[] = [];
    for (const config of options.company.agents) {
      const agent = current(state, config.id);
      if (agent !== undefined && agent.retired !== true) {
        result.push(toConfig(agent, config));
      }
    }
    for (const entry of Object.values(state.agents)) {
      if (!configAgents.has(entry.id) && entry.retired !== true) {
        result.push(toConfig(entry, undefined));
      }
    }
    return result;
  }

  function active(state: OrgState, id: string): boolean {
    const agent = current(state, id);
    return agent !== undefined && agent.retired !== true;
  }

  /** Refuses a reporting line that leaves the chart or loops back on itself. */
  function checkReportsTo(state: OrgState, agentId: string, reportsTo: string | undefined): void {
    if (agentId === options.ceoId) {
      if (reportsTo !== undefined) {
        throw new OrgError("The CEO reports to the owner and nobody else.");
      }
      return;
    }
    if (reportsTo === undefined) {
      throw new OrgError("Every agent but the CEO reports to someone. Name a manager.");
    }
    if (!active(state, reportsTo)) {
      throw new OrgError(`There is no active agent "${reportsTo}" to report to.`);
    }
    let cursor: string | undefined = reportsTo;
    const seen = new Set<string>();
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === agentId) {
        throw new OrgError("That reporting line would loop back on itself.");
      }
      seen.add(cursor);
      cursor = current(state, cursor)?.reportsTo;
    }
  }

  function guardCeo(state: OrgState, by: OrgActor, agentId: string): void {
    if (by === "ceo" && state.agents[agentId]?.setBy === "owner") {
      throw new OrgError(
        `The owner set ${agentId} as it is. Leave it, or ask the owner if it truly has to change.`,
      );
    }
  }

  async function record(
    state: OrgState,
    agents: Record<string, OverlayEntry>,
    change: Omit<OrgChange, "id" | "at">,
  ): Promise<OrgChange> {
    const full: OrgChange = { id: createId(), at: now().toISOString(), ...change };
    await save({ agents, changes: [full, ...state.changes].slice(0, MAX_CHANGES) });
    await apply();
    options.onChange?.(full);
    return full;
  }

  async function apply(): Promise<SeedAgentsResult> {
    const agents = effective(await load());
    const result = await options.directory.seed(companyAgentSeeds({ ...options.company, agents }));
    for (const agent of agents) {
      await options.directory.ensureWorkspace(agent.id);
    }
    return result;
  }

  const org: CompanyOrg = {
    async agents() {
      return effective(await load());
    },

    apply,

    hire: (by, input, reason) =>
      serial(async () => {
        const state = await load();
        const id = input.id.trim().toLowerCase();
        if (!ID.test(id)) {
          throw new OrgError(
            "An agent id is lowercase letters, digits and dashes, like vp-sales or analyst-2.",
          );
        }
        if (current(state, id) !== undefined) {
          throw new OrgError(
            `"${id}" is taken${active(state, id) ? "" : " by a retired agent"}. Pick another id.`,
          );
        }
        const role = input.role.trim();
        if (role.length === 0) {
          throw new OrgError("Give the new agent a role, like vp-sales or analyst.");
        }
        checkReportsTo(state, id, input.reportsTo);
        const agent = clean({ ...input, id, role });
        const summary = `Hired ${agent.title ?? agent.role} (${id}), reporting to ${agent.reportsTo}.`;
        return record(
          state,
          { ...state.agents, [id]: { ...agent, setBy: by } },
          {
            by,
            action: "hire",
            agentId: id,
            summary,
            ...(reason === undefined ? {} : { reason }),
            after: agent,
          },
        );
      }),

    change: (by, agentId, fields, reason) =>
      serial(async () => {
        const state = await load();
        const before = current(state, agentId);
        if (before === undefined || before.retired === true) {
          throw new OrgError(`There is no active agent "${agentId}".`);
        }
        guardCeo(state, by, agentId);
        const after = clean({ ...before, ...fields });
        if (after.role.trim().length === 0) {
          throw new OrgError("The role cannot be empty.");
        }
        if (fields.reportsTo !== undefined || agentId === options.ceoId) {
          checkReportsTo(state, agentId, after.reportsTo);
        }
        const what = Object.keys(fields)
          .map((key) => (key === "reportsTo" ? `now reports to ${after.reportsTo}` : `new ${key}`))
          .join(", ");
        return record(
          state,
          { ...state.agents, [agentId]: { ...after, setBy: by } },
          {
            by,
            action: "change",
            agentId,
            summary: `Changed ${after.title ?? after.role} (${agentId}): ${what || "no visible change"}.`,
            ...(reason === undefined ? {} : { reason }),
            before,
            after,
          },
        );
      }),

    retire: (by, agentId, reason) =>
      serial(async () => {
        const state = await load();
        const before = current(state, agentId);
        if (before === undefined || before.retired === true) {
          throw new OrgError(`There is no active agent "${agentId}".`);
        }
        if (agentId === options.ceoId) {
          throw new OrgError("The CEO cannot be retired.");
        }
        guardCeo(state, by, agentId);
        const busy = await options.activeTaskCount(agentId);
        if (busy > 0) {
          throw new OrgError(
            `${agentId} still has ${busy} ${busy === 1 ? "task" : "tasks"} in progress. Let them finish or cancel them first.`,
          );
        }
        // Its reports move up to its manager.
        const agents: Record<string, OverlayEntry> = {
          ...state.agents,
          [agentId]: { ...before, retired: true, setBy: by },
        };
        const moved: string[] = [];
        for (const agent of effective(state)) {
          if (agent.reportsTo === agentId) {
            const report = current(state, agent.id) as OrgAgent;
            agents[agent.id] = {
              ...report,
              ...(before.reportsTo === undefined ? {} : { reportsTo: before.reportsTo }),
              setBy: state.agents[agent.id]?.setBy ?? by,
            };
            moved.push(agent.id);
          }
        }
        return record(state, agents, {
          by,
          action: "retire",
          agentId,
          summary:
            `Retired ${before.title ?? before.role} (${agentId}).` +
            (moved.length === 0 ? "" : ` ${moved.join(", ")} now report to ${before.reportsTo}.`),
          ...(reason === undefined ? {} : { reason }),
          before,
          after: { ...before, retired: true },
        });
      }),

    overrule: (changeId) =>
      serial(async () => {
        const state = await load();
        const target = state.changes.find((change) => change.id === changeId);
        if (target === undefined) {
          throw new OrgError("No such org change.");
        }
        if (target.overruledAt !== undefined) {
          throw new OrgError("That change was already overruled.");
        }
        if (target.action === "overrule") {
          throw new OrgError("An overrule cannot be overruled. Change the agent directly instead.");
        }
        const agentId = target.agentId;
        const now_ = current(state, agentId);
        if (target.action !== "retire" && now_ !== undefined && now_.retired !== true) {
          const busy = target.action === "hire" ? await options.activeTaskCount(agentId) : 0;
          if (busy > 0) {
            throw new OrgError(
              `${agentId} has ${busy} ${busy === 1 ? "task" : "tasks"} in progress. Cancel them before undoing the hire.`,
            );
          }
        }
        if (target.before?.reportsTo !== undefined && !active(state, target.before.reportsTo)) {
          throw new OrgError(
            `${agentId} used to report to ${target.before.reportsTo}, who is no longer here.`,
          );
        }
        const restored: OrgAgent = target.before ?? {
          ...(target.after as OrgAgent),
          retired: true,
        };
        const changes = state.changes.map((change) =>
          change.id === changeId ? { ...change, overruledAt: now().toISOString() } : change,
        );
        const agents = { ...state.agents, [agentId]: { ...restored, setBy: "owner" as const } };
        return record({ ...state, changes }, agents, {
          by: "owner",
          action: "overrule",
          agentId,
          summary:
            target.action === "hire"
              ? `Undid the hire of ${agentId}.`
              : target.action === "retire"
                ? `Brought ${agentId} back.`
                : `Put ${agentId} back as it was.`,
          undoes: changeId,
          ...(now_ === undefined ? {} : { before: now_ }),
          after: restored,
        });
      }),

    async changes(listOptions = {}) {
      return (await load()).changes.slice(0, listOptions.limit ?? 100);
    },

    tools: () => orgTools(org),
  };
  return org;
}

function fromConfig(config: CompanyAgentConfig): OrgAgent {
  return clean({
    id: config.id,
    role: config.role,
    ...(config.title === undefined ? {} : { title: config.title }),
    ...(config.reportsTo === undefined ? {} : { reportsTo: config.reportsTo }),
    ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
  });
}

/** Overlay fields on top of the config entry, so models, tiers and secrets in config stay. */
function toConfig(agent: OrgAgent, config: CompanyAgentConfig | undefined): CompanyAgentConfig {
  const { retired: _retired, ...fields } = agent;
  const base: Record<string, unknown> = { ...(config ?? {}) };
  for (const key of ["title", "reportsTo", "instructions"] as const) {
    delete base[key];
  }
  // A move to another manager changes the tier, so a tier fixed in config no longer applies.
  if (config?.reportsTo !== agent.reportsTo) {
    delete base["tier"];
  }
  return { ...(base as Partial<CompanyAgentConfig>), ...fields } as CompanyAgentConfig;
}

function clean(agent: OrgAgent): OrgAgent {
  const trimmed = (value: string | undefined) => {
    const text = value?.trim();
    return text === undefined || text.length === 0 ? undefined : text;
  };
  const title = trimmed(agent.title);
  const reportsTo = trimmed(agent.reportsTo);
  const instructions = trimmed(agent.instructions);
  if (instructions !== undefined && instructions.length > MAX_INSTRUCTIONS) {
    throw new OrgError(`Instructions are limited to ${MAX_INSTRUCTIONS} characters.`);
  }
  return {
    id: agent.id,
    role: agent.role.trim(),
    ...(title === undefined ? {} : { title }),
    ...(reportsTo === undefined ? {} : { reportsTo }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(agent.retired === true ? { retired: true } : {}),
  };
}

const text = (params: JsonObject, key: string): string | undefined => {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
};

/** The CEO's tools. Each refusal says why, so the CEO can fix the call in the same turn. */
function orgTools(org: CompanyOrg): AgentHarnessHostTool[] {
  const run = async (work: () => Promise<OrgChange>) => {
    try {
      const change = await work();
      return { text: `${change.summary} It takes effect for new work right away.` };
    } catch (error) {
      if (error instanceof OrgError) {
        return { text: error.message, isError: true };
      }
      throw error;
    }
  };
  const reason = { type: "string", description: "Why, in a sentence. The owner reads this." };
  return [
    {
      name: "hire_agent",
      label: "Hire Agent",
      description:
        "Add an agent to the org chart when the work needs a role nobody has. It reports to an " +
        "existing agent and gets the same tools as everyone else. The owner can undo it.",
      promptSnippet: "hire_agent: add a role to the org chart when the work needs one",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lowercase id, like vp-sales or analyst-2." },
          role: { type: "string", description: "Role, like vp-sales or analyst." },
          title: { type: "string", description: "Job title, like VP of Sales." },
          reportsTo: { type: "string", description: "Id of the manager." },
          instructions: { type: "string", description: "What this agent owns and how it works." },
          reason,
        },
        required: ["id", "role", "reportsTo"],
        additionalProperties: false,
      },
      effects: ["handoff.write"],
      execute: (params) =>
        run(() =>
          org.hire(
            "ceo",
            {
              id: text(params, "id") ?? "",
              role: text(params, "role") ?? "",
              ...optional("title", text(params, "title")),
              ...optional("reportsTo", text(params, "reportsTo")),
              ...optional("instructions", text(params, "instructions")),
            },
            text(params, "reason"),
          ),
        ),
    },
    {
      name: "change_agent",
      label: "Change Agent",
      description:
        "Change an agent's title, role, instructions or manager. Only the fields you pass change.",
      promptSnippet: "change_agent: retitle, re-scope or move an agent in the org chart",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          title: { type: "string" },
          reportsTo: { type: "string" },
          instructions: { type: "string" },
          reason,
        },
        required: ["id"],
        additionalProperties: false,
      },
      effects: ["handoff.write"],
      execute: (params) =>
        run(() =>
          org.change(
            "ceo",
            text(params, "id") ?? "",
            {
              ...optional("role", text(params, "role")),
              ...optional("title", text(params, "title")),
              ...optional("reportsTo", text(params, "reportsTo")),
              ...optional("instructions", text(params, "instructions")),
            },
            text(params, "reason"),
          ),
        ),
    },
    {
      name: "retire_agent",
      label: "Retire Agent",
      description:
        "Remove an agent from the org chart once it has no work in progress. Its reports move up " +
        "to its manager. Its memory is kept, and the owner can bring it back.",
      promptSnippet: "retire_agent: remove a role that is no longer needed",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, reason },
        required: ["id"],
        additionalProperties: false,
      },
      effects: ["handoff.write"],
      execute: (params) =>
        run(() => org.retire("ceo", text(params, "id") ?? "", text(params, "reason"))),
    },
  ];
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
