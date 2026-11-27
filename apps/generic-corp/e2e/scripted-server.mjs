// A real Generic Corp server on a scripted model, for the end-to-end, crash and load tests
// (roadmap R19). Everything is the production path (HTTP server, owner API, dashboard, SQLite
// run store and durable queue, the delegation cascade, workers, approvals gate) except the model,
// which follows a fixed policy keyed on the agent and the owner's words:
//
// - "email ..."    the CEO sends an email (a `message.send` action the owner must approve);
// - "delegate ..." the CEO hands the work to the VP and reports the VP's answer;
// - anything else  the CEO answers itself.
//
// Run after `npm run build`. Configuration comes from the environment:
//
//   E2E_DATA_DIR       data directory (required)
//   E2E_PORT           port, default 0 (printed as `listening on <url>`)
//   E2E_OUTBOX         file each sent email is appended to, one JSON line per send
//   E2E_HANG_FILE      when set, the first VP turn creates this file and then hangs forever, so a
//                      test can kill the process mid-turn; later turns see the file and finish
//   E2E_MODEL_DELAY_MS simulated model latency per response, default 0
//   E2E_STATS_FILE     file the peak number of model calls in flight is written to, overall and
//                      per agent
//   GENERIC_CORP_TURN_LEASE_MS and other GENERIC_CORP_* variables work as in production.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@generic-ai/ai";
import { withAgentHarnessToolEffects } from "@generic-ai/sdk";
import { Type } from "@sinclair/typebox";

import { startFetchServer } from "../dist/node-server.js";
import { createGenericCorpServer } from "../dist/server.js";
import { createCompanyToolkit } from "../dist/toolkit.js";

const dataDir = process.env.E2E_DATA_DIR;
if (!dataDir) {
  throw new Error("E2E_DATA_DIR is required.");
}
const outbox = process.env.E2E_OUTBOX;
const hangFile = process.env.E2E_HANG_FILE;
const delayMs = Number(process.env.E2E_MODEL_DELAY_MS ?? "0");

export const E2E_COMPANY = {
  name: "Scripted Corp",
  mission: "Prove the golden flows end to end.",
  models: { ceo: "scripted/model", vp: "scripted/model", ic: "scripted/model" },
  agents: [
    { id: "ceo", role: "ceo", title: "Chief Executive Officer" },
    { id: "vp-ops", role: "vp-operations", title: "VP of Operations", reportsTo: "ceo" },
  ],
};

