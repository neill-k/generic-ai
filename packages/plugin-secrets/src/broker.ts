import {
  findSecretPlaceholders,
  isSecretGranted,
  SECRET_PLACEHOLDER_PATTERN,
  type SecretAccessPurpose,
  type SecretAccessRecord,
  type SecretActorContext,
  type SecretDescriptor,
  type SecretsBinding,
  type SecretSource,
  type WritableSecretSource,
} from "@generic-ai/sdk";

import { SecretRedactor } from "./redactor.js";
import { HOST_ONLY_SECRET_NAMES } from "./sources.js";

/** Raised when a tool input asks for a secret the actor may not use, or that is not set. */
export class SecretAccessError extends Error {
  readonly secretName: string;
  readonly decision: "denied" | "missing";

  constructor(secretName: string, decision: "denied" | "missing", message: string) {
    super(message);
    this.name = "SecretAccessError";
    this.secretName = secretName;
    this.decision = decision;
  }
}

export interface SecretsBrokerOptions {
  /** Sources in lookup order; the first that holds a name wins. */
  readonly sources: readonly SecretSource[];
  /** Where `set` and `delete` go. Usually the encrypted store. */
  readonly writable?: WritableSecretSource;
  /**
   * Names no agent may resolve, even with a `*` grant. Defaults to {@link HOST_ONLY_SECRET_NAMES}.
   * They are still redacted everywhere.
   */
  readonly hostOnly?: readonly string[];
  /** Audit sink for every resolution attempt. Records never hold values. */
  readonly onAccess?: (record: SecretAccessRecord) => void | Promise<void>;
  readonly now?: () => string;
}

export interface ResolveSecretOptions {
  readonly actorId: string;
  readonly grants?: readonly string[];
  readonly purpose?: SecretAccessPurpose;
  readonly runId?: string;
  readonly toolName?: string;
  readonly onAccess?: (record: SecretAccessRecord) => void | Promise<void>;
}

export interface SecretsBroker extends SecretsBinding {
  /** Resolve for an agent: checks grants and host-only names, records the access. */
  resolve(name: string, options: ResolveSecretOptions): Promise<string>;
  /** Resolve `{{secret:NAME}}` placeholders inside a string for an agent. */
  resolveTemplate(template: string, options: ResolveSecretOptions): Promise<string>;
  /**
   * Host-side read (provider keys, MCP launch config written by the owner). No grant check, but the
   * value is registered for redaction and the read is audited as actor `host`.
   */
  get(name: string, purpose?: SecretAccessPurpose): Promise<string | undefined>;
  /** Every known name with its source, never values. */
  list(): Promise<readonly SecretDescriptor[]>;
  set(name: string, value: string, options?: { readonly updatedBy?: string }): Promise<void>;
  delete(name: string): Promise<boolean>;
  /** Names too short to redact safely. Hosts should warn about them at startup. */
  weakNames(): readonly string[];
}

/**
 * The secrets broker: one place that knows where secrets live, who may use them, and which values
 * must never leave the host. It implements the SDK {@link SecretsBinding} the harness consumes.
 */
