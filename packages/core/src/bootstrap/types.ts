import type { RunEnvelope } from "@generic-ai/sdk";
import type { CanonicalEvent } from "../events/index.js";
import type { PluginDefinition, PluginHost, PluginLifecyclePhase } from "../plugin-host/index.js";
import type { Scope } from "../scope/index.js";

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

export type BootstrapPluginSlot =
  | "config"
  | "workspace"
  | "storage"
  | "queue"
  | "logging"
  | "terminalTools"
  | "fileTools"
  | "mcp"
  | "skills"
  | "delegation"
  | "messaging"
  | "memory"
  | "output"
  | "transport";

export type BootstrapPluginSource = "default" | "override" | "addon" | "custom";

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

export type BootstrapPluginConfig = Readonly<Record<string, unknown>>;

export interface BootstrapPluginSpec {
  readonly pluginId: string;
  readonly slot?: BootstrapPluginSlot;
  readonly required?: boolean;
  readonly source?: BootstrapPluginSource;
  readonly dependencies?: readonly string[];
  readonly description?: string;
  readonly config?: BootstrapPluginConfig;
}

export interface BootstrapPluginInstance {
  readonly pluginId: string;
  readonly slot?: BootstrapPluginSlot;
  readonly required: boolean;
  readonly source: BootstrapPluginSource;
  readonly config: BootstrapPluginConfig;
  readonly definition: PluginDefinition;
}

export interface BootstrapLifecycleEvent {
  readonly pluginId: string;
  readonly phase: PluginLifecyclePhase;
  readonly occurredAt: string;
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
  readonly plugins: readonly BootstrapPluginSpec[];
}

export interface BootstrapPresetInput {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly transport?: string;
  readonly capabilities?: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports?: BootstrapPortOverrides;
  readonly plugins?: readonly BootstrapPluginSpec[];
}

export interface GenericAIOptions {
  readonly preset?: BootstrapPresetInput;
  readonly capabilities?: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports?: BootstrapPortOverrides;
  readonly pluginConfig?: Readonly<Record<string, BootstrapPluginConfig>>;
  readonly createRunId?: () => string;
  readonly now?: () => string;
}

export interface GenericAIComposition {
  readonly preset: BootstrapPresetDefinition;
  readonly capabilities: ReadonlyArray<BootstrapCapabilityId>;
  readonly ports: BootstrapPorts;
  readonly pluginHost: PluginHost;
  readonly plugins: readonly BootstrapPluginInstance[];
  readonly surfaces: GenericAIComposedSurfaces;
}

export interface GenericAIComposedSurfaces {
  readonly pluginHost: PluginHost;
  readonly pluginOrder: readonly string[];
  readonly pluginConfigs: Readonly<Record<string, BootstrapPluginConfig>>;
  readonly ports: BootstrapPorts;
  readonly lifecycle: {
    readonly events: () => readonly BootstrapLifecycleEvent[];
  };
}

export interface GenericAIRunContext {
  readonly runId: string;
  readonly scope: Scope;
  readonly runtime: GenericAIBootstrap;
  readonly surfaces: GenericAIComposedSurfaces;
}

export type GenericAIRunTask<TOutput = unknown> =
  | TOutput
  | ((context: GenericAIRunContext) => TOutput | Promise<TOutput>);

export type GenericAIStreamChunk<TOutput = unknown> =
  | {
      readonly type: "event";
      readonly event: CanonicalEvent;
    }
  | {
      readonly type: "envelope";
      readonly envelope: RunEnvelope<TOutput>;
    };

export interface GenericAIBootstrap extends GenericAIComposition {
  readonly describe: () => string;
  readonly run: <TOutput = unknown>(
    task: GenericAIRunTask<TOutput>,
  ) => Promise<RunEnvelope<TOutput>>;
  readonly stream: <TOutput = unknown>(
    task: GenericAIRunTask<TOutput>,
  ) => AsyncIterable<GenericAIStreamChunk<TOutput>>;
}
