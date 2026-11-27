// Generic Corp dashboard. Plain ES modules, no build step: the server serves
// this file as is. Every piece of agent or owner text is inserted with
// textContent, never as HTML, because agent output is untrusted.

const state = {
  view: "chat",
  threadId: undefined,
  goalId: undefined,
  /** Drive files attached to the message being written. */
  attachments: [],
  drivePath: "drive",
  /** The memory page's scope: "company" (the handbook) or an agent id. */
  memoryScope: "company",
  company: undefined,
  refreshTimer: undefined,
  claudeFlowId: undefined,
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
  power: renderModelAuth,
  approvals: renderApprovals,
  drive: renderDrive,
  deliverables: renderDeliverables,
  memory: renderMemory,
};

function route() {
  const [, view = "chat", id] = window.location.hash.split("/");
  state.view = VIEWS[view] ? view : "chat";
  if (state.view === "chat") {
    state.threadId = id ? decodeURIComponent(id) : state.threadId;
  }
  if (state.view === "memory") {
    state.memoryScope = id ? decodeURIComponent(id) : "company";
  }
  if (state.view === "drive") {
    state.drivePath = id ? decodeURIComponent(id) : "drive";
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
  if (
    state.view === "secrets" ||
    state.view === "power" ||
    state.view === "tools" ||
    state.view === "approvals" ||
    state.view === "memory"
  ) {
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
    "drive.updated",
    "drive.goal.updated",
  ];
  for (const type of types) {
    source.addEventListener(type, scheduleRefresh);
  }
}

// ---------------------------------------------------------------------------
// Chat with the CEO
// ---------------------------------------------------------------------------

async function renderChat() {
  const [{ threads }, thread, { goals }] = await Promise.all([
    api("/threads"),
    state.threadId
      ? api(`/threads/${encodeURIComponent(state.threadId)}`).catch(() => undefined)
      : undefined,
    api("/goals").catch(() => ({ goals: [] })),
  ]);
  const chosenGoal = goals.find((goal) => goal.id === state.goalId);
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
        goals.length === 0
          ? null
          : h(
              "div",
              { class: "goal-picker" },
              h("h2", {}, "Or start from one of the company's goals"),
              h(
                "p",
                { class: "muted small" },
                "A goal comes with checks. The CEO's work is only done when every check passes.",
              ),
              h(
                "div",
                { class: "goal-cards" },
                goals.map((goal) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: `goal-card${goal.id === state.goalId ? " active" : ""}`,
                      onClick: () => {
                        state.goalId = goal.id;
                        const composer = document.getElementById("composer-text");
                        if (composer) {
                          composer.value = goal.request;
                        }
                        render();
                      },
                    },
                    h("strong", {}, goal.title),
                    h("span", {}, goal.description ?? goal.objective),
                    h("span", { class: "meta" }, `${goal.checks.length} checks`),
                  ),
                ),
              ),
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
          (exchange.message.attachments ?? []).length === 0
            ? null
            : h(
                "div",
                { class: "attachments" },
                exchange.message.attachments.map((filePath) => fileLink(filePath)),
              ),
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
          const result = await api(path, {
            method: "POST",
            body: JSON.stringify({
              text,
              ...(chosenGoal ? { goalId: chosenGoal.id } : {}),
              ...(state.attachments.length > 0
                ? { attachments: state.attachments.map((file) => file.path) }
                : {}),
            }),
          });
          textarea.value = "";
          state.goalId = undefined;
          state.attachments = [];
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
    chosenGoal
      ? h(
          "div",
          { class: "goal-chip", title: chosenGoal.definitionOfDone.join("\n") },
          `Goal: ${chosenGoal.title} · ${chosenGoal.checks.length} checks`,
          h(
            "button",
            {
              type: "button",
              "aria-label": "Remove the goal",
              onClick: () => {
                state.goalId = undefined;
                render();
              },
            },
            "×",
          ),
        )
      : null,
    state.attachments.length === 0
      ? null
      : h(
          "div",
          { class: "attachments composer-attachments" },
          state.attachments.map((file) =>
            h(
              "span",
              { class: "file-chip" },
              file.name,
              h(
                "button",
                {
                  type: "button",
                  "aria-label": `Remove ${file.name}`,
                  onClick: () => {
                    state.attachments = state.attachments.filter((item) => item.path !== file.path);
                    render();
                  },
                },
                "×",
              ),
            ),
          ),
        ),
    textarea,
    attachButton(async (files) => {
      for (const file of files) {
        state.attachments.push(await uploadToInbox(file));
      }
      render();
    }),
    sendButton,
  );
  const conversation = h("div", { class: "panel conversation" }, messages, form);
  conversation.addEventListener("dragover", (event) => {
    event.preventDefault();
    conversation.classList.add("dropping");
  });
  conversation.addEventListener("dragleave", () => conversation.classList.remove("dropping"));
  conversation.addEventListener("drop", async (event) => {
    event.preventDefault();
    conversation.classList.remove("dropping");
    try {
      for (const file of event.dataTransfer?.files ?? []) {
        state.attachments.push(await uploadToInbox(file));
      }
      render();
    } catch (error) {
      form.before(errorView(error));
    }
  });
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
      h("p", { class: "subtitle" }, "Cmd or Ctrl + Enter sends. Drop files here to hand them in."),
      h("div", { class: "chat" }, list, conversation),
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
      h("h3", {}, "Memory"),
      h("div", { class: "memory" }, detail.memory || "Empty so far."),
      h(
        "p",
        { class: "small" },
        h(
          "a",
          { href: `#/memory/${encodeURIComponent(agent.id)}`, onClick: closeDrawer },
          "Open and edit this agent's memory",
        ),
      ),
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
          h("h2", {}, "Skills"),
          (toolkit.skills ?? []).length === 0
            ? h("p", { class: "muted" }, "None.")
            : h(
                "dl",
                { class: "tool-list" },
                toolkit.skills.flatMap((skill) => [
                  h("dt", {}, h("code", {}, skill.name)),
                  h("dd", {}, firstSentence(skill.description)),
                ]),
              ),
          h(
            "p",
            { class: "muted small" },
            "Every agent has these. Agents also save their own skills as they learn, in their home folder.",
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

const MODEL_AUTH_SOURCES = {
  subscription: "Your Claude subscription",
  api_key: "An Anthropic API key saved here",
  environment: "ANTHROPIC_API_KEY on the server",
  none: "Nothing yet",
};

async function renderModelAuth(message) {
  const status = await api("/model-auth");
  const formError = h("p", { class: "form-error", role: "alert", hidden: true });
  const fail = (error) => {
    formError.textContent = error.message;
    formError.hidden = false;
  };
  const codeInput = h("input", {
    id: "claude-code",
    name: "code",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Paste the code here",
    required: true,
    "aria-label": "Code from Claude",
  });
  const keyInput = h("input", {
    id: "anthropic-key",
    name: "key",
    type: "password",
    autocomplete: "new-password",
    placeholder: "sk-ant-...",
    required: true,
    "aria-label": "Anthropic API key",
  });
  const linkSlot = h("div", {});
  const start = async () => {
    try {
      const flow = await api("/model-auth/claude/start", { method: "POST" });
      state.claudeFlowId = flow.flowId;
      linkSlot.replaceChildren(
        h(
          "ol",
          {},
          h(
            "li",
            {},
            h("a", { href: flow.url, target: "_blank", rel: "noopener noreferrer" }, "Open Claude"),
            " and approve access with the account whose plan should power the company.",
          ),
          h("li", {}, "Copy the code Claude shows at the end and paste it below."),
        ),
        h(
          "form",
          { class: "secret-form", onSubmit: finish },
          codeInput,
          h("button", { type: "submit" }, "Finish sign-in"),
        ),
      );
      codeInput.focus();
    } catch (error) {
      fail(error);
    }
  };
  const finish = async (event) => {
    event.preventDefault();
    try {
      await api("/model-auth/claude/finish", {
        method: "POST",
        body: JSON.stringify({ flowId: state.claudeFlowId, code: codeInput.value }),
      });
      state.claudeFlowId = undefined;
      await renderModelAuth("Signed in. Agents now run on your Claude subscription.");
    } catch (error) {
      fail(error);
    }
  };
  const saveKey = async (event) => {
    event.preventDefault();
    try {
      await api("/model-auth/api-key", {
        method: "PUT",
        body: JSON.stringify({ key: keyInput.value }),
      });
      keyInput.value = "";
      await renderModelAuth("Saved. Agents now run on this API key.");
    } catch (error) {
      fail(error);
    }
  };
  const signOut = async () => {
    try {
      await api("/model-auth", { method: "DELETE" });
      await renderModelAuth("Signed out. The stored sign-in or key was removed.");
    } catch (error) {
      fail(error);
    }
  };
  const stored = status.source === "subscription" || status.source === "api_key";
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Claude sign-in"),
      h(
        "p",
        { class: "subtitle" },
        "What powers your agents. Sign in with your Claude subscription, or use an Anthropic API key instead. Your agents use it without ever seeing it.",
      ),
      h(
        "div",
        { style: "display: grid; gap: 16px" },
        message ? h("div", { class: "notice", role: "status" }, message) : null,
        status.source === "none"
          ? h(
              "div",
              { class: "error-banner", role: "alert" },
              "Nothing powers the company yet. Agents cannot work until you sign in or add a key.",
            )
          : null,
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Powered by"),
          h("p", {}, MODEL_AUTH_SOURCES[status.source] ?? status.source),
          stored
            ? h("button", { type: "button", class: "ghost", onClick: signOut }, "Sign out")
            : null,
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Sign in with Claude"),
          h(
            "p",
            { class: "muted" },
            "Uses your Claude Pro or Max plan. When the plan's usage limit is reached, work pauses until it resets.",
          ),
          h("button", { type: "button", onClick: start }, "Sign in with Claude"),
          linkSlot,
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "Or use an API key"),
          h(
            "form",
            { class: "secret-form", onSubmit: saveKey },
            keyInput,
            h("button", { type: "submit" }, "Save key"),
          ),
        ),
        formError,
      ),
    ),
  );
}

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
// The company drive and the deliverables shelf
// ---------------------------------------------------------------------------

