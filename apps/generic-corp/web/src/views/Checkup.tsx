import { useState } from "preact/hooks";

import { ApiError, api } from "../api.js";
import { ErrorNote, Loading, SidePanel } from "../components/ui.js";
import { formatTime, formatTokens } from "../format.js";
import { useResource } from "../live.js";

interface Estimate {
  attempts: number;
  lowTokens: number;
  highTokens: number;
  basis: "measured" | "guess";
  maxTokens: number;
}

interface CheckupRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  estimate: Estimate;
  running?: string;
  finished: { id?: string; label?: string }[];
  plan: { configs: { id: string; label: string }[] };
  headline?: string;
  markdown?: string;
  error?: string;
}

interface CheckupView {
  description: string;
  estimate: Estimate;
  ready: boolean;
  reason?: string;
  latest?: CheckupRun;
}

const STATUS: Readonly<Record<CheckupRun["status"], string>> = {
  running: "In progress.",
  succeeded: "Finished.",
  failed: "Did not finish.",
};

/**
 * The checkup (decisions 43, 45, 46): the company against plain baselines on the same goals, on
 * the owner's own plan. Nothing starts it but this button, and only after a confirmation that
 * shows the plan and the expected usage.
 */
export function CheckupView() {
  const view = useResource(
    () =>
      api<CheckupView>("/checkup").catch((error) => {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }),
    [],
  );
  const latestId = view.data?.latest?.id;
  const latest = useResource(
    () =>
      latestId === undefined
        ? Promise.resolve(undefined)
        : api<CheckupRun>(`/checkups/${encodeURIComponent(latestId)}`),
    [latestId],
  );
  const [confirming, setConfirming] = useState(false);
  const run = latest.data ?? view.data?.latest;

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Checkup</h1>
          <p class="muted">
            Measures whether the company does better than a single agent on the same goals. It runs
            live models on your plan, so it only runs when you ask.
          </p>
        </div>
        {view.data ? (
          <button
            type="button"
            class="primary"
            disabled={!view.data.ready || run?.status === "running"}
            onClick={() => setConfirming(true)}
          >
            Run the checkup
          </button>
        ) : null}
      </header>
      <ErrorNote message={view.error} />
      {view.loading && view.data === undefined ? <Loading /> : null}
      {view.data === null ? (
        <p class="muted">The checkup is not available on this server.</p>
      ) : null}
      {view.data && !view.data.ready && view.data.reason !== undefined ? (
        <p class="notice checkup-reason">{view.data.reason}</p>
      ) : null}

      {view.data ? (
        <section class="card settings-card stack" aria-label="Latest checkup">
          <h2>Latest checkup</h2>
          {run === undefined ? (
            <p class="muted">No checkup has been run yet.</p>
          ) : (
            <>
              <p>
                <strong>{STATUS[run.status]}</strong>{" "}
                <span class="small muted">
                  Started {formatTime(run.startedAt)}
                  {run.finishedAt === undefined ? "" : `, finished ${formatTime(run.finishedAt)}`}.
                </span>
              </p>
              {run.headline === undefined ? null : <p>{run.headline}</p>}
              {run.status === "running" ? (
                <p class="small muted">
                  {run.finished.length} of {run.plan.configs.length} setups done
                  {run.running === undefined ? "." : `. Now running ${run.running}.`}
                </p>
              ) : null}
              {run.error === undefined ? null : <p class="error">{run.error}</p>}
              {run.markdown === undefined ? null : <pre class="report">{run.markdown}</pre>}
            </>
          )}
          <div class="row-end">
            <button type="button" class="ghost" onClick={() => view.reload()}>
              Refresh
            </button>
          </div>
        </section>
      ) : null}

      {confirming && view.data ? (
        <SidePanel title="Run the checkup?" onClose={() => setConfirming(false)}>
          <Confirm
            view={view.data}
            onStarted={() => {
              setConfirming(false);
              view.reload();
            }}
          />
        </SidePanel>
      ) : null}
    </div>
  );
}

function Confirm({ view, onStarted }: { view: CheckupView; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const { estimate } = view;
  return (
    <div class="stack">
      <p>{view.description}</p>
      <p class="small muted">
        Expected use: {formatTokens(estimate.lowTokens)} to {formatTokens(estimate.highTokens)}{" "}
        tokens over {estimate.attempts} attempts (
        {estimate.basis === "measured" ? "from the last checkup" : "a guess until one has run"}). It
        stops at {formatTokens(estimate.maxTokens)} tokens no matter what.
      </p>
      <ErrorNote message={error} />
      <div class="row-end">
        <button
          type="button"
          class="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await api("/checkup", { method: "POST", json: { confirm: true } });
              onStarted();
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Starting…" : "Start the checkup"}
        </button>
      </div>
    </div>
  );
}
