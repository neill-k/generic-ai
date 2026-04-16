import type { AgentConfig, PluginConfig, ResolvedConfig } from "@generic-ai/sdk";

export type BootstrapCapabilityId =
  | "workspace"
  | "storage"
  | "queue"
  | "logging"
  | "terminal-tools"
  | "file-tools"
  | "mcp"
  | "skills"
  | "delegation"
  | "messaging"
  | "memory"
  | "output"
  | "transport-hono";

export type BootstrapPortStatus = "expected" | "provided";

export interface BootstrapPortDescriptor {
  readonly module: string;
  readonly symbol: string;
  readonly status: BootstrapPortStatus;
  readonly note?: string;
}

export interface BootstrapPorts {
  readonly pluginHost: BootstrapPortDescriptor;
  readonly runMode: BootstrapPortDescriptor;
  readonly runEnvelope: BootstrapPortDescriptor;
  readonly piBoundary: BootstrapPortDescriptor;
}

export type BootstrapPortOverrides = {
  readonly [Key in keyof BootstrapPorts]?: Partial<BootstrapPorts[Key]>;
};

export interface BootstrapPresetDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly transport: string;
  readonly capabilities: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports: BootstrapPorts;
}

export interface BootstrapPresetInput {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly transport?: string;
  readonly capabilities?: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports?: BootstrapPortOverrides;
}

export interface GenericAIOptions {
  readonly preset?: BootstrapPresetInput;
  readonly capabilities?: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports?: BootstrapPortOverrides;
}

export interface GenericAIComposition {
  readonly preset: BootstrapPresetDefinition;
  readonly capabilities: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports: BootstrapPorts;
}

export interface GenericAIBootstrap extends GenericAIComposition {
  readonly describe: () => string;
}

export interface GenericAIResolvedConfig extends ResolvedConfig {
  readonly rootDir?: string;
  readonly configDir?: string;
}

export interface GenericAIConfigLoaderOptions<TSchemaSource = unknown> {
  readonly schemaSource?: TSchemaSource;
  readonly rejectUnknownPluginNamespaces?: boolean;
  readonly requireFramework?: boolean;
}

export interface GenericAIConfigLoadFailure {
  readonly code?: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface GenericAIConfigValidationDiagnostic {
  readonly code?: string;
  readonly message: string;
  readonly path?: string;
}

export type GenericAIConfigLoaderResult =
  | {
      readonly ok: true;
      readonly config: GenericAIResolvedConfig;
      readonly diagnostics?: readonly GenericAIConfigValidationDiagnostic[];
      readonly failures?: readonly GenericAIConfigLoadFailure[];
    }
  | {
      readonly ok: false;
      readonly diagnostics?: readonly GenericAIConfigValidationDiagnostic[];
      readonly failures?: readonly GenericAIConfigLoadFailure[];
    };

export type GenericAIConfigLoader<TSchemaSource = unknown> = (
  startDir: string,
  options: GenericAIConfigLoaderOptions<TSchemaSource>,
) => Promise<GenericAIConfigLoaderResult>;

export interface GenericAIConfigSource<TSchemaSource = unknown> {
  readonly startDir: string;
  readonly load: GenericAIConfigLoader<TSchemaSource>;
  readonly schemaSource?: TSchemaSource;
  readonly rejectUnknownPluginNamespaces?: boolean;
  readonly requireFramework?: boolean;
}

export interface GenericAIRuntimeSettingsPlan {
  readonly mode?: string;
  readonly retries?: number;
  readonly tracing?: boolean;
  readonly workspaceRoot: string;
  readonly storageProvider?: string;
  readonly queueProvider?: string;
  readonly loggingLevel?: "debug" | "info" | "warn" | "error";
}

export interface GenericAIAgentSessionPlan {
  readonly id: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly tools: readonly string[];
  readonly plugins: readonly string[];
  readonly memory?: NonNullable<AgentConfig["memory"]>;
}

export interface GenericAIPluginInitPlan {
  readonly namespace: string;
  readonly pluginId: string;
  readonly packageName?: string;
  readonly enabled: boolean;
  readonly dependsOn: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly raw: PluginConfig & Readonly<Record<string, unknown>>;
}

export interface GenericAIRuntimePlan {
  readonly runtime: GenericAIRuntimeSettingsPlan;
  readonly primaryAgent: GenericAIAgentSessionPlan;
  readonly plugins: readonly GenericAIPluginInitPlan[];
  readonly sources?: NonNullable<ResolvedConfig["sources"]>;
}

export interface GenericAIRuntimeStarterInput extends GenericAIComposition {
  readonly config: GenericAIResolvedConfig;
  readonly runtimePlan: GenericAIRuntimePlan;
}

export interface GenericAIRuntimeStartResult {
  readonly status: "planned";
  readonly plan: GenericAIRuntimePlan;
}

export type GenericAIRuntimeStarter<TResult = GenericAIRuntimeStartResult> = (
  input: GenericAIRuntimeStarterInput,
) => Promise<TResult> | TResult;

export interface GenericAIFromConfigOptions<
  TSchemaSource = unknown,
  TRuntimeStart = GenericAIRuntimeStartResult,
> extends GenericAIOptions {
  readonly config?: GenericAIResolvedConfig;
  readonly configSource?: GenericAIConfigSource<TSchemaSource>;
  readonly primaryAgentId?: string;
  readonly startRuntime?: GenericAIRuntimeStarter<TRuntimeStart>;
}

export interface GenericAIConfiguredBootstrap<TRuntimeStart = GenericAIRuntimeStartResult>
  extends GenericAIBootstrap {
  readonly config: GenericAIResolvedConfig;
  readonly runtimePlan: GenericAIRuntimePlan;
  readonly startRuntime: () => Promise<TRuntimeStart>;
}
