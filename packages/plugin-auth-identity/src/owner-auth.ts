import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  ALL_AUTH_SCOPES,
  type AuthContext,
  type AuthCredentialSource,
  type AuthSubject,
} from "@generic-ai/sdk";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

import type {
  AuthStore,
  StoredApiToken,
  StoredChallenge,
  StoredPasskey,
  StoredSession,
} from "./store.js";

export const API_TOKEN_PREFIX = "gai_" as const;
const API_TOKEN_ID_LENGTH = 16;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;
const MAX_TOKEN_NAME_LENGTH = 100;
/** Cap on unexpired, unused sign-in challenges, so option requests cannot fill the store. */
const MAX_OPEN_CHALLENGES = 100;

export class OwnerAuthError extends Error {
  constructor(
    public readonly code:
      | "SETUP_REQUIRED"
      | "SETUP_TOKEN_INVALID"
      | "FORBIDDEN"
      | "CHALLENGE_INVALID"
      | "PASSKEY_UNKNOWN"
      | "PASSKEY_VERIFICATION_FAILED"
      | "LAST_PASSKEY"
      | "NOT_FOUND"
      | "RATE_LIMITED"
      | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "OwnerAuthError";
  }
}

/**
 * A long-lived secret configured by the operator (for example from an
 * environment variable). It authenticates as the owner with the given scopes.
 * Intended for break-glass and automation; prefer API tokens.
 */
export interface OwnerStaticToken {
  /** Non-secret id recorded as the credential id, for example `env:GENERIC_AI_AUTH_TOKEN`. */
  readonly id: string;
  readonly token: string;
  readonly scopes?: readonly string[];
}

export interface OwnerAuthOptions {
  readonly store: AuthStore;
  readonly owner?: {
    readonly subjectId?: string;
    readonly displayName?: string;
  };
  /**
   * Public origin of the deployment, such as `https://example.up.railway.app`.
   * It fixes the WebAuthn relying party id and the expected origin. When
   * omitted, both are derived from each request URL, which is only safe on
   * loopback.
   */
  readonly publicOrigin?: string;
  readonly rpName?: string;
  /**
   * One-time secret that allows registering the first passkey. Once a passkey
   * exists, adding another requires an authenticated owner.
   */
  readonly setupToken?: string;
  readonly staticTokens?: readonly OwnerStaticToken[];
  readonly sessionTtlMs?: number;
  readonly challengeTtlMs?: number;
  readonly now?: () => Date;
}

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

export interface CreatedApiToken {
  /** The full token. It is returned once and never stored. */
  readonly token: string;
  readonly record: ApiTokenSummary;
}

export interface CreateApiTokenInput {
  readonly name: string;
  readonly scopes?: readonly string[];
  readonly expiresInDays?: number;
}

export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly deviceType?: string;
  readonly backedUp?: boolean;
}

export interface CreatedSession {
  /** Cookie value. Returned once and stored only as a hash. */
  readonly secret: string;
  readonly expiresAt: string;
}

export interface RequestOriginInfo {
  readonly origin: string;
  readonly rpId: string;
}

export interface PasskeyRegistrationStart {
  readonly challengeId: string;
  readonly options: PublicKeyCredentialCreationOptionsJSON;
}

export interface PasskeyAuthenticationStart {
  readonly challengeId: string;
  readonly options: PublicKeyCredentialRequestOptionsJSON;
}

export interface OwnerAuthStatus {
  readonly setupRequired: boolean;
  readonly passkeyCount: number;
}

export interface OwnerAuth {
  readonly subjectId: string;
  /** Resolves the expected WebAuthn origin and RP id for a request. */
  resolveOrigin(request: Request): RequestOriginInfo;
  status(): Promise<OwnerAuthStatus>;

  /** Authenticates a bearer credential (API token or static token). */
  authenticateBearer(token: string): Promise<AuthContext | undefined>;
  /** Authenticates a session cookie value. */
  authenticateSession(secret: string): Promise<AuthContext | undefined>;

  createApiToken(input: CreateApiTokenInput): Promise<CreatedApiToken>;
  listApiTokens(): Promise<readonly ApiTokenSummary[]>;
  revokeApiToken(id: string): Promise<ApiTokenSummary>;

  listPasskeys(): Promise<readonly PasskeySummary[]>;
  removePasskey(id: string): Promise<void>;

