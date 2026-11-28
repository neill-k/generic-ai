import { useEffect, useState } from "preact/hooks";

import { api } from "../../api.js";
import { ErrorNote, Loading } from "../../components/ui.js";
import { formatTime } from "../../format.js";
import { isWorkEvent, useResource } from "../../live.js";
import { href } from "../../router.js";
import "./settings.css";
import {
  errorText,
  type PlanLimitBehaviour,
  type PlanLimitStatus,
  type PlanWindowUsage,
} from "./types.js";

const WINDOW_NAMES: Readonly<Record<string, string>> = {
  five_hour: "5-hour window",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
};

function windowLine(entry: PlanWindowUsage): string {
  const name = WINDOW_NAMES[entry.window] ?? entry.window.replaceAll("_", " ");
  const used =
    entry.utilization === undefined ? "in use" : `${Math.round(entry.utilization * 100)}% used`;
  const resets = entry.resetsAt === undefined ? "" : `, resets ${formatTime(entry.resetsAt)}`;
  return `${name}: ${used}${resets}.`;
}

const CHOICES: readonly [PlanLimitBehaviour, string, string][] = [
  [
    "wait",
    "Wait for the plan to reset",
    "Work pauses and picks up again on its own once your plan resets. Costs nothing extra.",
  ],
  [
    "api_key",
    "Use an API key until then",
    "Work carries on, billed to your Anthropic API key, and goes back to your plan once it resets.",
  ],
];

/**
 * The Claude plan's usage, as the Claude Agent SDK last reported it, and what happens when its
 * limit is reached (decision 15). "Paused until your plan resets" is a normal state, shown here and
 * on the held work itself. Shown only while agents run on the plan.
 */
export function PlanLimitSection() {
  const plan = useResource(() => api<PlanLimitStatus>("/settings/plan-limit"), [], isWorkEvent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PlanLimitBehaviour | undefined>(undefined);
  useEffect(() => setPending(undefined), [plan.data]);

  const choose = async (behaviour: PlanLimitBehaviour) => {
    setBusy(true);
    setError(undefined);
    setPending(behaviour);
    try {
      await api("/settings/plan-limit", { method: "PUT", json: { behaviour } });
      plan.reload();
    } catch (reason) {
      setError(errorText(reason));
      setPending(undefined);
    } finally {
      setBusy(false);
    }
  };

  const status = plan.data;
  const chosen = pending ?? status?.behaviour;
  return (
    <section class="card settings-card stack" aria-label="When the plan's limit is reached">
      <h2>When your plan's usage limit is reached</h2>
      <p class="small muted">
        Claude plans have a usage limit that resets every few hours, and a weekly one. Agents and
        their checks count toward it.
      </p>
      <ErrorNote message={plan.error} />
      {status === undefined ? (
        plan.loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          {status.usage === undefined || status.usage.length === 0 ? (
            <p class="small muted">No plan usage reported yet. It shows after the first turn.</p>
          ) : (
            <ul class="small plan-usage" aria-label="Plan usage">
              {status.usage.map((entry) => (
                <li key={entry.window}>{windowLine(entry)}</li>
              ))}
            </ul>
          )}
          {status.limited ? (
            <p class="notice" role="status">
              {status.usingApiKey
                ? "Your plan's limit is reached. Work is running on your API key"
                : "Paused until your Claude plan resets"}
              {status.limitedUntil === undefined
                ? "."
                : status.resetKnown === true
                  ? `, at ${formatTime(status.limitedUntil)}.`
                  : `. The plan is tried again at ${formatTime(status.limitedUntil)}.`}
            </p>
          ) : null}
          <fieldset class="choice-list" disabled={busy}>
            <legend class="sr-only">When the plan's limit is reached</legend>
            {CHOICES.map(([behaviour, label, hint]) => (
              <label key={behaviour} class={`choice${chosen === behaviour ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="plan-limit"
                  checked={chosen === behaviour}
                  onChange={() => void choose(behaviour)}
                />
                <span>
                  <strong>{label}</strong>
                  <span class="small muted block">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {chosen === "api_key" && !status.apiKeyAvailable ? (
            <p class="small notice">
              No Anthropic API key is set, so work waits for now. Add one named ANTHROPIC_API_KEY
              under <a href={href("connections")}>Connections</a>, or in the server's environment.
            </p>
          ) : null}
        </>
      )}
      <ErrorNote message={error} />
    </section>
  );
}
