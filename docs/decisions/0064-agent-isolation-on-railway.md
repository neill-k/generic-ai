# 0064 Agent isolation on Railway: a separate OS user for agent commands, file tools confined to the workspace

## Context

Roadmap item R20 asks for stronger isolation of agents in production and a
threat model that covers agents gaming their own goals. Generic Corp agents
read web pages, email and documents through connectors, so anything they read
can try to steer them (prompt injection), and they have a shell and file
tools.

ADR 0062 made the app container the shell boundary on Railway, which cannot
start nested containers. Agent commands then ran as `node`, the server's own
user. PRs 133 and 139 kept the server's environment out of agent commands and
made the server non-dumpable. The gaps left were listed in
`apps/generic-corp/DEPLOY.md`: same-user access to everything on `/data`,
readable environments of non-node children such as MCP servers launched with
`uvx`, and lifecycle hooks with the full environment. Review for this record
found a larger one: the agent-facing file tools run in the server process and
accepted any absolute path, so `read /proc/self/environ` returned the server's
provider keys, `DATABASE_URL` and secrets key.

## Threat model

Single owner (D4), one Railway service, Postgres on the private network.

| Asset | Threat | Control |
| --- | --- | --- |
| Provider keys, `DATABASE_URL`, `GENERIC_AI_SECRETS_KEY`, setup and auth tokens (server environment) | Agent command reads its environment or `/proc/<pid>/environ` | Allowlisted command environment; commands run as `agent`, which cannot read `node`'s processes; `node` binary execute-only as a second line |
| Same, via file tools | Agent asks the read or grep tool for `/proc/self/environ` | File tools refuse paths outside the agent's home (symlinks resolved) |
| MCP server credentials | Agent command reads the environment of an MCP server process | MCP servers are children of `node`; commands run as `agent` |
| Owner auth, runs, company data | Agent command reads or edits the database | Postgres password is never in an agent's environment; locally the SQLite file on `/data` is closed to `agent` |
| Server code | Agent command changes code run on next start | `/app` owned by root |
| Other server files on `/data` (artifacts, local database) | Agent command or file tool reads or plants files | `/data` closed to other users; file tools confined to the home |
| Validators, goal specs, grading data | Agent edits its own checks to pass (NOVA's warning) | Goals are sealed and fingerprinted on the task record (R24); judges and checks are host code registered by name, never named or supplied by the agent; anything a check reads must live outside agent homes, where agent commands and file tools cannot write |
| Lifecycle hooks | Hook command inherits the server's secrets | Hooks start from the allowlisted environment; `passEnv` names exceptions |
| Outward actions (email, payments, external writes) | Injected agent acts in the world | Owner approvals (ADR 0061), unchanged |

Out of scope for v1, and listed in DEPLOY.md as what remains: one agent
reading or changing another agent's home (all agents share the `agent` user
and group), network egress (agent commands reach whatever the server can),
per-command CPU and memory limits, and a check-then-open race in the file
tools that an agent's shell could try to win with a symlink swap.

Gaming goals deserves a specific rule: a host check that runs a command in an
agent's workspace (tests, a linter) executes code the agent wrote. Such checks
must run that command through the terminal tool with `runAs`, as the agent's
user and with the allowlisted environment, never in the server process with
its environment. Their grading data stays outside the agent's home.

## Decision

- **A separate OS user for agent commands.** The image adds `agent`
  (uid 1001) and a sudoers rule that lets `node` run commands as `agent`
  without a password, keeping the environment it passes (`NOPASSWD:SETENV`),
  and nothing else. `createTerminalToolPlugin({ runAs })` rewrites each
  command into `sudo -n -u agent --preserve-env=<names> -- setpriv
  --pdeathsig TERM -- bash -c <supervisor> <command>`. Values travel in the
  environment, not on the public command line. The supervisor sets umask
  `0007`, runs the command in the background and waits; if sudo is killed on
  a timeout or abort (`node` may signal sudo but not `agent`'s processes),
  `--pdeathsig` wakes the supervisor, which kills the command's whole process
  group as `agent`.
- **Shared agent homes, closed server data.** The entrypoint sets umask
  `0007`, keeps everything outside `/data/agents` owned by `node` and closed
  to others, makes `/data` traversable only, and gives `/data/agents` to the
  `agent` group with setgid directories. `node` is in that group, so the
  server and agent commands both read and write agent homes. Git trusts
  repositories owned by either user (`safe.directory`).
- **Fallback, visible.** The app resolves `GENERIC_CORP_AGENT_USER` (set to
  `agent` in the image) at startup by running a trivial command as that user.
  `GENERIC_CORP_AGENT_ISOLATION=auto` (default) falls back to running as
  `node` with a `WARNING` log line; `required` refuses to start; `off`
  disables it. `/ready` reports `agentIsolation`. The fallback exists so a
  platform that blocks sudo (for example with `no_new_privs`) degrades rather
  than failing the first deploy; the runbook asks the owner to switch to
  `required` once the deploy reports `user`.
- **File tools confined to the workspace** (PR 142), and hook commands on
  the allowlisted environment.
- **The image smoke test proves it.** The probe starts a non-node child with
  the secrets, then checks commands run as `agent`, see none of the secrets
  in their environment or any readable `/proc/<pid>/environ`, cannot read or
  write server files on `/data`, can write in their home, leave nothing
  running after a timeout, and that the file tools refuse paths outside the
  home.

## Alternatives considered

- **The server switches users itself** (Node's `spawn({ uid })` with
  `CAP_SETUID` as an ambient capability). Every child of the server, MCP
  servers included, would inherit the capability and could become root, which
  could then write `/app`. Rejected.
- **A root launcher daemon** started by the entrypoint and reached over a
  socket. More code running as root than a one-line sudoers rule, for the
  same result.
- **A sandbox service** (a second Railway service, or a hosted microVM
  sandbox) for agent commands. The right next step for network egress and
  resource limits, but a new deployable, an authenticated protocol and file
  sync for agent homes; out of scope for v1.
- **One OS user per agent.** Needs creating users at runtime, which needs
  root; deferred with the cross-agent gap documented.

## Consequences

- Agent commands can no longer read files that are only `node`'s, including
  anything under `/home/node` and server temp files. The shell tool's saved
  full output stays readable through the `read` tool.
- Files agent commands create are owned by `agent`; the server reaches them
  through the group. Restarting the container re-applies group ownership and
  modes under `/data/agents`.
- On a platform where sudo does not work, nothing breaks, but the log and
  `/ready` say commands share the server's user.
