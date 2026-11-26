import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operationSignal } from "./abort.js";
import { AuthError } from "./errors.js";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.js";

export interface FileCredentialStoreOptions {
  /** Path of the JSON file, for example `~/.generic-ai/auth.json` resolved by the app. */
  path: string;
  /** Give up waiting for another process's lock after this long. Default 10 seconds. */
  lockTimeoutMs?: number;
  /** Treat a lock older than this as left behind by a crashed process. Default 30 seconds. */
  staleLockMs?: number;
}

type CredentialFile = Record<string, Credential>;

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MIN_MS = 20;
const LOCK_RETRY_MAX_MS = 250;

/**
 * Credential store backed by one JSON file (mode 0600, directory 0700).
 *
 * Every write takes an in-process queue and a cross-process lock (a `<path>.lock` directory, which
 * `mkdir` creates atomically), re-reads the file, applies the change, and replaces the file through an
 * atomic rename. Two processes sharing the file therefore never lose each other's writes, and a token
 * refresh running inside `modify` happens once even when several processes race for it. A lock whose
 * holder crashed is reclaimed after `staleLockMs`; the holder keeps its lock fresh while it works.
 */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: FileCredentialStoreOptions) {
    this.path = options.path;
    this.lockPath = `${options.path}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const file = await this.load();
    return Object.hasOwn(file, providerId) ? file[providerId] : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const file = await this.load();
    return Object.entries(file).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.locked(options, async () => {
      const file = await this.load();
      const current = Object.hasOwn(file, providerId) ? file[providerId] : undefined;
      const next = await fn(current);
      if (next === undefined) {
        return current;
      }
      await this.save({ ...file, [providerId]: next });
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.locked(options, async () => {
      const file = await this.load();
      if (!Object.hasOwn(file, providerId)) {
        return;
      }
      const { [providerId]: _removed, ...rest } = file;
      await this.save(rest);
    });
  }

  /**
   * Run `task` holding the in-process queue and the file lock. `signal` cancels only the wait: once
   * `task` starts it runs to completion, so a refresh that rotated a token is always persisted.
   */
  private locked<T>(options: AuthOperationOptions | undefined, task: () => Promise<T>): Promise<T> {
    const signal = operationSignal(options?.signal);
    const run = this.chain
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        const release = await this.acquireLock(signal);
        try {
          return await task();
        } finally {
          await release();
        }
      });
    this.chain = run.catch(() => {});
    return run;
  }

  private async acquireLock(signal: AbortSignal): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = LOCK_RETRY_MIN_MS;
    for (;;) {
      signal.throwIfAborted();
      try {
        await mkdir(this.lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AuthError("store", `Could not lock ${this.path}`, { cause: error });
        }
      }
      if (await this.reclaimStaleLock()) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AuthError("store", `Timed out waiting for the lock on ${this.path}`);
      }
      await sleep(delay, signal);
      delay = Math.min(LOCK_RETRY_MAX_MS, delay * 2);
    }

    // Keep the lock fresh so a long refresh is not mistaken for a crashed holder.
    const heartbeat = setInterval(
      () => {
        const now = new Date();
        utimes(this.lockPath, now, now).catch(() => {});
      },
      Math.max(1_000, Math.floor(this.staleLockMs / 3)),
    );
    heartbeat.unref();
    return async () => {
      clearInterval(heartbeat);
      await rm(this.lockPath, { recursive: true, force: true });
    };
  }

  private async reclaimStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath);
      if (Date.now() - info.mtimeMs < this.staleLockMs) {
        return false;
      }
      await rm(this.lockPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      // The holder released it between our mkdir and stat: retry straight away.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async load(): Promise<CredentialFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new AuthError("store", `Could not read ${this.path}`, { cause: error });
    }
    if (text.trim() === "") {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // Never overwrite a file we cannot parse: it may hold credentials the user wants back.
      throw new AuthError("store", `${this.path} is not valid JSON`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthError("store", `${this.path} must hold a JSON object`);
    }
    const file: CredentialFile = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      if (isCredential(value)) {
        file[providerId] = value;
      }
    }
    return file;
  }

  private async save(file: CredentialFile): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new AuthError("store", `Could not write ${this.path}`, { cause: error });
    }
  }
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    type?: unknown;
    key?: unknown;
    access?: unknown;
    refresh?: unknown;
    expires?: unknown;
  };
  if (candidate.type === "api_key") {
    return typeof candidate.key === "string";
  }
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number"
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
