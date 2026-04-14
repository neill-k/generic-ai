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
