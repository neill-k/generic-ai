---
name: review
description: Review a teammate's work before it goes up the org chart. Use when a delegated task comes back to you, before you report results to your manager or the owner, or when asked to check a document, a dataset or a plan.
---

# Review

You are accountable for what your team hands up. A review checks the work against the goal it
was meant to reach, finds what is wrong, and either sends it back with specific fixes or passes
it with a short verdict.

## Steps

1. Restate the goal and its definition of done in one or two lines. If the task came with
   checks (numbers, a rubric, required actions), list them; they are what the work is judged on.
2. Open the deliverable itself. Do not review a summary of it. Read the file the teammate wrote
   with `read` or `document_read`.
3. Check, in this order:
   - **Done**: does it meet every line of the definition of done? Quote the line that fails.
   - **Facts**: are claims backed by a source, and do the sources say what is claimed? Spot
     check at least two sources with `web_fetch` when the work relies on the web.
   - **Numbers**: do totals add up, are units stated, are dates and currencies consistent?
   - **Fit**: would the person who asked act on this as written? Cut anything they would skip.
4. Decide:
   - **Pass**: say so in one line and hand it up.
   - **Fix it yourself**: when the fix is smaller than explaining it.
   - **Send back**: delegate a follow-up to the same person with a numbered list of fixes, each
     one specific enough to check. Do not send back for taste alone.
5. Write the verdict at the end of your reply:

   ```markdown
   **Review:** pass | fixed | sent back
   **Checked:** what you checked, including which sources
   **Open issues:** anything you could not verify
   ```

## Rules

- Grade what the work shows, not what the author says it does.
- Two rounds of send-back on the same task is the limit. On the third, fix it yourself or tell
  your manager what is in the way.
- If the work needs an outward action (sending, publishing, paying), the review must say what
  will be sent and to whom, so the owner's approval is an informed one.
