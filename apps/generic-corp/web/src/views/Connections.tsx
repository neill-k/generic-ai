import { useEffect, useState } from "preact/hooks";

import {
  ApiError,
  api,
  type GithubConnection,
  type PermissionsView,
  type SecretView,
  type ToolkitView,
} from "../api.js";
import { Toggle } from "../components/Toggle.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { formatTime } from "../format.js";
import { useResource } from "../live.js";
import { href } from "../router.js";

/** A 404 means the server runs without that part; the card says so instead of an error. */
async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Tools, secrets and outside services in one place (decision 49). */
export function ConnectionsView() {
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Connections</h1>
          <p class="muted">
            What agents can reach and the keys they use without seeing them. What they may do with
            it is on <a href={href("permissions")}>Permissions</a>.
          </p>
        </div>
      </header>
      <div class="settings-stack">
        <GithubCard />
        <SecretsCard />
        <ToolsCard />
      </div>
    </div>
  );
}

function GithubCard() {
  const github = useResource(() => optional(() => api<GithubConnection>("/connectors/github")), []);
  const permissions = useResource(() => api<PermissionsView>("/permissions"), []);
  const [token, setToken] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  useEffect(() => {
    setPicked(permissions.data?.permissions.github.repos ?? []);
  }, [permissions.data]);

  const run = async (call: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await call();
      setNotice(done);
      github.reload();
      permissions.reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const connection = github.data;
  const saved = permissions.data?.permissions.github.repos ?? [];
  const changed = picked.join("\n") !== saved.join("\n");

  return (
    <section class="card settings-card stack" aria-label="GitHub">
      <div class="card-head">
        <h2>GitHub</h2>
        {connection?.connected === true ? <span class="badge tone-good">Connected</span> : null}
      </div>
      <ErrorNote message={github.error} />
      {github.loading && connection === undefined ? <Loading /> : null}
      {connection === null ? (
        <p class="muted">The GitHub connector is not available on this server.</p>
      ) : null}
      {connection?.connected === false ? (
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                api("/connectors/github", { method: "POST", json: { token } }).then(() =>
                  setToken(""),
                ),
              "GitHub connected. It is read-only until you pick repositories below.",
            );
          }}
        >
          <p class="small muted">
            Paste a fine-grained GitHub token. Give it Contents and Pull requests (read and write),
            and Checks and Commit statuses (read), on the repositories you want. It stays on this
            server. Agents never see it.
          </p>
          <input
            type="password"
            autocomplete="off"
            aria-label="GitHub token"
            placeholder="github_pat_..."
            value={token}
            onInput={(event) => setToken((event.target as HTMLInputElement).value)}
          />
          <div class="row-end">
            <button type="submit" class="primary" disabled={busy || token.trim() === ""}>
              Connect GitHub
            </button>
          </div>
        </form>
      ) : null}
      {connection?.connected === true ? (
        <>
          <p class="small">
            {connection.account === undefined
              ? "Connected with the server's token."
              : `Connected as ${connection.account}.`}{" "}
            Agents can read every repository it can see.
            {connection.connectedAt === undefined
              ? ""
              : ` Since ${formatTime(connection.connectedAt)}.`}
          </p>
          <h3>Repositories agents may write to</h3>
          {connection.repos.length === 0 ? (
            <p class="small muted">The token can't see any repositories.</p>
          ) : (
            <div class="repo-list">
              {connection.repos.map((repo) => (
                <Toggle
                  key={repo.fullName}
                  label={repo.fullName}
                  hint={`${repo.private ? "Private" : "Public"}${repo.canPush ? "" : ". The token cannot push here."}`}
                  checked={picked.includes(repo.fullName.toLowerCase())}
                  onChange={(on) => {
                    const name = repo.fullName.toLowerCase();
                    setPicked(on ? [...picked, name] : picked.filter((entry) => entry !== name));
                  }}
                />
              ))}
            </div>
          )}
          <div class="row-end">
            {connection.source === "owner" ? (
              <button
                type="button"
                class="ghost danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api("/connectors/github", { method: "DELETE" }),
                    "GitHub disconnected.",
                  )
                }
              >
                Disconnect
              </button>
            ) : null}
            <button
              type="button"
              class="primary"
              disabled={busy || !changed}
              onClick={() =>
                void run(
                  () => api("/permissions", { method: "PUT", json: { github: { repos: picked } } }),
                  picked.length === 0
                    ? "Saved. GitHub is read-only for agents."
                    : "Saved. Agents may write to the picked repositories from their next step.",
                )
              }
            >
              Save repositories
            </button>
          </div>
        </>
      ) : null}
      <ErrorNote message={error} />
      {notice === undefined ? null : (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

const SOURCE: Readonly<Record<string, string>> = {
  env: "From the server environment",
  file: "From a secret file",
  "encrypted-store": "Saved here",
};

function SecretsCard() {
  const secrets = useResource(
    () => optional(() => api<{ writable: boolean; secrets: SecretView[] }>("/secrets")),
    [],
  );
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const save = async (name: string) => {
    setError(undefined);
    try {
      await api(`/secrets/${encodeURIComponent(name)}`, { method: "PUT", json: { value } });
      setEditing(undefined);
      setValue("");
      setNewName("");
      secrets.reload();
    } catch (reason) {
      setError(message(reason));
    }
  };
  const remove = async (name: string) => {
    setError(undefined);
    try {
      await api(`/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      secrets.reload();
    } catch (reason) {
      setError(message(reason));
    }
  };

  const body = secrets.data;
  return (
    <section class="card settings-card stack" aria-label="Secrets">
      <h2>Secrets</h2>
      <p class="small muted">
        Keys agents may use without seeing them. Values are never shown again once saved.
      </p>
      <ErrorNote message={secrets.error} />
      {body === null ? (
        <p class="muted">The secrets vault is not available on this server.</p>
      ) : null}
      {body !== undefined && body !== null && !body.writable ? (
        <p class="small muted">
          Secrets can't be saved here until GENERIC_AI_SECRETS_KEY is set on the server. Until then,
          set them in the server's environment.
        </p>
      ) : null}
      {body !== undefined && body !== null ? (
        <ul class="secrets">
          {body.secrets.length === 0 ? <li class="muted">No secrets yet.</li> : null}
          {body.secrets.map((secret) => (
            <li key={secret.name}>
              <div class="secret-head">
                <code>{secret.name}</code>
                <span
                  class={`badge ${secret.set ? "tone-good" : secret.optional ? "" : "tone-warn"}`}
                >
                  {secret.set ? "Set" : secret.optional ? "Optional" : "Missing"}
                </span>
              </div>
              <div class="small muted">
                {secret.usedBy.length === 0
                  ? "Not used by anything yet."
                  : `Used by ${secret.usedBy.join(", ")}.`}
                {secret.source === undefined ? "" : ` ${SOURCE[secret.source] ?? secret.source}.`}
                {secret.updatedAt === undefined ? "" : ` Updated ${formatTime(secret.updatedAt)}.`}
              </div>
              {editing === secret.name ? (
                <SecretForm
                  value={value}
                  onValue={setValue}
                  onSave={() => void save(secret.name)}
                  onCancel={() => setEditing(undefined)}
                />
              ) : body.writable && secret.source !== "env" && secret.source !== "file" ? (
                <div class="row-end">
                  {secret.source === "encrypted-store" ? (
                    <button
                      type="button"
                      class="ghost danger"
                      onClick={() => void remove(secret.name)}
                    >
                      Remove
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="ghost"
                    onClick={() => {
                      setValue("");
                      setEditing(secret.name);
                    }}
                  >
                    {secret.set ? "Replace" : "Set"}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {body?.writable === true ? (
        editing === "" ? (
          <div class="stack">
            <input
              aria-label="Secret name"
              placeholder="NAME_IN_CAPITALS"
              value={newName}
              onInput={(event) => setNewName((event.target as HTMLInputElement).value)}
            />
            <SecretForm
              value={value}
              onValue={setValue}
              onSave={() => void save(newName.trim())}
              onCancel={() => setEditing(undefined)}
            />
          </div>
        ) : (
          <div class="row-end">
            <button
              type="button"
              onClick={() => {
                setValue("");
                setNewName("");
                setEditing("");
              }}
            >
              Add a secret
            </button>
          </div>
        )
      ) : null}
      <ErrorNote message={error} />
    </section>
  );
}

function SecretForm(props: {
  value: string;
  onValue: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      class="secret-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <input
        type="password"
        autocomplete="off"
        aria-label="Secret value"
        placeholder="Value"
        value={props.value}
        onInput={(event) => props.onValue((event.target as HTMLInputElement).value)}
      />
      <button type="button" class="ghost" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="submit" class="primary" disabled={props.value === ""}>
        Save
      </button>
    </form>
  );
}

const GROUP: Readonly<Record<string, string>> = {
  files: "Files",
  terminal: "Terminal",
  web: "Web",
  documents: "Documents",
  github: "GitHub",
};

function ToolsCard() {
  const toolkit = useResource(() => api<ToolkitView>("/tools"), []);
  const data = toolkit.data;
  const groups = new Map<string, string[]>();
  for (const tool of data?.tools ?? []) {
    groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool.name]);
  }
  return (
    <section class="card settings-card stack" aria-label="Tools">
      <h2>Tools</h2>
      <p class="small muted">What every agent has to work with.</p>
      <ErrorNote message={toolkit.error} />
      {data === undefined ? null : (
        <>
          <ul class="tool-groups">
            {[...groups].map(([group, names]) => (
              <li key={group}>
                <strong>{GROUP[group] ?? group}</strong>
                <span class="small muted"> {names.join(", ")}</span>
              </li>
            ))}
            {data.webSearch === null ? null : (
              <li>
                <strong>Web search</strong>
                <span class="small muted">
                  {" "}
                  {data.webSearch.configured
                    ? data.webSearch.provider === "auto"
                      ? "Ready."
                      : `Through ${data.webSearch.provider}.`
                    : "No search key yet. Add one under Secrets above."}
                </span>
              </li>
            )}
          </ul>
          <h3>Connectors</h3>
          {data.connectors.length === 0 ? (
            <p class="small muted">None configured.</p>
          ) : (
            <ul class="tool-groups">
              {data.connectors.map((connector) => (
                <li key={connector.id}>
                  <strong>{connector.serverName ?? connector.connector ?? connector.id}</strong>
                  <span class="small muted">
                    {" "}
                    {connector.state === "connected"
                      ? `${connector.toolCount} tools.`
                      : (connector.lastError ?? `${connector.state}.`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.skills.length === 0 ? null : (
            <>
              <h3>Skills</h3>
              <ul class="tool-groups">
                {data.skills.map((skill) => (
                  <li key={skill.name}>
                    <strong>{skill.name}</strong>
                    <span class="small muted"> {skill.description}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
