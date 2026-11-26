// Adapted from pi (https://github.com/badlogic/pi-mono), packages/ai/src/auth/credential-store.ts. MIT License.

import { operationSignal, raceWithAbortSignal } from "./abort.js";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.js";

/**
 * In-memory credential store for tests and short-lived processes. Writes are serialized per provider
 * through a promise chain.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(initial?: Record<string, Credential>) {
    for (const [providerId, credential] of Object.entries(initial ?? {})) {
      this.credentials.set(providerId, credential);
    }
  }

  /** Serialize tasks per provider without releasing the chain before active work settles. */
  private enqueue<T>(
    providerId: string,
    task: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const signal = operationSignal(options?.signal);
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => {});
      signal.throwIfAborted();
      return task();
    })();
    const tail = queued.catch(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) {
        this.chains.delete(providerId);
      }
    });
    return raceWithAbortSignal(queued, signal);
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.credentials.get(providerId);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(
      providerId,
      async () => {
        const current = this.credentials.get(providerId);
        const next = await fn(current);
        if (next !== undefined) {
          this.credentials.set(providerId, next);
        }
        return next ?? current;
      },
      options,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(
      providerId,
      async () => {
        this.credentials.delete(providerId);
      },
      options,
    );
  }
}
