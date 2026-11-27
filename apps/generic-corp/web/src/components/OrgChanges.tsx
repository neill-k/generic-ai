import { useState } from "preact/hooks";

import { api } from "../api.js";
import { timeAgo } from "../format.js";
import { useResource } from "../live.js";
import { href } from "../router.js";
import { ErrorNote } from "./ui.js";

interface OrgChange {
  id: string;
  at: string;
  by: "ceo" | "owner";
  action: "hire" | "change" | "retire" | "overrule";
  agentId: string;
  summary: string;
  reason?: string;
  overruledAt?: string;
}

/**
 * What the CEO changed in the org chart, and a way to undo each change (decision 51). Undoing
 * marks the agent as set by the owner, and the CEO leaves it alone from then on.
 */
export function OrgChanges() {
  const changes = useResource(
    () => api<{ changes: OrgChange[] }>("/org/changes?limit=20").then((body) => body.changes),
    [],
    (event) => event.type === "org.changed",
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  if (changes.data === undefined || changes.data.length === 0) {
    return null;
  }
  return (
    <section class="card settings-card org-changes" aria-label="Org changes">
      <h2>Changes to the org</h2>
      <p class="small muted">
        The CEO reshapes the team as the work needs. Undo anything you disagree with. The CEO won't
        touch that agent again.
      </p>
      <ul class="refusals">
        {changes.data.map((change) => (
          <li key={change.id} class={change.overruledAt === undefined ? undefined : "overruled"}>
            <div>
              {change.summary}{" "}
              <span class="small muted">
                {change.by === "owner" ? "You" : "The CEO"}, {timeAgo(change.at)}
              </span>
            </div>
            {change.reason === undefined ? null : <div class="small muted">"{change.reason}"</div>}
            <div class="row-end">
              {change.action === "retire" ? null : (
                <a class="small" href={href("org", change.agentId)}>
                  Open
                </a>
              )}
              {change.overruledAt !== undefined ? (
                <span class="small muted">Undone {timeAgo(change.overruledAt)}.</span>
              ) : change.by === "ceo" ? (
                <button
                  type="button"
                  class="ghost"
                  disabled={busy !== undefined}
                  onClick={async () => {
                    setBusy(change.id);
                    setError(undefined);
                    try {
                      await api(`/org/changes/${encodeURIComponent(change.id)}/overrule`, {
                        method: "POST",
                      });
                      changes.reload();
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : String(reason));
                    } finally {
                      setBusy(undefined);
                    }
                  }}
                >
                  {busy === change.id ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ErrorNote message={error} />
    </section>
  );
}