const AGENT = /\(agent id "([A-Za-z0-9._-]+)", role /;
const EMAIL = { to: "customer@example.com", body: "Your order shipped today." };

function textOf(message) {
  if (message === undefined) {
    return "";
  }
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * This turn's rendered prompt. An agent keeps one saved session per goal, so earlier turns' prompts
 * come first; the latest one naming the agent is the current turn's.
 */
function turnPrompt(messages) {
  const latest = messages.findLast((m) => m.role === "user" && AGENT.test(textOf(m)));
  return textOf(latest ?? messages[0]);
}

/** The owner's request: the text under "## Task <id>" up to the next section. */
function taskOf(prompt) {
  const match = /## Task [^\n]*\n([\s\S]*?)(?:\n## |$)/.exec(prompt);
  return match?.[1] ?? "";
}

const call = (name, args) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = (text) => call("stop_and_respond", { response: text });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Model calls in flight, overall and per agent, with their peaks. Written to E2E_STATS_FILE after
// every call so a test can check that turns overlap across agents but never within one agent.
const statsFile = process.env.E2E_STATS_FILE;
const inflight = { all: 0, byAgent: {} };
const peak = { all: 0, byAgent: {}, calls: 0 };
async function respond(context) {
  const agent = AGENT.exec(turnPrompt(context.messages))?.[1] ?? "unknown";
  inflight.all += 1;
  inflight.byAgent[agent] = (inflight.byAgent[agent] ?? 0) + 1;
  peak.all = Math.max(peak.all, inflight.all);
  peak.byAgent[agent] = Math.max(peak.byAgent[agent] ?? 0, inflight.byAgent[agent]);
  peak.calls += 1;
  try {
    return await decide(context);
  } finally {
    inflight.all -= 1;
    inflight.byAgent[agent] -= 1;
    if (statsFile) {
      writeFileSync(statsFile, JSON.stringify(peak));
    }
  }
}

async function decide(context) {
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  const prompt = turnPrompt(context.messages);
  const agent = AGENT.exec(prompt)?.[1];
  const task = taskOf(prompt);
  const last = context.messages.at(-1);
  const lastTool =
    last?.role === "toolResult"
      ? context.messages.findLast((m) => m.role === "assistant")
      : undefined;
  const lastCall = lastTool?.content.find((part) => part.type === "toolCall")?.name;

  if (agent === "vp-ops") {
    if (hangFile && !existsSync(hangFile)) {
      writeFileSync(hangFile, String(process.pid));
      await new Promise(() => undefined);
    }
    return answer("42 chairs counted.");
  }
  if (agent !== "ceo") {
    return answer(`Nothing scripted for ${agent ?? "an unknown agent"}.`);
  }
  if (prompt.includes("## Results from the work you delegated")) {
    const report = /### "vp-ops": succeeded[\s\S]*?\n\n([^\n]+)/.exec(prompt)?.[1] ?? "no answer";
    return answer(`The VP reports: ${report}`);
  }
  if (/\bemail\b/i.test(task)) {
    if (lastCall === "send_email") {
      return answer(
        prompt.includes("## The owner's decisions")
          ? "Email sent."
          : "Waiting for the owner to approve the email.",
      );
    }
    return call("send_email", EMAIL);
  }
  if (/\bdelegate\b/i.test(task)) {
    if (lastCall === "delegate_task") {
      return answer("Asked the VP of Operations to count the chairs.");
    }
    return call("delegate_task", {
      tasks: [
        {
          to: "vp-ops",
          task: "Count the chairs in the office.",
          definitionOfDone: "A chair count.",
        },
      ],
    });
  }
  return answer("Hello from the CEO.");
}

const provider = registerFauxProvider({ provider: "scripted", models: [{ id: "model" }] });
// The faux provider answers from a list; refill it so the script never runs dry.
const refill = () => provider.setResponses(Array.from({ length: 10_000 }, () => respond));
refill();
setInterval(refill, 60_000).unref();
const model = provider.getModel("model");

const sendEmail = withAgentHarnessToolEffects(
  {
    name: "send_email",
    label: "Send email",
    description: "Send an email to a customer.",
    parameters: Type.Object({ to: Type.String(), body: Type.String() }),
    async execute(_id, params) {
      if (outbox) {
        appendFileSync(outbox, `${JSON.stringify(params)}\n`);
      }
      return { content: [{ type: "text", text: "sent" }], details: {} };
    },
  },
  ["message.send"],
);

const base = createCompanyToolkit({ company: E2E_COMPANY, env: {} });
const toolkit = {
  ...base,
  capabilities: (input) => {
    const bindings = base.capabilities(input);
    return { ...bindings, customTools: [...(bindings.customTools ?? []), sendEmail] };
  },
};

const app = await createGenericCorpServer({
  env: {
    ...process.env,
    GENERIC_CORP_DATA_DIR: dataDir,
    GENERIC_CORP_INSECURE_NO_AUTH: "true",
    GENERIC_CORP_HOST: "127.0.0.1",
  },
  company: E2E_COMPANY,
  toolkit,
  executorOptions: { native: { resolveModel: () => model } },
  log: () => undefined,
});
const server = await startFetchServer(app.fetch, {
  host: "127.0.0.1",
  port: Number(process.env.E2E_PORT ?? "0"),
  onError: (error) => console.error(error),
});
console.log(`listening on http://127.0.0.1:${server.port}`);

const shutdown = async () => {
  await server.close();
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
