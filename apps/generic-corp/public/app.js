// Generic Corp dashboard. Plain ES modules, no build step: the server serves
// this file as is. Every piece of agent or owner text is inserted with
// textContent, never as HTML, because agent output is untrusted.

const state = {
  view: "chat",
  threadId: undefined,
  company: undefined,
  refreshTimer: undefined,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Creates an element. Children may be nodes, strings, or arrays; falsy children are skipped. */
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === "class") {
      element.className = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      element.setAttribute(key, "");
    } else {
      element.setAttribute(key, String(value));
    }
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) {
      continue;
    }
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function statusPill(status) {
  return h("span", { class: `status status-${status}` }, status);
}

function formatTime(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function formatTokens(value) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function formatUsd(value) {
  if (value === null || value === undefined) {
    return "–";
  }
  return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) {
    window.location.assign("/auth/login");
    throw new ApiError(401, "Sign in to continue.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? `Request failed (${response.status}).`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Shell: routing, drawer, live events
// ---------------------------------------------------------------------------

const viewRoot = () => document.getElementById("view");

function setView(content) {
  const root = viewRoot();
  root.replaceChildren(content);
}

function errorView(error) {
  return h("div", { class: "error-banner", role: "alert" }, error.message ?? String(error));
}

function openDrawer(title, body) {
  document.getElementById("drawer-title").textContent = title;
  document.getElementById("drawer-body").replaceChildren(body);
  const drawer = document.getElementById("drawer");
  drawer.hidden = false;
  document.getElementById("drawer-close").focus();
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
}

const VIEWS = {
  chat: renderChat,
  org: renderOrgChart,
  board: renderBoard,
  costs: renderCosts,
  tools: renderTools,
  secrets: renderSecrets,
  approvals: renderApprovals,
};

function route() {
  const [, view = "chat", id] = window.location.hash.split("/");
  state.view = VIEWS[view] ? view : "chat";
  if (state.view === "chat") {
    state.threadId = id ? decodeURIComponent(id) : state.threadId;
  }
  for (const link of document.querySelectorAll(".nav a")) {
    link.classList.toggle("active", link.dataset.view === state.view);
  }
  render();
}

async function render() {
  try {
    await VIEWS[state.view]();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      setView(errorView(error));
    }
  }
}

/** Coalesces bursts of live events into one refresh of the current view. */
function scheduleRefresh() {
  // Task events don't change these views, and a refresh would clear a half-typed secret.
  if (state.view === "secrets" || state.view === "tools" || state.view === "approvals") {
    return;
  }
  if (state.refreshTimer !== undefined) {
    return;
  }
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = undefined;
    if (document.getElementById("drawer").hidden) {
      render();
    }
  }, 400);
}

function connectLiveEvents() {
  const status = document.getElementById("live-status");
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    status.textContent = "Live";
    status.classList.add("on");
  });
  source.addEventListener("error", () => {
    status.textContent = "Reconnecting…";
    status.classList.remove("on");
  });
  const types = [
    "task.submitted",
    "task.started",
    "task.delegated",
    "task.requeued",
    "task.resumed",
    "task.succeeded",
    "task.failed",
    "task.cancelled",
    "task.awaiting_approval",
    "thread.updated",
  ];
  for (const type of types) {
    source.addEventListener(type, scheduleRefresh);
  }
}

// ---------------------------------------------------------------------------
// Chat with the CEO
// ---------------------------------------------------------------------------