export function createSecretsBroker(options: SecretsBrokerOptions): SecretsBroker {
  const sources = [...options.sources];
  if (options.writable !== undefined && !sources.includes(options.writable)) {
    sources.push(options.writable);
  }
  const hostOnly = new Set(options.hostOnly ?? HOST_ONLY_SECRET_NAMES);
  const redactor = new SecretRedactor();
  const now = options.now ?? (() => new Date().toISOString());
  let prepared: Promise<void> | undefined;

  const lookup = async (name: string): Promise<string | undefined> => {
    for (const source of sources) {
      const value = await source.get(name);
      if (value !== undefined) {
        redactor.add(name, value);
        return value;
      }
    }
    return undefined;
  };

  const audit = async (
    record: Omit<SecretAccessRecord, "at">,
    extra?: (record: SecretAccessRecord) => void | Promise<void>,
  ) => {
    const full: SecretAccessRecord = Object.freeze({ ...record, at: now() });
    for (const sink of [options.onAccess, extra]) {
      if (sink === undefined) {
        continue;
      }
      try {
        await sink(full);
      } catch {
        // Audit sinks must not break tool calls.
      }
    }
  };

  const resolve = async (name: string, resolveOptions: ResolveSecretOptions): Promise<string> => {
    const base = {
      name,
      actorId: resolveOptions.actorId,
      purpose: resolveOptions.purpose ?? "tool-input",
      ...(resolveOptions.runId === undefined ? {} : { runId: resolveOptions.runId }),
      ...(resolveOptions.toolName === undefined ? {} : { toolName: resolveOptions.toolName }),
    };
    if (hostOnly.has(name) || !isSecretGranted(name, resolveOptions.grants)) {
      const reason = hostOnly.has(name)
        ? `Secret "${name}" is reserved for the host and cannot be used by agents.`
        : `Secret "${name}" is not granted to "${resolveOptions.actorId}". The owner can add it to that role's secrets.`;
      await audit({ ...base, decision: "denied", reason }, resolveOptions.onAccess);
      throw new SecretAccessError(name, "denied", reason);
    }
    const value = await lookup(name);
    if (value === undefined) {
      const reason = `Secret "${name}" is granted but not set. The owner needs to add it.`;
      await audit({ ...base, decision: "missing", reason }, resolveOptions.onAccess);
      throw new SecretAccessError(name, "missing", reason);
    }
    await audit(
      { ...base, decision: "allowed", reason: "Granted to this actor." },
      resolveOptions.onAccess,
    );
    return value;
  };

  const resolveTemplate = async (
    template: string,
    resolveOptions: ResolveSecretOptions,
  ): Promise<string> => {
    const names = findSecretPlaceholders(template);
    if (names.length === 0) {
      return template;
    }
    const values = new Map<string, string>();
    for (const name of names) {
      values.set(name, await resolve(name, resolveOptions));
    }
    return template.replace(
      SECRET_PLACEHOLDER_PATTERN,
      (_match, name: string) => values.get(name) ?? "",
    );
  };

  const resolveDeep = async (
    value: unknown,
    resolveOptions: ResolveSecretOptions,
  ): Promise<unknown> => {
    if (typeof value === "string") {
      return resolveTemplate(value, resolveOptions);
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (const item of value) {
        copy.push(await resolveDeep(item, resolveOptions));
      }
      return copy;
    }
    if (value !== null && typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return value;
      }
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        copy[key] = await resolveDeep(item, resolveOptions);
      }
      return copy;
    }
    return value;
  };

  const hasPlaceholder = (value: unknown): boolean => {
    if (typeof value === "string") {
      return findSecretPlaceholders(value).length > 0;
    }
    if (Array.isArray(value)) {
      return value.some(hasPlaceholder);
    }
    if (value !== null && typeof value === "object") {
      return Object.values(value).some(hasPlaceholder);
    }
    return false;
  };

  const redactError = (error: unknown): unknown => {
    if (!(error instanceof Error)) {
      return typeof error === "string" ? redactor.redactText(error) : error;
    }
    const message = redactor.redactText(error.message);
    const stack = error.stack === undefined ? undefined : redactor.redactText(error.stack);
    if (message === error.message && stack === error.stack) {
      return error;
    }
    try {
      error.message = message;
      if (stack !== undefined) {
        error.stack = stack;
      }
      return error;
    } catch {
      const copy = new Error(message);
      copy.name = error.name;
      return copy;
    }
  };

  const wrapTool = <TTool>(tool: TTool, context: SecretActorContext): TTool => {
    const candidate = tool as { execute?: unknown; name?: unknown };
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.execute !== "function"
    ) {
      return tool;
    }
    const execute = (candidate.execute as (...args: unknown[]) => unknown).bind(tool);
    const toolName = typeof candidate.name === "string" ? candidate.name : undefined;
    const wrapped = Object.create(Object.getPrototypeOf(tool)) as Record<string, unknown>;
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(tool));
    Object.defineProperty(wrapped, "execute", {
      enumerable: true,
      configurable: true,
      writable: true,
      async value(...args: unknown[]) {
        await broker.prepare();
        const nextArgs = [...args];
        if (hasPlaceholder(args[1])) {
          nextArgs[1] = await resolveDeep(args[1], {
            actorId: context.actorId,
            ...(context.grants === undefined ? {} : { grants: context.grants }),
            purpose: "tool-input",
            ...(context.runId === undefined ? {} : { runId: context.runId }),
            ...(toolName === undefined ? {} : { toolName }),
            ...(context.onAccess === undefined ? {} : { onAccess: context.onAccess }),
          });
        }
        const onUpdate = args[3];
        if (typeof onUpdate === "function") {
          nextArgs[3] = (partial: unknown) =>
            (onUpdate as (value: unknown) => unknown)(redactor.redact(partial));
        }
        try {
          return redactor.redact(await execute(...nextArgs));
        } catch (error) {
          throw redactError(error);
        }
      },
    });
    return wrapped as TTool;
  };

  const broker: SecretsBroker = {
    kind: "secrets",
    prepare() {
      prepared ??= (async () => {
        for (const source of sources) {
          for (const name of await source.list()) {
            await lookup(name);
          }
        }
      })().catch((error: unknown) => {
        prepared = undefined;
        throw error;
      });
      return prepared;
    },
    wrapTool,
    redact: (value) => redactor.redact(value),
    redactText: (text) => redactor.redactText(text),
    async grantedNames(grants) {
      if (grants === undefined || grants.length === 0) {
        return [];
      }
      const names = new Set<string>();
      for (const descriptor of await broker.list()) {
        if (!hostOnly.has(descriptor.name) && isSecretGranted(descriptor.name, grants)) {
          names.add(descriptor.name);
        }
      }
      // Exact grants for secrets that are not set yet are still worth telling the agent about.
      for (const grant of grants) {
        if (!grant.endsWith("*") && !hostOnly.has(grant)) {
          names.add(grant);
        }
      }
      return [...names].sort();
    },
    resolve,
    resolveTemplate,
    async get(name, purpose = "host") {
      const value = await lookup(name);
      await audit({
        name,
        actorId: "host",
        purpose,
        decision: value === undefined ? "missing" : "allowed",
        reason: value === undefined ? "Not set." : "Host read.",
      });
      return value;
    },
    async list() {
      const seen = new Map<string, SecretDescriptor>();
      for (const source of sources) {
        const described =
          source === options.writable && options.writable !== undefined
            ? await options.writable.describe()
            : (await source.list()).map((name) => ({ name, source: source.id }));
        for (const descriptor of described) {
          if (!seen.has(descriptor.name)) {
            seen.set(descriptor.name, Object.freeze(descriptor));
          }
        }
      }
      return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
    async set(name, value, setOptions) {
      if (options.writable === undefined) {
        throw new Error(
          "No writable secret store is configured. Set GENERIC_AI_SECRETS_KEY to enable one.",
        );
      }
      if (hostOnly.has(name)) {
        throw new Error(
          `Secret "${name}" is reserved for the host and must be set in the environment.`,
        );
      }
      await options.writable.set(name, value, setOptions);
      redactor.add(name, value);
    },
    async delete(name) {
      if (options.writable === undefined) {
        return false;
      }
      return options.writable.delete(name);
    },
    weakNames: () => redactor.weakNames(),
  };
  return Object.freeze(broker);
}
