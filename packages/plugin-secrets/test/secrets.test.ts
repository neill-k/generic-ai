import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretAccessRecord, StorageContract, StorageRecord } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEncryptedSecretStore,
  createEnvSecretSource,
  createFileSecretSource,
  createSecretsBroker,
  createSecretsFromEnvironment,
  createStaticSecretSource,
  parseSecretsKey,
  SecretAccessError,
  SecretRedactor,
  SecretsKeyError,
  SecretsStoreError,
} from "../src/index.js";

// Obviously fake values only.
const FAKE_GITHUB = "fake-github-token-0000000000";
const FAKE_OPENAI = "sk-fake-openai-key-1111111111";
const FAKE_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

function memoryStorage(): StorageContract & { readonly rows: Map<string, StorageRecord> } {
  const rows = new Map<string, StorageRecord>();
  const id = (key: StorageRecord["key"]) => `${key.namespace}/${key.collection}/${key.id}`;
  return {
    kind: "storage",
    driver: "test-memory",
    rows,
    get: <T>(key: StorageRecord["key"]) => rows.get(id(key)) as StorageRecord<T> | undefined,
    set: (record) => {
      rows.set(id(record.key), structuredClone(record) as StorageRecord);
    },
    delete: (key) => rows.delete(id(key)),
    list: (filter) =>
      [...rows.values()].filter(
        (record) =>
          (filter?.namespace === undefined || record.key.namespace === filter.namespace) &&
          (filter?.collection === undefined || record.key.collection === filter.collection),
      ),
    clear: () => rows.clear(),
  };
}

function fakeTool(name: string, run: (params: Record<string, unknown>) => unknown) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: {},
    calls: [] as Record<string, unknown>[],
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      onUpdate?: (partial: unknown) => void,
    ) {
      this.calls.push(params);
      onUpdate?.({ content: [{ type: "text", text: `partial ${String(params["command"])}` }] });
      return run(params);
    },
  };
}

describe("SecretRedactor", () => {
  it("scrubs raw, trimmed, base64, URL and JSON-escaped forms", () => {
    const redactor = new SecretRedactor();
    const value = 'fake secret/with+chars="q"';
    redactor.add("API", value);
    const base64 = Buffer.from(value).toString("base64");
    const text = [value, base64, encodeURIComponent(value), JSON.stringify(value)].join(" | ");
    const redacted = redactor.redactText(text);
    expect(redacted).not.toContain(value);
    expect(redacted).not.toContain(base64);
    expect(redacted).not.toContain(encodeURIComponent(value));
    expect(redacted).toContain("[REDACTED:API]");
  });

  it("walks objects and arrays without mutating the input", () => {
    const redactor = new SecretRedactor();
    redactor.add("GITHUB_TOKEN", FAKE_GITHUB);
    const input = { a: [`x ${FAKE_GITHUB}`], b: { c: FAKE_GITHUB, n: 3 } };
    const output = redactor.redact(input);
    expect(output).toEqual({
      a: ["x [REDACTED:GITHUB_TOKEN]"],
      b: { c: "[REDACTED:GITHUB_TOKEN]", n: 3 },
    });
    expect(input.b.c).toBe(FAKE_GITHUB);
  });

  it("refuses values too short to redact and reports them", () => {
    const redactor = new SecretRedactor();
    expect(redactor.add("PIN", "123")).toBe(false);
    expect(redactor.weakNames()).toEqual(["PIN"]);
    expect(redactor.redactText("123")).toBe("123");
  });

  it("replaces the longest value first", () => {
    const redactor = new SecretRedactor();
    redactor.add("SHORT", "fake-abcd");
    redactor.add("LONG", "fake-abcd-efgh-ijkl");
    expect(redactor.redactText("fake-abcd-efgh-ijkl")).toBe("[REDACTED:LONG]");
  });
});

