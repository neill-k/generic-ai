import type { Awaitable } from "./shared.js";

/**
 * Secrets contracts.
 *
 * A secret is a named credential (a provider API key, an MCP server token, a password) that the
 * host holds and agents may *use* without ever *seeing*. Agents refer to a secret with a
 * `{{secret:NAME}}` placeholder in a tool input. The host resolves the placeholder when the tool
 * runs, only if the agent's role was granted that secret, and scrubs every known secret value from
 * tool output, events and traces before anything reaches the model or a log.
 *
 * The contract is runtime-agnostic. `@generic-ai/plugin-secrets` is the reference implementation;
 * the core harness only depends on {@link SecretsBinding}.
 */

/** Pattern a secret name must match: an environment-variable style identifier. */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Placeholder syntax agents use in tool inputs: `{{secret:NAME}}`. */
export const SECRET_PLACEHOLDER_PATTERN = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]{0,127})\s*\}\}/g;

/** What replaces a secret value when it is scrubbed. */
export function secretRedactionMarker(name: string): string {
  return `[REDACTED:${name}]`;
}

export function isSecretName(value: string): boolean {
  return SECRET_NAME_PATTERN.test(value);
}

/** Every distinct secret name referenced by `{{secret:NAME}}` placeholders in a string. */
export function findSecretPlaceholders(value: string): readonly string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(SECRET_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

/** Where a secret's value lives. Sources never log or return values except from `get`. */
export interface SecretSource {
  readonly id: string;
  /** The secret's value, or `undefined` when this source does not hold it. */
  get(name: string): Awaitable<string | undefined>;
  /** Names this source holds. Values are never listed. */
  list(): Awaitable<readonly string[]>;
}

/** A source the owner can write to at runtime (for example an encrypted database store). */
export interface WritableSecretSource extends SecretSource {
  set(name: string, value: string, options?: { readonly updatedBy?: string }): Awaitable<void>;
  delete(name: string): Awaitable<boolean>;
  /** Names with metadata, never values. */
  describe(): Awaitable<readonly SecretDescriptor[]>;
}

export interface SecretDescriptor {
  readonly name: string;
  readonly source: string;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

/** Why a secret was read, for the audit trail. */
export type SecretAccessPurpose = "tool-input" | "mcp-launch" | "provider-key" | "host";

/** One read of a secret, recorded without its value. */
export interface SecretAccessRecord {
  readonly name: string;
  readonly actorId: string;
  readonly purpose: SecretAccessPurpose;
  readonly decision: "allowed" | "denied" | "missing";
  readonly reason: string;
  readonly runId?: string;
  readonly toolName?: string;
  readonly at: string;
}

/** Who is using a secret: the role or agent running the tool. */
export interface SecretActorContext {
  readonly actorId: string;
  /** Secret names (or `PREFIX_*` patterns) this actor may use. Omit or leave empty for none. */
  readonly grants?: readonly string[];
  readonly runId?: string;
  /** Called after every placeholder resolution attempt, allowed or not. */
  readonly onAccess?: (record: SecretAccessRecord) => void | Promise<void>;
}

/**
 * The seam the harness uses. A host binds one as `capabilities.secrets`; the harness then wraps each
 * role's tools with {@link SecretsBinding.wrapTool} and passes every event through
 * {@link SecretsBinding.redact}.
 */
export interface SecretsBinding {
  readonly kind: "secrets";
  /** Load every known value so redaction covers secrets no tool has used yet. Idempotent. */
  prepare(): Promise<void>;
  /**
   * Wrap a tool so `{{secret:NAME}}` placeholders in its input resolve at call time (only names the
   * actor is granted) and every known secret value is scrubbed from its result, partial updates and
   * errors. Tools without an `execute` function are returned unchanged.
   */
  wrapTool<TTool>(tool: TTool, context: SecretActorContext): TTool;
  /** Deep-copy a value with every known secret value replaced by its redaction marker. */
  redact<TValue>(value: TValue): TValue;
  /** Scrub secrets from one string. */
  redactText(text: string): string;
  /** Names the actor may use, for prompt guidance. Never values. */
  grantedNames(grants: readonly string[] | undefined): Promise<readonly string[]>;
}

/** Whether `name` is covered by a grant list. Grants are exact names, `PREFIX_*` patterns, or `*`. */
export function isSecretGranted(name: string, grants: readonly string[] | undefined): boolean {
  if (grants === undefined) {
    return false;
  }
  for (const grant of grants) {
    if (grant === "*" || grant === name) {
      return true;
    }
    if (grant.endsWith("*") && name.startsWith(grant.slice(0, -1))) {
      return true;
    }
  }
  return false;
}
