import { useState } from "preact/hooks";

import { api, type GoalTemplate, type GoalView } from "../api.js";
import { Avatar, Empty, ErrorNote, Loading, StateBadge } from "../components/ui.js";
import { formatTokens, timeAgo } from "../format.js";
import { isWorkEvent, useResource } from "../live.js";
import { href, navigate } from "../router.js";

const FINISHED = new Set(["done", "impossible", "stopped", "cancelled"]);

/** The home screen (decision 47): every goal, the open ones first. */
export function GoalsView() {
  const goals = useResource(
    () => api<{ goals: GoalView[] }>("/goal-views").then((body) => body.goals),
    [],
    isWorkEvent,
  );
  const [showFinished, setShowFinished] = useState(true);

  const open = goals.data?.filter((goal) => !FINISHED.has(goal.state)) ?? [];
  const finished = goals.data?.filter((goal) => FINISHED.has(goal.state)) ?? [];

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Goals</h1>
          <p class="muted">
            {goals.data === undefined
              ? "Reviewing the company's objectives."
              : open.length === 0
                ? "Nothing is in progress."
                : `${open.length} in progress.`}
          </p>
        </div>
      </header>

      <NewGoal />

      <ErrorNote message={goals.error} />
      {goals.loading && goals.data === undefined ? <Loading /> : null}

      {goals.data !== undefined && goals.data.length === 0 ? (
        <Empty title="No goals have been set.">
          The company is ready when you are. State a goal above and the CEO will write down what
          done means, then see it through.
        </Empty>
      ) : null}

      {open.length > 0 ? (
        <section aria-label="In progress" class="goal-grid">
          {open.map((goal) => (
            <GoalCard key={goal.goalId} goal={goal} />
          ))}
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section aria-label="Finished" class="finished">
          <button
            type="button"
            class="section-toggle"
            aria-expanded={showFinished}
            onClick={() => setShowFinished(!showFinished)}
          >
            Finished <span class="count">{finished.length}</span>
          </button>
          {showFinished ? (
            <div class="goal-grid">
              {finished.map((goal) => (
                <GoalCard key={goal.goalId} goal={goal} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function GoalCard({ goal }: { goal: GoalView }) {
  const met = goal.checklist.filter((item) => item.state === "met").length;
  const total = goal.checklist.length;
  const working = goal.team.filter((member) => member.working);
  return (
    <a class={`goal-card state-${goal.state}`} href={href("goals", goal.goalId)}>
      <div class="goal-card-top">
        <StateBadge state={goal.state} />
        <span class="muted small">{timeAgo(goal.updatedAt)}</span>
      </div>
      <h2 class="goal-title">{goal.title}</h2>
      {total > 0 ? (
        <div class="progress">
          <div class="progress-bar" aria-hidden="true">
            <span style={{ width: `${(met / total) * 100}%` }} />
          </div>
          <span class="small muted">
            {met} of {total} met{goal.checkedCurrentVersion ? "" : " · changed since last check"}
          </span>
        </div>
      ) : (
        <p class="small muted">Done has not been defined yet.</p>
      )}
      <div class="goal-card-foot">
        <span class="team-stack" title={`${goal.team.length} on this goal`}>
          {goal.team.slice(0, 5).map((member) => (
            <Avatar
              key={member.agentId}
              name={member.title ?? member.role}
              working={member.working}
            />
          ))}
          {goal.team.length > 5 ? <span class="small muted">+{goal.team.length - 5}</span> : null}
        </span>
        <span class="small muted">
          {working.length > 0
            ? `${working.map((member) => member.title ?? member.role).join(", ")} working`
            : goal.deliverables.length > 0
              ? `${goal.deliverables.length} delivered`
              : ""}
        </span>
        <span class="small muted">{formatTokens(goal.usage.tokens)} tokens</span>
      </div>
      {goal.openQuestions > 0 ? (
        <p class="small note">
          {goal.openQuestions === 1
            ? "One question for you. Work continues on a stated assumption."
            : `${goal.openQuestions} questions for you. Work continues on stated assumptions.`}
        </p>
      ) : null}
    </a>
  );
}

/** States a new goal. The CEO drafts what done means; a standing goal brings its own. */
function NewGoal() {
  const [text, setText] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const templates = useResource(
    () => api<{ goals: GoalTemplate[] }>("/goals").then((body) => body.goals),
    [],
  );
  const template = templates.data?.find((goal) => goal.id === templateId);

  const submit = async (event: Event) => {
    event.preventDefault();
    const message = text.trim();
    if (message.length === 0 && template === undefined) {
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      const body = await api<{ taskId: string }>("/threads", {
        method: "POST",
        json: {
          ...(message.length === 0 ? {} : { text: message }),
          ...(template === undefined ? {} : { goalId: template.id }),
        },
      });
      setText("");
      setTemplateId("");
      navigate("goals", body.taskId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <form class="new-goal" onSubmit={submit}>
      <label for="new-goal-text" class="label">
        Set a goal
      </label>
      <textarea
        id="new-goal-text"
        rows={2}
        value={text}
        placeholder={
          template === undefined
            ? "Describe the outcome you want. The CEO will write down what done means and see it through."
            : template.request
        }
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            void submit(event);
          }
        }}
      />
      <div class="new-goal-row">
        {templates.data !== undefined && templates.data.length > 0 ? (
          <select
            aria-label="Start from a standing goal"
            value={templateId}
            onChange={(event) => setTemplateId((event.target as HTMLSelectElement).value)}
          >
            <option value="">Start from scratch</option>
            {templates.data.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
        ) : (
          <span />
        )}
        <button type="submit" class="primary" disabled={sending}>
          {sending ? "Filing…" : "Set goal"}
        </button>
      </div>
      {template === undefined ? null : (
        <div class="template-preview">
          <p class="small muted">Done means:</p>
          <ul class="small">
            {template.definitionOfDone.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote message={error} />
    </form>
  );
}
