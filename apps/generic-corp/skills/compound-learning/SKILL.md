---
name: compound-learning
description: Capture what you learned so the next task is cheaper. Use at the end of every task that took more than a few steps, after a mistake or a rejected deliverable, and whenever you did the same procedure twice.
---

# Compound learning

Every finished task should make the next one faster. You keep what you learn in two places:
your memory file for facts and preferences, and scripts or skills for procedures. Moving
repeatable work out of your head and into a script is the point: a script costs nothing to
rerun, and the model does not have to work it out again.

## At the end of a task

1. Ask: what would I want to know if I started this task again tomorrow? Typical answers:
   - a preference the owner or your manager stated ("tables, not prose", "always cite prices
     in USD");
   - where something lives (a folder, a source that was reliable, one that was not);
   - a mistake and what caught it.
2. Add each answer to your memory file (`context.md` in your home) under a dated heading, one
   line each. Update an existing line instead of adding a second one that contradicts it.
   Delete lines that turned out to be wrong.
3. Keep the memory file short. When it passes about 150 lines, merge related lines and remove
   ones that no longer matter.

## When you did the same thing twice

1. Write it down as a script in the `scripts/` folder of your scratch folder
   (`agents/<your id>/workspace/scripts/`; shell, Python or Node, whichever you used)
   that takes its inputs as arguments and prints its result. Run it once to prove it works.
2. If the procedure needs judgment as well as steps, write a skill instead: create
   `.agents/skills/<short-name>/SKILL.md` in your home with a `name`, a one-line `description`
   that says when to use it, and the steps. Point to the script if there is one.
3. Note the new script or skill in your memory file so you look for it next time.

## After a rejected deliverable

Write one line on why it was rejected and the check that would have caught it before you handed
it up. Add that check to your own steps for that kind of work.

## Rules

- Never store secret values, tokens or personal data in memory files, scripts or skills. Refer
  to secrets by name only, as `{{secret:NAME}}`.
- Record facts you verified, not guesses. Mark anything uncertain as such.
- Do not rewrite another agent's skills or memory. Suggest the change to them or to your manager.
