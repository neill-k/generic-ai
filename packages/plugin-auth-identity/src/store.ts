import type { StorageContract } from "@generic-ai/sdk";

/**
 * Persistence for owner auth. Every record is non-secret at rest: API tokens
 * and sessions are stored by SHA-256 hash only, passkeys hold public keys.
 */

export interface StoredApiToken {
  readonly id: string;
  readonly name: string;
  /** Hex SHA-256 of the token secret. */
  readonly secretHash: string;
  /** First characters of the full token, shown in listings so tokens can be recognized. */
  readonly displayPrefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

export interface StoredPasskey {
  /** Base64url credential id. */
  readonly id: string;
  /** Base64url COSE public key. */
  readonly publicKey: string;
  readonly counter: number;
  readonly transports?: readonly string[];
  readonly name: string;
  readonly deviceType?: string;
  readonly backedUp?: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface StoredSession {
  /** Hex SHA-256 of the session secret carried in the cookie. */
  readonly id: string;
  readonly passkeyId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
}

export interface StoredChallenge {
  readonly id: string;
  readonly kind: "registration" | "authentication";
  readonly challenge: string;
  readonly expiresAt: string;
}

export interface StoredOwnerProfile {
  /** Base64url WebAuthn user handle. Stable for the lifetime of the deployment. */
  readonly userHandle: string;
  readonly createdAt: string;
}

export type AuthCollection = "tokens" | "passkeys" | "sessions" | "challenges" | "owner";

interface AuthCollectionRecords {
  readonly tokens: StoredApiToken;
  readonly passkeys: StoredPasskey;
  readonly sessions: StoredSession;
  readonly challenges: StoredChallenge;
  readonly owner: StoredOwnerProfile;
}

/**
 * Minimal async key-value surface the auth store needs. Adapters exist for the
 * SDK `StorageContract` and for an in-memory map; any durable KV (SQLite,
 * Postgres) can implement it in a few lines.
 */
export interface AuthKeyValueStore {
  get(collection: AuthCollection, id: string): Promise<unknown>;
  set(collection: AuthCollection, id: string, value: unknown): Promise<void>;
  delete(collection: AuthCollection, id: string): Promise<boolean>;
  list(collection: AuthCollection): Promise<readonly unknown[]>;
}

export interface AuthStore {
  get<C extends AuthCollection>(
    collection: C,
    id: string,
  ): Promise<AuthCollectionRecords[C] | undefined>;
  set<C extends AuthCollection>(
    collection: C,
    id: string,
    value: AuthCollectionRecords[C],
  ): Promise<void>;
  delete(collection: AuthCollection, id: string): Promise<boolean>;
  list<C extends AuthCollection>(collection: C): Promise<readonly AuthCollectionRecords[C][]>;
}

export function createAuthStore(kv: AuthKeyValueStore): AuthStore {
  return Object.freeze({
    get: async <C extends AuthCollection>(collection: C, id: string) =>
      (await kv.get(collection, id)) as AuthCollectionRecords[C] | undefined,
    set: async <C extends AuthCollection>(
      collection: C,
      id: string,
      value: AuthCollectionRecords[C],
    ) => {
      await kv.set(collection, id, structuredClone(value));
    },
    delete: async (collection: AuthCollection, id: string) => kv.delete(collection, id),
    list: async <C extends AuthCollection>(collection: C) =>
      (await kv.list(collection)) as readonly AuthCollectionRecords[C][],
  });
}

export function createMemoryAuthKeyValueStore(): AuthKeyValueStore {
  const collections = new Map<AuthCollection, Map<string, unknown>>();
  const bucket = (collection: AuthCollection): Map<string, unknown> => {
    let existing = collections.get(collection);
    if (existing === undefined) {
      existing = new Map();
      collections.set(collection, existing);
    }
    return existing;
  };

  return Object.freeze({
    get: async (collection: AuthCollection, id: string) => {
      const value = bucket(collection).get(id);
      return value === undefined ? undefined : structuredClone(value);
    },
    set: async (collection: AuthCollection, id: string, value: unknown) => {
      bucket(collection).set(id, structuredClone(value));
    },
    delete: async (collection: AuthCollection, id: string) => bucket(collection).delete(id),
    list: async (collection: AuthCollection) =>
      [...bucket(collection).values()].map((value) => structuredClone(value)),
  });
}

/** In-memory auth store. Suitable for tests and throwaway local runs only. */
export function createMemoryAuthStore(): AuthStore {
  return createAuthStore(createMemoryAuthKeyValueStore());
}

export interface StorageContractAuthStoreOptions {
  /** Storage namespace for auth records. Defaults to `generic-ai.auth`. */
  readonly namespace?: string;
  readonly now?: () => string;
}

/** Adapts any SDK `StorageContract` implementation into an auth store. */
export function createStorageContractAuthStore(
  storage: StorageContract,
  options: StorageContractAuthStoreOptions = {},
): AuthStore {
  const namespace = options.namespace ?? "generic-ai.auth";
  const now = options.now ?? (() => new Date().toISOString());

  return createAuthStore({
    get: async (collection, id) =>
      (await storage.get({ namespace, collection, id }))?.value ?? undefined,
    set: async (collection, id, value) => {
      await storage.set({ key: { namespace, collection, id }, value, updatedAt: now() });
    },
    delete: async (collection, id) => storage.delete({ namespace, collection, id }),
    list: async (collection) =>
      (await storage.list({ namespace, collection })).map((record) => record.value),
  });
}
