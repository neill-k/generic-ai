import { useCallback, useState } from "preact/hooks";

import { type AgentDetail, api, type CompanyInfo, type OrgNode } from "../api.js";
import { AgentPauseButton, usePause } from "../components/pause.js";
import { Avatar, ErrorNote, Loading, SidePanel } from "../components/ui.js";
import { formatTime } from "../format.js";
import { useResource } from "../live.js";
import { href, navigate } from "../router.js";
import { AgentLimits } from "./settings/AgentLimits.js";

const isAgentEvent = (event: { type: string }) =>
  event.type.startsWith("task.") ||
  event.type.startsWith("agent.") ||
  event.type.startsWith("org.");

/** The org chart is how the owner reaches agents (decision 48). */
export function OrgView({
  agentId,
  company,
}: {
  agentId?: string;
  company: CompanyInfo | undefined;
}) {
  const chart = useResource(
    () => api<{ root: OrgNode }>("/org-chart").then((body) => body.root),
    [],
    isAgentEvent,
  );
  const close = useCallback(() => navigate("org"), []);
  const pause = usePause();
  const paused = new Set(
    pause.data?.company === true ? allIds(chart.data) : (pause.data?.agents ?? []),
  );
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Org chart</h1>
          <p class="muted">Select anyone to speak with them or to see what they are doing.</p>
        </div>
      </header>
      <ErrorNote message={chart.error} />
      {chart.data === undefined ? (
        chart.loading ? (
          <Loading />
        ) : null
      ) : (
        <div class="org-scroll">
          <ul class="org-tree" aria-label="Org chart">
            <OrgBranch node={chart.data} selected={agentId} paused={paused} />
          </ul>
        </div>
      )}
      {agentId === undefined ? null : (
        <AgentPanel agentId={agentId} onClose={close} ceoId={company?.ceoId} />
      )}
    </div>
  );
}

function OrgBranch({
  node,
  selected,
  paused,
}: {
  node: OrgNode;
  selected: string | undefined;
  paused: ReadonlySet<string>;
}) {
  const retired = node.status === "retired";
  return (
    <li>
      <a
        href={href("org", node.id)}
        class={`org-node${selected === node.id ? " selected" : ""}${retired ? " retired" : ""}`}
        aria-current={selected === node.id ? "true" : undefined}
      >
        <Avatar name={node.title ?? node.role} working={node.activeTasks > 0} />
        <span class="org-node-text">
          <span class="org-role">{node.title ?? node.role}</span>
          <span class="small muted">{node.id}</span>
          <span class="small muted">
            {retired
              ? "Retired."
              : paused.has(node.id)
                ? "Paused."
                : node.activeTasks === 0
                  ? "Available."
                  : node.activeTasks === 1
                    ? "On one task."
                    : `On ${node.activeTasks} tasks.`}
          </span>
        </span>
      </a>
      {node.reports.length === 0 ? null : (
        <ul>
          {node.reports.map((report) => (
            <OrgBranch key={report.id} node={report} selected={selected} paused={paused} />
          ))}
        </ul>
      )}
    </li>
  );
}

function allIds(node: OrgNode | undefined): string[] {
  return node === undefined ? [] : [node.id, ...node.reports.flatMap(allIds)];
}

const TASK_WORDS: Record<string, string> = {
  queued: "Up next",
  running: "Working on it",
  waiting: "Waiting on its reports",
  succeeded: "Handed in",
  failed: "Stopped",
  cancelled: "Cancelled",
};