async function renderChat() {
  const [{ threads }, thread] = await Promise.all([
    api("/threads"),
    state.threadId
      ? api(`/threads/${encodeURIComponent(state.threadId)}`).catch(() => undefined)
      : undefined,
  ]);
  const current = thread?.thread;
  const previousDraft = document.getElementById("composer-text")?.value ?? "";
  const scrolledToEnd = isScrolledToEnd();

  const list = h(
    "div",
    { class: "panel thread-list", "aria-label": "Threads" },
    h(
      "button",
      {
        type: "button",
        class: current ? "" : "active",
        onClick: () => {
          state.threadId = undefined;
          window.location.hash = "#/chat";
        },
      },
      "+ New conversation",
    ),
    threads.map((item) =>
      h(
        "button",
        {
          type: "button",
          class: item.threadId === current?.threadId ? "active" : "",
          onClick: () => {
            window.location.hash = `#/chat/${encodeURIComponent(item.threadId)}`;
          },
        },
        item.title,
        h("span", { class: "meta" }, formatTime(item.updatedAt)),
      ),
    ),
  );

  const messages = h("div", { class: "messages", id: "messages", "aria-live": "polite" });
  if (!current) {
    append(messages, [
      h(
        "div",
        { class: "empty" },
        h("h1", {}, "What should the company work on?"),
        h(
          "p",
          {},
          "Give the CEO a goal. It is broken down and delegated through the org chart, and the answer comes back here.",
        ),
      ),
    ]);
  } else {
    for (const exchange of current.exchanges) {
      append(messages, [
        h(
          "div",
          { class: "bubble owner" },
          h("div", { class: "who" }, "You", " · ", formatTime(exchange.message.createdAt)),
          exchange.message.text,
        ),
        replyBubble(exchange.reply),
      ]);
    }
  }

  const textarea = h("textarea", {
    id: "composer-text",
    rows: 2,
    placeholder: current ? "Reply to the CEO…" : "Ask the CEO for something…",
    "aria-label": "Message to the CEO",
  });
  textarea.value = previousDraft;
  const sendButton = h("button", { type: "submit" }, "Send");
  const form = h(
    "form",
    {
      class: "composer",
      onSubmit: async (event) => {
        event.preventDefault();
        const text = textarea.value.trim();
        if (!text) {
          return;
        }
        sendButton.disabled = true;
        try {
          const path = current
            ? `/threads/${encodeURIComponent(current.threadId)}/messages`
            : "/threads";
          const result = await api(path, { method: "POST", body: JSON.stringify({ text }) });
          textarea.value = "";
          state.threadId = result.thread.threadId;
          if (window.location.hash !== `#/chat/${encodeURIComponent(result.thread.threadId)}`) {
            window.location.hash = `#/chat/${encodeURIComponent(result.thread.threadId)}`;
          } else {
            await render();
          }
        } catch (error) {
          form.before(errorView(error));
        } finally {
          sendButton.disabled = false;
        }
      },
    },
    textarea,
    sendButton,
  );
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      form.requestSubmit();
    }
  });

  setView(
    h(
      "div",
      {},
      h("h1", {}, current?.title ?? "Chat with the CEO"),
      h("p", { class: "subtitle" }, "Cmd or Ctrl + Enter sends."),
      h("div", { class: "chat" }, list, h("div", { class: "panel conversation" }, messages, form)),
    ),
  );
  if (scrolledToEnd || !previousDraft) {
    messages.scrollTop = messages.scrollHeight;
  }
}

function isScrolledToEnd() {
  const messages = document.getElementById("messages");
  return !messages || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
}

function replyBubble(reply) {
  const settled = reply.status === "succeeded" || reply.status === "failed";
  const text = reply.text ?? reply.error;
  return h(
    "div",
    { class: "bubble agent" },
    h(
      "div",
      { class: "who" },
      reply.agentId.toUpperCase(),
      statusPill(reply.status),
      reply.completedAt ? formatTime(reply.completedAt) : "",
      h(
        "button",
        { type: "button", class: "ghost", onClick: () => showTask(reply.taskId) },
        "Details",
      ),
    ),
    settled ? text || "(no answer)" : h("span", { class: "muted" }, workingText(reply.status)),
  );
}

function workingText(status) {
  switch (status) {
    case "queued":
      return "Queued. The CEO will pick this up shortly.";
    case "running":
      return "The CEO is working on this…";
    case "waiting":
      return "Waiting on the team. Results come back up the org chart.";
    case "cancelled":
      return "Cancelled.";
    default:
      return "No record of this task.";
  }
}

// ---------------------------------------------------------------------------
// Task detail
// ---------------------------------------------------------------------------

