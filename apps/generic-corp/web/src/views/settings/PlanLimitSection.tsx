import { useEffect, useState } from "preact/hooks";

import { api } from "../../api.js";
import { ErrorNote, Loading } from "../../components/ui.js";
import { formatTime } from "../../format.js";
import { isWorkEvent, useResource } from "../../live.js";
import { href } from "../../router.js";
import "./settings.css";
import { errorText, type PlanLimitBehaviour, type PlanLimitStatus } from "./types.js";

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
 * What happens when the Claude plan's usage limit is reached (decision 15). "Paused until your
 * plan resets" is a normal state, shown here and on the held work itself.
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
        Claude plans have a usage limit that resets every few hours. This applies only while agents
        run on your Claude sign-in.
      </p>
      <ErrorNote message={plan.error} />
      {status === undefined ? (
        plan.loading ? (
          <Loading />
        ) : null
      ) : (
        <>
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