const GOAL_STATUS = {
  active: { label: "in progress", status: "running" },
  done: { label: "done", status: "succeeded" },
  failed: { label: "failed", status: "failed" },
  abandoned: { label: "abandoned", status: "cancelled" },
};

function fileUrl(filePath, download = false) {
  return `/api/drive/file?path=${encodeURIComponent(filePath)}${download ? "&download=1" : ""}`;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function upload(url, file, method) {
  const response = await fetch(url, { method, credentials: "same-origin", body: file });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? `Upload failed (${response.status}).`);
  }
  return body.entry;
}

/** Puts a file the owner hands in into the drive's inbox, under a free name. */
function uploadToInbox(file) {
  return upload(`/api/drive/inbox?name=${encodeURIComponent(file.name)}`, file, "POST");
}

/** A button that opens the file picker and passes the chosen files on. */
function attachButton(onFiles, label = "Attach") {
  const input = h("input", { type: "file", multiple: true, hidden: true });
  input.addEventListener("change", async () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length > 0) {
      try {
        await onFiles(files);
      } catch (error) {
        viewRoot().prepend(errorView(error));
      }
    }
  });
  return h(
    "span",
    {},
    input,
    h("button", { type: "button", class: "ghost", onClick: () => input.click() }, label),
  );
}

