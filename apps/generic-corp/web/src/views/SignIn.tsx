import { useState } from "preact/hooks";

import { api } from "../api.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { useResource } from "../live.js";
import { PlanLimitSection } from "./settings/PlanLimitSection.js";

interface ModelAuthStatus {
  source: "claude_plan" | "api_key" | "environment" | "none";
  apiKey?: boolean;
}

const SOURCE: Readonly<Record<string, string>> = {
  claude_plan:
    "Your Claude plan, through the Claude Agent SDK (CLAUDE_CODE_OAUTH_TOKEN on the server). Agent turns count toward your plan's usage limits.",
  api_key: "An Anthropic API key saved here.",
  environment: "ANTHROPIC_API_KEY on the server.",
  none: "Nothing yet.",
};

/**
 * What powers the agents: the owner's Claude plan (a `claude setup-token` token set on the server,
 * used by the Claude Agent SDK) or an Anthropic API key. The app never takes a plan token itself.
 */
export function SignInView() {
  const status = useResource(() => api<ModelAuthStatus>("/model-auth"), []);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      if (done !== undefined) {
        setNotice(done);
        status.reload();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const source = status.data?.source;
  const stored = source === "api_key";

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Claude access</h1>
          <p class="muted">
            What powers your agents: your Claude plan or an Anthropic API key. Agents never see
            either.
          </p>
        </div>
      </header>
      <ErrorNote message={status.error} />
      {status.data === undefined ? <Loading /> : null}
      <div class="settings-stack">
        {notice === undefined ? null : (
          <p class="notice" role="status">
            {notice}
          </p>
        )}
        {source === "none" ? (
          <p class="error" role="alert">
            Nothing powers the company yet. Agents cannot work until you set up your Claude plan or
            add a key.
          </p>
        ) : null}
        {source === undefined ? null : (
          <section class="card settings-card stack" aria-label="Powered by">
            <h2>Powered by</h2>
            <p>{SOURCE[source] ?? source}</p>
            {stored ? (
              <div class="row-end">
                <button
                  type="button"
                  class="ghost danger"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api("/model-auth", { method: "DELETE" }),
                      "Removed. The saved key is gone.",
                    )
                  }
                >
                  Remove key
                </button>
              </div>
            ) : null}
          </section>
        )}
        <section class="card settings-card stack" aria-label="Claude plan">
          <h2>Claude plan</h2>
          {source === "claude_plan" ? (
            <p class="small">On. Claude turns run on your plan.</p>
          ) : (
            <p class="small muted">Off.</p>
          )}
          <p class="small muted">
            To run agents on your Claude Pro or Max plan, run <code>claude setup-token</code> on
            your own computer with Claude Code installed. It opens Anthropic's sign-in and prints a
            token that lasts a year. Set it as the <code>CLAUDE_CODE_OAUTH_TOKEN</code> variable on
            the server (on Railway: the app service's Variables) and redeploy. Don't paste it here:
            the app never stores plan tokens.
          </p>
        </section>
        {source === "claude_plan" ? <PlanLimitSection /> : null}
        <section class="card settings-card stack" aria-label="API key">
          <h2>API key</h2>
          <p class="small muted">
            Create one at{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              console.anthropic.com
            </a>
            . With your plan on, a key is used for other model calls and, if you choose, after the
            plan's limit is reached.
          </p>
          <form
            class="secret-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api("/model-auth/api-key", { method: "PUT", json: { key } });
                setKey("");
              }, "Saved. Agents now run on this API key.");
            }}
          >
            <input
              type="password"
              autocomplete="new-password"
              aria-label="Anthropic API key"
              placeholder="sk-ant-..."
              value={key}
              onInput={(event) => setKey((event.target as HTMLInputElement).value)}
            />
            <button type="submit" class="primary" disabled={busy || key.trim() === ""}>
              Save key
            </button>
          </form>
        </section>
        <ErrorNote message={error} />
      </div>
    </div>
  );
}
