/**
 * Identity and auth contracts.
 *
 * These shapes are provider-neutral. An auth plugin (for example
 * `@generic-ai/plugin-auth-identity`) authenticates a request and normalizes
 * the result into an {@link AuthContext}. Transports pass that context to run
 * handlers, and the kernel carries only the redaction-safe {@link RunActor}
 * projection on run envelopes and canonical events.
 *
 * Nothing in these contracts may hold a raw credential: no bearer token, no
 * session id, no password, no provider ID token.
 */

/** What kind of party is acting. */
export type AuthActorType = "human" | "service" | "agent" | "unknown";

/** How the credential that authenticated the request was presented. */
export type AuthCredentialSource = "bearer" | "cookie" | "passkey" | "oidc" | "custom";

/** Coarse assurance level of the authentication that produced a context. */
export type AuthAssurance = "low" | "medium" | "high";

/**
 * Well-known scopes used by Generic AI transports and the starter app.
 * Plugins may define their own scope strings; these are the shared baseline.
 */
export const AUTH_SCOPES = Object.freeze({
  /** Start runs (sync or streaming). */
  runsExecute: "runs:execute",
  /** Read run state, events, and console data. */
  runsRead: "runs:read",
  /** Create, list, and revoke API tokens; manage owner credentials. */
  tokensManage: "tokens:manage",
} as const);

export type KnownAuthScope = (typeof AUTH_SCOPES)[keyof typeof AUTH_SCOPES];

/** Every well-known scope. The owner holds all of them. */
export const ALL_AUTH_SCOPES: readonly KnownAuthScope[] = Object.freeze([
  AUTH_SCOPES.runsExecute,
  AUTH_SCOPES.runsRead,
  AUTH_SCOPES.tokensManage,
]);

export interface AuthSubject {
  /** Stable id of the subject, for example `owner`. */
  readonly subjectId: string;
  /** Issuer of the identity, for example the deployment's public origin. */
  readonly issuer?: string;
  readonly displayName?: string;
  readonly actorType: AuthActorType;
  readonly scopes: readonly string[];
  /** Non-secret claims only. */
  readonly claims: Readonly<Record<string, unknown>>;
  readonly authenticatedAt?: string;
  readonly expiresAt?: string;
}

export interface AuthContext {
  readonly subject: AuthSubject;
  readonly credentialSource: AuthCredentialSource;
  /**
   * Non-secret id of the credential that was used, such as an API token id or
   * a session id hash prefix. Never the credential itself.
   */
  readonly credentialId?: string;
  readonly assurance?: AuthAssurance;
  /** Redaction-safe audit metadata. */
  readonly audit: Readonly<Record<string, unknown>>;
}

/**
 * Redaction-safe projection of an {@link AuthContext} carried on run envelopes
 * and canonical events so later work (approvals, audit, policy) can tell who
 * acted.
 */
export interface RunActor {
  readonly subjectId: string;
  readonly actorType: AuthActorType;
  readonly credentialSource: AuthCredentialSource;
  readonly displayName?: string;
  readonly credentialId?: string;
}

export function hasAuthScope(context: AuthContext | undefined, scope: string): boolean {
  if (context === undefined) {
    return false;
  }

  return context.subject.scopes.includes(scope);
}

export function toRunActor(context: AuthContext): RunActor {
  return Object.freeze({
    subjectId: context.subject.subjectId,
    actorType: context.subject.actorType,
    credentialSource: context.credentialSource,
    ...(context.subject.displayName === undefined
      ? {}
      : { displayName: context.subject.displayName }),
    ...(context.credentialId === undefined ? {} : { credentialId: context.credentialId }),
  });
}

const AUTH_ACTOR_TYPES = new Set<AuthActorType>(["human", "service", "agent", "unknown"]);
const AUTH_CREDENTIAL_SOURCES = new Set<AuthCredentialSource>([
  "bearer",
  "cookie",
  "passkey",
  "oidc",
  "custom",
]);

/**
 * Parses an untrusted value into a {@link RunActor}, dropping unknown fields.
 * Returns `undefined` when the value is not a valid actor.
 */
export function parseRunActor(value: unknown): RunActor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const subjectId = record["subjectId"];
  const actorType = record["actorType"];
  const credentialSource = record["credentialSource"];
  if (
    typeof subjectId !== "string" ||
    subjectId.length === 0 ||
    typeof actorType !== "string" ||
    !AUTH_ACTOR_TYPES.has(actorType as AuthActorType) ||
    typeof credentialSource !== "string" ||
    !AUTH_CREDENTIAL_SOURCES.has(credentialSource as AuthCredentialSource)
  ) {
    return undefined;
  }

  const displayName = record["displayName"];
  const credentialId = record["credentialId"];
  return Object.freeze({
    subjectId,
    actorType: actorType as AuthActorType,
    credentialSource: credentialSource as AuthCredentialSource,
    ...(typeof displayName === "string" ? { displayName } : {}),
    ...(typeof credentialId === "string" ? { credentialId } : {}),
  });
}