function fileLink(filePath, name) {
  return h(
    "a",
    {
      href: fileUrl(filePath),
      class: "file-chip",
      onClick: (event) => {
        event.preventDefault();
        previewFile({ path: filePath, name: name ?? filePath.split("/").pop() });
      },
    },
    name ?? filePath.split("/").pop(),
  );
}

/** Folders the drive keeps for itself; they cannot be deleted. */
const DRIVE_OWN_FOLDERS = new Set(["drive/inbox", "drive/goals"]);

const TEXT_PREVIEW = /^(text\/|application\/(json|yaml|xml))/;

/** Shows a file in the drawer: text and images inline, anything else as a download. */
async function previewFile(entry) {
  const body = h("div", { class: "preview" });
  const actions = h(
    "p",
    { class: "preview-actions" },
    h(
      "span",
      { class: "muted" },
      entry.path,
      entry.size === undefined ? "" : ` · ${formatBytes(entry.size)}`,
    ),
    " ",
    h("a", { href: fileUrl(entry.path, true) }, "Download"),
    " ",
    h("a", { href: fileUrl(entry.path), target: "_blank", rel: "noopener" }, "Open"),
  );
  body.append(actions);
  openDrawer(entry.name, body);
  const type = entry.mimeType ?? "";
  if (type.startsWith("image/") && type !== "image/svg+xml") {
    body.append(h("img", { src: fileUrl(entry.path), alt: entry.name }));
    return;
  }
  if (!TEXT_PREVIEW.test(type) && type !== "") {
    body.append(
      h("p", { class: "muted" }, "No preview for this kind of file. Download it to open it."),
    );
    return;
  }
  const response = await fetch(fileUrl(entry.path), { credentials: "same-origin" });
  if (!response.ok) {
    body.append(errorView(new Error(`Could not open the file (${response.status}).`)));
    return;
  }
  const text = await response.text();
  const limit = 200_000;
  body.append(
    h(
      "pre",
      { class: "file-text" },
      text.length > limit
        ? `${text.slice(0, limit)}\n\n[Cut. Download the file to see all of it.]`
        : text,
    ),
  );
}

