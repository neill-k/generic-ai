import { api } from "../../api.js";
import { ErrorNote, Loading } from "../../components/ui.js";
import { formatTokens, formatUsd } from "../../format.js";
import { isWorkEvent, useResource } from "../../live.js";
import { href } from "../../router.js";
import { describeLimit, LimitEditor } from "./LimitEditor.js";
import "./settings.css";
import type { LimitsView, SpendAmount, SpendLimit } from "./types.js";

interface AgentName {
  id: string;
  role: string;
  title?: string;
  status?: string;
}

export function useLimits() {
  return useResource(() => api<LimitsView>("/limits"), [], isWorkEvent);
}

/**
 * Spending limits for the whole company and for each agent (decision 42). Both are optional.
 * Reaching one pauses work and loses nothing; it carries on when the period ends or the owner
 * raises the limit.
 */
export function LimitsSection() {
  const limits = useLimits();
  const agents = useResource(
    () => api<{ agents: AgentName[] }>("/agents").then((body) => body.agents),
    [],
  );
  const saveCompany = async (limit: SpendLimit | null) => {
    await api("/limits/company", { method: "PUT", json: { limit } });
    limits.reload();
  };

  const view = limits.data;
  const names = new Map((agents.data ?? []).map((agent) => [agent.id, agent]));
  const ids = view === undefined ? [] : Object.keys(view.spending);

  return (
    <>
      <section class="card settings-card stack" aria-label="Company spending limit">
        <h2>Company spending limit</h2>
        <p class="small muted">
          A cap on what all agents spend together. Optional. Set limits for one agent from the table
          below or from its card on the org chart.
        </p>
        <ErrorNote message={limits.error} />
        {view === undefined ? (
          limits.loading ? (
            <Loading />
          ) : null
        ) : (
          <LimitEditor status={view.company} save={saveCompany} noun="the company" />
        )}
      </section>

      <section class="card settings-card stack" aria-label="Spending by agent">
        <h2>Spending by agent</h2>
        <p class="small muted">
          List-price estimates, counted as each turn runs. Weeks start on Monday, in the server's
          time.
        </p>
        {view === undefined ? null : ids.length === 0 ? (
          <p class="muted">No agents yet.</p>
        ) : (
          <div class="table-scroll">
            <table class="spend-table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col" class="num">
                    Today
                  </th>
                  <th scope="col" class="num">
                    This week
                  </th>
                  <th scope="col" class="num">
                    This month
                  </th>
                  <th scope="col">Limit</th>
                </tr>
              </thead>
              <tbody>
                {ids.map((id) => {
                  const spent = view.spending[id];
                  const status = view.agents[id];
                  const agent = names.get(id);
                  return (
                    <tr key={id} class={status?.reached === true ? "reached" : undefined}>
                      <th scope="row">
                        <a href={href("org", id)}>{agent?.title ?? agent?.role ?? id}</a>
                        <span class="small muted block">{id}</span>
                      </th>
                      <td class="num">{amount(spent?.day)}</td>
                      <td class="num">{amount(spent?.week)}</td>
                      <td class="num">{amount(spent?.month)}</td>
                      <td>
                        {status === undefined ? (
                          <span class="muted">None</span>
                        ) : (
                          <>
                            {status.reached ? <span class="badge tone-warn">Paused</span> : null}{" "}
                            <span class="small">{describeLimit(status)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function amount(value: SpendAmount | undefined): string {
  if (value === undefined || (value.costUsd === 0 && value.tokens === 0)) {
    return "–";
  }
  return `${formatUsd(value.costUsd)} · ${formatTokens(value.tokens)}`;
}
