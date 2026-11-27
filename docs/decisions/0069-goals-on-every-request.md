# 0069. Goals on Every Request

## Context

The design review with the owner (November 2026, decisions 6, 7, 8, 10, 12 and 13) made the goal
the centre of Generic Corp. Until now a task only had a machine-checked goal when the owner picked
a template goal; a task finished as soon as an agent replied without delegating; the agent's own
reply (a fenced JSON block) named the deliverable and carried the numbers the checks read;
`finish_task` let any agent give up on its own say-so; and there was no way for the owner to
change what "done" means once work had started.

## Decision

All of this lives in `@generic-ai/plugin-delegation`, so any host gets it; Generic Corp wires it.

1. **The agent drafts the goal, the host locks it.** `submit({ draftGoal: true })` marks the task
   `goalDraft: "pending"`. Its first turn gets a `set_goal` tool and is told to set the objective,
   definition of done and checks before any other work; `delegate_task` and `submit_work` refuse
   until it does. The host fixes the goal id (the task id), parses the spec, applies decision 11
   (numeric checks must read a host metric, `source: { metric }`, never `outputPath` into the
   agent's reply) and the host's `goals.draftPolicy`, seals it and writes it to the task record at
   once. After that `set_goal` refuses and is no longer offered. A turn that ends with the goal
   still unset goes back to the agent. The prompt lists the metrics the host measures
   (`goals.metrics`) and its registered checks, and tells the agent to size the goal to the
   request: a small question gets one line and one rubric.
2. **Handing in is a tool call.** `submit_work({ summary, deliverables: [{ path, title? }] })`
   is the only way to finish a task (`handIn: "tool"`, the default). The hand-in is stored on the
   task (`handIn`), validators see it as the structured output (`{ summary, deliverables }`) and
   the summary as the output text, and the host's `goals.evidence` hook gets it to read the files.
   `checkHandIn` lets the host refuse a hand-in during the turn, for example a missing file. A
   turn that ends without a hand-in, delegation or impossibility claim goes back to the agent with
   that feedback. `handIn: "reply"` keeps the old reply-is-the-result behaviour for hosts that
   need it. A fenced `{"submit_work": {...}}` block is read for executors without tools.
3. **Impossible needs a second opinion.** `declare_impossible({ reason })` replaces
   `finish_task`. The host's `impossibility` reviewer, meant to run on a different model, decides
   whether the task is impossible in principle and writes its reasoning. Only a confirmed claim
   ends the task (status `failed`, with `impossible` and the reasoning on the record); otherwise
   the agent gets the task back with the reviewer's reasoning. Without a reviewer, or when the
   review fails, no claim is confirmed. Every claim is kept in `impossibilityClaims`. The older
   `finish_task` JSON reads as a claim and gets the same review.
4. **The owner can change the goal at any time.** `cascade.updateGoal(taskId, edit)` re-seals the
   goal under a new revision (`goalRevision`, `goalHistory` with who changed what). When the
   definition of done changes, a host-owned `definition-of-done` rubric is rewritten (or added)
   with one required criterion per line, so the new lines are checked and not only the ones the
   original checks covered. Every unfinished task in the cascade gets a notice, shown at its next
   step under "New since your last step"; `submit_work` also reports an edit made during the
   turn. The next hand-in is checked against the new version. A root task that already succeeded
   is reopened. Step-level delivery inside a running turn waits for steering (decision 5).
5. **Questions never block.** `ask_owner({ question, assumption })` writes the question to the
   task and tells the agent to carry on with its assumption. `cascade.answerQuestion` records the
   answer and delivers it as a notice. `cascade.notify` sends any other note.
6. **Judges per agent.** `goals.judgesFor({ task, agent })` picks the rubric judges for a task, so
   the host can run the judge on a model other than the worker's (decision 12).

## Consequences

- Every task can end only as done (hand-in passes its checks), impossible (confirmed by a
  reviewer), cancelled, or failed by the remaining limits (rounds, validation attempts, turn
  retries), which the "first real run" work makes opt-in.
- Hosts must configure an impossibility reviewer for agents to ever stop on impossibility.
- Template goals that read numbers from the agent's reply must move to host metrics.
- Existing hosts that relied on a plain reply finishing a task must either give agents the tools
  (the default) or set `handIn: "reply"`.