async function renderDrive() {
  const folder = state.drivePath;
  const { path: current, entries } = await api(`/drive?path=${encodeURIComponent(folder)}`);
  const segments = current.split("/");
  const crumbs = segments.map((segment, index) => {
    const target = segments.slice(0, index + 1).join("/");
    const label = index === 0 ? "Drive" : segment;
    return index === segments.length - 1
      ? h("strong", {}, label)
      : h("a", { href: `#/drive/${encodeURIComponent(target)}` }, label);
  });
  const message = h("div");
  const fail = (error) => message.replaceChildren(errorView(error));

  const rows = entries.map((entry) =>
    h(
      "tr",
      {},
      h(
        "td",
        {},
        entry.kind === "folder"
          ? h("a", { href: `#/drive/${encodeURIComponent(entry.path)}` }, `${entry.name}/`)
          : fileLink(entry.path, entry.name),
      ),
      h("td", { class: "muted" }, entry.kind === "folder" ? "folder" : formatBytes(entry.size)),
      h("td", { class: "muted" }, formatTime(entry.modifiedAt)),
      h(
        "td",
        { class: "row-actions" },
        entry.kind === "file" ? h("a", { href: fileUrl(entry.path, true) }, "Download") : null,
        " ",
        DRIVE_OWN_FOLDERS.has(entry.path)
          ? null
          : h(
              "button",
              {
                type: "button",
                class: "ghost",
                onClick: async () => {
                  if (!window.confirm(`Delete ${entry.path}?`)) {
                    return;
                  }
                  try {
                    await api(`/drive?path=${encodeURIComponent(entry.path)}`, {
                      method: "DELETE",
                    });
                    await render();
                  } catch (error) {
                    fail(error);
                  }
                },
              },
              "Delete",
            ),
      ),
    ),
  );

  const folderName = h("input", {
    type: "text",
    placeholder: "New folder name",
    "aria-label": "New folder name",
  });
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Company drive"),
      h(
        "p",
        { class: "subtitle" },
        "Every agent reads and writes here. Files you hand in land in inbox; each goal has a folder under goals.",
      ),
      message,
      h(
        "div",
        { class: "panel drive" },
        h(
          "div",
          { class: "drive-toolbar" },
          h(
            "nav",
            { class: "crumbs", "aria-label": "Folder" },
            crumbs.flatMap((crumb, index) => (index === 0 ? [crumb] : [" / ", crumb])),
          ),
          h(
            "span",
            { class: "drive-actions" },
            attachButton(async (files) => {
              for (const file of files) {
                await upload(
                  `/api/drive/file?path=${encodeURIComponent(`${current}/${file.name}`)}`,
                  file,
                  "PUT",
                );
              }
              await render();
            }, "Upload"),
            h(
              "form",
              {
                class: "inline-form",
                onSubmit: async (event) => {
                  event.preventDefault();
                  const name = folderName.value.trim();
                  if (!name) {
                    return;
                  }
                  try {
                    await api("/drive/folder", {
                      method: "POST",
                      body: JSON.stringify({ path: `${current}/${name}` }),
                    });
                    await render();
                  } catch (error) {
                    fail(error);
                  }
                },
              },
              folderName,
              h("button", { type: "submit", class: "ghost" }, "Add folder"),
            ),
          ),
        ),
        entries.length === 0
          ? h("p", { class: "muted empty-folder" }, "Nothing here yet.")
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
                  h("th", {}, "Size"),
                  h("th", {}, "Changed"),
                  h("th", {}, ""),
                ),
              ),
              h("tbody", {}, rows),
            ),
      ),
    ),
  );
}

