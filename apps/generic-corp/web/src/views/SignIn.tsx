import { useState } from "preact/hooks";

import { api } from "../api.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { useResource } from "../live.js";

interface ModelAuthStatus {
  source: "subscription" | "api_key" | "environment" | "none";
}

const SOURCE: Readonly<Record<string, string>> = {
  subscription: "Your Claude subscription.",
  api_key: "An Anthropic API key saved here.",
  environment: "ANTHROPIC_API_KEY on the server.",
  none: "Nothing yet.",
};

/** What powers the agents: the owner's Claude subscription or an API key. */
export function SignInView() {
  const status = useResource(() => api<ModelAuthStatus>("/model-auth"), []);
  const [flowId, setFlowId] = useState<string | undefined>(undefined);
  const [link, setLink] = useState<string | undefined>(undefined);
  const [code, setCode] = useState("");
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
  const stored = source === "subscription" || source === "api_key";

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Claude sign-in</h1>
          <p class="muted">
            What powers your agents. Sign in with your Claude plan, or use an Anthropic API key.
            Agents use it without ever seeing it.
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
            Nothing powers the company yet. Agents cannot work until you sign in or add a key.
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
                      "Signed out. The stored sign-in or key was removed.",
                    )
                  }
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </section>
        )}
        <section class="card settings-card stack" aria-label="Sign in with Claude">
          <h2>Sign in with Claude</h2>
          <p class="small muted">
            Uses your Claude Pro or Max plan. When the plan's usage limit is reached, work pauses
            until it resets.
          </p>
          {flowId === undefined ? (
            <div class="row-end">
              <button
                type="button"
                class="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const flow = await api<{ flowId: string; url: string }>(
                      "/model-auth/claude/start",
                      { method: "POST" },
                    );
                    setFlowId(flow.flowId);
                    setLink(flow.url);
                  })
                }
              >
                Sign in with Claude
              </button>
            </div>
          ) : (
            <form
              class="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api("/model-auth/claude/finish", {
                    method: "POST",
                    json: { flowId, code: code.trim() },
                  });
                  setFlowId(undefined);
                  setCode("");
                }, "Signed in. Agents now run on your Claude subscription.");
              }}
            >
              <ol class="small">
                <li>
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    Open Claude
                  </a>{" "}
                  and approve access with the account whose plan should power the company.
                </li>
                <li>Copy the code Claude shows at the end and paste it here.</li>
              </ol>
              <input
                aria-label="Code from Claude"
                autocomplete="off"
                spellcheck={false}
                placeholder="Paste the code here"
                value={code}
                onInput={(event) => setCode((event.target as HTMLInputElement).value)}
              />
              <div class="row-end">
                <button type="submit" class="primary" disabled={busy || code.trim() === ""}>
                  Finish sign-in
                </button>
              </div>
            </form>
          )}
        </section>
        <section class="card settings-card stack" aria-label="API key">
          <h2>Or use an API key</h2>
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
