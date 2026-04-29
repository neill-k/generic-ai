import type {
  AgentConfig,
  AgentHarnessConfig,
  ResolvedConfig,
  StorageContract,
} from "@generic-ai/sdk";
import type {
  CanonicalConfigEdit,
  CanonicalConfigTransactionFailure,
  CanonicalConfigTransactionPlan,
} from "@generic-ai/plugin-config-yaml";

export const name = "@generic-ai/plugin-web-ui" as const;
export const kind = "web-ui" as const;

export type WebUiTemplateStatus = "runnable" | "preview";
export type WebUiTemplateEffect =
  | "fs.read"
  | "fs.write"
  | "process.spawn"
  | "network.egress"
  | "mcp.read";
export type WebUiChatThreadStatus = "idle" | "running" | "interrupted" | "failed" | "completed";
export type WebUiChatRole = "user" | "assistant" | "system";

export interface WebUiTopologyNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly description?: string;
}

export interface WebUiTopologyEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface WebUiTemplateDefinition {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly status: WebUiTemplateStatus;
  readonly topology: {
    readonly nodes: readonly WebUiTopologyNode[];
    readonly edges: readonly WebUiTopologyEdge[];
  };
  readonly effects: readonly WebUiTemplateEffect[];
  readonly previewReason?: string;
  readonly sampleTask?: string;
  readonly edits: readonly CanonicalConfigEdit[];
}

export interface WebUiTemplateSummary {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly status: WebUiTemplateStatus;
  readonly effects: readonly WebUiTemplateEffect[];
  readonly previewReason?: string;
}

export interface WebUiConfigSnapshot {
  readonly rootDir: string;
  readonly configDir: string;
  readonly revision: string;
  readonly config?: ResolvedConfig;
  readonly failures: readonly CanonicalConfigTransactionFailure[];
}

export interface WebUiHealth {
  readonly plugin: typeof name;
  readonly workspaceRoot: string;
  readonly routePrefix: string;
  readonly config: {
    readonly ok: boolean;
    readonly revision?: string;
    readonly primaryAgent?: string;
    readonly primaryHarness?: string;
  };
  readonly templates: {
    readonly total: number;
    readonly runnable: number;
    readonly preview: number;
  };
  readonly security: {
    readonly loopbackOnly: boolean;
    readonly requiresSessionTokenForMutation: boolean;
    readonly requiresSessionTokenForRead: boolean;
  };
}

export interface WebUiConfigPreviewInput {
  readonly edits: readonly CanonicalConfigEdit[];
  readonly expectedRevision?: string;
}

export interface WebUiConfigApplyInput extends WebUiConfigPreviewInput {
  readonly idempotencyKey?: string;
}

export type WebUiConfigMutationResult =
  | {
      readonly ok: true;
      readonly plan: CanonicalConfigTransactionPlan;
      readonly config?: ResolvedConfig;
      readonly failures: [];
    }
  | {
      readonly ok: false;
      readonly plan?: CanonicalConfigTransactionPlan;
      readonly failures: readonly CanonicalConfigTransactionFailure[];
    };

export interface WebUiTemplateApplyInput {
  readonly dryRun?: boolean;
  readonly expectedRevision?: string;
  readonly idempotencyKey?: string;
}

export interface WebUiChatThread {
  readonly id: string;
  readonly title: string;
  readonly status: WebUiChatThreadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly selectedAgentId?: string;
  readonly selectedHarnessId?: string;
}

export interface WebUiChatMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: WebUiChatRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface WebUiChatEvent {
  readonly id: string;
  readonly sequence: number;
  readonly threadId: string;
  readonly type:
    | "thread.created"
    | "message.created"
    | "run.started"
    | "run.completed"
    | "run.failed"
    | "run.interrupted";
  readonly occurredAt: string;
  readonly data: Record<string, unknown>;
}

export interface WebUiChatThreadDetail {
  readonly thread: WebUiChatThread;
  readonly messages: readonly WebUiChatMessage[];
  readonly events: readonly WebUiChatEvent[];
}

export interface WebUiPostMessageInput {
  readonly content: string;
  readonly selectedAgentId?: string;
  readonly selectedHarnessId?: string;
}

export interface WebUiHarnessRunnerInput {
  readonly thread: WebUiChatThread;
  readonly message: WebUiChatMessage;
  readonly config?: ResolvedConfig;
  readonly agent?: AgentConfig;
  readonly harness?: AgentHarnessConfig;
  readonly signal: AbortSignal;
}

export interface WebUiHarnessRunnerResult {
  readonly content: string;
  readonly status?: Extract<WebUiChatThreadStatus, "completed" | "failed">;
  readonly metadata?: Record<string, unknown>;
}

export type WebUiHarnessRunner = (
  input: WebUiHarnessRunnerInput,
) => Promise<WebUiHarnessRunnerResult> | WebUiHarnessRunnerResult;

export interface WebUiStorageContract extends StorageContract {}

export interface WebUiTemplateRegistry {
  list(): readonly WebUiTemplateDefinition[];
  get(id: string): WebUiTemplateDefinition | undefined;
}

export interface WebUiPluginOptions {
  readonly workspaceRoot: string;
  readonly storage?: WebUiStorageContract;
  readonly templates?: WebUiTemplateRegistry;
  readonly harnessRunner?: WebUiHarnessRunner;
  readonly sessionToken?: string;
  readonly now?: () => string | number | Date;
  readonly idFactory?: () => string;
}

export interface WebUiPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly workspaceRoot: string;
  readonly sessionToken: string;
  health(routePrefix: string): Promise<WebUiHealth>;
  getConfig(): Promise<WebUiConfigSnapshot>;
  previewConfig(input: WebUiConfigPreviewInput): Promise<WebUiConfigMutationResult>;
  applyConfig(input: WebUiConfigApplyInput): Promise<WebUiConfigMutationResult>;
  listTemplates(): readonly WebUiTemplateSummary[];
  getTemplate(id: string): WebUiTemplateDefinition | undefined;
  applyTemplate(id: string, input: WebUiTemplateApplyInput): Promise<WebUiConfigMutationResult>;
  listThreads(): Promise<readonly WebUiChatThread[]>;
  getThread(threadId: string): Promise<WebUiChatThreadDetail | undefined>;
  postMessage(
    threadId: string,
    input: WebUiPostMessageInput,
    signal: AbortSignal,
  ): Promise<WebUiChatThreadDetail>;
  interruptThread(threadId: string): Promise<WebUiChatThreadDetail | undefined>;
  streamThreadEvents(threadId: string, fromSequence?: number): AsyncIterable<WebUiChatEvent>;
}

export interface WebUiTransportSecurityOptions {
  readonly sessionToken?: string;
  readonly allowRemote?: boolean;
  readonly authorize?: (request: Request) => Promise<Response | undefined> | Response | undefined;
  readonly trustRequestUrlLoopback?: boolean;
  readonly requireSessionTokenForRead?: boolean;
}