async function showTask(taskId) {
  const [{ task, children }, { tasks: tree }] = await Promise.all([
    api(`/tasks/${encodeURIComponent(taskId)}`),
    api(`/tasks/${encodeURIComponent(taskId)}/tree`),
  ]);
  const active = ["queued", "running", "waiting"].includes(task.status);
  const body = h(
    "div",
    {},
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "Status"),
      h("dd", {}, statusPill(task.status)),
      h("dt", {}, "Agent"),
      h("dd", {}, task.agentId),
      task.delegatedBy ? [h("dt", {}, "Delegated by"), h("dd", {}, task.delegatedBy)] : null,
      h("dt", {}, "Round"),
      h("dd", {}, `${task.round} (attempts ${task.attempts})`),
      h("dt", {}, "Created"),
      h("dd", {}, formatTime(task.createdAt)),
      task.completedAt
        ? [h("dt", {}, "Finished"), h("dd", {}, formatTime(task.completedAt))]
        : null,
      task.lastGoalReport
        ? [
            h("dt", {}, "Goal checks"),
            h(
              "dd",
              {},
              `${task.lastGoalReport.status}: ${task.lastGoalReport.passed} of ${task.lastGoalReport.required} passed`,
            ),
          ]
        : null,
    ),
    active
      ? h(
          "p",
          {},
          h(
            "button",
            {
              type: "button",
              class: "ghost",
              onClick: async () => {
                await api(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
                  method: "POST",
                  body: JSON.stringify({ reason: "Cancelled from the dashboard." }),
                });
                await showTask(taskId);
              },
            },
            "Cancel this task and its delegated work",
          ),
        )
      : null,
    h("h3", {}, "Instruction"),
    h("pre", {}, task.instruction),
    task.goal?.definitionOfDone
      ? [h("h3", {}, "Definition of done"), h("pre", {}, task.goal.definitionOfDone)]
      : null,
    task.feedback
      ? [h("h3", {}, "Feedback for the next round"), h("pre", {}, task.feedback)]
      : null,
    task.outputText ? [h("h3", {}, "Result"), h("pre", {}, task.outputText)] : null,
    task.failureMessage ? [h("h3", {}, "Failure"), h("pre", {}, task.failureMessage)] : null,
    children.length > 0 ? [h("h3", {}, "Delegated"), taskList(children)] : null,
    tree.length > 1 ? [h("h3", {}, "Whole cascade"), taskList(tree, true)] : null,
  );
  openDrawer(`Task ${task.taskId}`, body);
}

