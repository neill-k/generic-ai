import { api } from "../api.js";
import { ErrorNote, Loading } from "../components/ui.js";
import { formatTokens, formatUsd } from "../format.js";
import { isWorkEvent, useResource } from "../live.js";
import { LimitsSection } from "./settings/LimitsSection.js";

interface UsageRow {
  key: string;
  totals: { totalTokens: number; costUsd: number };
}

interface CompanyCosts {
  totals: { totalTokens: number; costUsd: number };
  completedRequests: number;
  costPerCompletedRequestUsd: number | null;
  tokensPerCompletedRequest: number | null;
  byAgent: UsageRow[];
  byModel: UsageRow[];
}

/**
 * Tokens and spend by agent and model. On a Claude plan the dollars are list-price estimates;
 * tokens per finished goal is the number that matters.
 */
export function UsageView() {
  const costs = useResource(() => api<CompanyCosts>("/costs"), [], isWorkEvent);
  const data = costs.data;
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Usage and limits</h1>
          <p class="muted">
            List-price estimates from model usage. Failed and open work counts toward the cost per
            finished goal.
          </p>
        </div>
      </header>
      <ErrorNote message={costs.error} />
      {data === undefined ? (
        <Loading />
      ) : (
        <>
          <div class="stats">
            <Stat label="Tokens" value={formatTokens(data.totals.totalTokens)} />
            <Stat label="Estimated spend" value={formatUsd(data.totals.costUsd)} />
            <Stat label="Goals finished" value={String(data.completedRequests)} />
            <Stat
              label="Tokens per finished goal"
              value={
                data.tokensPerCompletedRequest === null
                  ? "–"
                  : formatTokens(data.tokensPerCompletedRequest)
              }
            />
          </div>
          <div class="settings-stack">
            <LimitsSection />
            <UsageTable title="By agent" rows={data.byAgent} />
            <UsageTable title="By model" rows={data.byModel} />
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="card stat">
      <div class="stat-value">{value}</div>
      <div class="small muted">{label}</div>
    </div>
  );
}

function UsageTable({ title, rows }: { title: string; rows: UsageRow[] }) {
  const max = Math.max(...rows.map((row) => row.totals.totalTokens), 0);
  return (
    <section class="card settings-card stack" aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p class="muted">No usage recorded yet.</p>
      ) : (
        <ul class="usage-rows">
          {rows.map((row) => (
            <li key={row.key}>
              <div class="usage-line">
                <span class="usage-key">{row.key}</span>
                <span class="small muted">
                  {formatTokens(row.totals.totalTokens)} · {formatUsd(row.totals.costUsd)}
                </span>
              </div>
              <div class="usage-bar" aria-hidden="true">
                <span style={{ width: `${max > 0 ? (row.totals.totalTokens / max) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