  /**
   * Starts passkey registration. Allowed with a valid setup token while no
   * passkey exists, or for an authenticated owner holding `tokens:manage`.
   */
  startPasskeyRegistration(input: {
    readonly request: Request;
    readonly auth?: AuthContext;
    readonly setupToken?: string;
  }): Promise<PasskeyRegistrationStart>;
  finishPasskeyRegistration(input: {
    readonly request: Request;
    readonly auth?: AuthContext;
    readonly setupToken?: string;
    readonly challengeId: string;
    readonly response: RegistrationResponseJSON;
    readonly name?: string;
  }): Promise<{ readonly passkey: PasskeySummary; readonly session: CreatedSession }>;

  startPasskeyAuthentication(input: {
    readonly request: Request;
  }): Promise<PasskeyAuthenticationStart>;
  finishPasskeyAuthentication(input: {
    readonly request: Request;
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
  }): Promise<CreatedSession>;

  revokeSession(secret: string): Promise<void>;
  /**
   * Replaces a live session with a fresh one bound to the same passkey and
   * revokes the old one. Returns `undefined` when the secret is not a live
   * session.
   */
  rotateSession(secret: string): Promise<CreatedSession | undefined>;
  /** Revokes every session except the one whose secret is given. Returns how many were revoked. */
  revokeOtherSessions(keepSecret?: string): Promise<number>;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function randomId(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OwnerAuthError("INVALID_INPUT", `publicOrigin must be http(s): ${origin}`);
  }
  return url.origin;
}

function toApiTokenSummary(record: StoredApiToken): ApiTokenSummary {
  return Object.freeze({
    id: record.id,
    name: record.name,
    displayPrefix: record.displayPrefix,
    scopes: Object.freeze([...record.scopes]),
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  });
}

function toPasskeySummary(record: StoredPasskey): PasskeySummary {
  return Object.freeze({
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    ...(record.deviceType === undefined ? {} : { deviceType: record.deviceType }),
    ...(record.backedUp === undefined ? {} : { backedUp: record.backedUp }),
  });
}

/** Splits `gai_<id>_<secret>` into its parts, or returns undefined. */
export function parseApiToken(token: string): { id: string; secret: string } | undefined {
  if (!token.startsWith(API_TOKEN_PREFIX)) {
    return undefined;
  }

  const rest = token.slice(API_TOKEN_PREFIX.length);
  const id = rest.slice(0, API_TOKEN_ID_LENGTH);
  if (id.length !== API_TOKEN_ID_LENGTH || !/^[0-9a-f]+$/.test(id)) {
    return undefined;
  }

  if (rest[API_TOKEN_ID_LENGTH] !== "_") {
    return undefined;
  }

  const secret = rest.slice(API_TOKEN_ID_LENGTH + 1);
  return secret.length >= 32 ? { id, secret } : undefined;
}

function normalizeScopes(scopes: readonly string[] | undefined): readonly string[] {
  if (scopes === undefined) {
    return Object.freeze([...ALL_AUTH_SCOPES]);
  }

  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new OwnerAuthError("INVALID_INPUT", "A token needs at least one scope.");
  }
  for (const scope of normalized) {
    if (!/^[a-z][a-z0-9._-]*(:[a-z0-9._*-]+)*$/.test(scope)) {
      throw new OwnerAuthError("INVALID_INPUT", `Invalid scope: ${scope}`);
    }
  }
  return Object.freeze(normalized);
}

