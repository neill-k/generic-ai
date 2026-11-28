import { useState } from "preact/hooks";

import { api } from "../api.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { formatTime, formatTokens } from "../format.js";
import { useResource } from "../live.js";
import { href } from "../router.js";

/**
 * What the company remembers: the handbook every agent reads, and each agent's own memory. The
 * owner edits any entry (his edits are kept as he wrote them), sees where each one came from, and
 * undoes any change. Background work (preference scanner, dreaming) is shown and paused here.
 */

type Kind = "memory" | "prompt" | "skill" | "subagent";

interface MemoryOrigin {
  kind: string;
  ref?: string;
  note?: string;
  at: string;
}

interface MemoryEntry {
  id: string;
  kind: Kind;
  title: string;
  content: string;
  reference: Record<string, unknown>;
  origin?: MemoryOrigin;
  locked: boolean;
}

interface MemoryChange {
  id: string;
  summary: string;
  rationale?: string;
  createdAt: string;
  actor: { kind: string };
  origin?: MemoryOrigin;
  undoOf?: string;
  undoneBy?: string;
}

interface EditResult {
  edits: { applied: boolean; error?: string }[];
}

interface Job {
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  usage?: { calls: number; totalTokens: number };
}

interface Background {
  settings: { paused: boolean };
  jobs: { scanner?: Job; dreaming?: Job };
}

interface AgentRow {
  id: string;
  role: string;
  title?: string;
}

const KIND_LABEL: Record<Kind, string> = {
  memory: "Memory",
  prompt: "Rule",
  skill: "Procedure",
  subagent: "Helper",
};

const ORIGIN_LABEL: Record<string, string> = {
  owner: "You",
  agent: "The agent, during work",
  chat: "Noticed in your chats",
  dream: "Dreaming",
  import: "Imported from old notes",
  undo: "Undo",
};

