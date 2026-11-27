import { api } from "../api.js";
import { Avatar, Empty, ErrorNote, Loading } from "../components/ui.js";
import { timeAgo } from "../format.js";
import { isWorkEvent, useResource } from "../live.js";
import { href } from "../router.js";

export interface ActivityItem {
  taskId: string;
  goalId: string;
  goalTitle: string;
  agentId: string;
  agentRole: string;
  agentTitle?: string;
  delegatedBy?: string;
  title: string;
  active: boolean;
  held: boolean;
  statusText: string;
  updatedAt: string;
}

/** Everything the company is doing, as it moves (decision 49). Replaces the board. */
export function ActivityView() {
  const activity = useResource(
    () => api<{ now: ActivityItem[]; recent: ActivityItem[] }>("/activity?limit=60"),
    [],
    isWorkEvent,
  );
  const now = activity.data?.now ?? [];
  const recent = activity.data?.recent ?? [];

  return (
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Activity</h1>
          <p class="muted">
            {activity.data === undefined
              ? "Gathering status updates."
              : now.length === 0
                ? "Nobody is working on anything right now."
                : `${now.length} ${now.length === 1 ? "piece" : "pieces"} of work in motion.`}
          </p>
        </div>
      </header>

      <ErrorNote message={activity.error} />
      {activity.loading && activity.data === undefined ? <Loading /> : null}

      {activity.data !== undefined && now.length === 0 && recent.length === 0 ? (
        <Empty title="No activity to report.">
          Work shows up here the moment a goal is set. Every hand-off, every step.
        </Empty>
      ) : null}

      {now.length > 0 ? (
        <section class="card activity-card" aria-label="Now">
          <h2>Now</h2>
          <ActivityList items={now} />
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section class="card activity-card" aria-label="Recently finished">
          <h2>Recently finished</h2>
          <ActivityList items={recent} />
        </section>
      ) : null}
    </div>
  );
}

function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ul class="activity">
      {items.map((item) => {
        const name = item.agentTitle ?? item.agentRole;
        return (
          <li key={item.taskId} class={item.held ? "activity-held" : undefined}>
            <a class="activity-agent" href={href("org", item.agentId)} title={name}>
              <Avatar name={name} working={item.active && !item.held} />
            </a>
            <div class="activity-body">
              <div class="activity-line">
                <a href={href("org", item.agentId)}>{name}</a>
                <span class="muted"> · {item.statusText}</span>
              </div>
              <div class="activity-title">{item.title}</div>
              <div class="small muted">
                {item.taskId === item.goalId ? (
                  "The goal itself"
                ) : (
                  <>
                    For <a href={href("goals", item.goalId)}>{item.goalTitle}</a>
                  </>
                )}
                {item.delegatedBy === undefined ? "" : `, asked by ${item.delegatedBy}`}
                {" · "}
                {timeAgo(item.updatedAt)}
              </div>
            </div>
            {item.taskId === item.goalId ? (
              <a class="activity-open small" href={href("goals", item.goalId)}>
                Open
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
