import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

import {
  isSecretName,
  type SecretDescriptor,
  type StorageContract,
  type WritableSecretSource,
} from "@generic-ai/sdk";

/** Environment variable holding the master key for the encrypted store. */
export const SECRETS_KEY_ENV = "GENERIC_AI_SECRETS_KEY";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MIN_PASSPHRASE_LENGTH = 32;
const ENVELOPE_VERSION = 1;

export class SecretsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsKeyError";
  }
}

export class SecretsStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretsStoreError";
  }
}

interface MasterKey {
  readonly id: string;
  readonly bytes: Buffer;
}

interface SecretEnvelope {
  readonly v: number;
  readonly kid: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
  readonly updatedBy?: string;
}

/**
 * Turn the configured master key into 32 key bytes. Accepts 64 hex characters, base64 of 32 bytes,
 * or a passphrase of at least 32 characters (stretched with scrypt). Anything shorter is refused.
 */
export function parseSecretsKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const bytes = Buffer.from(
      value,
      value.includes("-") || value.includes("_") ? "base64url" : "base64",
    );
    if (bytes.length === KEY_BYTES) {
      return bytes;
    }
  }
  if (value.length >= MIN_PASSPHRASE_LENGTH) {
    return scryptSync(value, "generic-ai.secrets.v1", KEY_BYTES);
  }
  throw new SecretsKeyError(
    `${SECRETS_KEY_ENV} must be 64 hex characters, base64 of 32 bytes, or a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters. Generate one with: openssl rand -hex 32`,
  );
}

function masterKey(raw: string | Buffer): MasterKey {
  const bytes = typeof raw === "string" ? parseSecretsKey(raw) : raw;
  if (bytes.length !== KEY_BYTES) {
    throw new SecretsKeyError(`Secrets key must be ${KEY_BYTES} bytes.`);
  }
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return { id, bytes };
}

export interface EncryptedSecretStoreOptions {
  readonly storage: StorageContract;
  /** Current master key: raw string (see {@link parseSecretsKey}) or 32 bytes. */
  readonly key: string | Buffer;
  /** Older keys still accepted for reading, so the owner can rotate without downtime. */
  readonly previousKeys?: readonly (string | Buffer)[];
  /** Storage namespace. Defaults to `generic-ai.secrets`. */
  readonly namespace?: string;
  readonly now?: () => string;
  readonly id?: string;
}

export interface EncryptedSecretStore extends WritableSecretSource {
  /** Re-encrypt every secret with the current key. Returns how many were rewritten. */
  rotate(): Promise<number>;
}

/**
 * Secrets the owner sets at runtime, encrypted with AES-256-GCM before they reach storage. Works on
 * any SDK `StorageContract`: Postgres on Railway, SQLite or memory locally. The master key never
 * touches storage; the secret's name is bound in as associated data so rows cannot be swapped.
 */
export function createEncryptedSecretStore(
  options: EncryptedSecretStoreOptions,
): EncryptedSecretStore {
  const current = masterKey(options.key);
  const keys = new Map<string, MasterKey>([[current.id, current]]);
  for (const previous of options.previousKeys ?? []) {
    const key = masterKey(previous);
    if (!keys.has(key.id)) {
      keys.set(key.id, key);
    }
  }
  const namespace = options.namespace ?? "generic-ai.secrets";
  const collection = "values";
  const now = options.now ?? (() => new Date().toISOString());
  const keyFor = (name: string) => ({ namespace, collection, id: name });

  const encrypt = (name: string, value: string, updatedBy?: string): SecretEnvelope => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, current.bytes, iv);
    cipher.setAAD(Buffer.from(name, "utf8"));
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      v: ENVELOPE_VERSION,
      kid: current.id,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
      ...(updatedBy === undefined ? {} : { updatedBy }),
    };
  };

  const decrypt = (name: string, envelope: SecretEnvelope): string => {
    const key = keys.get(envelope.kid);
    if (key === undefined) {
      throw new SecretsStoreError(
        `Secret "${name}" was encrypted with a key that is not configured (key id ${envelope.kid}). Add the old key to previousKeys.`,
      );
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key.bytes, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(name, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ct, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw new SecretsStoreError(
        `Secret "${name}" failed to decrypt; it may have been tampered with.`,
        {
          cause: error,
        },
      );
    }
  };

  const readEnvelope = async (name: string) => {
    const record = await options.storage.get<SecretEnvelope>(keyFor(name));
    if (record === undefined) {
      return undefined;
    }
    if (!isEnvelope(record.value)) {
      throw new SecretsStoreError(`Secret "${name}" is not a valid encrypted record.`);
    }
    return { envelope: record.value, updatedAt: record.updatedAt };
  };

  const write = async (name: string, value: string, updatedBy?: string) => {
    if (!isSecretName(name)) {
      throw new SecretsStoreError(
        `Secret name "${name}" is invalid. Use letters, digits and underscores, starting with a letter or underscore.`,
      );
    }
    if (value.length === 0) {
      throw new SecretsStoreError(`Secret "${name}" cannot be empty.`);
    }
    await options.storage.set({
      key: keyFor(name),
      value: encrypt(name, value, updatedBy),
      updatedAt: now(),
    });
  };

  const store: EncryptedSecretStore = {
    id: options.id ?? "encrypted-store",
    async get(name) {
      const found = await readEnvelope(name);
      return found === undefined ? undefined : decrypt(name, found.envelope);
    },
    async list() {
      const records = await options.storage.list({ namespace, collection });
      return records.map((record) => record.key.id);
    },
    async set(name, value, setOptions) {
      await write(name, value, setOptions?.updatedBy);
    },
    async delete(name) {
      return options.storage.delete(keyFor(name));
    },
    async describe(): Promise<readonly SecretDescriptor[]> {
      const records = await options.storage.list({ namespace, collection });
      return records.map((record) => {
        const envelope = record.value as Partial<SecretEnvelope>;
        return Object.freeze({
          name: record.key.id,
          source: store.id,
          updatedAt: record.updatedAt,
          ...(typeof envelope.updatedBy === "string" ? { updatedBy: envelope.updatedBy } : {}),
        });
      });
    },
    async rotate() {
      let rewritten = 0;
      for (const name of await store.list()) {
        const found = await readEnvelope(name);
        if (found === undefined || found.envelope.kid === current.id) {
          continue;
        }
        await write(name, decrypt(name, found.envelope), found.envelope.updatedBy);
        rewritten += 1;
      }
      return rewritten;
    },
  };
  return Object.freeze(store);
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["v"] === ENVELOPE_VERSION &&
    typeof record["kid"] === "string" &&
    typeof record["iv"] === "string" &&
    typeof record["tag"] === "string" &&
    typeof record["ct"] === "string"
  );
}
