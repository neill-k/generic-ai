import type { PersistentAgentSeed } from "@generic-ai/plugin-delegation";
import { McpRegistryError, parseMcpPluginConfig } from "@generic-ai/plugin-mcp";
import type { WebSearchProviderConfig } from "@generic-ai/plugin-tools-web";
import { type GoalSpec, GoalSpecError, parseGoalSpec } from "@generic-ai/sdk";
import { parse as parseYaml } from "yaml";

import { type CompanyPermissions, PermissionsError, parsePermissions } from "./permissions.js";

/**
 * The company: who works at Generic Corp, whom they report to, and which
 * model each level of the org chart runs on (D3: models per role in config).
 *
 * A company is plain data so it can live in YAML next to the deployment. It
 * seeds the persistent agent directory on every start; agents keep their
 * memory and workspaces across restarts and config changes.
 */
export type OrgTier = "ceo" | "vp" | "ic";

export const ORG_TIERS: readonly OrgTier[] = ["ceo", "vp", "ic"];

export interface CompanyAgentConfig {
  readonly id: string;
  /** Org-chart role, for example `ceo`, `vp-research`, `analyst`. */
  readonly role: string;
  readonly title?: string;
  readonly reportsTo?: string;
  readonly instructions?: string;
  /** Model reference (`provider/model-id`). Overrides the tier default. */
  readonly model?: string;
  /** Harness role kind that governs tools. Defaults by tier. */
  readonly roleKind?: string;
  /** Org tier. Derived from the reporting line when omitted. */
  readonly tier?: OrgTier;
  /**
   * Secrets this agent may use in tool calls as `{{secret:NAME}}`: exact names, `PREFIX_*`
   * patterns, or `*`. Values never reach the model. Omit for none.
   */
  readonly secrets?: readonly string[];
}

/**
 * Tools for generic work (D6), shared by every agent. Role policies decide who may call what,
 * and the owner's permissions decide which outward actions (sending, external writes, payments)
 * are allowed at all.
 */
export interface CompanyToolsConfig {
  /**
   * The `web_search` backend. Keys go in `${NAME}` placeholders that resolve from the secrets
   * vault, then the environment. When omitted, a `BRAVE_API_KEY` or `TAVILY_API_KEY` secret
   * turns search on.
   */
  readonly webSearch?: WebSearchProviderConfig;
  /**
   * MCP servers and connectors (email, calendar, chat, documents, browser, payments), in the
   * `@generic-ai/plugin-mcp` config shape.
   */
  readonly mcp?: Readonly<Record<string, unknown>>;
}

/**
 * A goal the company knows how to pursue: what the owner asks for, and the machine-checkable
 * definition of done the CEO's task is held to. Templates ship a few; the owner starts from one
 * on the dashboard, and each template's eval suite replays them.
 */
export interface CompanyGoalTemplate {
  readonly id: string;
  readonly title: string;
  /** The request as the owner would send it to the CEO. */
  readonly request: string;
  readonly description?: string;
  /** The goal the CEO's task must reach. Its `id` is the template goal's id. */
  readonly spec: GoalSpec;
}

export interface CompanyConfig {
  readonly name: string;
  /** Which template this company came from, when it came from one. */
  readonly template?: string;
  readonly mission?: string;
  /** Default model per org tier. */
  readonly models?: Partial<Readonly<Record<OrgTier, string>>>;
  /**
   * Models for second opinions (the rubric judge, the impossibility reviewer), in order of
   * preference. Each review uses the first one that differs from the worker's model; without
   * this, the tier models are tried.
   */
  readonly judgeModels?: readonly string[];
  readonly tools?: CompanyToolsConfig;
  /**
   * The starting permissions (see permissions.ts): reading outside systems on, sending messages,
   * spending money and writing to outside systems off, unless this says otherwise. Once the owner
   * saves permissions in the app, those replace these.
   */
  readonly permissions?: CompanyPermissions;
  /** Goals the owner can start from. */
  readonly goals?: readonly CompanyGoalTemplate[];
  readonly agents: readonly CompanyAgentConfig[];
}

export class CompanyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyConfigError";
  }
}

export const DEFAULT_TIER_MODELS: Readonly<Record<OrgTier, string>> = Object.freeze({
  ceo: "anthropic/claude-opus-5-5",
  vp: "anthropic/claude-sonnet-5-5",
  ic: "anthropic/claude-sonnet-5-5",
});

/**
 * Every tier defaults to the `builder` role kind: managers write plans and
 * their own memory file, and generic work needs files at every level.
 */
