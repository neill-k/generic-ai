import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@generic-ai/auth";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCompanyModelAuth,
  ModelAuthError,
  providerKeyName,
  resolveProviderKeyFromEnv,
} from "./model-auth.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("company model auth", () => {
  it("drops a Claude plan sign-in left by an earlier version and never uses it", async () => {
    const store = new InMemoryCredentialStore();
    await store.modify("anthropic", async () => ({
      type: "oauth",
      access: "sk-ant-oat-access",
      refresh: "r",
      expires: Date.now() + 3_600_000,
    }));
    const auth = createCompanyModelAuth({ store, fallback: () => "sk-ant-api-env" });
    expect(await auth.getAuth("anthropic")).toEqual({ apiKey: "sk-ant-api-env" });
    expect(await store.read("anthropic")).toBeUndefined();
    expect((await auth.status()).source).toBe("environment");
  });

  it("refuses a Claude plan token pasted as a key", async () => {
    const auth = createCompanyModelAuth({
      store: new InMemoryCredentialStore(),
      fallback: () => undefined,
    });
    await expect(auth.saveApiKey("sk-ant-oat01-abc")).rejects.toBeInstanceOf(ModelAuthError);
    await expect(auth.saveApiKey("sk-ant-oat01-abc")).rejects.toThrow(/Claude plan/);
    expect((await auth.status()).source).toBe("none");
  });

  it("keeps an API key in the file store and checks its shape", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "generic-corp-model-auth-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "model-auth.json");
    const auth = createCompanyModelAuth({ path: file, fallback: () => undefined });
    await expect(auth.saveApiKey("not-a-key")).rejects.toThrow(/sk-ant-/);
    expect((await auth.saveApiKey(" sk-ant-api-123 ")).source).toBe("api_key");

    const reopened = createCompanyModelAuth({ path: file, fallback: () => "ignored" });
    expect(await reopened.getAuth("anthropic")).toEqual({ apiKey: "sk-ant-api-123" });
  });

  it("finds provider keys under the names each provider accepts", () => {
    expect(providerKeyName("openai-codex")).toBe("OPENAI_CODEX_API_KEY");
    expect(resolveProviderKeyFromEnv("anthropic", { ANTHROPIC_AUTH_TOKEN: " t " })).toBe("t");
    expect(resolveProviderKeyFromEnv("anthropic", {})).toBeUndefined();
  });
});