function AgentPanel({
  agentId,
  onClose,
  ceoId,
}: {
  agentId: string;
  onClose: () => void;
  ceoId: string | undefined;
}) {
  const detail = useResource(
    () => api<AgentDetail>(`/agents/${encodeURIComponent(agentId)}`),
    [agentId],
    (event) => {
      const task = event.data["task"] as { agentId?: string } | undefined;
      return task?.agentId === agentId;
    },
  );
  const [tab, setTab] = useState<"now" | "chat" | "memory" | "limits">("chat");
  const data = detail.data;
  const title = data?.agent.title ?? data?.agent.role ?? agentId;
  const active =
    data?.tasks.filter((task) => ["queued", "running", "waiting"].includes(task.status)) ?? [];
  const recent =
    data?.tasks.filter((task) => !["queued", "running", "waiting"].includes(task.status)) ?? [];

  return (
    <SidePanel title={title} onClose={onClose} wide>
      <ErrorNote message={detail.error} />
      {data === undefined ? (
        <Loading />
      ) : (
        <div class="stack">
          <div class="agent-head">
            <Avatar name={data.agent.title ?? data.agent.role} working={active.length > 0} />
            <div>
              <p>{data.agent.id}</p>
              <p class="small muted">
                {data.managementChain.length === 0
                  ? "Reports to you."
                  : `Reports to ${data.managementChain[0]}.`}{" "}
                {data.reports.length === 0
                  ? ""
                  : `${data.reports.length} direct report${data.reports.length === 1 ? "" : "s"}.`}
                {data.agent.model === undefined ? "" : ` Runs on ${data.agent.model}.`}
              </p>
            </div>
          </div>
          <AgentPauseButton agentId={agentId} name={title} />
          <div class="tabs" role="tablist">
            {(
              [
                ["chat", "Message"],
                ["now", "Now"],
                ["memory", "Memory"],
                ["limits", "Limits"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                class={tab === id ? "tab active" : "tab"}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "now" ? (
            <div class="stack">
              {active.length === 0 ? (
                <p class="muted">Nothing assigned at the moment.</p>
              ) : (
                <ul class="task-list">
                  {active.map((task) => (
                    <li key={task.taskId}>
                      <a href={href("goals", task.rootTaskId)}>{task.title}</a>
                      <span class="small muted">{TASK_WORDS[task.status] ?? task.status}</span>
                    </li>
                  ))}
                </ul>
              )}
              {recent.length === 0 ? null : (
                <>
                  <h3>Recently</h3>
                  <ul class="task-list">
                    {recent.slice(0, 8).map((task) => (
                      <li key={task.taskId}>
                        <a href={href("goals", task.rootTaskId)}>{task.title}</a>
                        <span class="small muted">
                          {TASK_WORDS[task.status] ?? task.status} · {formatTime(task.updatedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}

          {tab === "chat" ? (
            <AgentMessage agentId={agentId} name={title} isCeo={agentId === ceoId} />
          ) : null}

          {tab === "memory" ? (
            data.memory.trim().length === 0 ? (
              <p class="muted">This agent has not written anything down yet.</p>
            ) : (
              <pre class="memory">{data.memory}</pre>
            )
          ) : null}
          {tab === "memory" ? (
            <p class="small">
              <a href={href("memory", agentId)}>Open the memory page</a> to edit, see where each
              entry came from, or undo a change.
            </p>
          ) : null}
          {tab === "limits" ? <AgentLimits agentId={agentId} name={title} /> : null}
        </div>
      )}
    </SidePanel>
  );
}

interface ChatEntry {
  message: {
    messageId: string;
    text: string;
    createdAt: string;
    delivery: "current-work" | "new-request";
    taskIds: string[];
  };
  reply?: { taskId: string; status: string; text?: string; error?: string };
}

/**
 * Direct messages to any agent (decisions 4 and 5). A busy agent reads the message at its next
 * step; an idle one takes it as a new request with its own goal. The CEO is told either way.
 */
function AgentMessage({ agentId, name, isCeo }: { agentId: string; name: string; isCeo: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const history = useResource(
    () =>
      api<{ messages: ChatEntry[] }>(`/agents/${encodeURIComponent(agentId)}/messages`).then(
        (body) => body.messages,
      ),
    [agentId],
    (event) =>
      (event.type === "agent.message" && event.data["agentId"] === agentId) ||
      ((event.type === "task.succeeded" || event.type === "task.failed") &&
        (event.data["task"] as { agentId?: string } | undefined)?.agentId === agentId),
  );
  const send = async (event: Event) => {
    event.preventDefault();
    if (text.trim().length === 0) {
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await api(`/agents/${encodeURIComponent(agentId)}/messages`, {
        method: "POST",
        json: { text },
      });
      setText("");
      history.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  const entries = history.data ?? [];
  return (
    <div class="stack">
      <p class="small muted">
        If {name} is busy, your message reaches it at its next step. If not, it becomes a new
        request with its own definition of done.
        {isCeo ? "" : " The CEO is informed that you spoke to its team directly."}
      </p>
      {entries.length === 0 ? (
        <p class="muted">No messages yet. The line is open.</p>
      ) : (
        <ol class="messages">
          {entries.map((entry) => (
            <li key={entry.message.messageId}>
              <div class="message owner">
                <span class="who">You</span>
                <p>{entry.message.text}</p>
                <span class="small muted">
                  {formatTime(entry.message.createdAt)} ·{" "}
                  {entry.message.delivery === "current-work" ? (
                    "delivered to its current work"
                  ) : (
                    <a href={href("goals", entry.message.taskIds[0])}>filed as a new request</a>
                  )}
                </span>
              </div>
              {entry.reply?.text !== undefined || entry.reply?.error !== undefined ? (
                <div class="message agent">
                  <span class="who">{name}</span>
                  <p>{entry.reply?.text ?? entry.reply?.error}</p>
                </div>
              ) : entry.reply !== undefined ? (
                <p class="small muted">{name} is on it.</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <form class="stack" onSubmit={send}>
        <textarea
          rows={3}
          aria-label={`Message to ${name}`}
          value={text}
          onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              void send(event);
            }
          }}
        />
        <div class="row-end">
          <button type="submit" class="primary" disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
      <ErrorNote message={error} />
    </div>
  );
}
