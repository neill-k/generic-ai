---
name: standup
description: Run a standup. Use when the owner or your manager asks for a status update, a standup or a weekly summary, or when you start work after a break and need to know where things stand.
---

# Standup

A standup tells your manager three things in under a minute of reading: what is done, what is
in progress, and what is blocked. It is built from evidence, not from memory.

## Steps

1. Read your memory file (`context.md` in your home) and list the files you changed in
   `workspace/` since the last standup recorded there.
2. If people report to you, ask each of them for their own standup with `delegate_task`, with
   the definition of done "a standup in the format below". Wait for their results before you
   write yours. Do not ask the same person twice in one standup.
3. Write the standup in this format. Keep each line to one sentence and name the file, task or
   person it is about.

   ```markdown
   ## Standup, <date>

   **Done**
   - <result>, with where it is (file path or task)

   **In progress**
   - <work>, and when you expect it to finish

   **Blocked**
   - <what is blocked>, on whom or what, and what would unblock it

   **Team**
   - <person>: one line from their standup, only if it matters to your manager
   ```

4. Leave out sections with nothing in them, except **Blocked**: write "Nothing blocked" so your
   manager knows you checked.
5. Append a one-line summary and the date to your memory file, so the next standup can start
   from it.

## Rules

- Never report work as done unless you can point to the file or task that shows it.
- Anything waiting on the owner (an approval, a decision, a missing secret) goes under
  **Blocked**, first.
- A standup is not the place to do the work. If something can be fixed in two minutes, fix it
  after the standup and say so next time.
