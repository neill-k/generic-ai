import { useState } from "preact/hooks";

import { api } from "../api.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { useResource } from "../live.js";

interface ModelAuthStatus {
  source: "api_key" | "environment" | "none";
}

const SOURCE: Readonly<Record<string, string>> = {
  api_key: "An Anthropic API key saved here.",
  environment: "ANTHROPIC_API_KEY on the server.",
  none: "Nothing yet.",
};

/**
 * What powers the agents: an Anthropic API key. There is no Claude plan sign-in, because
 * Anthropic's terms don't allow third-party apps to use a Claude plan.
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
          <h1>Claude API key</h1>
          <p class="muted">
            What powers your agents: an Anthropic API key. Agents use it without ever seeing it.
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
            Nothing powers the company yet. Agents cannot work until you add a key.
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
            . Claude Pro and Max plans can't power the company: Anthropic's terms don't allow
            third-party apps to use them.
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
