import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "../src/errors.js";
import { FileCredentialStore } from "../src/file-store.js";
import { InMemoryCredentialStore } from "../src/memory-store.js";
import type { Credential, CredentialStore } from "../src/types.js";

const oauth = (access: string, expires = Date.now() + 3_600_000): Credential => ({
  type: "oauth",
  access,
  refresh: `refresh-${access}`,
  expires,
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "generic-ai-auth-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stores: Array<[string, () => CredentialStore]> = [
  ["InMemoryCredentialStore", () => new InMemoryCredentialStore()],
  [
    "FileCredentialStore",
    () => new FileCredentialStore({ path: join(dir, "nested", "auth.json") }),
  ],
];

describe.each(stores)("%s", (_name, create) => {
  it("reads, lists, modifies and deletes credentials", async () => {
    const store = create();
    expect(await store.read("openrouter")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    const stored = await store.modify("openrouter", async () => ({ type: "api_key", key: "sk-1" }));
    expect(stored).toEqual({ type: "api_key", key: "sk-1" });
    await store.modify("anthropic", async () => oauth("a"));
    expect(await store.read("openrouter")).toEqual({ type: "api_key", key: "sk-1" });
    expect(await store.list()).toEqual(
      expect.arrayContaining([
        { providerId: "openrouter", type: "api_key" },
        { providerId: "anthropic", type: "oauth" },
      ]),
    );

    await store.delete("openrouter");
    expect(await store.read("openrouter")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "oauth" }]);
  });

  it("leaves the entry unchanged when modify returns undefined or throws", async () => {
    const store = create();
    await store.modify("p", async () => ({ type: "api_key", key: "keep" }));
    expect(await store.modify("p", async () => undefined)).toEqual({
      type: "api_key",
      key: "keep",
    });
    await expect(
      store.modify("p", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.read("p")).toEqual({ type: "api_key", key: "keep" });
  });

  it("serializes concurrent modifications so none are lost", async () => {
    const store = create();
    await store.modify("counter", async () => ({ type: "api_key", key: "0" }));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.modify("counter", async (current) => {
          const value = Number(current?.type === "api_key" ? current.key : "0");
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { type: "api_key", key: String(value + 1) };
        }),
      ),
    );
    expect(await store.read("counter")).toEqual({ type: "api_key", key: "10" });
  });

  it("rejects a queued modify whose signal aborts before it starts", async () => {
    const store = create();
    const gate = deferred();
    const first = store.modify("p", async () => {
      await gate.promise;
      return { type: "api_key", key: "first" };
    });
    const controller = new AbortController();
    let ran = false;
    const second = store.modify(
      "p",
      async () => {
        ran = true;
        return { type: "api_key", key: "second" };
      },
      { signal: controller.signal },
    );
    controller.abort(new Error("cancelled"));
    gate.resolve();
    await first;
    await expect(second).rejects.toThrow("cancelled");
    expect(ran).toBe(false);
    expect(await store.read("p")).toEqual({ type: "api_key", key: "first" });
  });
});

describe("FileCredentialStore on disk", () => {
  it("writes the file with owner-only permissions and no leftovers", async () => {
    const path = join(dir, "auth.json");
    const store = new FileCredentialStore({ path });
    await store.modify("openrouter", async () => ({ type: "api_key", key: "sk-secret" }));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "sk-secret" },
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares writes between two stores on the same file without losing any", async () => {
    const path = join(dir, "auth.json");
    const a = new FileCredentialStore({ path });
    const b = new FileCredentialStore({ path });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? a : b).modify(`provider-${index}`, async () => ({
          type: "api_key",
          key: String(index),
        })),
      ),
    );
    const listed = await new FileCredentialStore({ path }).list();
    expect(listed.map((entry) => entry.providerId).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `provider-${index}`).sort(),
    );
  });

  it("holds the lock across stores so a second writer sees the first one's result", async () => {
    const path = join(dir, "auth.json");
    const a = new FileCredentialStore({ path });
    const b = new FileCredentialStore({ path });
    const inside = deferred();
    const release = deferred();
    const first = a.modify("p", async () => {
      inside.resolve();
      await release.promise;
      return oauth("from-a");
    });
    await inside.promise;
    let seen: Credential | undefined;
    const second = b.modify("p", async (current) => {
      seen = current;
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toBeUndefined();
    release.resolve();
    await first;
    await second;
    expect(seen).toMatchObject({ access: "from-a" });
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    const path = join(dir, "auth.json");
    await mkdir(`${path}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const store = new FileCredentialStore({ path, staleLockMs: 30_000 });
    await store.modify("p", async () => ({ type: "api_key", key: "ok" }));
    expect(await store.read("p")).toEqual({ type: "api_key", key: "ok" });
  });

  it("times out on a fresh lock held by someone else", async () => {
    const path = join(dir, "auth.json");
    await mkdir(`${path}.lock`);
    const store = new FileCredentialStore({ path, lockTimeoutMs: 100 });
    const error = await store
      .modify("p", async () => ({ type: "api_key", key: "x" }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain("Timed out waiting for the lock");
  });

  it("never overwrites a file it cannot parse", async () => {
    const path = join(dir, "auth.json");
    await writeFile(path, "{not json");
    const store = new FileCredentialStore({ path });
    await expect(store.read("p")).rejects.toThrow("is not valid JSON");
    await expect(store.modify("p", async () => ({ type: "api_key", key: "x" }))).rejects.toThrow(
      "is not valid JSON",
    );
    expect(await readFile(path, "utf8")).toBe("{not json");
  });

  it("skips malformed entries but keeps valid ones", async () => {
    const path = join(dir, "auth.json");
    await writeFile(
      path,
      JSON.stringify({
        good: { type: "api_key", key: "k" },
        bad: { type: "oauth", access: 1 },
        other: "x",
      }),
    );
    const store = new FileCredentialStore({ path });
    expect(await store.list()).toEqual([{ providerId: "good", type: "api_key" }]);
  });
});
