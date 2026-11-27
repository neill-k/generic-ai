import { api, type DriveEntry, fileUrl } from "../api.js";
import { Empty, ErrorNote, Loading } from "../components/ui.js";
import { fileName, formatSize, formatTime } from "../format.js";
import { useResource } from "../live.js";
import { href } from "../router.js";

interface ShelfEntry {
  goalId: string;
  status: "active" | "done" | "failed" | "abandoned";
  title?: string;
  createdAt: string;
  reason?: string;
  folder: string;
  files: DriveEntry[];
}

const STATUS: Readonly<Record<ShelfEntry["status"], string>> = {
  active: "In progress",
  done: "Done",
  failed: "Stopped",
  abandoned: "Cancelled",
};

/** Everything handed in, by goal. */
export function DeliverablesView() {
  const shelf = useResource(
    () => api<{ goals: ShelfEntry[] }>("/deliverables").then((body) => body.goals),
    [],
    (event) => event.type.startsWith("drive."),
  );
  const goals = shelf.data?.filter((goal) => goal.files.length > 0) ?? [];
  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Deliverables</h1>
          <p class="muted">Everything handed in, by goal, newest first.</p>
        </div>
      </header>
      <ErrorNote message={shelf.error} />
      {shelf.data === undefined ? <Loading /> : null}
      {shelf.data !== undefined && goals.length === 0 ? (
        <Empty title="Nothing has been delivered yet.">Results land here as goals finish.</Empty>
      ) : null}
      <div class="settings-stack">
        {goals.map((goal) => (
          <section key={goal.goalId} class="card settings-card stack" aria-label={goal.title}>
            <div class="card-head">
              <h2>
                <a href={href("goals", goal.goalId)}>{goal.title ?? goal.goalId}</a>
              </h2>
              <span class="small muted">
                {STATUS[goal.status]} · {formatTime(goal.createdAt)}
              </span>
            </div>
            <ul class="files">
              {goal.files.map((file) => (
                <li key={file.path}>
                  <a href={fileUrl(file.path)} target="_blank" rel="noreferrer">
                    {file.path.startsWith(`${goal.folder}/`)
                      ? file.path.slice(goal.folder.length + 1)
                      : fileName(file.path)}
                  </a>
                  <span class="small muted">{formatSize(file.size)}</span>
                  <a class="small" href={fileUrl(file.path, true)}>
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
