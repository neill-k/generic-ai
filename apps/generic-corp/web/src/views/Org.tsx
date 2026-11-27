import { useCallback, useState } from "preact/hooks";

import { type AgentDetail, api, type CompanyInfo, type OrgNode } from "../api.js";
import { Avatar, ErrorNote, Loading, SidePanel } from "../components/ui.js";
import { formatTime } from "../format.js";
import { useResource } from "../live.js";
import { href, navigate } from "../router.js";

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
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Org chart</h1>
          <p class="muted">Select anyone to see what they are doing or to speak with them.</p>
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
            <OrgBranch node={chart.data} selected={agentId} />
          </ul>
        </div>
      )}
      {agentId === undefined ? null : (
        <AgentPanel agentId={agentId} onClose={close} ceoId={company?.ceoId} />
      )}
    </div>
  );
}

function OrgBranch({ node, selected }: { node: OrgNode; selected: string | undefined }) {
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
            <OrgBranch key={report.id} node={report} selected={selected} />
          ))}
        </ul>
      )}
    </li>
  );
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
  const [tab, setTab] = useState<"now" | "chat" | "memory">("now");
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
          <div class="tabs" role="tablist">
            {(
              [
                ["now", "Now"],
                ["chat", "Message"],
                ["memory", "Memory"],
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

          {tab === "chat" ? <AgentMessage agentId={agentId} isCeo={agentId === ceoId} /> : null}

          {tab === "memory" ? (
            data.memory.trim().length === 0 ? (
              <p class="muted">This agent has not written anything down yet.</p>
            ) : (
              <pre class="memory">{data.memory}</pre>
            )
          ) : null}
        </div>
      )}
    </SidePanel>
  );
}

/** A message to the CEO starts a goal. Messages to other agents come with direct chat. */
function AgentMessage({ agentId, isCeo }: { agentId: string; isCeo: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (!isCeo) {
    return (
      <p class="muted">
        Direct messages to {agentId} are not open in this build. Speak with the CEO, who will pass
        it along.
      </p>
    );
  }
  const send = async (event: Event) => {
    event.preventDefault();
    if (text.trim().length === 0) {
      return;
    }
    setSending(true);
    try {
      const body = await api<{ taskId: string }>("/threads", { method: "POST", json: { text } });
      navigate("goals", body.taskId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  return (
    <form class="stack" onSubmit={send}>
      <p class="small muted">
        Each message to the CEO becomes a goal with its own definition of done.
      </p>
      <textarea
        rows={4}
        aria-label="Message to the CEO"
        value={text}
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
      />
      <div class="row-end">
        <button type="submit" class="primary" disabled={sending}>
          Send
        </button>
      </div>
      <ErrorNote message={error} />
    </form>
  );
}