async function renderDeliverables() {
  const { goals } = await api("/deliverables");
  const cards = goals.map((goal) => {
    const status = GOAL_STATUS[goal.status] ?? { label: goal.status, status: "queued" };
    return h(
      "article",
      { class: `panel deliverable deliverable-${goal.status}` },
      h(
        "header",
        {},
        h("span", { class: `status status-${status.status}` }, status.label),
        " ",
        h("strong", {}, goal.title ?? goal.goalId),
        h("span", { class: "meta" }, formatTime(goal.updatedAt)),
      ),
      goal.reason && goal.status !== "done" ? h("p", { class: "muted small" }, goal.reason) : null,
      goal.files.length === 0
        ? h(
            "p",
            { class: "muted small" },
            goal.status === "active" ? "Nothing handed in yet." : "No files were handed in.",
          )
        : h(
            "ul",
            { class: "deliverable-files" },
            goal.files.map((file) =>
              h(
                "li",
                {},
                fileLink(file.path, file.path.slice(goal.folder.length + 1)),
                h("span", { class: "muted small" }, ` ${formatBytes(file.size)} · `),
                h("a", { href: fileUrl(file.path, true), class: "small" }, "Download"),
              ),
            ),
          ),
      h(
        "p",
        { class: "small" },
        h(
          "a",
          { href: `#/drive/${encodeURIComponent(goal.folder.replace(/\/deliverables$/, ""))}` },
          "Open the goal's folder",
        ),
        goal.threadId ? " · " : null,
        goal.threadId
          ? h("a", { href: `#/chat/${encodeURIComponent(goal.threadId)}` }, "Open the conversation")
          : null,
      ),
    );
  });
  setView(
    h(
      "div",
      {},
      h("h1", {}, "Deliverables"),
      h(
        "p",
        { class: "subtitle" },
        "Finished work from every goal. Cancelled goals keep their partial work, marked abandoned.",
      ),
      goals.length === 0
        ? h("div", { class: "panel empty" }, h("p", {}, "No goals yet. Ask the CEO for something."))
        : h("div", { class: "deliverables" }, cards),
    ),
  );
}

// ---------------------------------------------------------------------------
// Memory: the company handbook and each agent's private memory
// ---------------------------------------------------------------------------

const MEMORY_KIND_LABELS = {
  memory: "Memory",
  prompt: "Rule",
  skill: "Procedure",
  subagent: "Helper",
};

const MEMORY_ORIGIN_LABELS = {
  owner: "You",
  agent: "The agent, during work",
  chat: "Noticed in your chats",
  dream: "Dreaming",
  import: "Imported from old notes",
  undo: "Undo",
};

function describeOrigin(origin) {
  if (!origin) {
    return "Unknown";
  }
  const label = MEMORY_ORIGIN_LABELS[origin.kind] ?? origin.kind;
  const parts = [label];
  if (origin.note) {
    parts.push(`“${origin.note}”`);
  }
  if (origin.ref) {
    parts.push(origin.ref);
  }
  parts.push(formatTime(origin.at));
  return parts.join(" · ");
}