function taskList(tasks, indent = false) {
  return h(
    "ul",
    { class: "tree" },
    tasks.map((task) =>
      h(
        "li",
        { style: indent ? `padding-left: ${task.depth * 18}px` : undefined },
        statusPill(task.status),
        " ",
        h("strong", {}, task.agentId),
        " ",
        h(
          "a",
          {
            href: "#",
            onClick: (event) => {
              event.preventDefault();
              showTask(task.taskId);
            },
          },
          task.title ?? task.instruction,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Org chart and agent detail
// ---------------------------------------------------------------------------

async function renderOrgChart() {
  const { root } = await api("/org-chart");
  const node = (agent) =>
    h(
      "li",
      {},
      h(
        "button",
        { type: "button", class: "agent-card", onClick: () => showAgent(agent.id) },
        h(
          "span",
          { class: "title" },
          agent.title ?? agent.role,
          " ",
          h("span", { class: "badge" }, agent.tier),
        ),
        h("span", { class: "line" }, agent.id, " · ", agent.model ?? "default model"),
        h(
          "span",
          { class: "line" },
          agent.status === "retired"
            ? "Retired"
            : agent.activeTasks > 0
              ? `${agent.activeTasks} active task${agent.activeTasks === 1 ? "" : "s"}`
              : "Idle",
        ),
      ),
      agent.reports.length > 0 ? h("ul", {}, agent.reports.map(node)) : null,
    );
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Org chart"),
      h(
        "p",
        { class: "subtitle" },
        "Work is delegated down and results come back up. Select an agent for details.",
      ),
      h("div", { class: "panel org" }, h("ul", {}, node(root))),
    ),
  );
}

async function showAgent(agentId) {
  const [detail, costs] = await Promise.all([
    api(`/agents/${encodeURIComponent(agentId)}`),
    api(`/agents/${encodeURIComponent(agentId)}/costs`),
  ]);
  const { agent } = detail;
  openDrawer(
    agent.title ?? agent.id,
    h(
      "div",
      {},
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Id"),
        h("dd", {}, agent.id),
        h("dt", {}, "Role"),
        h("dd", {}, agent.role),
        h("dt", {}, "Model"),
        h("dd", {}, agent.model ?? "default"),
        h("dt", {}, "Reports to"),
        h("dd", {}, detail.managementChain.join(" → ") || "The owner"),
        h("dt", {}, "Direct reports"),
        h("dd", {}, detail.reports.join(", ") || "None"),
        h("dt", {}, "Spend"),
        h(
          "dd",
          {},
          `${formatUsd(costs.totals.costUsd)} · ${formatTokens(costs.totals.totalTokens)} tokens`,
        ),
      ),
      agent.instructions ? [h("h3", {}, "Instructions"), h("pre", {}, agent.instructions)] : null,
      h("h3", {}, "Memory (context.md)"),
      h("div", { class: "memory" }, detail.memory || "Empty so far."),
      h("h3", {}, "Recent tasks"),
      detail.tasks.length > 0
        ? taskList(detail.tasks)
        : h("p", { class: "muted" }, "No tasks yet."),
    ),
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

const COLUMN_TITLES = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting on team",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

async function renderBoard() {
  const { columns } = await api("/board");
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Board"),
      h("p", { class: "subtitle" }, "Every task in the company, by status. Updates live."),
      h(
        "div",
        { class: "board" },
        columns.map((column) =>
          h(
            "section",
            { class: "column", "aria-label": COLUMN_TITLES[column.status] },
            h(
              "h2",
              {},
              COLUMN_TITLES[column.status],
              h("span", { class: "muted" }, column.tasks.length),
            ),
            column.tasks.length === 0
              ? h("div", { class: "muted" }, "Nothing here.")
              : column.tasks.map((task) =>
                  h(
                    "button",
                    { type: "button", class: "task-card", onClick: () => showTask(task.taskId) },
                    h("div", { class: "instruction" }, task.title),
                    h(
                      "div",
                      { class: "line" },
                      task.agentId,
                      task.delegatedBy ? ` ← ${task.delegatedBy}` : " ← owner",
                      " · ",
                      formatTime(task.updatedAt),
                    ),
                    task.goal?.lastStatus
                      ? h(
                          "div",
                          { class: "line" },
                          `Goal: ${task.goal.lastStatus} (${task.goal.passed}/${task.goal.required})`,
                        )
                      : null,
                  ),
                ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

async function renderCosts() {
  const costs = await api("/costs");
  const stat = (label, value) =>
    h(
      "div",
      { class: "panel stat" },
      h("div", { class: "value" }, value),
      h("div", { class: "label" }, label),
    );
  const table = (title, rows, keyLabel) => {
    const max = Math.max(...rows.map((row) => row.totals.costUsd), 0);
    return h(
      "div",
      { class: "panel" },
      h("h2", {}, title),
      rows.length === 0
        ? h("p", { class: "muted" }, "No usage recorded yet.")
        : h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, keyLabel),
                h("th", { class: "num" }, "Tokens"),
                h("th", { class: "num" }, "Cost"),
                h("th", {}, ""),
              ),
            ),
            h(
              "tbody",
              {},
              rows.map((row) =>
                h(
                  "tr",
                  {},
                  h("td", {}, row.key),
                  h("td", { class: "num" }, formatTokens(row.totals.totalTokens)),
                  h("td", { class: "num" }, formatUsd(row.totals.costUsd)),
                  h(
                    "td",
                    { style: "width: 30%" },
                    h("div", {
                      class: "bar",
                      style: `width: ${max > 0 ? (row.totals.costUsd / max) * 100 : 0}%`,
                    }),
                  ),
                ),
              ),
            ),
          ),
    );
  };
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Costs"),
      h(
        "p",
        { class: "subtitle" },
        "List-price estimates from model usage. Failed and open work counts toward the cost per completed request.",
      ),
      h(
        "div",
        { class: "stats" },
        stat("Total spend", formatUsd(costs.totals.costUsd)),
        stat("Total tokens", formatTokens(costs.totals.totalTokens)),
        stat("Completed requests", String(costs.completedRequests)),
        stat("Cost per completed request", formatUsd(costs.costPerCompletedRequestUsd)),
        stat(
          "Tokens per completed request",
          costs.tokensPerCompletedRequest === null
            ? "–"
            : formatTokens(costs.tokensPerCompletedRequest),
        ),
      ),
      h(
        "div",
        { style: "display: grid; gap: 16px" },
        table("By agent", costs.byAgent, "Agent"),
        table("By model", costs.byModel, "Model"),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tools and connectors
// ---------------------------------------------------------------------------

const TOOL_GROUPS = [
  ["files", "Files"],
  ["terminal", "Shell"],
  ["web", "Web"],
  ["documents", "Documents"],
];

const CONNECTOR_STATUS = {
  connected: "succeeded",
  connecting: "running",
  reconnecting: "waiting",
  idle: "queued",
  disabled: "cancelled",
  failed: "failed",
  closed: "cancelled",
};

async function renderTools() {
  const toolkit = await api("/tools");
  const groups = TOOL_GROUPS.map(([group, label]) => {
    const tools = toolkit.tools.filter((tool) => tool.group === group);
    return h(
      "div",
      { class: "panel" },
      h("h2", {}, label),
      tools.length === 0
        ? h("p", { class: "muted" }, "None.")
        : h(
            "dl",
            { class: "tool-list" },
            tools.flatMap((tool) => [
              h("dt", {}, h("code", {}, tool.name)),
              h("dd", {}, firstSentence(tool.description)),
            ]),
          ),
    );
  });
  const search = toolkit.webSearch;
  const connectors = toolkit.connectors;
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Tools"),
      h(
        "p",
        { class: "subtitle" },
        "Every agent works with these tools in its own home folder. Actions that send messages, change outside systems or spend money wait for your approval.",
      ),
      h(
        "div",
        { style: "display: grid; gap: 16px" },
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Web search"),
          h(
            "p",
            {},
            search === null
              ? "Not available."
              : search.configured
                ? `Uses ${search.provider}, set in the company file.`
                : "Turns on when a BRAVE_API_KEY or TAVILY_API_KEY secret is set, or when the company file names a provider.",
          ),
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Connectors"),
          connectors.length === 0
            ? h(
                "p",
                { class: "muted" },
                "No connectors yet. Add email, calendar, chat, documents, browser or payments servers under tools.mcp in the company file.",
              )
            : h(
                "table",
                {},
                h(
                  "thead",
                  {},
                  h(
                    "tr",
                    {},
                    h("th", {}, "Connector"),
                    h("th", {}, "Kind"),
                    h("th", {}, "State"),
                    h("th", { class: "num" }, "Tools"),
                  ),
                ),
                h(
                  "tbody",
                  {},
                  connectors.map((connector) =>
                    h(
                      "tr",
                      {},
                      h(
                        "td",
                        {},
                        connector.id,
                        connector.lastError
                          ? h("div", { class: "muted small" }, connector.lastError)
                          : null,
                      ),
                      h("td", {}, connector.connector ?? "generic"),
                      h(
                        "td",
                        {},
                        h(
                          "span",
                          {
                            class: `status status-${CONNECTOR_STATUS[connector.state] ?? "queued"}`,
                          },
                          connector.state,
                        ),
                      ),
                      h("td", { class: "num" }, String(connector.toolCount)),
                    ),
                  ),
                ),
              ),
        ),
        h("div", { class: "tool-groups" }, groups),
      ),
    ),
  );
}

function firstSentence(text) {
  const trimmed = String(text ?? "").trim();
  const end = trimmed.search(/\.(\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_SOURCES = {
  env: "Server environment",
  file: "Secret file",
  "encrypted-store": "Saved here",
};

async function renderSecrets(message) {
  const { writable, secrets } = await api("/secrets");
  const nameInput = h("input", {
    id: "secret-name",
    name: "name",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "CRM_API_KEY",
    pattern: "[A-Za-z_][A-Za-z0-9_]*",
    required: true,
    "aria-label": "Secret name",
  });
  const valueInput = h("input", {
    id: "secret-value",
    name: "value",
    type: "password",
    autocomplete: "new-password",
    placeholder: "Value",
    required: true,
    "aria-label": "Secret value",
  });
  const formError = h("p", { class: "form-error", role: "alert", hidden: true });
  const save = async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    try {
      await api(`/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ value: valueInput.value }),
      });
      valueInput.value = "";
      await renderSecrets(`Saved ${name}. Agents and connectors use it from their next call.`);
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    }
  };
  const edit = (name) => {
    nameInput.value = name;
    valueInput.value = "";
    valueInput.focus();
  };
  const remove = async (name) => {
    try {
      await api(`/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      await renderSecrets(`Removed ${name}.`);
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    }
  };
  const missing = secrets.filter((secret) => !secret.set && !secret.optional);

  setView(
    h(
      "div",
      {},
      h("h1", {}, "Secrets"),
      h(
        "p",
        { class: "subtitle" },
        "Keys and tokens your agents and connectors use. Agents use a secret without ever seeing its value, and values are never shown here.",
      ),
      h(
        "div",
        { style: "display: grid; gap: 16px" },
        message ? h("div", { class: "notice", role: "status" }, message) : null,
        missing.length > 0
          ? h(
              "div",
              { class: "error-banner", role: "alert" },
              `Missing: ${missing.map((secret) => secret.name).join(", ")}. Work that needs them will fail until they are set.`,
            )
          : null,
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Add or replace a secret"),
          writable
            ? h(
                "form",
                { class: "secret-form", onSubmit: save },
                nameInput,
                valueInput,
                h("button", { type: "submit" }, "Save"),
              )
            : h(
                "p",
                { class: "muted" },
                "Saving secrets here needs a master key. Set GENERIC_AI_SECRETS_KEY on the server (generate one with openssl rand -hex 32) and restart. Until then, set secrets as GENERIC_AI_SECRET_<NAME> variables.",
              ),
          formError,
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Secrets"),
          secrets.length === 0
            ? h("p", { class: "muted" }, "No secrets yet, and the company config needs none.")
            : h(
                "table",
                {},
                h(
                  "thead",
                  {},
                  h(
                    "tr",
                    {},
                    h("th", {}, "Name"),
                    h("th", {}, "State"),
                    h("th", {}, "Used by"),
                    h("th", {}, ""),
                  ),
                ),
                h(
                  "tbody",
                  {},
                  secrets.map((secret) =>
                    h(
                      "tr",
                      {},
                      h("td", {}, h("code", {}, secret.name)),
                      h(
                        "td",
                        {},
                        secret.set
                          ? h(
                              "span",
                              { class: "status status-succeeded" },
                              SECRET_SOURCES[secret.source] ?? secret.source,
                            )
                          : h(
                              "span",
                              {
                                class: `status ${secret.optional ? "status-queued" : "status-failed"}`,
                              },
                              secret.optional ? "Not set (optional)" : "Missing",
                            ),
                        secret.updatedAt
                          ? h(
                              "div",
                              { class: "muted small" },
                              `Updated ${formatTime(secret.updatedAt)}`,
                            )
                          : null,
                      ),
                      h(
                        "td",
                        { class: "muted" },
                        secret.usedBy.length === 0 ? "–" : secret.usedBy.join(", "),
                      ),
                      h(
                        "td",
                        { class: "actions" },
                        writable && secret.source !== "env" && secret.source !== "file"
                          ? h(
                              "button",
                              { type: "button", class: "ghost", onClick: () => edit(secret.name) },
                              secret.set ? "Replace" : "Set",
                            )
                          : null,
                        writable && secret.source === "encrypted-store"
                          ? h(
                              "button",
                              {
                                type: "button",
                                class: "ghost",
                                onClick: () => remove(secret.name),
                              },
                              "Remove",
                            )
                          : null,
                      ),
                    ),
                  ),
                ),
              ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const APPROVAL_STATUS = {
  pending: "waiting",
  approved: "succeeded",
  rejected: "failed",
  denied: "failed",
  expired: "cancelled",
  cancelled: "cancelled",
};

const EFFECT_LABELS = {
  "message.send": "Sends a message",
  "external.write": "Changes an outside system",
  "payment.spend": "Spends money",
  "mcp.write": "Writes through a connector",
};

async function updateApprovalBadge() {
  const badge = document.getElementById("approvals-badge");
  if (!badge) {
    return;
  }
  try {
    const { approvals } = await api("/approvals?status=pending&limit=100");
    badge.textContent = String(approvals.length);
    badge.hidden = approvals.length === 0;
  } catch {
    badge.hidden = true;
  }
}

function connectApprovalEvents() {
  const source = new EventSource("/api/approvals/stream");
  const refresh = () => {
    updateApprovalBadge();
    if (state.view === "approvals" && document.getElementById("drawer").hidden) {
      render();
    }
  };
  for (const type of [
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "approval.denied",
    "approval.expired",
    "approval.cancelled",
    "approval.executed",
    "approval.execution.failed",
  ]) {
    source.addEventListener(type, refresh);
  }
  source.addEventListener("ready", () => updateApprovalBadge());
}

function approvalCard(approval, onDecided) {
  const comment = h("input", {
    type: "text",
    placeholder: "Note for the agent (optional)",
    "aria-label": "Note for the agent",
    maxlength: "2000",
  });
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const decide = (verdict) => async (event) => {
    const buttons = event.target.parentElement.querySelectorAll("button");
    for (const button of buttons) {
      button.disabled = true;
    }
    try {
      await api(`/approvals/${encodeURIComponent(approval.approvalId)}/${verdict}`, {
        method: "POST",
        body: JSON.stringify(comment.value.trim() ? { comment: comment.value.trim() } : {}),
      });
      await onDecided();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      for (const button of buttons) {
        button.disabled = false;
      }
    }
  };
  const effects = approval.action.effects.map((effect) => EFFECT_LABELS[effect]).filter(Boolean);
  const pending = approval.status === "pending";
  return h(
    "article",
    { class: "panel approval" },
    h(
      "header",
      { class: "approval-head" },
      h("h2", {}, approval.action.summary || approval.action.name),
      h(
        "span",
        { class: `status status-${APPROVAL_STATUS[approval.status] ?? "queued"}` },
        approval.status,
      ),
    ),
    h(
      "p",
      { class: "muted" },
      `${approval.requester.agentId} wants to run `,
      h("code", {}, approval.action.name),
      ` · ${formatTime(approval.createdAt)}`,
      approval.expiresAt && pending ? ` · expires ${formatTime(approval.expiresAt)}` : "",
    ),
    effects.length > 0 ? h("p", { class: "effects" }, effects.join(" · ")) : null,
    approval.action.inputOmitted
      ? h("p", { class: "muted" }, "The input is too large to show here.")
      : h("pre", { class: "approval-input" }, JSON.stringify(approval.action.input ?? {}, null, 2)),
    approval.requester.taskId
      ? h(
          "p",
          {},
          h(
            "button",
            {
              type: "button",
              class: "ghost",
              onClick: () => showTask(approval.requester.taskId),
            },
            "Open the task",
          ),
        )
      : null,
    approval.decision
      ? h(
          "p",
          { class: "muted" },
          `${approval.decision.decision === "approved" ? "Approved" : "Rejected"} by ${approval.decision.decidedBy.subjectId} · ${formatTime(approval.decision.decidedAt)}`,
          approval.decision.comment ? ` · "${approval.decision.comment}"` : "",
        )
      : null,
    pending
      ? h(
          "div",
          { class: "approval-actions" },
          comment,
          h("button", { type: "button", onClick: decide("approve") }, "Approve"),
          h("button", { type: "button", class: "ghost", onClick: decide("reject") }, "Reject"),
        )
      : null,
    error,
  );
}

async function renderApprovals() {
  const [{ approvals: pending }, { approvals: recent }] = await Promise.all([
    api("/approvals?status=pending&limit=100"),
    api("/approvals?status=approved,rejected,denied,expired,cancelled&limit=20"),
  ]);
  const reload = async () => {
    await renderApprovals();
    await updateApprovalBadge();
  };
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Approvals"),
      h(
        "p",
        { class: "subtitle" },
        "Agents ask before they send messages, change outside systems or spend money. An approved action runs once, exactly as shown. Its task picks up where it left off.",
      ),
      h(
        "div",
        { style: "display: grid; gap: 16px" },
        pending.length === 0
          ? h("div", { class: "panel" }, h("p", { class: "muted" }, "Nothing is waiting for you."))
          : pending.map((approval) => approvalCard(approval, reload)),
        recent.length > 0 ? h("h2", { class: "section-title" }, "Recently decided") : null,
        recent.map((approval) => approvalCard(approval, reload)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer").addEventListener("click", (event) => {
    if (event.target.id === "drawer") {
      closeDrawer();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
    }
  });
  window.addEventListener("hashchange", route);
  try {
    state.company = await api("/company");
    document.getElementById("company-name").textContent = state.company.name;
    document.title = state.company.name;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
  }
  connectLiveEvents();
  connectApprovalEvents();
  route();
}

start();