const DEFAULT_ROLE_KIND = "builder";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The default company: a CEO, three VPs and one individual contributor under
 * each. It is deliberately not software-only (D6): research, operations and
 * engineering all report to the CEO. The `generic-corp` template is the same
 * org chart in YAML, plus goals; a test keeps the two in step.
 */
export const DEFAULT_COMPANY: CompanyConfig = Object.freeze({
  name: "Generic Corp",
  mission: "We care deeply about our employees. Our employees pursue the owner's goals.",
  agents: Object.freeze([
    {
      id: "ceo",
      role: "ceo",
      title: "Chief Executive Officer",
      instructions:
        "You run Generic Corp for its owner. Turn each request from the owner into a clear goal " +
        "with a definition of done, delegate the work to the VP who owns that area, review what " +
        "comes back, and answer the owner plainly. Do small things yourself. When the answer is a " +
        "document, have it saved in this goal's deliverables folder on the drive and hand it in " +
        "with submit_work, naming the file, so the owner and the goal checks can open it.",
    },
    {
      id: "vp-research",
      role: "vp-research",
      title: "VP of Research",
      reportsTo: "ceo",
      instructions:
        "You own research: finding, reading and summarising information from the web and from " +
        "documents. Break work into tasks for your team and check their sources.",
    },
    {
      id: "vp-operations",
      role: "vp-operations",
      title: "VP of Operations",
      reportsTo: "ceo",
      instructions:
        "You own operations: plans, schedules, correspondence drafts, spreadsheets and reports. " +
        "Nothing leaves the company unless the owner's permissions allow it.",
    },
    {
      id: "vp-engineering",
      role: "vp-engineering",
      title: "VP of Engineering",
      reportsTo: "ceo",
      instructions:
        "You own software work: code, scripts, automation and data processing. Prefer a script " +
        "that can be rerun over doing repetitive work by hand.",
    },
    {
      id: "researcher",
      role: "researcher",
      title: "Research Analyst",
      reportsTo: "vp-research",
    },
    {
      id: "operations-associate",
      role: "operations-associate",
      title: "Operations Associate",
      reportsTo: "vp-operations",
    },
    {
      id: "engineer",
      role: "engineer",
      title: "Software Engineer",
      reportsTo: "vp-engineering",
    },
  ]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const raw = value[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CompanyConfigError(`${where}.${key} must be a non-empty string.`);
  }
  return raw.trim();
}

function readTier(value: string | undefined, where: string): OrgTier | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(ORG_TIERS as readonly string[]).includes(value)) {
    throw new CompanyConfigError(`${where}.tier must be one of ${ORG_TIERS.join(", ")}.`);
  }
  return value as OrgTier;
}

const SECRET_GRANT_PATTERN = /^(\*|[A-Za-z_][A-Za-z0-9_]*(_\*|\*)?)$/;

