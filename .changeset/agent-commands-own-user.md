---
"@generic-ai/plugin-tools-terminal": patch
---

Agent shell commands can run as a separate OS user. `createTerminalToolPlugin({ runAs: { user } })` runs each command through `sudo -n -u <user>` with only the allowlisted variables (passed in the environment, not on the command line), a `0007` umask, and a supervisor that kills the command and everything it started when the tool times out or aborts. The Generic Corp image adds an `agent` user and a sudoers rule limited to it, keeps `/data` closed to other users and shares agent homes through the `agent` group; the server resolves `GENERIC_CORP_AGENT_USER` at startup, falls back with a warning unless `GENERIC_CORP_AGENT_ISOLATION=required`, and reports the mode as `agentIsolation` on `/ready`.