function describeOrigin(origin: MemoryOrigin | undefined): string {
  if (origin === undefined) {
    return "Unknown";
  }
  return [
    ORIGIN_LABEL[origin.kind] ?? origin.kind,
    origin.note === undefined ? undefined : `“${origin.note}”`,
    origin.ref,
    formatTime(origin.at),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function MemoryView({ scopeId }: { scopeId: string | undefined }) {
  const scope = scopeId ?? "company";
  const isHandbook = scope === "company";
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const data = useResource(
    async () => {
      const [overview, listing, history, agents, background] = await Promise.all([
        api<{ scopes: { scope: string; entries: number }[] }>("/memory"),
        api<{ entries: MemoryEntry[] }>(`/memory/${encodeURIComponent(scope)}`),
        api<{ changes: MemoryChange[] }>(
          `/memory/changes?scope=${encodeURIComponent(scope)}&limit=50`,
        ),
        api<{ agents: AgentRow[] }>("/agents"),
        api<Background>("/memory/background").catch(() => undefined),
      ]);
      return { overview, listing, history, agents, background };
    },
    [scope],
    (event) => event.type.startsWith("memory."),
  );

  const run = async (action: () => Promise<string>) => {
    setFailure(undefined);
    try {
      setNotice(await action());
    } catch (reason) {
      setNotice(undefined);
      setFailure(message(reason));
    }
    data.reload();
  };

  const send = async (edits: Record<string, unknown>[]) => {
    const result = await api<EditResult>(`/memory/${encodeURIComponent(scope)}`, {
      method: "POST",
      json: { edits },
    });
    const refused = result.edits.find((edit) => !edit.applied);
    if (refused !== undefined) {
      throw new Error(refused.error ?? "The change was refused.");
    }
  };

  const counts = new Map(data.data?.overview.scopes.map((row) => [row.scope, row.entries]) ?? []);
  const background = data.data?.background;

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Memory</h1>
          <p class="muted">
            What the company remembers. Every agent reads the handbook; each agent also keeps its
            own memory from its work. Your edits are kept as you wrote them, and any change can be
            undone.
          </p>
        </div>
      </header>

      <div class="tabs" role="tablist" aria-label="Whose memory">
        <a
          role="tab"
          class={isHandbook ? "tab active" : "tab"}
          aria-selected={isHandbook}
          href={href("memory", "company")}
        >
          Handbook ({counts.get("company") ?? 0})
        </a>
        {(data.data?.agents.agents ?? []).map((agent) => (
          <a
            key={agent.id}
            role="tab"
            class={scope === agent.id ? "tab active" : "tab"}
            aria-selected={scope === agent.id}
            href={href("memory", agent.id)}
          >
            {agent.title ?? agent.role} ({counts.get(`agent:${agent.id}`) ?? 0})
          </a>
        ))}
      </div>

      {notice === undefined ? null : (
        <p class="note" role="status">
          {notice}
        </p>
      )}
      <ErrorNote message={failure ?? data.error} />

      {data.loading && data.data === undefined ? (
        <Loading />
      ) : (
        <div class="memory-layout">
          <div class="stack">
            <section class="card">
              <div class="card-head">
                <h2>{isHandbook ? "Company handbook" : "This agent's memory"}</h2>
                {adding ? null : (
                  <button type="button" onClick={() => setAdding(true)}>
                    Add
                  </button>
                )}
              </div>
              {adding ? (
                <MemoryForm
                  onCancel={() => setAdding(false)}
                  onSave={(fields) =>
                    run(async () => {
                      await send([{ action: "create", kind: "memory", ...fields }]);
                      setAdding(false);
                      return `Saved “${fields.title}”.`;
                    })
                  }
                />
              ) : null}
              {(data.data?.listing.entries ?? []).length === 0 ? (
                <p class="muted">
                  {isHandbook
                    ? "Nothing in the handbook yet. Add how you like things done, and facts about the company."
                    : "This agent has not written anything down yet."}
                </p>
              ) : (
                <ul class="memory-entries">
                  {(data.data?.listing.entries ?? []).map((entry) => (
                    <EntryCard
                      key={`${entry.kind}:${entry.id}`}
                      entry={entry}
                      onSave={(fields) =>
                        run(async () => {
                          await send([
                            { action: "update", kind: entry.kind, id: entry.id, ...fields },
                          ]);
                          return `Saved “${fields.title}”.`;
                        })
                      }
                      onRemove={() =>
                        run(async () => {
                          await send([{ action: "delete", kind: entry.kind, id: entry.id }]);
                          return `Removed “${entry.title}”. Undo it in the history if that was a mistake.`;
                        })
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div class="stack">
            {background === undefined ? null : (
              <section class="card">
                <h2>Background work</h2>
                <p class="small muted">
                  A small model reads your chats for lasting preferences, and idle agents dream:
                  they reread their recent work and tidy their memory. Both use your API key,
                  sparingly.
                </p>
                <JobLine label="Preference scanner" job={background.jobs.scanner} />
                <JobLine label="Dreaming" job={background.jobs.dreaming} />
                <div class="row-end">
                  {background.settings.paused ? (
                    <button
                      type="button"
                      onClick={() =>
                        run(async () => {
                          await api("/memory/background", {
                            method: "PUT",
                            json: { paused: false },
                          });
                          return "Background memory work is back on.";
                        })
                      }
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="ghost"
                      onClick={() =>
                        run(async () => {
                          await api("/memory/background", {
                            method: "PUT",
                            json: { paused: true },
                          });
                          return "Background memory work is paused.";
                        })
                      }
                    >
                      Pause
                    </button>
                  )}
                  <button
                    type="button"
                    class="ghost"
                    onClick={() =>
                      run(async () => {
                        const { result } = await api<{
                          result: { scanned: number; filed: number; skipped?: string };
                        }>("/memory/background/scan", { method: "POST" });
                        return (
                          result.skipped ??
                          `Read ${result.scanned} messages and filed ${result.filed} preferences.`
                        );
                      })
                    }
                  >
                    Scan chats now
                  </button>
                  {isHandbook ? null : (
                    <button
                      type="button"
                      class="ghost"
                      onClick={() =>
                        run(async () => {
                          const { result } = await api<{
                            result: {
                              sessions?: number;
                              scripts?: number;
                              applied?: number;
                              skipped?: string;
                            };
                          }>(`/memory/background/dream/${encodeURIComponent(scope)}`, {
                            method: "POST",
                          });
                          return (
                            result.skipped ??
                            `Dreamed over ${result.sessions ?? 0} sessions and ${result.scripts ?? 0} scripts: ${result.applied ?? 0} changes.`
                          );
                        })
                      }
                    >
                      Dream now
                    </button>
                  )}
                </div>
              </section>
            )}

            <section class="card">
              <h2>History</h2>
              {(data.data?.history.changes ?? []).length === 0 ? (
                <p class="muted">No changes yet.</p>
              ) : (
                <ul class="memory-changes">
                  {(data.data?.history.changes ?? []).map((change) => (
                    <li key={change.id}>
                      <div>
                        <strong>{change.summary}</strong>
                        <div class="small muted">
                          {ORIGIN_LABEL[change.origin?.kind ?? ""] ?? change.actor.kind} ·{" "}
                          {formatTime(change.createdAt)}
                          {change.rationale === undefined ? "" : ` · ${change.rationale}`}
                          {change.undoneBy === undefined ? "" : " · undone"}
                        </div>
                      </div>
                      {change.undoneBy !== undefined || change.undoOf !== undefined ? null : (
                        <button
                          type="button"
                          class="ghost"
                          onClick={() =>
                            run(async () => {
                              const result = await api<EditResult>(
                                `/memory/changes/${encodeURIComponent(change.id)}/undo`,
                                { method: "POST" },
                              );
                              const skipped = result.edits.filter((edit) => !edit.applied).length;
                              return skipped === 0
                                ? `Undone: ${change.summary}.`
                                : `Undone in part. ${skipped} ${skipped === 1 ? "entry" : "entries"} changed again since and ${skipped === 1 ? "was" : "were"} left as it is.`;
                            })
                          }
                        >
                          Undo
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function JobLine({ label, job }: { label: string; job: Job | undefined }) {
  return (
    <p class="small">
      <strong>{label}: </strong>
      {job?.lastRunAt === undefined ? "has not run yet" : `last ran ${formatTime(job.lastRunAt)}`}
      {job?.lastResult === undefined ? "" : ` · ${job.lastResult}`}
      {job?.lastError === undefined ? "" : ` · last problem: ${job.lastError}`}
      {job?.usage?.calls
        ? ` · ${job.usage.calls} calls, ${formatTokens(job.usage.totalTokens)} tokens`
        : ""}
    </p>
  );
}

function EntryCard({
  entry,
  onSave,
  onRemove,
}: {
  entry: MemoryEntry;
  onSave: (fields: { title: string; content: string }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const command = entry.reference["command"];
  if (editing) {
    return (
      <li class="memory-entry">
        <MemoryForm
          entry={entry}
          onCancel={() => setEditing(false)}
          onSave={async (fields) => {
            await onSave(fields);
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li class="memory-entry">
      <div>
        <span class="badge tone-quiet">{KIND_LABEL[entry.kind] ?? entry.kind}</span>{" "}
        <strong>{entry.title}</strong>
        {entry.locked ? <span class="small muted"> · kept as you wrote it</span> : null}
      </div>
      <p class="memory-content">{entry.content}</p>
      {typeof command === "string" ? (
        <p class="small">
          <code>{command}</code>
        </p>
      ) : null}
      <p class="small muted">From: {describeOrigin(entry.origin)}</p>
      <div class="row-end">
        <button type="button" class="ghost" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" class="ghost" onClick={() => void onRemove()}>
          Remove
        </button>
      </div>
    </li>
  );
}

function MemoryForm({
  entry,
  onSave,
  onCancel,
}: {
  entry?: MemoryEntry;
  onSave: (fields: { title: string; content: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [content, setContent] = useState(entry?.content ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="memory-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await onSave({ title: title.trim(), content: content.trim() });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        aria-label="Title"
        placeholder="Title"
        required
        maxLength={200}
        value={title}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
      <textarea
        aria-label="What should be remembered"
        placeholder="What should be remembered"
        required
        rows={4}
        maxLength={20000}
        value={content}
        onInput={(event) => setContent(event.currentTarget.value)}
      />
      <div class="row-end">
        <button type="button" class="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}
