# Run Generic Corp on your machine

This is the first real run: Generic Corp in Docker on your own computer,
powered by your Claude subscription. It takes about ten minutes, most of it
the first build.

## What you need

- Docker Desktop (or Docker Engine with Compose v2), running.
- A Claude Pro or Max account.
- This repository, cloned.

## 1. Start it

From the repository root:

```sh
./apps/generic-corp/start-local.sh
```

It builds the image, starts Postgres and the app, waits until the app is
ready, and prints what to do next, including a one-time setup token.

## 2. Create your passkey

Open <http://localhost:3000/auth/login>, paste the setup token, and create a
passkey. That passkey is how you sign in from now on. The token is only
needed once. Press **Continue** and the app opens on **Goals**.

## 3. Sign in with Claude

Open **More** (last item in the menu), then **Claude sign-in**, and press
**Sign in with Claude**. A link appears. Open it, approve access with the
Claude account whose plan should power the company, copy the code Claude
shows at the end, paste it into the box, and press **Finish sign-in**. Under
**Powered by** the page then shows your Claude subscription. The sign-in
renews itself.

If you would rather use an API key, paste an Anthropic key (`sk-ant-...`)
under **Or use an API key** on the same page.

Further down the same page, **When your plan's usage limit is reached** picks
what happens at the limit: **Wait for the plan to reset** (work pauses and
picks up on its own) or **Use an API key until then**.

## 4. Give it a goal

On **Goals**, type the outcome you want under **Set a goal**, the way you
would brief a person, and press **Set goal**. You can also pick a standing
goal from the list next to the button. The goal's page opens:

- The CEO first writes down **What done means**, a short checklist. Press
  **Edit** beside it to change it at any time. Agents are told when it
  changes, and nobody stops to ask you.
- The CEO hands parts of the work to the team and keeps going until the
  checks pass. There is no round or time limit. A goal ends when it is done,
  when an agent shows it is impossible, or when you press **Cancel this
  goal**.
- **Activity** shows what everyone is doing right now, and **Org chart** shows
  the team. Click an agent to see its work, chat with it, read its memory, or
  set its limits.

## 5. Find the results

Finished work lands in **More > Deliverables**, grouped by goal, newest
first. Every file the agents made, deliverables included, is in **More >
Drive**, where you can also upload files for them. (On disk the goal's folder
is `drive/goals/<goal id>/deliverables/` in the company drive.)

## Pause, limits and backups

- **Pause:** **Pause the company** at the bottom of the menu (under **More**
  on a phone) stops all work. Each agent finishes the step it is on, so
  nothing is cut off mid-action. Press **Resume work** to carry on. To pause
  one agent, open it on the **Org chart** and press **Pause <name>**.
- **Limits:** spending limits are optional. Set one for the whole company in
  **More > Usage and limits** (**Company spending limit**, then **Set
  limit**), or for one agent there or on its card in the **Org chart**
  (**Limits** tab). The same tab has the agent's quality dial.
- **Backups:** **More > Backups** lists the nightly backups and has **Back up
  now**. Restoring runs from the terminal (see [Backups](#backups) below):
  `./apps/generic-corp/start-local.sh restore latest`.

## Run the checkup (optional)

The checkup measures what Generic Corp is worth: it runs one goal (closing a
month of expenses) through a plain single agent and through the whole company,
and shows tokens per finished goal for each. It runs on your plan, so it shows
the expected usage first and only starts when you confirm:

```bash
docker compose -f apps/generic-corp/compose.yaml exec app node apps/generic-corp/dist/checkup-cli.js
```

**More > Checkup** in the app runs the same thing.

## Day to day

| To | Run |
| --- | --- |
| Follow the log | `./apps/generic-corp/start-local.sh logs` |
| Stop (your company's data is kept) | `./apps/generic-corp/start-local.sh stop` |
| Start again after a stop or a code update | `./apps/generic-corp/start-local.sh` |
| List backups | `./apps/generic-corp/start-local.sh backups` |
| Put a backup back | `./apps/generic-corp/start-local.sh restore <id>` (or `latest`) |
| Wipe everything and start fresh | `docker compose -f apps/generic-corp/compose.yaml down -v` |

To use another port, set `GENERIC_CORP_PORT=3100` before the start command.

## Backups

Every night at 03:00 (UTC inside Docker) the app backs up the database and
the company's files: the shared drive, every agent's home, the agents' saved
sessions and memory, and run artifacts. The first backup is made a minute
after the first start. The last 7 are kept, in `/data/backups` inside the
data volume. You can also make one with **Back up now** on **More >
Backups**.

To put one back, run `./apps/generic-corp/start-local.sh restore <id>`. It
stops the app, checks the backup, saves what is there now as one more backup
(so a restore can be undone the same way), replaces the database and files,
and starts the app again. Your Claude sign-in is not in backups, so sign in
again afterwards. Secrets stored in the app stay readable only with the same
`GENERIC_AI_SECRETS_KEY`, so keep that key somewhere safe too.

Backups live on the same disk as the data, which protects against mistakes
and broken updates but not a lost disk. To keep a copy elsewhere:

```bash
docker compose -f apps/generic-corp/compose.yaml cp app:/data/backups ./generic-corp-backups
```

Settings: `GENERIC_CORP_BACKUP_HOUR` (0 to 23), `GENERIC_CORP_BACKUP_KEEP`
(how many to keep), `GENERIC_CORP_BACKUP_DIR` (where they go, outside the
company folder) and `GENERIC_CORP_BACKUPS=off` to stop the nightly run.

## Good to know

- Your plan's usage limit applies. When it is reached, work shows as
  "Paused until your Claude plan resets" and picks up on its own afterwards.
  To keep going on an API key instead, add a key on **More > Claude
  sign-in** (or set `ANTHROPIC_API_KEY`) and choose **Use an API key until
  then** on that page.
- Running agents nonstop on a personal plan is your account's risk.
- A turn that makes no progress for 15 minutes (no tool activity), or repeats
  the same tool call 8 times in a row, is stopped and retried. Change the
  minutes with `GENERIC_CORP_NO_PROGRESS_MINUTES`.
- Everything stays on your machine: the database and the agents' files live
  in two Docker volumes, `generic-corp_postgres-data` and
  `generic-corp_generic-corp-data`. Your Claude sign-in is stored in the
  second one.
- If something goes wrong, `./apps/generic-corp/start-local.sh logs` shows
  what the app is doing.
