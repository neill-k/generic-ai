import { api } from "../api.js";
import { formatTokens } from "../format.js";
import { isWorkEvent, useResource } from "../live.js";
import { href } from "../router.js";

interface SummaryGoal {
  goalId: string;
  title: string;
  state: string;
}

export interface DailySummaryBody {
  from: string;
  to: string;
  headline: string;
  done: SummaryGoal[];
  ended: SummaryGoal[];
  started: number;
  open: number;
  handedIn: number;
  refused: number;
  orgChanges: string[];
  tokens: number;
  costUsd: number;
}

const ENDED_WORDS: Record<string, string> = {
  impossible: "declared impossible",
  stopped: "stopped",
  cancelled: "cancelled",
};

export function useDailySummary() {
  return useResource(() => api<DailySummaryBody>("/summary"), [], isWorkEvent);
}

/**
 * The quiet daily summary (decision 35). It is never sent anywhere: it waits here for the owner,
 * like a memo on the desk.
 */
export function DailySummaryCard() {
  const summary = useDailySummary();
  const body = summary.data;
  if (body === undefined) {
    return null;
  }
  return (
    <section class="card daily-summary" aria-label="The last 24 hours">
      <h2>The last 24 hours</h2>
      <p class="daily-headline">{body.headline}</p>
      {body.done.length > 0 || body.ended.length > 0 ? (
        <ul class="daily-goals">
          {body.done.map((goal) => (
            <li key={goal.goalId}>
              <span class="daily-mark done" aria-hidden="true">
                ✓
              </span>
              <a href={href("goals", goal.goalId)}>{goal.title}</a>
            </li>
          ))}
          {body.ended.map((goal) => (
            <li key={goal.goalId}>
              <span class="daily-mark ended" aria-hidden="true">
                ×
              </span>
              <a href={href("goals", goal.goalId)}>{goal.title}</a>
              <span class="small muted"> · {ENDED_WORDS[goal.state] ?? goal.state}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {body.orgChanges.length > 0 ? (
        <ul class="daily-org small">
          {body.orgChanges.map((change, index) => (
            <li key={`${index}:${change}`}>{change}</li>
          ))}
        </ul>
      ) : null}
      <p class="small muted">
        {body.open} {body.open === 1 ? "goal" : "goals"} open · {formatTokens(body.tokens)} tokens
        {body.refused > 0 ? (
          <>
            {" · "}
            <a href={href("permissions")}>
              {body.refused} refused {body.refused === 1 ? "action" : "actions"}
            </a>
          </>
        ) : null}
      </p>
    </section>
  );
}
