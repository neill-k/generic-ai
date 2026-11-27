import { useEffect, useState } from "preact/hooks";

import { api } from "../../api.js";
import { ErrorNote, Loading } from "../../components/ui.js";
import { formatTokens, formatUsd } from "../../format.js";
import { useResource } from "../../live.js";
import { LimitEditor } from "./LimitEditor.js";
import { useLimits } from "./LimitsSection.js";
import "./settings.css";
import { errorText, type QualityLevel, type QualityView, type SpendLimit } from "./types.js";

const QUALITY: readonly [QualityLevel, string, string][] = [
  ["best", "Best", "The most capable model. Slower and costs the most."],
  ["balanced", "Balanced", "Strong work at a middle price."],
  ["cheap", "Cheap", "Fast and inexpensive, for routine work."],
];

/**
 * One agent's quality dial (decision 22) and spending limit (decision 42), shown in its card on
 * the org chart. Model names sit behind "Show models" for the advanced view.
 */
export function AgentLimits({ agentId, name }: { agentId: string; name: string }) {
  return (
    <div class="stack">
      <QualityDial agentId={agentId} name={name} />
      <AgentSpending agentId={agentId} name={name} />
    </div>
  );
}

function QualityDial({ agentId, name }: { agentId: string; name: string }) {
  const quality = useResource(() => api<QualityView>("/quality"), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showModels, setShowModels] = useState(false);
  // The choice shows at once; the server's answer replaces it.
  const [pending, setPending] = useState<QualityLevel | "default" | undefined>(undefined);
  useEffect(() => setPending(undefined), [quality.data]);
  const agent = quality.data?.agents.find((entry) => entry.agentId === agentId);
  const modelOf = (level: QualityLevel) =>
    quality.data?.levels.find((entry) => entry.level === level)?.model;

  const choose = async (level: QualityLevel | "default") => {
    setBusy(true);
    setError(undefined);
    setPending(level);
    try {
      await api(`/agents/${encodeURIComponent(agentId)}/quality`, {
        method: "PUT",
        json: { level },
      });
      quality.reload();
    } catch (reason) {
      setError(errorText(reason));
      setPending(undefined);
    } finally {
      setBusy(false);
    }
  };

  const selected: QualityLevel | "default" = pending ?? agent?.level ?? "default";
  return (
    <section class="stack" aria-label="Quality">
      <h3>Quality</h3>
      <p class="small muted">
        How capable a model {name} works with. Higher quality costs more. The change applies from
        its next turn.
      </p>
      <ErrorNote message={quality.error} />
      {quality.data === undefined ? (
        quality.loading ? (
          <Loading />
        ) : null
      ) : agent === undefined ? (
        <p class="muted">The quality dial is not available for this agent.</p>
      ) : (
        <>
          <fieldset class="choice-list" disabled={busy}>
            <legend class="sr-only">Quality for {name}</legend>
            {QUALITY.map(([level, label, hint]) => (
              <label key={level} class={`choice${selected === level ? " selected" : ""}`}>
                <input
                  type="radio"
                  name={`quality-${agentId}`}
                  checked={selected === level}
                  onChange={() => void choose(level)}
                />
                <span>
                  <strong>{label}</strong>
                  <span class="small muted block">
                    {hint}
                    {showModels && modelOf(level) !== undefined ? ` ${modelOf(level)}.` : ""}
                  </span>
                </span>
              </label>
            ))}
            <label class={`choice${selected === "default" ? " selected" : ""}`}>
              <input
                type="radio"
                name={`quality-${agentId}`}
                checked={selected === "default"}
                onChange={() => void choose("default")}
              />
              <span>
                <strong>Company default</strong>
                <span class="small muted block">
                  {agent.defaultLevel === undefined
                    ? "The model set for this role in the company file."
                    : `The company file's choice for this role, the same as ${agent.defaultLevel}.`}
                  {showModels ? ` ${agent.defaultModel}.` : ""}
                </span>
              </span>
            </label>
          </fieldset>
          <div class="row-between">
            <span class="small muted">{showModels ? `Runs on ${agent.model} now.` : ""}</span>
            <button type="button" class="ghost small" onClick={() => setShowModels(!showModels)}>
              {showModels ? "Hide models" : "Show models"}
            </button>
          </div>
        </>
      )}
      <ErrorNote message={error} />
    </section>
  );
}

function AgentSpending({ agentId, name }: { agentId: string; name: string }) {
  const limits = useLimits();
  const save = async (limit: SpendLimit | null) => {
    await api(`/agents/${encodeURIComponent(agentId)}/limit`, { method: "PUT", json: { limit } });
    limits.reload();
  };
  const spent = limits.data?.spending[agentId];
  return (
    <section class="stack" aria-label="Spending limit">
      <h3>Spending limit</h3>
      <ErrorNote message={limits.error} />
      {limits.data === undefined ? (
        limits.loading ? (
          <Loading />
        ) : null
      ) : (
        <>
          {spent === undefined ? null : (
            <p class="small muted">
              Spent today {formatUsd(spent.day.costUsd)} ({formatTokens(spent.day.tokens)} tokens),
              this week {formatUsd(spent.week.costUsd)}, this month {formatUsd(spent.month.costUsd)}
              .
            </p>
          )}
          <LimitEditor status={limits.data.agents[agentId]} save={save} noun={name} />
          {limits.data.company?.reached === true ? (
            <p class="notice small">
              The company's own limit is reached too, so {name} stays paused until that one lifts.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