export function createOwnerAuth(options: OwnerAuthOptions): OwnerAuth {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const subjectId = options.owner?.subjectId ?? "owner";
  const displayName = options.owner?.displayName ?? "Owner";
  const rpName = options.rpName ?? "Generic AI";
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  const publicOrigin =
    options.publicOrigin === undefined ? undefined : normalizeOrigin(options.publicOrigin);
  const setupTokenHash =
    options.setupToken === undefined || options.setupToken.trim().length === 0
      ? undefined
      : sha256Hex(options.setupToken.trim());
  const staticTokens = (options.staticTokens ?? []).map((entry) => {
    if (entry.token.trim().length < 16) {
      throw new OwnerAuthError(
        "INVALID_INPUT",
        `Static token ${entry.id} must be at least 16 characters.`,
      );
    }
    return {
      id: entry.id,
      hash: sha256Hex(entry.token.trim()),
      scopes: normalizeScopes(entry.scopes),
    };
  });

  function subject(scopes: readonly string[], authenticatedAt: string, expiresAt?: string) {
    const value: AuthSubject = {
      subjectId,
      displayName,
      actorType: "human",
      scopes,
      claims: {},
      authenticatedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(publicOrigin === undefined ? {} : { issuer: publicOrigin }),
    };
    return Object.freeze(value);
  }

  function context(
    credentialSource: AuthCredentialSource,
    credentialId: string,
    scopes: readonly string[],
    assurance: "low" | "medium" | "high",
    expiresAt?: string,
  ): AuthContext {
    return Object.freeze({
      subject: subject(scopes, now().toISOString(), expiresAt),
      credentialSource,
      credentialId,
      assurance,
      audit: Object.freeze({ credentialSource, credentialId }),
    });
  }

  function resolveOrigin(request: Request): RequestOriginInfo {
    const origin = publicOrigin ?? new URL(request.url).origin;
    return { origin, rpId: new URL(origin).hostname };
  }

  async function passkeyCount(): Promise<number> {
    return (await store.list("passkeys")).length;
  }

  async function shouldWriteLastUsed(previous: string | undefined, at: Date): Promise<boolean> {
    return (
      previous === undefined || at.getTime() - Date.parse(previous) >= LAST_USED_WRITE_INTERVAL_MS
    );
  }

  async function createSession(passkeyId: string | undefined): Promise<CreatedSession> {
    const secret = randomId(32);
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + sessionTtlMs).toISOString();
    const record: StoredSession = {
      id: sha256Hex(secret),
      ...(passkeyId === undefined ? {} : { passkeyId }),
      createdAt: createdAt.toISOString(),
      expiresAt,
      lastSeenAt: createdAt.toISOString(),
    };
    await store.set("sessions", record.id, record);
    return Object.freeze({ secret, expiresAt });
  }

  async function storeChallenge(kind: StoredChallenge["kind"], challenge: string): Promise<string> {
    const id = randomId(18);
    await store.set("challenges", id, {
      id,
      kind,
      challenge,
      expiresAt: new Date(now().getTime() + challengeTtlMs).toISOString(),
    });
    return id;
  }

  /** Loads and deletes a challenge, so each one can be used once. */
  async function consumeChallenge(
    id: string,
    kind: StoredChallenge["kind"],
  ): Promise<StoredChallenge> {
    const record = typeof id === "string" ? await store.get("challenges", id) : undefined;
    if (record === undefined) {
      throw new OwnerAuthError("CHALLENGE_INVALID", "Unknown or already used challenge.");
    }
    await store.delete("challenges", id);
    if (record.kind !== kind || Date.parse(record.expiresAt) <= now().getTime()) {
      throw new OwnerAuthError("CHALLENGE_INVALID", "Challenge expired or of the wrong kind.");
    }
    return record;
  }

  /** Drops expired challenges and refuses new ones while too many are open. */
  async function pruneExpiredChallenges(): Promise<void> {
    const at = now().getTime();
    let open = 0;
    for (const challenge of await store.list("challenges")) {
      if (Date.parse(challenge.expiresAt) <= at) {
        await store.delete("challenges", challenge.id);
      } else {
        open += 1;
      }
    }
    if (open >= MAX_OPEN_CHALLENGES) {
      throw new OwnerAuthError(
        "RATE_LIMITED",
        "Too many sign-in attempts are in progress. Try again in a few minutes.",
      );
    }
  }

  async function ownerUserHandle(): Promise<Uint8Array> {
    const existing = await store.get("owner", "profile");
    if (existing !== undefined) {
      return new Uint8Array(Buffer.from(existing.userHandle, "base64url"));
    }
    const handle = randomBytes(32);
    await store.set("owner", "profile", {
      userHandle: handle.toString("base64url"),
      createdAt: now().toISOString(),
    });
    return new Uint8Array(handle);
  }

  async function assertMayRegister(
    auth: AuthContext | undefined,
    setupToken: string | undefined,
  ): Promise<void> {
    if (auth?.subject.scopes.includes("tokens:manage")) {
      return;
    }

    if ((await passkeyCount()) > 0) {
      throw new OwnerAuthError(
        "FORBIDDEN",
        "A passkey is already registered. Sign in as the owner to add another.",
      );
    }

    if (setupTokenHash === undefined) {
      throw new OwnerAuthError(
        "SETUP_REQUIRED",
        "No setup token is configured, so the first passkey cannot be registered.",
      );
    }

    if (
      typeof setupToken !== "string" ||
      !constantTimeEqualHex(sha256Hex(setupToken.trim()), setupTokenHash)
    ) {
      throw new OwnerAuthError("SETUP_TOKEN_INVALID", "The setup token is missing or invalid.");
    }
  }

  const auth: OwnerAuth = {
    subjectId,
    resolveOrigin,

    async status() {
      const count = await passkeyCount();
      return Object.freeze({ setupRequired: count === 0, passkeyCount: count });
    },

    async authenticateBearer(token) {
      const trimmed = token.trim();
      const parsed = parseApiToken(trimmed);
      if (parsed !== undefined) {
        const record = await store.get("tokens", parsed.id);
        if (
          record === undefined ||
          record.revokedAt !== undefined ||
          !constantTimeEqualHex(sha256Hex(parsed.secret), record.secretHash)
        ) {
          return undefined;
        }
        const at = now();
        if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= at.getTime()) {
          return undefined;
        }
        if (await shouldWriteLastUsed(record.lastUsedAt, at)) {
          await store.set("tokens", record.id, { ...record, lastUsedAt: at.toISOString() });
        }
        return context("bearer", `token:${record.id}`, record.scopes, "medium", record.expiresAt);
      }

      const hash = sha256Hex(trimmed);
      for (const entry of staticTokens) {
        if (constantTimeEqualHex(hash, entry.hash)) {
          return context("bearer", entry.id, entry.scopes, "low");
        }
      }
      return undefined;
    },

    async authenticateSession(secret) {
      if (secret.length < 32) {
        return undefined;
      }
      const id = sha256Hex(secret);
      const record = await store.get("sessions", id);
      if (record === undefined) {
        return undefined;
      }
      const at = now();
      if (Date.parse(record.expiresAt) <= at.getTime()) {
        await store.delete("sessions", id);
        return undefined;
      }
      if (await shouldWriteLastUsed(record.lastSeenAt, at)) {
        await store.set("sessions", id, { ...record, lastSeenAt: at.toISOString() });
      }
      return context(
        "cookie",
        `session:${id.slice(0, 12)}`,
        ALL_AUTH_SCOPES,
        "high",
        record.expiresAt,
      );
    },

    async createApiToken(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name.length === 0 || name.length > MAX_TOKEN_NAME_LENGTH) {
        throw new OwnerAuthError(
          "INVALID_INPUT",
          `Token name must be 1-${MAX_TOKEN_NAME_LENGTH} characters.`,
        );
      }
      const scopes = normalizeScopes(input.scopes);
      let expiresAt: string | undefined;
      if (input.expiresInDays !== undefined) {
        if (
          !Number.isFinite(input.expiresInDays) ||
          input.expiresInDays <= 0 ||
          input.expiresInDays > 3650
        ) {
          throw new OwnerAuthError("INVALID_INPUT", "expiresInDays must be between 0 and 3650.");
        }
        expiresAt = new Date(now().getTime() + input.expiresInDays * 86_400_000).toISOString();
      }

      const id = randomBytes(API_TOKEN_ID_LENGTH / 2).toString("hex");
      const secret = randomId(32);
      const token = `${API_TOKEN_PREFIX}${id}_${secret}`;
      const record: StoredApiToken = {
        id,
        name,
        secretHash: sha256Hex(secret),
        displayPrefix: token.slice(0, API_TOKEN_PREFIX.length + API_TOKEN_ID_LENGTH),
        scopes,
        createdAt: now().toISOString(),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      await store.set("tokens", id, record);
      return Object.freeze({ token, record: toApiTokenSummary(record) });
    },

    async listApiTokens() {
      const records = await store.list("tokens");
      return records
        .map(toApiTokenSummary)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async revokeApiToken(id) {
      const record = await store.get("tokens", id);
      if (record === undefined) {
        throw new OwnerAuthError("NOT_FOUND", `No API token with id ${id}.`);
      }
      if (record.revokedAt !== undefined) {
        return toApiTokenSummary(record);
      }
      const revoked: StoredApiToken = { ...record, revokedAt: now().toISOString() };
      await store.set("tokens", id, revoked);
      return toApiTokenSummary(revoked);
    },

    async listPasskeys() {
      const records = await store.list("passkeys");
      return records
        .map(toPasskeySummary)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async removePasskey(id) {
      const record = await store.get("passkeys", id);
      if (record === undefined) {
        throw new OwnerAuthError("NOT_FOUND", `No passkey with id ${id}.`);
      }
      if ((await passkeyCount()) <= 1) {
        throw new OwnerAuthError(
          "LAST_PASSKEY",
          "Refusing to remove the last passkey; register another one first.",
        );
      }
      await store.delete("passkeys", id);
      for (const session of await store.list("sessions")) {
        if (session.passkeyId === id) {
          await store.delete("sessions", session.id);
        }
      }
    },

    async startPasskeyRegistration(input) {
      await assertMayRegister(input.auth, input.setupToken);
      await pruneExpiredChallenges();
      const { rpId } = resolveOrigin(input.request);
      const existing = await store.list("passkeys");
      const options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userName: subjectId,
        userDisplayName: displayName,
        userID: (await ownerUserHandle()) as Uint8Array<ArrayBuffer>,
        attestationType: "none",
        excludeCredentials: existing.map((passkey) => ({
          id: passkey.id,
          ...(passkey.transports === undefined ? {} : { transports: [...passkey.transports] }),
        })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });
      const challengeId = await storeChallenge("registration", options.challenge);
      return Object.freeze({ challengeId, options });
    },

    async finishPasskeyRegistration(input) {
      await assertMayRegister(input.auth, input.setupToken);
      const challenge = await consumeChallenge(input.challengeId, "registration");
      const { origin, rpId } = resolveOrigin(input.request);

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: input.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
          requireUserVerification: true,
        });
      } catch (error) {
        throw new OwnerAuthError(
          "PASSKEY_VERIFICATION_FAILED",
          `Passkey registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!verification.verified) {
        throw new OwnerAuthError("PASSKEY_VERIFICATION_FAILED", "Passkey registration failed.");
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;
      const name =
        typeof input.name === "string" && input.name.trim().length > 0
          ? input.name.trim().slice(0, MAX_TOKEN_NAME_LENGTH)
          : `Passkey ${(await passkeyCount()) + 1}`;
      const record: StoredPasskey = {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        ...(credential.transports === undefined ? {} : { transports: credential.transports }),
        name,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: now().toISOString(),
      };
      await store.set("passkeys", record.id, record);
      const session = await createSession(record.id);
      return Object.freeze({ passkey: toPasskeySummary(record), session });
    },

    async startPasskeyAuthentication(input) {
      if ((await passkeyCount()) === 0) {
        throw new OwnerAuthError("SETUP_REQUIRED", "No passkey is registered yet.");
      }
      await pruneExpiredChallenges();
      const { rpId } = resolveOrigin(input.request);
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        userVerification: "required",
      });
      const challengeId = await storeChallenge("authentication", options.challenge);
      return Object.freeze({ challengeId, options });
    },

    async finishPasskeyAuthentication(input) {
      const challenge = await consumeChallenge(input.challengeId, "authentication");
      const credentialId = typeof input.response?.id === "string" ? input.response.id : undefined;
      const passkey =
        credentialId === undefined ? undefined : await store.get("passkeys", credentialId);
      if (passkey === undefined) {
        throw new OwnerAuthError("PASSKEY_UNKNOWN", "This passkey is not registered.");
      }

      const { origin, rpId } = resolveOrigin(input.request);
      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await verifyAuthenticationResponse({
          response: input.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpId,
          requireUserVerification: true,
          credential: {
            id: passkey.id,
            publicKey: new Uint8Array(
              Buffer.from(passkey.publicKey, "base64url"),
            ) as Uint8Array<ArrayBuffer>,
            counter: passkey.counter,
            ...(passkey.transports === undefined ? {} : { transports: [...passkey.transports] }),
          },
        });
      } catch (error) {
        throw new OwnerAuthError(
          "PASSKEY_VERIFICATION_FAILED",
          `Passkey sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!verification.verified) {
        throw new OwnerAuthError("PASSKEY_VERIFICATION_FAILED", "Passkey sign-in failed.");
      }

      await store.set("passkeys", passkey.id, {
        ...passkey,
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: now().toISOString(),
      });
      return createSession(passkey.id);
    },

    async revokeSession(secret) {
      await store.delete("sessions", sha256Hex(secret));
    },

    async rotateSession(secret) {
      const id = sha256Hex(secret);
      const record = await store.get("sessions", id);
      if (record === undefined || Date.parse(record.expiresAt) <= now().getTime()) {
        return undefined;
      }
      await store.delete("sessions", id);
      return createSession(record.passkeyId);
    },

    async revokeOtherSessions(keepSecret) {
      const keep = keepSecret === undefined ? undefined : sha256Hex(keepSecret);
      let revoked = 0;
      for (const session of await store.list("sessions")) {
        if (session.id !== keep) {
          await store.delete("sessions", session.id);
          revoked += 1;
        }
      }
      return revoked;
    },
  };

  return Object.freeze(auth);
}
