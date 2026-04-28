import { randomUUID } from "node:crypto";

export const canonicalEventFamilies = [
  "run",
  "session",
  "delegation",
  "handoff",
  "tool",
  "terminal",
  "policy",
  "hook",
  "artifact",
  "plugin",
] as const;

export type CanonicalEventFamily = (typeof canonicalEventFamilies)[number];

export const canonicalRunLifecycleNames = [
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export type CanonicalRunLifecycleName = (typeof canonicalRunLifecycleNames)[number];

export const canonicalSessionLifecycleNames = [
  "session.created",
  "session.started",
  "session.completed",
  "session.failed",
  "session.cancelled",
  "session.child.created",
  "session.child.started",
  "session.child.completed",
  "session.child.failed",
  "session.child.cancelled",
] as const;

export type CanonicalSessionLifecycleName = (typeof canonicalSessionLifecycleNames)[number];

export const canonicalDelegationLifecycleNames = [
  "delegation.requested",
  "delegation.accepted",
  "delegation.rejected",
  "delegation.completed",
  "delegation.failed",
  "delegation.cancelled",
] as const;

export type CanonicalDelegationLifecycleName = (typeof canonicalDelegationLifecycleNames)[number];

export const canonicalHandoffLifecycleNames = [
  "handoff.requested",
  "handoff.accepted",
  "handoff.completed",
  "handoff.failed",
  "handoff.cancelled",
] as const;

export type CanonicalHandoffLifecycleName = (typeof canonicalHandoffLifecycleNames)[number];

export const canonicalToolCallLifecycleNames = [
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
] as const;

export type CanonicalToolCallLifecycleName = (typeof canonicalToolCallLifecycleNames)[number];

export const canonicalTerminalCommandLifecycleNames = [
  "terminal.command.started",
  "terminal.command.completed",
  "terminal.command.failed",
] as const;

export type CanonicalTerminalCommandLifecycleName =
  (typeof canonicalTerminalCommandLifecycleNames)[number];

export const canonicalPolicyLifecycleNames = ["policy.decision"] as const;

export type CanonicalPolicyLifecycleName = (typeof canonicalPolicyLifecycleNames)[number];

export const canonicalHookLifecycleNames = [
  "hook.execution.started",
  "hook.execution.completed",
  "hook.execution.failed",
  "hook.decision",
] as const;

export type CanonicalHookLifecycleName = (typeof canonicalHookLifecycleNames)[number];

export const canonicalArtifactLifecycleNames = ["artifact.created"] as const;

export type CanonicalArtifactLifecycleName = (typeof canonicalArtifactLifecycleNames)[number];

export const canonicalCoreEventNames = [
  ...canonicalRunLifecycleNames,
  ...canonicalSessionLifecycleNames,
  ...canonicalDelegationLifecycleNames,
  ...canonicalHandoffLifecycleNames,
  ...canonicalToolCallLifecycleNames,
  ...canonicalTerminalCommandLifecycleNames,
  ...canonicalPolicyLifecycleNames,
  ...canonicalHookLifecycleNames,
  ...canonicalArtifactLifecycleNames,
] as const;

export type CanonicalCoreEventName = (typeof canonicalCoreEventNames)[number];

export type CanonicalPluginEventName = `plugin.${string}.${string}`;

export type CanonicalEventName = CanonicalCoreEventName | CanonicalPluginEventName;

export type CanonicalEventOriginNamespace = "core" | "plugin";

export interface CanonicalEventOrigin {
  readonly namespace: CanonicalEventOriginNamespace;
  readonly pluginId?: string;
  readonly subsystem?: string;
}

export interface CanonicalEventContext {
  readonly scopeId: string;
  readonly runId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly delegationId?: string;
}

export type CanonicalEventData = Readonly<Record<string, unknown>>;

export interface CanonicalEvent<
  TName extends CanonicalEventName = CanonicalEventName,
  TData extends CanonicalEventData = CanonicalEventData,
> extends CanonicalEventContext {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly name: TName;
  readonly origin: CanonicalEventOrigin;
  readonly data: TData;
}

export interface CanonicalEventInput<
  TName extends CanonicalEventName = CanonicalEventName,
  TData extends CanonicalEventData = CanonicalEventData,
> extends CanonicalEventContext {
  readonly eventId?: string;
  readonly sequence?: number;
  readonly occurredAt?: string;
  readonly name: TName;
  readonly origin?: Partial<CanonicalEventOrigin>;
  readonly data?: TData;
}

export interface CreateCanonicalEventOptions {
  readonly createEventId?: () => string;
  readonly now?: () => string;
  readonly sequence?: number;
}

const canonicalCoreEventNameSet = new Set<string>(canonicalCoreEventNames);

export function isCanonicalCoreEventName(name: string): name is CanonicalCoreEventName {
  return canonicalCoreEventNameSet.has(name);
}

export function isCanonicalPluginEventName(name: string): name is CanonicalPluginEventName {
  return name.startsWith("plugin.") && name.split(".").length >= 3;
}

export function isCanonicalEventName(name: string): name is CanonicalEventName {
  return isCanonicalCoreEventName(name) || isCanonicalPluginEventName(name);
}

export function getCanonicalEventFamily(name: string): CanonicalEventFamily | undefined {
  if (name.startsWith("run.")) {
    return "run";
  }

  if (name.startsWith("session.")) {
    return "session";
  }

  if (name.startsWith("delegation.")) {
    return "delegation";
  }

  if (name.startsWith("handoff.")) {
    return "handoff";
  }

  if (name.startsWith("tool.")) {
    return "tool";
  }

  if (name.startsWith("terminal.")) {
    return "terminal";
  }

  if (name.startsWith("policy.")) {
    return "policy";
  }

  if (name.startsWith("hook.")) {
    return "hook";
  }

  if (name.startsWith("artifact.")) {
    return "artifact";
  }

  if (isCanonicalPluginEventName(name)) {
    return "plugin";
  }

  return undefined;
}

export function createCanonicalEvent<
  TName extends CanonicalEventName,
  TData extends CanonicalEventData = CanonicalEventData,
>(
  input: CanonicalEventInput<TName, TData>,
  options: CreateCanonicalEventOptions = {},
): CanonicalEvent<TName, TData> {
  const eventId = input.eventId ?? options.createEventId?.() ?? randomUUID();
  const sequence =
    input.sequence !== undefined && input.sequence > 0 ? input.sequence : (options.sequence ?? 0);
  const occurredAt = input.occurredAt ?? options.now?.() ?? new Date().toISOString();
  const origin = Object.freeze({
    namespace: input.origin?.namespace ?? "core",
    ...(input.origin?.pluginId === undefined ? {} : { pluginId: input.origin.pluginId }),
    ...(input.origin?.subsystem === undefined ? {} : { subsystem: input.origin.subsystem }),
  }) as CanonicalEventOrigin;
  const data = Object.freeze({ ...(input.data ?? {}) }) as TData;

  return Object.freeze({
    eventId,
    sequence,
    occurredAt,
    name: input.name,
    scopeId: input.scopeId,
    runId: input.runId,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    delegationId: input.delegationId,
    origin,
    data,
  }) as CanonicalEvent<TName, TData>;
}

export function createRunLifecycleEvent<
  TName extends CanonicalRunLifecycleName,
  TData extends CanonicalEventData = CanonicalEventData,
>(
  name: TName,
  input: Omit<CanonicalEventInput<TName, TData>, "name">,
  options?: CreateCanonicalEventOptions,
): CanonicalEvent<TName, TData> {
  return createCanonicalEvent({ ...input, name }, options);
}

export function createSessionLifecycleEvent<
  TName extends CanonicalSessionLifecycleName,
  TData extends CanonicalEventData = CanonicalEventData,
>(
  name: TName,
  input: Omit<CanonicalEventInput<TName, TData>, "name">,
  options?: CreateCanonicalEventOptions,
): CanonicalEvent<TName, TData> {
  return createCanonicalEvent({ ...input, name }, options);
}

export function createDelegationLifecycleEvent<
  TName extends CanonicalDelegationLifecycleName,
  TData extends CanonicalEventData = CanonicalEventData,
>(
  name: TName,
  input: Omit<CanonicalEventInput<TName, TData>, "name">,
  options?: CreateCanonicalEventOptions,
): CanonicalEvent<TName, TData> {
  return createCanonicalEvent({ ...input, name }, options);
}

export function createPluginEvent<TData extends CanonicalEventData = CanonicalEventData>(
  pluginId: string,
  localName: string,
  input: Omit<CanonicalEventInput<CanonicalPluginEventName, TData>, "name">,
  options?: CreateCanonicalEventOptions,
): CanonicalEvent<CanonicalPluginEventName, TData> {
  const name = `plugin.${pluginId}.${localName}` as CanonicalPluginEventName;

  return createCanonicalEvent(
    {
      ...input,
      name,
      origin: {
        namespace: "plugin",
        pluginId,
        ...(input.origin?.subsystem === undefined ? {} : { subsystem: input.origin.subsystem }),
      },
    },
    options,
  );
}

export function createHandoffLifecycleEvent<
  TName extends CanonicalHandoffLifecycleName,
  TData extends CanonicalEventData = CanonicalEventData,
>(
  name: TName,
  input: Omit<CanonicalEventInput<TName, TData>, "name">,
  options?: CreateCanonicalEventOptions,
): CanonicalEvent<TName, TData> {
  return createCanonicalEvent({ ...input, name }, options);
}
