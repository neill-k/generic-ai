import { useEffect, useState } from "preact/hooks";

import { ErrorNote } from "../../components/ui.js";
import { formatTime, formatTokens, formatUsd } from "../../format.js";
import "./settings.css";
import { errorText, type LimitPeriod, type SpendLimit, type SpendLimitStatus } from "./types.js";

const PERIODS: readonly [LimitPeriod, string][] = [
  ["day", "Per day"],
  ["week", "Per week (from Monday)"],
  ["month", "Per month"],
];

/** Where a limit stands, such as "$4.20 of $20.00 this week" (no full stop). */
export function describeLimit(status: SpendLimitStatus): string {
  const parts: string[] = [];
  if (status.limit.maxCostUsd !== undefined) {
    parts.push(`${formatUsd(status.spent.costUsd)} of $${status.limit.maxCostUsd.toFixed(2)}`);
  }
  if (status.limit.maxTokens !== undefined) {
    parts.push(
      `${formatTokens(status.spent.tokens)} of ${formatTokens(status.limit.maxTokens)} tokens`,
    );
  }
  return `${parts.join(", ")} ${status.limit.period === "day" ? "today" : `this ${status.limit.period}`}`;
}

/**
 * Sets, changes or removes one spending limit. Both amounts are optional, but at least one is
 * needed. Saving a higher limit (or removing it) lets paused work carry on at once.
 */
export function LimitEditor({
  status,
  save,
  noun,
}: {
  status: SpendLimitStatus | undefined;
  save: (limit: SpendLimit | null) => Promise<unknown>;
  /** "the company" or the agent's name, for the sentences. */
  noun: string;
}) {
  const current = status?.limit;
  const [period, setPeriod] = useState<LimitPeriod>(current?.period ?? "month");
  const [cost, setCost] = useState(current?.maxCostUsd?.toString() ?? "");
  const [tokens, setTokens] = useState(current?.maxTokens?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    setPeriod(current?.period ?? "month");
    setCost(current?.maxCostUsd?.toString() ?? "");
    setTokens(current?.maxTokens?.toString() ?? "");
  }, [current?.period, current?.maxCostUsd, current?.maxTokens]);

  const run = async (limit: SpendLimit | null, done: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await save(limit);
      setNotice(done);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const maxCostUsd = cost.trim() === "" ? undefined : Number(cost);
    const maxTokens = tokens.trim() === "" ? undefined : Number(tokens);
    if (maxCostUsd === undefined && maxTokens === undefined) {
      setError("Enter a dollar amount, a token count or both.");
      return;
    }
    if (
      (maxCostUsd !== undefined && !(maxCostUsd > 0)) ||
      (maxTokens !== undefined && !(maxTokens > 0))
    ) {
      setError("Amounts need to be numbers above 0.");
      return;
    }
    void run(
      {
        period,
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
      "Saved.",
    );
  };

  return (
    <form class="stack" onSubmit={submit}>
      {status === undefined ? (
        <p class="muted">No limit. {capitalise(noun)} can spend as much as the work needs.</p>
      ) : status.reached ? (
        <p class="notice" role="status">
          Paused: the limit is reached ({describeLimit(status)}). Work carries on when the{" "}
          {status.limit.period} ends ({formatTime(status.periodEnd)}) or when you raise the limit.
        </p>
      ) : (
        <p>{describeLimit(status)}.</p>
      )}
      <div class="limit-fields">
        <label>
          <span class="small muted">Period</span>
          <select
            value={period}
            onChange={(event) =>
              setPeriod((event.target as HTMLSelectElement).value as LimitPeriod)
            }
          >
            {PERIODS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span class="small muted">Dollars</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="No cap"
            value={cost}
            onInput={(event) => setCost((event.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span class="small muted">Tokens</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            step="1000"
            placeholder="No cap"
            value={tokens}
            onInput={(event) => setTokens((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <p class="small muted">
        When {noun} reaches the limit, work pauses at the end of its current step. Nothing is lost.
      </p>
      <div class="row-end">
        {status === undefined ? null : (
          <button
            type="button"
            class="ghost"
            disabled={busy}
            onClick={() => void run(null, "Limit removed.")}
          >
            Remove limit
          </button>
        )}
        <button type="submit" class="primary" disabled={busy}>
          {busy ? "Saving…" : status === undefined ? "Set limit" : "Save limit"}
        </button>
      </div>
      {notice === undefined ? null : (
        <p class="small muted" role="status">
          {notice}
        </p>
      )}
      <ErrorNote message={error} />
    </form>
  );
}

function capitalise(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}
