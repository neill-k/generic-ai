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
needed once.

## 3. Sign in with Claude

In the menu, open **Claude sign-in** and press **Sign in with Claude**. A link
appears. Open it, approve access with the Claude account whose plan should
power the company, copy the code Claude shows at the end, paste it into the
box, and press **Finish sign-in**. The page then says the company is powered
by your Claude subscription. The sign-in renews itself.

If you would rather use an API key, paste an Anthropic key (`sk-ant-...`) in
the same page instead.

## 4. Give it a goal

Open **Chat with the CEO** and describe what you want done, the way you would
brief a person. You can also pick one of the ready-made goals on that page.
The CEO plans the work, hands parts to the team, and keeps going until the
goal's checks pass. There is no round or time limit: a goal ends when it is
done, or when you cancel it.

The **Board** and **Org chart** show who is working on what. **Costs** shows
the tokens used.

## Day to day

| To | Run |
| --- | --- |
| Follow the log | `./apps/generic-corp/start-local.sh logs` |
| Stop (your company's data is kept) | `./apps/generic-corp/start-local.sh stop` |
| Start again after a stop or a code update | `./apps/generic-corp/start-local.sh` |
| Wipe everything and start fresh | `docker compose -f apps/generic-corp/compose.yaml down -v` |

To use another port, set `GENERIC_CORP_PORT=3100` before the start command.

## Good to know

- Your plan's usage limit applies. When it is reached, agent turns fail and
  are retried, so heavy goals can stall until the limit resets.
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
