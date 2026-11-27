import { useState } from "preact/hooks";

import { ApiError, api } from "../../api.js";
import { ErrorNote, Loading } from "../../components/ui.js";
import { formatSize, formatTime } from "../../format.js";
import { useResource } from "../../live.js";
import "./settings.css";
import { type BackupReason, type BackupStatus, errorText } from "./types.js";

const REASON: Record<BackupReason, string> = {
  nightly: "Nightly",
  first: "First backup",
  manual: "Made by hand",
  "before-restore": "Before a restore",
};

/**
 * Nightly backups of the database and the company's files (decision 55), with a button for one
 * now and the restore command. Restoring stays a command on the server on purpose: it replaces
 * everything, so it should never be one click away.
 */
export function BackupsView() {
  const backups = useResource(
    async () => {
      try {
        return await api<BackupStatus>("/backups");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    [],
    (event) => event.type === "backups.updated",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const backUpNow = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api("/backups", { method: "POST" });
      backups.reload();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const status = backups.data;
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Backups</h1>
          <p class="muted">
            A copy of the company's database and files: drive, memory and agents' sessions.
          </p>
        </div>
      </header>
      <ErrorNote message={backups.error} />
      {status === undefined ? (
        backups.loading ? (
          <Loading />
        ) : null
      ) : status === null ? (
        <p class="muted">Backups are not available on this server.</p>
      ) : (
        <div class="settings-stack">
          <section class="card settings-card stack" aria-label="Schedule">
            <div class="card-head">
              <h2>Schedule</h2>
              {status.running ? (
                <span class="badge tone-active">
                  <span class="pulse" aria-hidden="true" />
                  Backing up
                </span>
              ) : status.lastError !== undefined ? (
                <span class="badge tone-bad">Last backup failed</span>
              ) : null}
            </div>
            <p>
              {status.enabled
                ? `Every night. The newest ${status.keep} are kept.`
                : "Nightly backups are off (GENERIC_CORP_BACKUPS=off). You can still make one by hand."}
              {status.nextAt === undefined ? "" : ` Next: ${formatTime(status.nextAt)}.`}
            </p>
            {status.lastError === undefined ? null : (
              <p class="error" role="alert">
                {formatTime(status.lastError.at)}: {status.lastError.message}
              </p>
            )}
            <p class="small muted">
              Saved to <code>{status.dir}</code>, on the same disk as the company. Copy them
              somewhere else now and then.
            </p>
            <div class="row-end">
              <button
                type="button"
                class="primary"
                disabled={busy || status.running}
                onClick={() => void backUpNow()}
              >
                {status.running ? "Backing up…" : "Back up now"}
              </button>
            </div>
            <ErrorNote message={error} />
          </section>

          <section class="card settings-card stack" aria-label="Saved backups">
            <h2>Saved backups</h2>
            {status.backups.length === 0 ? (
              <p class="muted">None yet.</p>
            ) : (
              <ul class="backup-list">
                {status.backups.map((backup) => (
                  <li key={backup.id}>
                    <div>
                      <strong>{formatTime(backup.createdAt)}</strong>
                      <span class="small muted"> · {REASON[backup.reason] ?? backup.reason}</span>
                    </div>
                    <div class="small muted">
                      {formatSize(backup.bytes)} · took {seconds(backup.durationMs)} ·{" "}
                      <code>{backup.id}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section class="card settings-card stack" aria-label="Restore">
            <h2>Restore</h2>
            <p class="small">
              Restoring replaces the database and the company's files with a backup's, so it runs as
              a command on the server instead of from a button here. A fresh backup is made first,
              so a restore can be undone. You'll need to sign in to Claude again afterwards.
            </p>
            <p class="small muted">With Docker:</p>
            <pre class="command">./start-local.sh restore {status.backups[0]?.id ?? "<id>"}</pre>
            <p class="small muted">Without Docker, from apps/generic-corp:</p>
            <pre class="command">
              node dist/restore.js {status.backups[0]?.id ?? "latest"} --yes
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}

function seconds(ms: number): string {
  return ms < 1000 ? "under a second" : `${Math.round(ms / 1000)} s`;
}