function memoryForm(entry, onSave, onCancel) {
  const title = h("input", {
    name: "title",
    required: true,
    maxlength: 200,
    placeholder: "Title",
    "aria-label": "Title",
    value: entry?.title ?? "",
  });
  const content = h("textarea", {
    name: "content",
    required: true,
    rows: 4,
    maxlength: 20000,
    placeholder: "What should be remembered",
    "aria-label": "Content",
  });
  content.value = entry?.content ?? "";
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = async (event) => {
    event.preventDefault();
    try {
      await onSave({ title: title.value.trim(), content: content.value.trim() });
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    }
  };
  return h(
    "form",
    { class: "memory-form", onSubmit: submit },
    title,
    content,
    h(
      "div",
      { class: "row-actions" },
      h("button", { type: "submit" }, entry ? "Save" : "Add"),
      onCancel
        ? h("button", { type: "button", class: "ghost", onClick: onCancel }, "Cancel")
        : null,
    ),
    error,
  );
}

async function renderMemory(message) {
  const scope = state.memoryScope ?? "company";
  const [overview, listing, history, agents, background] = await Promise.all([
    api("/memory"),
    api(`/memory/${encodeURIComponent(scope)}`),
    api(`/memory/changes?scope=${encodeURIComponent(scope)}&limit=50`),
    api("/agents"),
    api("/memory/background").catch(() => undefined),
  ]);
  const counts = new Map(overview.scopes.map((row) => [row.scope, row.entries]));
  const isHandbook = scope === "company";
  const scopeLabel = isHandbook ? "Company handbook" : scope;
  const send = async (edits, summary) => {
    const result = await api(`/memory/${encodeURIComponent(scope)}`, {
      method: "POST",
      body: JSON.stringify({ edits, ...(summary ? { summary } : {}) }),
    });
    const refused = result.edits.find((edit) => !edit.applied);
    if (refused) {
      throw new Error(refused.error ?? "The change was refused.");
    }
  };
  const undo = async (change) => {
    try {
      const result = await api(`/memory/changes/${encodeURIComponent(change.id)}/undo`, {
        method: "POST",
      });
      const skipped = result.edits.filter((edit) => !edit.applied);
      await renderMemory(
        skipped.length === 0
          ? `Undone: ${change.summary}.`
          : `Undone in part. ${skipped.length} entry changed again since and was left as it is.`,
      );
    } catch (error) {
      await renderMemory(error.message);
    }
  };

  const setPaused = async (paused) => {
    try {
      await api("/memory/background", { method: "PUT", body: JSON.stringify({ paused }) });
      await renderMemory(
        paused ? "Background memory work is paused." : "Background memory work is back on.",
      );
    } catch (error) {
      await renderMemory(error.message);
    }
  };
  const scanNow = async () => {
    try {
      const { result } = await api("/memory/background/scan", { method: "POST" });
      await renderMemory(
        result.skipped
          ? result.skipped
          : `Read ${result.scanned} messages and filed ${result.filed} preferences.`,
      );
    } catch (error) {
      await renderMemory(error.message);
    }
  };
  const jobLine = (label, job) =>
    h(
      "p",
      { class: "small" },
      h("strong", {}, `${label}: `),
      job?.lastRunAt ? `last ran ${formatTime(job.lastRunAt)}` : "has not run yet",
      job?.lastResult ? ` · ${job.lastResult}` : "",
      job?.lastError ? ` · last problem: ${job.lastError}` : "",
      job?.usage?.calls
        ? ` · ${job.usage.calls} calls, ${formatTokens(job.usage.totalTokens)} tokens`
        : "",
    );
  const backgroundPanel = background
    ? h(
        "div",
        { class: "panel" },
        h("h2", {}, "Background work"),
        h(
          "p",
          { class: "muted small" },
          "A small model reads your chats for lasting preferences, and idle agents dream: they reread their recent work and tidy their memory. Both use your Claude plan, sparingly.",
        ),
        jobLine("Preference scanner", background.jobs.scanner),
        jobLine("Dreaming", background.jobs.dreaming),
        h(
          "div",
          { class: "row-actions" },
          background.settings.paused
            ? h("button", { type: "button", onClick: () => setPaused(false) }, "Resume")
            : h(
                "button",
                { type: "button", class: "ghost", onClick: () => setPaused(true) },
                "Pause",
              ),
          h("button", { type: "button", class: "ghost", onClick: scanNow }, "Scan chats now"),
        ),
      )
    : null;

  const tabs = h(
    "div",
    { class: "memory-scopes", role: "tablist" },
    h(
      "a",
      { href: "#/memory/company", class: isHandbook ? "active" : "", role: "tab" },
      `Handbook (${counts.get("company") ?? 0})`,
    ),
    agents.agents.map((agent) =>
      h(
        "a",
        {
          href: `#/memory/${encodeURIComponent(agent.id)}`,
          class: scope === agent.id ? "active" : "",
          role: "tab",
        },
        `${agent.title ?? agent.role} (${counts.get(`agent:${agent.id}`) ?? 0})`,
      ),
    ),
  );

  const entryCard = (entry) => {
    const card = h("article", { class: "memory-entry" });
    const show = () => {
      card.replaceChildren();
      append(card, [
        h(
          "header",
          {},
          h(
            "span",
            { class: "status status-queued" },
            MEMORY_KIND_LABELS[entry.kind] ?? entry.kind,
          ),
          " ",
          h("strong", {}, entry.title),
          entry.locked ? h("span", { class: "muted small" }, " · kept as you wrote it") : null,
        ),
        h("p", { class: "memory-content" }, entry.content),
        typeof entry.reference?.command === "string"
          ? h("p", { class: "small" }, h("code", {}, entry.reference.command))
          : null,
        h("p", { class: "muted small" }, `From: ${describeOrigin(entry.origin)}`),
        h(
          "div",
          { class: "row-actions" },
          h("button", { type: "button", class: "ghost", onClick: edit }, "Edit"),
          h("button", { type: "button", class: "ghost", onClick: remove }, "Remove"),
        ),
      ]);
    };
    const edit = () => {
      card.replaceChildren(
        memoryForm(
          entry,
          async (fields) => {
            await send([{ action: "update", kind: entry.kind, id: entry.id, ...fields }]);
            await renderMemory(`Saved “${fields.title}”.`);
          },
          show,
        ),
      );
    };
    const remove = async () => {
      try {
        await send([{ action: "delete", kind: entry.kind, id: entry.id }]);
        await renderMemory(`Removed “${entry.title}”. Undo it below if that was a mistake.`);
      } catch (error) {
        await renderMemory(error.message);
      }
    };
    show();
    return card;
  };

  const changeRow = (change) =>
    h(
      "li",
      { class: "memory-change" },
      h(
        "div",
        {},
        h("strong", {}, change.summary),
        h(
          "div",
          { class: "muted small" },
          `${MEMORY_ORIGIN_LABELS[change.origin?.kind] ?? change.actor.kind} · ${formatTime(change.createdAt)}`,
          change.rationale ? ` · ${change.rationale}` : "",
          change.undoneBy ? " · undone" : "",
        ),
      ),
      change.undoneBy || change.undoOf
        ? null
        : h("button", { type: "button", class: "ghost", onClick: () => undo(change) }, "Undo"),
    );

  setView(
    h(
      "div",
      {},
      h("h1", {}, "Memory"),
      h(
        "p",
        { class: "subtitle" },
        "What the company remembers. The handbook is read by every agent; each agent also keeps its own memory from its work. Your edits are kept as you wrote them, and any change can be undone.",
      ),
      tabs,
      h(
        "div",
        { style: "display: grid; gap: 16px" },
        message ? h("div", { class: "notice", role: "status" }, message) : null,
        h(
          "div",
          { class: "panel" },
          h("h2", {}, isHandbook ? "Add to the handbook" : `Add to ${scopeLabel}'s memory`),
          memoryForm(undefined, async (fields) => {
            await send([{ action: "create", kind: "memory", ...fields }]);
            await renderMemory(`Added “${fields.title}”.`);
          }),
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", {}, scopeLabel),
          listing.entries.length === 0
            ? h("p", { class: "muted" }, "Nothing here yet.")
            : h("div", { class: "memory-entries" }, listing.entries.map(entryCard)),
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", {}, "History"),
          history.changes.length === 0
            ? h("p", { class: "muted" }, "No changes yet.")
            : h("ul", { class: "memory-changes" }, history.changes.map(changeRow)),
        ),
        backgroundPanel,
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
    if (state.company.mission) {
      document.getElementById("company-tagline").textContent = firstSentence(state.company.mission);
    }
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
