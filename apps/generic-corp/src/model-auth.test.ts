import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore, type OAuthProvider } from "@generic-ai/auth";
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

/** A Claude sign-in that behaves like Anthropic's copy-code flow, without the network. */
function fakeClaude(expectedCode = "code-123#state"): OAuthProvider & { methods: string[] } {
  const methods: string[] = [];
  return {
    name: "Fake Claude",
    isSubscription: true,
    methods,
    async login(interaction) {
      const method = await interaction.prompt({
        type: "select",
        message: "method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "copy_code", label: "Copy code" },
        ],
      });
      methods.push(method);
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?fake=1" });
      const code = await interaction.prompt({ type: "manual_code", message: "code" });
      if (code !== expectedCode) {
        throw new Error("invalid_grant");
      }
      return {
        type: "oauth",
        access: "sk-ant-oat-access",
        refresh: "r",
        expires: Date.now() + 3_600_000,
      };
    },
    async refresh(credential) {
      return { ...credential, access: "sk-ant-oat-refreshed", expires: Date.now() + 3_600_000 };
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

describe("company model auth", () => {
  it("signs in with Claude through the copy-code flow and powers requests with it", async () => {
    const claude = fakeClaude();
    const auth = createCompanyModelAuth({
      store: new InMemoryCredentialStore(),
      claude,
      fallback: () => "sk-ant-api-env",
    });
    expect((await auth.status()).source).toBe("environment");
    expect(await auth.getAuth("anthropic")).toEqual({ apiKey: "sk-ant-api-env" });

    const flow = await auth.startClaudeSignIn();
    expect(flow.url).toContain("claude.ai/oauth/authorize");
    expect(claude.methods).toEqual(["copy_code"]);
    expect((await auth.status()).pendingSignIn).toBe(true);

    const status = await auth.finishClaudeSignIn(flow.flowId, "  code-123#state \n");
    expect(status.source).toBe("subscription");
    expect(status.pendingSignIn).toBeUndefined();
    expect(await auth.getAuth("anthropic")).toEqual({ apiKey: "sk-ant-oat-access" });

    const out = await auth.signOut();
    expect(out.source).toBe("environment");
  });

  it("reports a rejected code and a stale flow plainly", async () => {
    const auth = createCompanyModelAuth({
      store: new InMemoryCredentialStore(),
      claude: fakeClaude(),
      fallback: () => undefined,
    });
    expect((await auth.status()).source).toBe("none");
    const flow = await auth.startClaudeSignIn();
    await expect(auth.finishClaudeSignIn(flow.flowId, "wrong")).rejects.toThrow(
      /did not accept that code/,
    );
    await expect(auth.finishClaudeSignIn(flow.flowId, "code-123#state")).rejects.toBeInstanceOf(
      ModelAuthError,
    );
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
