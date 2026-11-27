import { useEffect, useState } from "preact/hooks";

import {
  api,
  type CompanyPermissions,
  type PermissionsView as PermissionsBody,
  type RefusedAction,
} from "../api.js";
import { lines, Toggle } from "../components/Toggle.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { formatTime } from "../format.js";
import { isWorkEvent, useResource } from "../live.js";
import { href } from "../router.js";

const ALLOWED: readonly [keyof CompanyPermissions, string, string][] = [
  ["readOutside", "Read outside systems", "Connector reads, web pages and web search."],
  ["sendMessages", "Send messages on my behalf", "Email, chat, posts and invites."],
  ["spendMoney", "Spend money", "Payments and purchases."],
  ["writeOutside", "Write to outside systems", "Create, change or delete records elsewhere."],
];

const CATEGORY: Readonly<Record<string, string>> = {
  network: "Network",
  "read-outside": "Reading outside systems",
  "send-messages": "Sending messages",
  "spend-money": "Spending money",
  "write-outside": "Writing to outside systems",
  github: "GitHub",
};

/**
 * What agents may do outside the company, and what they tried and were refused (decision 49).
 * Nothing waits for approval: anything not allowed is refused on the spot and listed here.
 */
export function PermissionsView() {
  const permissions = useResource(() => api<PermissionsBody>("/permissions"), []);
  const refusals = useResource(
    () => api<{ refusals: RefusedAction[] }>("/refusals?limit=100").then((body) => body.refusals),
    [],
    isWorkEvent,
  );

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Permissions</h1>
          <p class="muted">
            What agents may do outside the company. Anything else is refused on the spot and noted
            below. Nobody waits for you.
          </p>
        </div>
      </header>
      <ErrorNote message={permissions.error} />
      {permissions.data === undefined ? (
        <Loading />
      ) : (
        <PermissionsForm body={permissions.data} onSaved={permissions.reload} />
      )}
      <section class="card settings-card" aria-label="Refused actions">
        <h2>Refused actions</h2>
        <ErrorNote message={refusals.error} />
        {refusals.data === undefined ? null : refusals.data.length === 0 ? (
          <p class="muted">Nothing has been refused. Everyone is staying within policy.</p>
        ) : (
          <ul class="refusals">
            {refusals.data.map((refusal, index) => (
              <li key={refusal.id ?? index}>
                <div>
                  <code>{refusal.action}</code>
                  <span class="small muted">
                    {" "}
                    · {CATEGORY[refusal.category] ?? refusal.category}
                  </span>
                </div>
                <div>{refusal.reason}</div>
                <div class="small muted">
                  {refusal.agentId === undefined ? (
                    "Unknown agent"
                  ) : (
                    <a href={href("org", refusal.agentId)}>{refusal.agentId}</a>
                  )}
                  {" · "}
                  {formatTime(refusal.at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PermissionsForm({ body, onSaved }: { body: PermissionsBody; onSaved: () => void }) {
  const [draft, setDraft] = useState(body.permissions);
  const [hosts, setHosts] = useState(body.permissions.shellHosts.join("\n"));
  const [rules, setRules] = useState(body.permissions.standingRules.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  useEffect(() => {
    setDraft(body.permissions);
    setHosts(body.permissions.shellHosts.join("\n"));
    setRules(body.permissions.standingRules.join("\n"));
  }, [body]);

  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api("/permissions", {
        method: "PUT",
        json: {
          readOutside: draft.readOutside,
          sendMessages: draft.sendMessages,
          spendMoney: draft.spendMoney,
          writeOutside: draft.writeOutside,
          github: {
            push: draft.github.push,
            openPullRequests: draft.github.openPullRequests,
            merge: draft.github.merge,
          },
          shellHosts: lines(hosts),
          standingRules: lines(rules),
        },
      });
      setNotice("Saved. Agents work under these permissions from their next step.");
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const github = (key: "push" | "openPullRequests" | "merge", value: boolean) =>
    setDraft({ ...draft, github: { ...draft.github, [key]: value } });

  return (
    <form class="card settings-card stack" onSubmit={save}>
      <h2>Allowed</h2>
      {ALLOWED.map(([key, label, hint]) => (
        <Toggle
          key={key}
          label={label}
          hint={hint}
          checked={draft[key] === true}
          onChange={(value) => setDraft({ ...draft, [key]: value })}
        />
      ))}

      <h2>GitHub</h2>
      <p class="small muted">
        In the repositories picked on <a href={href("connections")}>Connections</a>.{" "}
        {draft.github.repos.length === 0
          ? "None are picked, so GitHub is read-only."
          : `Picked: ${draft.github.repos.join(", ")}.`}
      </p>
      <Toggle
        label="Push branches"
        checked={draft.github.push}
        onChange={(v) => github("push", v)}
      />
      <Toggle
        label="Open pull requests"
        checked={draft.github.openPullRequests}
        onChange={(v) => github("openPullRequests", v)}
      />
      <Toggle
        label="Merge pull requests"
        hint="Only when their checks are green."
        checked={draft.github.merge}
        onChange={(v) => github("merge", v)}
      />

      <h2>Network for shell commands</h2>
      <label class="small muted" for="shell-hosts">
        Hosts agents' shell commands may reach, one per line. Use *.example.com for subdomains. Web
        pages are read through the web tools instead.
      </label>
      <textarea
        id="shell-hosts"
        rows={6}
        value={hosts}
        onInput={(event) => setHosts((event.target as HTMLTextAreaElement).value)}
      />

      <h2>Standing rules</h2>
      <label class="small muted" for="standing-rules">
        Every agent reads these at the start of every turn. One per line.
      </label>
      <textarea
        id="standing-rules"
        rows={5}
        placeholder="Never email a customer without a draft in the drive first."
        value={rules}
        onInput={(event) => setRules((event.target as HTMLTextAreaElement).value)}
      />

      <ErrorNote message={error} />
      {notice === undefined ? null : (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      <div class="row-end">
        {body.saved ? null : (
          <span class="small muted">Showing the company config's defaults.</span>
        )}
        <button type="submit" class="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
