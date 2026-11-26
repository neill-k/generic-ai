import type { PiCapabilityBindings } from "@generic-ai/core";
import { createMcpPlugin, type McpPlugin, type McpServerStatus } from "@generic-ai/plugin-mcp";
import type { SecretsBroker } from "@generic-ai/plugin-secrets";
import { createDocumentTools } from "@generic-ai/plugin-tools-documents";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import {
  createTerminalToolPlugin,
  type TerminalRunAsUser,
} from "@generic-ai/plugin-tools-terminal";
import {
  createWebSearchProvider,
  createWebToolsPlugin,
  type WebSearchProvider,
  type WebSearchProviderConfig,
  WebSearchProviderError,
} from "@generic-ai/plugin-tools-web";
import type { AgentTaskExecutionInput } from "@generic-ai/sdk";

import type { CompanyConfig } from "./company.js";

/**
 * The generic-work toolkit (D6) for every agent turn: files and a shell in the agent's home,
 * web fetch and search, document reading and writing, and the company's MCP connectors (email,
 * calendar, chat, documents, browser, payments).
 *
 * Every tool carries effect tags. Role policies decide who sees a tool, and outward effects
 * (`message.send`, `external.write`, `payment.spend`, `mcp.write`) are what the approvals gate
 * holds for the owner. Credentials resolve host-side from the secrets vault, so agents use them
 * without seeing them.
 */
export interface CompanyToolkit {
  /** Tool bindings for one agent turn, rooted at that agent's home directory. */
  capabilities(input: AgentTaskExecutionInput): PiCapabilityBindings;
  /** Secret grants for an agent, from the company config. */
  secretGrants(agentId: string): readonly string[] | undefined;
  /** What the toolkit offers, for the dashboard. */
  describe(): CompanyToolkitDescription;
  close(): Promise<void>;
}

export interface CompanyToolkitDescription {
  readonly tools: readonly CompanyToolDescription[];
  readonly webSearch: { readonly provider: string; readonly configured: boolean };
  readonly connectors: readonly CompanyConnectorDescription[];
}

export interface CompanyToolDescription {
  readonly name: string;
  readonly group: "files" | "terminal" | "web" | "documents";
  readonly description: string;
}

export interface CompanyConnectorDescription extends McpServerStatus {
  readonly connector?: string;
}

/** A secret the company config refers to, and who needs it. */
export interface CompanySecretReference {
  readonly name: string;
  /** Where it is used: `web search`, `connector <id>`, `agent <id>`. */
  readonly usedBy: readonly string[];
  /** True when any one of a group of alternatives is enough (the search keys). */
  readonly optional?: boolean;
}

function collectPlaceholders(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) {
      into.add(match[1] as string);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectPlaceholders(entry, into);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      collectPlaceholders(entry, into);
    }
  }
}

/**
 * The secrets a company's config refers to: `${NAME}` placeholders in the search and connector
 * settings, and exact names in agents' grants. Patterns such as `CRM_*` are not listed.
 */
