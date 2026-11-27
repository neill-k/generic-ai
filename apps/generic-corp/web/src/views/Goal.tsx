import { useCallback, useState } from "preact/hooks";

import { api, fileUrl, type GoalDetail } from "../api.js";
import {
  Avatar,
  Checklist,
  CheckMark,
  Empty,
  ErrorNote,
  Loading,
  SidePanel,
  StateBadge,
} from "../components/ui.js";
import { fileName, formatSize, formatTime, formatTokens, formatUsd, timeAgo } from "../format.js";
import { type LiveEvent, useResource } from "../live.js";
import { href } from "../router.js";

const FINISHED = new Set(["done", "impossible", "stopped", "cancelled"]);

/** How each kind of check works, in plain words. */
const CHECK_KIND: Record<string, string> = {
  output_schema: "format check",
  rubric: "judged by a second model",
  numeric: "measured by the host",
  trace: "checks what was done",
  check: "host check",
};

function touches(goalId: string, event: LiveEvent): boolean {
  if (event.type.startsWith("drive.") || event.type === "thread.updated") {
    return true;
  }
  const task = event.data["task"] as { rootTaskId?: string } | undefined;
  return task?.rootTaskId === goalId;
}

export function GoalView({ goalId }: { goalId: string }) {
  const goal = useResource(
    () =>
      api<{ goal: GoalDetail }>(`/goal-views/${encodeURIComponent(goalId)}`).then((b) => b.goal),
    [goalId],
    (event) => touches(goalId, event),
  );
  const [editing, setEditing] = useState(false);
  const closeEditor = useCallback(() => setEditing(false), []);

  if (goal.data === undefined) {
    return (
      <div class="page">
        <a class="back" href={href("goals")}>
          ← Goals
        </a>
        <ErrorNote message={goal.error} />
        {goal.loading ? <Loading /> : null}
      </div>
    );
  }
  const data = goal.data;
  const finished = FINISHED.has(data.state);

  return (
    <div class="page goal-page">
      <a class="back" href={href("goals")}>
        ← Goals
      </a>
      <header class="goal-header">
        <StateBadge state={data.state} />
        <h1>{data.title}</h1>
        {data.objective !== undefined && data.objective !== data.title ? (
          <p class="muted">{data.objective}</p>
        ) : null}
        <p class="status-line">{data.statusText}</p>
        {data.failure === undefined ? null : <p class="error">{data.failure}</p>}
        {data.impossible === undefined ? null : (
          <div class="note">
            <p>
              <strong>Reason given:</strong> {data.impossible.reason}
            </p>
            {data.impossible.reasoning === undefined ? null : (
              <p class="small muted">Reviewer: {data.impossible.reasoning}</p>
            )}
          </div>
        )}
      </header>

      <div class="goal-layout">
        <div class="goal-main">
          <section class="card">
            <div class="card-head">
              <h2>What done means</h2>
              <button type="button" class="ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
            <Checklist items={data.checklist} />
            <p class="small muted">
              {data.revision === undefined || data.revision <= 1
                ? "Version 1."
                : `Version ${data.revision}.`}{" "}
              {data.lastCheckedAt === undefined
                ? "Not checked yet. Checks run when work is handed in."
                : data.checkedCurrentVersion
                  ? `Last checked ${timeAgo(data.lastCheckedAt)}.`
                  : "You changed this after the last check. The next hand-in is checked against it."}
            </p>
          </section>

          <Questions goal={data} onAnswered={goal.reload} />

          <section class="card">
            <h2>Delivered</h2>
            {data.summary === undefined ? null : <p class="summary">{data.summary}</p>}
            {data.files.length === 0 && data.deliverables.length === 0 ? (
              <p class="muted">Nothing has been handed in yet.</p>
            ) : (
              <ul class="files">
                {(data.files.length > 0
                  ? data.files.map((file) => ({
                      path: file.path,
                      size: file.size,
                      title: undefined,
                    }))
                  : data.deliverables.map((item) => ({ ...item, size: undefined }))
                ).map((file) => (
                  <li key={file.path}>
                    <a href={fileUrl(file.path)} target="_blank" rel="noreferrer">
                      {file.title ?? fileName(file.path)}
                    </a>
                    <span class="small muted">{formatSize(file.size)}</span>
                    <a class="small" href={fileUrl(file.path, true)}>
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Conversation goal={data} onSent={goal.reload} />
        </div>

        <aside class="goal-side">
          <section class="card">
            <h2>On this goal</h2>
            {data.team.length === 0 ? (
              <p class="muted">Nobody has picked this up yet.</p>
            ) : (
              <ul class="team">
                {data.team.map((member) => (
                  <li key={member.agentId}>
                    <a href={href("org", member.agentId)} class="team-member">
                      <Avatar name={member.title ?? member.role} working={member.working} />
                      <span>
                        <span class="team-role">{member.title ?? member.role}</span>
                        <span class="small muted">{member.statusText}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section class="card">
            <h2>Used so far</h2>
            <p class="big-number">{formatTokens(data.usage.tokens)}</p>
            <p class="small muted">tokens · about {formatUsd(data.usage.costUsd)} at API prices</p>
          </section>

          {data.checks.length > 0 ? (
            <section class="card">
              <h2>How it is checked</h2>
              <ul class="checks">
                {data.checks.map((check) => (
                  <li key={check.id}>
                    <CheckMark state={check.state} />
                    <span>
                      <span>{check.description ?? check.id}</span>
                      <span class="small muted">
                        {" "}
                        {CHECK_KIND[check.kind] ?? check.kind}
                        {check.required ? "" : ", advisory"}
                      </span>
                      {check.message === undefined || check.state === "met" ? null : (
                        <span class="small muted block">{check.message}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section class="card">
            <h2>Record</h2>
            <ul class="small record">
              <li>Set {formatTime(data.createdAt)}</li>
              {data.history
                .filter((entry) => entry.revision > 1)
                .map((entry) => (
                  <li key={entry.revision}>
                    Version {entry.revision} by {entry.changedBy ?? entry.source},{" "}
                    {formatTime(entry.changedAt)}
                  </li>
                ))}
              {data.completedAt === undefined ? null : (
                <li>Closed {formatTime(data.completedAt)}</li>
              )}
            </ul>
            {finished ? null : <CancelGoal goalId={data.goalId} onDone={goal.reload} />}
          </section>
        </aside>
      </div>

      {editing ? (
        <SidePanel title="What done means" onClose={closeEditor}>
          <DefinitionEditor
            goal={data}
            onSaved={() => {
              setEditing(false);
              goal.reload();
            }}
          />
        </SidePanel>
      ) : null}
    </div>
  );
}

/** The owner can change what done means at any time (decision 8). Agents hear at their next step. */
function DefinitionEditor({ goal, onSaved }: { goal: GoalDetail; onSaved: () => void }) {
  const [text, setText] = useState(goal.definitionOfDone.join("\n"));
  const [objective, setObjective] = useState(goal.objective ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await api(`/tasks/${encodeURIComponent(goal.goalId)}/goal`, {
        method: "PUT",
        json: {
          definitionOfDone: text.split("\n"),
          ...(objective.trim().length === 0 ? {} : { objective }),
        },
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form class="stack" onSubmit={save}>
      <p class="muted small">
        One line per thing that must be true. Everyone on the goal is told at their next step and
        every line is checked when work is handed in.
        {FINISHED.has(goal.state) && goal.state !== "cancelled" ? " Saving reopens this goal." : ""}
      </p>
      <label class="label" for="dod-text">
        Done means
      </label>
      <textarea
        id="dod-text"
        rows={Math.max(6, goal.definitionOfDone.length + 2)}
        value={text}
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
      />
      <label class="label" for="dod-objective">
        Objective
      </label>
      <input
        id="dod-objective"
        value={objective}
        onInput={(event) => setObjective((event.target as HTMLInputElement).value)}
      />
      <ErrorNote message={error} />
      <div class="row-end">
        <button type="submit" class="primary" disabled={saving}>
          {saving ? "Saving…" : "Save new version"}
        </button>
      </div>
    </form>
  );
}

/** Questions agents wrote down. They never block: each one says what the agent assumed. */
function Questions({ goal, onAnswered }: { goal: GoalDetail; onAnswered: () => void }) {
  const open = goal.questions.filter((question) => question.answer === undefined);
  if (goal.questions.length === 0) {
    return null;
  }
  return (
    <section class="card">
      <h2>Questions for you</h2>
      <p class="small muted">
        Nobody is waiting on these. Each agent carried on with the assumption shown. Answer if the
        assumption is wrong.
      </p>
      {open.length === 0 ? <p class="muted">All answered.</p> : null}
      <ul class="questions">
        {goal.questions.map((question) => (
          <QuestionItem key={question.questionId} question={question} onAnswered={onAnswered} />
        ))}
      </ul>
    </section>
  );
}

function QuestionItem({
  question,
  onAnswered,
}: {
  question: GoalDetail["questions"][number];
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const send = async (event: Event) => {
    event.preventDefault();
    if (answer.trim().length === 0) {
      return;
    }
    try {
      await api(
        `/tasks/${encodeURIComponent(question.taskId)}/questions/${encodeURIComponent(question.questionId)}/answer`,
        { method: "POST", json: { answer } },
      );
      setAnswer("");
      onAnswered();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <li class="question">
      <p>
        <a href={href("org", question.agentId)}>{question.agentId}</a> asked: {question.question}
      </p>
      <p class="small muted">Assumed: {question.assumption}</p>
      {question.answer === undefined ? (
        <form class="inline-form" onSubmit={send}>
          <input
            aria-label="Your answer"
            placeholder="Your answer"
            value={answer}
            onInput={(event) => setAnswer((event.target as HTMLInputElement).value)}
          />
          <button type="submit">Answer</button>
        </form>
      ) : (
        <p class="small">You answered: {question.answer}</p>
      )}
      <ErrorNote message={error} />
    </li>
  );
}

function Conversation({ goal, onSent }: { goal: GoalDetail; onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const thread = goal.conversation;
  if (thread === undefined) {
    return null;
  }
  const exchanges = thread.exchanges.filter((exchange) => exchange.message.taskId === goal.goalId);
  const later = thread.exchanges.filter((exchange) => exchange.message.taskId !== goal.goalId);
  const send = async (event: Event) => {
    event.preventDefault();
    if (text.trim().length === 0) {
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await api(`/threads/${encodeURIComponent(thread.threadId)}/messages`, {
        method: "POST",
        json: { text },
      });
      setText("");
      onSent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  return (
    <section class="card">
      <h2>Conversation with the CEO</h2>
      {exchanges.length === 0 ? <Empty title="No messages." /> : null}
      <ol class="messages">
        {exchanges.map((exchange) => (
          <li key={exchange.message.messageId}>
            <div class="message owner">
              <span class="who">You</span>
              <p>{exchange.message.text}</p>
              <span class="small muted">{formatTime(exchange.message.createdAt)}</span>
            </div>
            {exchange.reply.text !== undefined || exchange.reply.error !== undefined ? (
              <div class="message agent">
                <span class="who">CEO</span>
                <p>{exchange.reply.text ?? exchange.reply.error}</p>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {later.length > 0 ? (
        <p class="small muted">
          Follow-up requests in this conversation became their own goals:{" "}
          {later.map((exchange, index) => (
            <span key={exchange.message.messageId}>
              {index > 0 ? ", " : ""}
              <a href={href("goals", exchange.message.taskId)}>
                {exchange.message.text.slice(0, 40)}
              </a>
            </span>
          ))}
        </p>
      ) : null}
      <form class="inline-form" onSubmit={send}>
        <input
          aria-label="Follow-up to the CEO"
          placeholder="Ask a follow-up. It becomes a new goal."
          value={text}
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
        />
        <button type="submit" disabled={sending}>
          Send
        </button>
      </form>
      <ErrorNote message={error} />
    </section>
  );
}

function CancelGoal({ goalId, onDone }: { goalId: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (!confirming) {
    return (
      <button type="button" class="ghost danger" onClick={() => setConfirming(true)}>
        Cancel this goal
      </button>
    );
  }
  return (
    <div class="confirm">
      <p class="small">Work stops. What exists stays on the drive, marked abandoned.</p>
      <div class="row-end">
        <button type="button" class="ghost" onClick={() => setConfirming(false)}>
          Keep going
        </button>
        <button
          type="button"
          class="danger"
          onClick={async () => {
            try {
              await api(`/tasks/${encodeURIComponent(goalId)}/cancel`, {
                method: "POST",
                json: { reason: "Cancelled by the owner." },
              });
              setConfirming(false);
              onDone();
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          }}
        >
          Cancel goal
        </button>
      </div>
      <ErrorNote message={error} />
    </div>
  );
}