describe("sources", () => {
  it("only exposes listed and prefixed environment variables", async () => {
    const source = createEnvSecretSource({
      env: {
        OPENAI_API_KEY: FAKE_OPENAI,
        GENERIC_AI_SECRET_GITHUB_TOKEN: FAKE_GITHUB,
        PATH: "/usr/bin",
        HOME: "/root",
        GENERIC_AI_SECRET_: "ignored",
      },
    });
    expect([...(await source.list())].sort()).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
    expect(await source.get("GITHUB_TOKEN")).toBe(FAKE_GITHUB);
    expect(await source.get("PATH")).toBeUndefined();
  });

  describe("file source", () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("reads Docker-style secret files and ignores a missing directory", async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "generic-ai-secrets-"));
      await writeFile(path.join(dir, "SMTP_PASSWORD"), "fake-smtp-password\n");
      await writeFile(path.join(dir, "not a name"), "x");
      const source = createFileSecretSource({ directory: dir });
      expect(await source.list()).toEqual(["SMTP_PASSWORD"]);
      expect(await source.get("SMTP_PASSWORD")).toBe("fake-smtp-password");
      expect(await source.get("../etc/passwd")).toBeUndefined();
      const missing = createFileSecretSource({ directory: path.join(dir, "nope") });
      expect(await missing.list()).toEqual([]);
      expect(await missing.get("SMTP_PASSWORD")).toBeUndefined();
    });
  });
});