export function companySecretReferences(company: CompanyConfig): readonly CompanySecretReference[] {
  const references = new Map<string, { usedBy: string[]; optional: boolean }>();
  const add = (name: string, usedBy: string, optional = false) => {
    const entry = references.get(name) ?? { usedBy: [], optional };
    if (!entry.usedBy.includes(usedBy)) {
      entry.usedBy.push(usedBy);
    }
    entry.optional &&= optional;
    references.set(name, entry);
  };
  const webSearch = company.tools?.webSearch;
  if (webSearch === undefined) {
    for (const config of AUTO_SEARCH) {
      for (const name of placeholderNames(config)) {
        add(name, "web search", true);
      }
    }
  } else {
    for (const name of placeholderNames(webSearch)) {
      add(name, "web search");
    }
  }
  const servers = company.tools?.mcp?.["servers"];
  if (Array.isArray(servers)) {
    for (const server of servers) {
      if (
        typeof server === "object" &&
        server !== null &&
        "enabled" in server &&
        server.enabled === false
      ) {
        continue;
      }
      const names = new Set<string>();
      collectPlaceholders(server, names);
      const id =
        typeof server === "object" && server !== null && "id" in server
          ? String((server as { id: unknown }).id)
          : "?";
      for (const name of names) {
        add(name, `connector ${id}`);
      }
    }
  }
  for (const agent of company.agents) {
    for (const grant of agent.secrets ?? []) {
      if (!grant.includes("*")) {
        add(grant, `agent ${agent.id}`);
      }
    }
  }
  return [...references.entries()]
    .map(([name, entry]) => ({
      name,
      usedBy: entry.usedBy,
      ...(entry.optional ? { optional: true } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface CreateCompanyToolkitOptions {
  readonly company: CompanyConfig;
  readonly secrets?: SecretsBroker;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the MCP plugin, for tests. */
  readonly mcp?: McpPlugin;
  /** Replaces the search backend, for tests. */
  readonly searchProvider?: WebSearchProvider;
  /** Lets web tools reach private addresses. Local development only. */
  readonly allowPrivateNetwork?: boolean;
  /** Runs agent shell commands as another OS user (see `resolveAgentIsolation`). */
  readonly runAs?: TerminalRunAsUser;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Search backends tried, in order, when the company config names none. */
const AUTO_SEARCH: readonly WebSearchProviderConfig[] = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a config placeholder, resolved per search.
  { provider: "brave", apiKey: "${BRAVE_API_KEY}" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a config placeholder, resolved per search.
  { provider: "tavily", apiKey: "${TAVILY_API_KEY}" },
];

function placeholderNames(config: WebSearchProviderConfig): string[] {
  const names = new Set<string>();
  for (const value of Object.values(config)) {
    if (typeof value === "string") {
      for (const match of value.matchAll(PLACEHOLDER)) {
        names.add(match[1] as string);
      }
    }
  }
  return [...names];
}

/**
 * A search provider whose keys are looked up on each search (vault first, then the
 * environment), so a key the owner adds on the secrets screen works without a restart.
 */
function createLazySearchProvider(
  configured: WebSearchProviderConfig | undefined,
  lookup: (name: string) => Promise<string | undefined>,
): WebSearchProvider {
  const candidates = configured === undefined ? AUTO_SEARCH : [configured];
  return {
    name: configured?.provider ?? "auto",
    async search(request) {
      for (const config of candidates) {
        const env: Record<string, string | undefined> = {};
        let complete = true;
        for (const name of placeholderNames(config)) {
          env[name] = await lookup(name);
          complete &&= env[name] !== undefined && env[name] !== "";
        }
        if (!complete && configured === undefined) {
          continue;
        }
        return createWebSearchProvider(config, { env }).search(request);
      }
      throw new WebSearchProviderError(
        "auto",
        "Web search is not set up. Add a BRAVE_API_KEY or TAVILY_API_KEY secret, or set tools.webSearch in the company config.",
      );
    },
  };
}

export function createCompanyToolkit(options: CreateCompanyToolkitOptions): CompanyToolkit {
  const env = options.env ?? process.env;
  const secrets = options.secrets;
  const lookup = async (name: string): Promise<string | undefined> =>
    (await secrets?.get(name, "host")) ?? env[name];
  const searchProvider =
    options.searchProvider ?? createLazySearchProvider(options.company.tools?.webSearch, lookup);
  const mcpConfig = options.company.tools?.mcp;
  const mcp =
    options.mcp ??
    (mcpConfig === undefined
      ? undefined
      : createMcpPlugin(mcpConfig, secrets === undefined ? {} : { secrets }));
  const grants = new Map(options.company.agents.map((agent) => [agent.id, agent.secrets] as const));

  const build = (root: string) => {
    const files = createWorkspaceFileTools({ root });
    const terminal = createTerminalToolPlugin({
      root,
      ...(options.runAs === undefined ? {} : { runAs: options.runAs }),
    });
    const web = createWebToolsPlugin({
      root,
      searchProvider,
      ...(options.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    });
    const documents = createDocumentTools({ root });
    return { files, terminal, web, documents };
  };

  return {
    capabilities(input) {
      const { files, terminal, web, documents } = build(input.workspaceRoot);
      return {
        fileTools: { piTools: files.piTools },
        terminalTools: { tool: terminal.tool },
        customTools: [...web.piTools, ...documents.piTools],
        ...(mcp === undefined ? {} : { mcp: mcp.capability }),
        ...(secrets === undefined ? {} : { secrets }),
      } as unknown as PiCapabilityBindings;
    },
    secretGrants(agentId) {
      return grants.get(agentId);
    },
    describe() {
      const sample = build(process.cwd());
      const describeTools = (
        group: CompanyToolDescription["group"],
        tools: readonly { readonly name: string; readonly description?: string }[],
      ): CompanyToolDescription[] =>
        tools.map((tool) => ({ name: tool.name, group, description: tool.description ?? "" }));
      const terminalTool = sample.terminal.tool as {
        readonly name: string;
        readonly description?: string;
      };
      const servers = new Map((mcp?.config.servers ?? []).map((server) => [server.id, server]));
      return {
        tools: [
          ...describeTools("files", sample.files.piTools),
          ...describeTools("terminal", [terminalTool]),
          ...describeTools("web", sample.web.piTools),
          ...describeTools("documents", sample.documents.piTools),
        ],
        webSearch: {
          provider: options.company.tools?.webSearch?.provider ?? searchProvider.name,
          configured: options.company.tools?.webSearch !== undefined,
        },
        connectors: (mcp?.manager.status() ?? []).map((status) => {
          const connector = servers.get(status.id)?.connector;
          return connector === undefined ? status : { ...status, connector };
        }),
      };
    },
    async close() {
      await mcp?.close();
    },
  };
}
