import {
  createAgentSession,
  createAgentSessionRuntime,
  type AgentSessionRuntime,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";

export interface PiRuntimeFactories {
  readonly createAgentSession?: typeof createAgentSession;
  readonly createAgentSessionRuntime?: typeof createAgentSessionRuntime;
}

export async function createPiAgentSession(
  options: CreateAgentSessionOptions,
  factories: PiRuntimeFactories = {},
): Promise<CreateAgentSessionResult> {
  return (factories.createAgentSession ?? createAgentSession)(options);
}

export async function createPiAgentSessionRuntime(
  factory: CreateAgentSessionRuntimeFactory,
  options: Parameters<typeof createAgentSessionRuntime>[1],
  factories: PiRuntimeFactories = {},
): Promise<AgentSessionRuntime> {
  return (factories.createAgentSessionRuntime ?? createAgentSessionRuntime)(factory, options);
}