describe("encrypted store", () => {
  it("round-trips values and never stores plaintext", async () => {
    const storage = memoryStorage();
    const store = createEncryptedSecretStore({ storage, key: FAKE_KEY });
    await store.set("GITHUB_TOKEN", FAKE_GITHUB, { updatedBy: "owner" });
    expect(await store.get("GITHUB_TOKEN")).toBe(FAKE_GITHUB);
    expect(JSON.stringify([...storage.rows.values()])).not.toContain(FAKE_GITHUB);
    const [descriptor] = await store.describe();
    expect(descriptor).toMatchObject({ name: "GITHUB_TOKEN", updatedBy: "owner" });
    expect(await store.delete("GITHUB_TOKEN")).toBe(true);
    expect(await store.get("GITHUB_TOKEN")).toBeUndefined();
  });

  it("binds ciphertext to the secret name", async () => {
    const storage = memoryStorage();
    const store = createEncryptedSecretStore({ storage, key: FAKE_KEY });
    await store.set("A_SECRET", FAKE_GITHUB);
    const row = storage.rows.get("generic-ai.secrets/values/A_SECRET");
    storage.rows.set("generic-ai.secrets/values/B_SECRET", {
      ...(row as StorageRecord),
      key: { namespace: "generic-ai.secrets", collection: "values", id: "B_SECRET" },
    });
    await expect(store.get("B_SECRET")).rejects.toBeInstanceOf(SecretsStoreError);
  });

  it("rotates to a new key while still reading the old one", async () => {
    const storage = memoryStorage();
    await createEncryptedSecretStore({ storage, key: FAKE_KEY }).set("A_SECRET", FAKE_GITHUB);
    await expect(
      createEncryptedSecretStore({ storage, key: OTHER_KEY }).get("A_SECRET"),
    ).rejects.toThrow(/not configured/);
    const rotated = createEncryptedSecretStore({
      storage,
      key: OTHER_KEY,
      previousKeys: [FAKE_KEY],
    });
    expect(await rotated.rotate()).toBe(1);
    expect(await createEncryptedSecretStore({ storage, key: OTHER_KEY }).get("A_SECRET")).toBe(
      FAKE_GITHUB,
    );
  });

  it("rejects weak master keys and bad names", async () => {
    expect(() => parseSecretsKey("short")).toThrow(SecretsKeyError);
    expect(parseSecretsKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
    expect(parseSecretsKey("a passphrase that is long enough to be stretched")).toHaveLength(32);
    const store = createEncryptedSecretStore({ storage: memoryStorage(), key: FAKE_KEY });
    await expect(store.set("bad name", "fake-value")).rejects.toThrow(/invalid/);
  });
});

describe("secrets broker", () => {
  const broker = () => {
    const records: SecretAccessRecord[] = [];
    return {
      records,
      broker: createSecretsBroker({
        sources: [
          createStaticSecretSource({
            GITHUB_TOKEN: FAKE_GITHUB,
            OPENAI_API_KEY: FAKE_OPENAI,
            DATABASE_URL: "postgres://fake:fake-password@localhost/db",
          }),
        ],
        onAccess: (record) => {
          records.push(record);
        },
      }),
    };
  };

  it("resolves granted placeholders at call time and scrubs the result", async () => {
    const { broker: secrets, records } = broker();
    const tool = fakeTool("bash", (params) => ({
      content: [{ type: "text", text: `ran ${String(params["command"])}` }],
      details: { echoed: params["command"] },
    }));
    const updates: unknown[] = [];
    const wrapped = secrets.wrapTool(tool, {
      actorId: "builder",
      grants: ["GITHUB_*"],
      runId: "run-1",
    });
    const result = await wrapped.execute(
      "call-1",
      { command: "curl -H 'Authorization: token {{secret:GITHUB_TOKEN}}' https://api.github.test" },
      undefined,
      (partial) => updates.push(partial),
    );

    expect(tool.calls[0]?.["command"]).toContain(FAKE_GITHUB);
    expect(JSON.stringify(result)).not.toContain(FAKE_GITHUB);
    expect(JSON.stringify(result)).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(JSON.stringify(updates)).not.toContain(FAKE_GITHUB);
    expect(records).toEqual([
      expect.objectContaining({
        name: "GITHUB_TOKEN",
        actorId: "builder",
        decision: "allowed",
        toolName: "bash",
        runId: "run-1",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(FAKE_GITHUB);
  });

  it("wraps frozen tools", async () => {
    const { broker: secrets } = broker();
    const tool = Object.freeze(
      fakeTool("document_write", (params) => ({
        content: [{ type: "text", text: `wrote ${String(params["content"])}` }],
      })),
    );
    const wrapped = secrets.wrapTool(tool, { actorId: "builder", grants: ["GITHUB_TOKEN"] });
    expect(wrapped).not.toBe(tool);
    expect(wrapped.name).toBe("document_write");
    const result = await wrapped.execute("call-1", { content: "{{secret:GITHUB_TOKEN}}" });
    expect(JSON.stringify(result)).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  it("denies secrets the role was not granted, and host-only secrets even with *", async () => {
    const { broker: secrets, records } = broker();
    const tool = fakeTool("bash", () => ({ content: [] }));
    const explorer = secrets.wrapTool(tool, { actorId: "explorer", grants: [] });
    await expect(
      explorer.execute("c", { command: "echo {{secret:GITHUB_TOKEN}}" }),
    ).rejects.toBeInstanceOf(SecretAccessError);
    const greedy = secrets.wrapTool(tool, { actorId: "builder", grants: ["*"] });
    await expect(greedy.execute("c", { command: "echo {{secret:DATABASE_URL}}" })).rejects.toThrow(
      /reserved for the host/,
    );
    expect(tool.calls).toHaveLength(0);
    expect(records.map((record) => record.decision)).toEqual(["denied", "denied"]);
  });

  it("reports granted secrets that are not set", async () => {
    const { broker: secrets } = broker();
    await expect(
      secrets.resolve("SLACK_TOKEN", { actorId: "ceo", grants: ["SLACK_TOKEN"] }),
    ).rejects.toMatchObject({ decision: "missing" });
  });

  it("scrubs secrets a tool leaks on its own, once prepared", async () => {
    const { broker: secrets } = broker();
    const leaky = fakeTool("read", () => ({
      content: [{ type: "text", text: `OPENAI_API_KEY=${FAKE_OPENAI}` }],
    }));
    const wrapped = secrets.wrapTool(leaky, { actorId: "explorer" });
    const result = await wrapped.execute("c", { path: ".env" });
    expect(JSON.stringify(result)).toContain("[REDACTED:OPENAI_API_KEY]");
    expect(secrets.redactText(`db postgres://fake:fake-password@localhost/db`)).toContain(
      "[REDACTED:DATABASE_URL]",
    );
  });

  it("scrubs secrets from tool errors", async () => {
    const { broker: secrets } = broker();
    const failing = fakeTool("bash", (params) => {
      throw new Error(`failed: ${String(params["command"])}`);
    });
    const wrapped = secrets.wrapTool(failing, { actorId: "builder", grants: ["GITHUB_TOKEN"] });
    const error: Error = await wrapped
      .execute("c", { command: "git push https://x:{{secret:GITHUB_TOKEN}}@example.test" })
      .then(
        () => new Error("expected a failure"),
        (caught: unknown) => caught as Error,
      );
    expect(error.message).not.toContain(FAKE_GITHUB);
    expect(error.message).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  it("lists names only and tells roles which secrets they may use", async () => {
    const { broker: secrets } = broker();
    const listed = await secrets.list();
    expect(listed.map((descriptor) => descriptor.name)).toEqual([
      "DATABASE_URL",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
    ]);
    expect(JSON.stringify(listed)).not.toContain(FAKE_GITHUB);
    expect(await secrets.grantedNames(["*"])).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
    expect(await secrets.grantedNames(["SLACK_TOKEN"])).toEqual(["SLACK_TOKEN"]);
    expect(await secrets.grantedNames(undefined)).toEqual([]);
  });

  it("leaves tools without placeholders and non-tools alone", async () => {
    const { broker: secrets } = broker();
    const tool = fakeTool("bash", (params) => ({
      content: [{ type: "text", text: String(params["command"]) }],
    }));
    const wrapped = secrets.wrapTool(tool, { actorId: "builder" });
    await wrapped.execute("c", { command: "echo {{ not a secret }}" });
    expect(tool.calls[0]).toEqual({ command: "echo {{ not a secret }}" });
    const plain = { name: "x" };
    expect(secrets.wrapTool(plain, { actorId: "builder" })).toBe(plain);
  });
});

describe("createSecretsFromEnvironment", () => {
  it("layers env over the encrypted store and keeps host secrets unreadable", async () => {
    const storage = memoryStorage();
    const secrets = createSecretsFromEnvironment({
      env: {
        GENERIC_AI_SECRETS_KEY: FAKE_KEY,
        GENERIC_AI_SECRET_GITHUB_TOKEN: FAKE_GITHUB,
        GENERIC_AI_SECRETS_DIR: path.join(os.tmpdir(), "generic-ai-no-such-secrets-dir"),
      },
      storage,
    });
    await secrets.set("NOTION_TOKEN", "fake-notion-token-2222", { updatedBy: "owner" });
    await secrets.set("GITHUB_TOKEN", "fake-shadowed-by-env-3333");
    expect(await secrets.resolve("GITHUB_TOKEN", { actorId: "a", grants: ["*"] })).toBe(
      FAKE_GITHUB,
    );
    expect(await secrets.resolve("NOTION_TOKEN", { actorId: "a", grants: ["*"] })).toBe(
      "fake-notion-token-2222",
    );
    await expect(secrets.set("GENERIC_AI_SECRETS_KEY", "x".repeat(40))).rejects.toThrow(/reserved/);
    await secrets.prepare();
    expect(secrets.redactText(FAKE_KEY)).toBe("[REDACTED:GENERIC_AI_SECRETS_KEY]");
  });

  it("has no writable store without a master key", async () => {
    const secrets = createSecretsFromEnvironment({
      env: {},
      storage: memoryStorage(),
      secretsDirectory: "/nonexistent",
    });
    await expect(secrets.set("A_SECRET", "fake-value-123")).rejects.toThrow(
      /GENERIC_AI_SECRETS_KEY/,
    );
  });
});
