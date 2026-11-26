// Consumer smoke test for scripts/check-pack.mjs. It runs inside an empty project where the packed
// @generic-ai/* tarballs were installed from npm-style tarballs, and proves an outside user can
// compose a small multi-agent run with no model key: a lead agent spawns a researcher subagent,
// collects its answer and replies. The scripted "faux" provider stands in for a real model.

import assert from "node:assert/strict";
import { Agent } from "@generic-ai/agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@generic-ai/ai";
import { createGenericAI } from "@generic-ai/core";
import {
  createAgentChildSessionFactory,
  createSubagentRoot,
  createSubagentTools,
} from "@generic-ai/subagents";

// 1. The kernel bootstraps on the starter preset.
const bootstrap = createGenericAI();
assert.equal(bootstrap.preset.id, "@generic-ai/preset-starter-hono");

// 2. A lead agent delegates to a subagent and uses its answer.
const provider = registerFauxProvider({ models: [{ id: "smoke-model" }] });
try {
  const model = provider.getModel();
  const root = createSubagentRoot({ factory: createAgentChildSessionFactory({ model }) });
  const lead = new Agent({
    initialState: { model, systemPrompt: "You lead.", tools: createSubagentTools(root) },
  });
  const unbind = root.bindAgent(lead);

  let leadTurns = 0;
  const respond = (context) => {
    if (context.systemPrompt?.includes('subagent named "researcher"')) {
      return fauxAssistantMessage("The answer is 42.");
    }
    leadTurns += 1;
    if (leadTurns === 1) {
      return fauxAssistantMessage(
        fauxToolCall("spawn_agent", { prompt: "Find the answer.", name: "researcher" }),
        {
          stopReason: "toolUse",
        },
      );
    }
    if (leadTurns === 2) {
      return fauxAssistantMessage(fauxToolCall("collect_agents", { timeout_ms: 5_000 }), {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage("Researcher says 42.");
  };
  provider.setResponses(Array.from({ length: 8 }, () => respond));

  await lead.prompt("Delegate the question.");
  unbind();

  const last = lead.state.messages.at(-1);
  const lastText =
    typeof last?.content === "string"
      ? last.content
      : last?.content.map((b) => b.text ?? "").join("");
  assert.equal(lastText, "Researcher says 42.");
  const collected = lead.state.messages.filter((m) => m.role === "toolResult").at(-1);
  const collectedText =
    typeof collected?.content === "string"
      ? collected.content
      : collected?.content.map((b) => b.text ?? "").join("");
  assert.match(collectedText, /The answer is 42\./);
} finally {
  provider.unregister();
}

console.log("multi-agent smoke: lead agent delegated to a subagent from the installed packages.");