function readSecretGrants(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new CompanyConfigError(`${where} must be a list of secret names.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !SECRET_GRANT_PATTERN.test(entry.trim())) {
      throw new CompanyConfigError(
        `${where} entries must be secret names such as GITHUB_TOKEN, patterns such as SEARCH_*, or *.`,
      );
    }
    return entry.trim();
  });
}

const WEB_SEARCH_PROVIDERS: ReadonlySet<string> = new Set(["brave", "tavily", "searxng"]);

function readTools(value: unknown): CompanyToolsConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new CompanyConfigError("company.tools must be an object.");
  }
  const webSearch = value["webSearch"];
  if (webSearch !== undefined) {
    if (!isRecord(webSearch) || !WEB_SEARCH_PROVIDERS.has(String(webSearch["provider"]))) {
      throw new CompanyConfigError(
        "company.tools.webSearch.provider must be brave, tavily or searxng.",
      );
    }
    const required = webSearch["provider"] === "searxng" ? "baseUrl" : "apiKey";
    if (typeof webSearch[required] !== "string" || webSearch[required].trim().length === 0) {
      throw new CompanyConfigError(
        `company.tools.webSearch.${required} is required for ${String(webSearch["provider"])}.`,
      );
    }
  }
  const mcp = value["mcp"];
  if (mcp !== undefined) {
    if (!isRecord(mcp)) {
      throw new CompanyConfigError("company.tools.mcp must be an object with a servers list.");
    }
    try {
      parseMcpPluginConfig(mcp);
    } catch (error) {
      if (error instanceof McpRegistryError) {
        throw new CompanyConfigError(`company.tools.mcp: ${error.message}`);
      }
      throw error;
    }
  }
  return {
    ...(webSearch === undefined
      ? {}
      : { webSearch: webSearch as unknown as WebSearchProviderConfig }),
    ...(mcp === undefined ? {} : { mcp: mcp as Record<string, unknown> }),
  };
}

function readGoals(value: unknown): readonly CompanyGoalTemplate[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new CompanyConfigError("company.goals must be a list of goals.");
  }
  const seen = new Set<string>();
  return value.map((raw, index): CompanyGoalTemplate => {
    const where = `company.goals[${index}]`;
    if (!isRecord(raw)) {
      throw new CompanyConfigError(`${where} must be an object.`);
    }
    const id = optionalString(raw, "id", where);
    if (id === undefined || !ID_PATTERN.test(id)) {
      throw new CompanyConfigError(
        `${where}.id must be letters, digits, dots, dashes or underscores.`,
      );
    }
    if (seen.has(id)) {
      throw new CompanyConfigError(`Goal "${id}" is defined twice.`);
    }
    seen.add(id);
    const title = optionalString(raw, "title", where) ?? id;
    const request = optionalString(raw, "request", where);
    if (request === undefined) {
      throw new CompanyConfigError(`${where}.request must say what the owner asks for.`);
    }
    const description = optionalString(raw, "description", where);
    if (!isRecord(raw["goal"])) {
      throw new CompanyConfigError(
        `${where}.goal must be a goal spec: objective, definitionOfDone and validators.`,
      );
    }
    const parsed = parseGoalSpec({ id, title, ...raw["goal"] });
    if (!parsed.ok) {
      throw new CompanyConfigError(`${where}.goal: ${new GoalSpecError(parsed.issues).message}`);
    }
    return {
      id,
      title,
      request,
      ...(description === undefined ? {} : { description }),
      spec: parsed.value,
    };
  });
}

/** A company goal by id. */
export function companyGoal(
  company: CompanyConfig,
  goalId: string,
): CompanyGoalTemplate | undefined {
  return company.goals?.find((goal) => goal.id === goalId);
}

/** Validates an untrusted company definition (for example parsed YAML). */
export function parseCompanyConfig(input: unknown): CompanyConfig {
  if (!isRecord(input)) {
    throw new CompanyConfigError("The company config must be an object.");
  }
  const name = optionalString(input, "name", "company") ?? DEFAULT_COMPANY.name;
  const mission = optionalString(input, "mission", "company");
  const template = optionalString(input, "template", "company");

  let judgeModels: string[] | undefined;
  if (input["judgeModels"] !== undefined) {
    const raw = input["judgeModels"];
    if (
      !Array.isArray(raw) ||
      raw.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
    ) {
      throw new CompanyConfigError("company.judgeModels must be a list of model references.");
    }
    judgeModels = raw.map((entry) => (entry as string).trim());
  }
  let models: Partial<Record<OrgTier, string>> | undefined;
  if (input["models"] !== undefined) {
    if (!isRecord(input["models"])) {
      throw new CompanyConfigError("company.models must map ceo, vp and ic to model references.");
    }
    models = {};
    for (const [key, value] of Object.entries(input["models"])) {
      const tier = readTier(key, "company.models");
      if (tier === undefined || typeof value !== "string" || value.trim().length === 0) {
        throw new CompanyConfigError(`company.models.${key} must be a model reference.`);
      }
      models[tier] = value.trim();
    }
  }

  const rawAgents = input["agents"];
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new CompanyConfigError("company.agents must list at least one agent.");
  }
  const agents = rawAgents.map((raw, index): CompanyAgentConfig => {
    const where = `company.agents[${index}]`;
    if (!isRecord(raw)) {
      throw new CompanyConfigError(`${where} must be an object.`);
    }
    const id = optionalString(raw, "id", where);
    if (id === undefined || !ID_PATTERN.test(id) || id.includes("..")) {
      throw new CompanyConfigError(
        `${where}.id must be letters, digits, dots, dashes or underscores.`,
      );
    }
    const role = optionalString(raw, "role", where) ?? id;
    const title = optionalString(raw, "title", where);
    const reportsTo = optionalString(raw, "reportsTo", where);
    const instructions = optionalString(raw, "instructions", where);
    const model = optionalString(raw, "model", where);
    const roleKind = optionalString(raw, "roleKind", where);
    const tier = readTier(optionalString(raw, "tier", where), where);
    const secrets = readSecretGrants(raw["secrets"], `${where}.secrets`);
    return {
      id,
      role,
      ...(title === undefined ? {} : { title }),
      ...(reportsTo === undefined ? {} : { reportsTo }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(model === undefined ? {} : { model }),
      ...(roleKind === undefined ? {} : { roleKind }),
      ...(tier === undefined ? {} : { tier }),
      ...(secrets === undefined ? {} : { secrets }),
    };
  });
  const tools = readTools(input["tools"]);
  if (input["approvals"] !== undefined) {
    throw new CompanyConfigError(
      "company.approvals was replaced by company.permissions: agents never wait for approval, and actions outside the owner's permissions are refused.",
    );
  }
  let permissions: CompanyPermissions | undefined;
  if (input["permissions"] !== undefined) {
    try {
      permissions = parsePermissions(input["permissions"]);
    } catch (error) {
      throw new CompanyConfigError(
        `company.permissions: ${error instanceof PermissionsError ? error.message : String(error)}`,
      );
    }
  }

  const goals = readGoals(input["goals"]);

  const company: CompanyConfig = {
    name,
    ...(template === undefined ? {} : { template }),
    ...(mission === undefined ? {} : { mission }),
    ...(models === undefined ? {} : { models }),
    ...(judgeModels === undefined ? {} : { judgeModels }),
    ...(tools === undefined ? {} : { tools }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(goals === undefined ? {} : { goals }),
    agents,
  };
  validateOrgChart(company);
  return company;
}

/** Parses a company from YAML text. */
export function parseCompanyYaml(text: string): CompanyConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new CompanyConfigError(
      `The company YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseCompanyConfig(parsed);
}

/**
 * Checks the org chart: unique ids, managers that exist, no reporting cycles,
 * and exactly one CEO (the one agent with no manager).
 */
export function validateOrgChart(company: CompanyConfig): void {
  const byId = new Map<string, CompanyAgentConfig>();
  for (const agent of company.agents) {
    if (byId.has(agent.id)) {
      throw new CompanyConfigError(`Agent "${agent.id}" is defined twice.`);
    }
    byId.set(agent.id, agent);
  }
  const roots = company.agents.filter((agent) => agent.reportsTo === undefined);
  if (roots.length !== 1) {
    throw new CompanyConfigError(
      `The org chart needs exactly one agent without a manager (the CEO); found ${roots.length}.`,
    );
  }
  for (const agent of company.agents) {
    if (agent.reportsTo !== undefined && !byId.has(agent.reportsTo)) {
      throw new CompanyConfigError(
        `Agent "${agent.id}" reports to "${agent.reportsTo}", which is not in the company.`,
      );
    }
    const seen = new Set<string>([agent.id]);
    let manager = agent.reportsTo;
    while (manager !== undefined) {
      if (seen.has(manager)) {
        throw new CompanyConfigError(`The reporting line of "${agent.id}" loops back on itself.`);
      }
      seen.add(manager);
      manager = byId.get(manager)?.reportsTo;
    }
  }
}

/** The CEO: the one agent at the top of the org chart. */
export function ceoOf(company: CompanyConfig): CompanyAgentConfig {
  const ceo = company.agents.find((agent) => agent.reportsTo === undefined);
  if (ceo === undefined) {
    throw new CompanyConfigError("The company has no CEO.");
  }
  return ceo;
}

/** The agent's tier: explicit, or from its distance to the CEO. */
export function tierOf(company: CompanyConfig, agentId: string): OrgTier {
  const agent = company.agents.find((entry) => entry.id === agentId);
  if (agent?.tier !== undefined) {
    return agent.tier;
  }
  if (agent?.reportsTo === undefined) {
    return "ceo";
  }
  const manager = company.agents.find((entry) => entry.id === agent.reportsTo);
  return manager?.reportsTo === undefined ? "vp" : "ic";
}

/** The model an agent runs on: its own, else its tier's, else the built-in default. */
export function modelFor(company: CompanyConfig, agentId: string): string {
  const agent = company.agents.find((entry) => entry.id === agentId);
  const tier = tierOf(company, agentId);
  return agent?.model ?? company.models?.[tier] ?? DEFAULT_TIER_MODELS[tier];
}

/** Persistent agent seeds for the agent directory, with models and role kinds resolved. */
export function companyAgentSeeds(company: CompanyConfig): readonly PersistentAgentSeed[] {
  return company.agents.map((agent) => {
    const tier = tierOf(company, agent.id);
    return {
      id: agent.id,
      role: agent.role,
      ...(agent.title === undefined ? {} : { title: agent.title }),
      ...(agent.reportsTo === undefined ? {} : { reportsTo: agent.reportsTo }),
      ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
      model: modelFor(company, agent.id),
      roleKind: agent.roleKind ?? DEFAULT_ROLE_KIND,
      metadata: { tier },
    };
  });
}
