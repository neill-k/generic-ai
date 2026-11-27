# syntax=docker/dockerfile:1.7
#
# Production image for the Generic Corp app server.
#
# Build from the repository root, because the app builds against the
# workspace packages next to it:
#
#   docker build -f apps/generic-corp/Dockerfile -t generic-corp .
#
# Railway builds this file through railway.toml at the repository root.
# Local testing with Postgres: apps/generic-corp/compose.yaml.
# Runbook: apps/generic-corp/DEPLOY.md.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# build: install the workspace, compile the app and the packages it uses, then
# drop dev dependencies.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true

COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run -w @generic-ai/app-generic-corp build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# Pinned to PLAYWRIGHT_MCP_PACKAGE in packages/plugin-mcp/src/connectors.ts.
# apps/generic-corp/src/packaging.test.ts fails when the two drift apart.
ARG PLAYWRIGHT_MCP_PACKAGE=@playwright/mcp@0.0.86
# Set to false for a smaller image without the browser connector's browser.
ARG INSTALL_BROWSER=true

# Agents get file and shell tools: bash and git for the shell, ripgrep and fd
# for the native grep and find tools, python3 for the python tool's persistent
# workspace (@generic-ai/rlm). tini forwards signals to node so a
# redeploy drains cleanly; setpriv (util-linux) drops root after the
# entrypoint fixes volume ownership.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates fd-find git python3 ripgrep sudo tini util-linux \
 && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Agents' shell commands run as their own unprivileged user, `agent`, not as
# `node`, which runs the server. As `agent` a command cannot read the server's
# files on /data, the environment of the server or of anything it starts (MCP
# servers included), or signal those processes. `node` may run commands as
# `agent` and nothing else, without a password, keeping the environment it
# hands over (already reduced to an allowlist by the terminal tool). `node` is
# in the `agent` group so the server can read and write what agents create in
# their homes. Agent workspaces are shared between the two users, so git must
# not refuse repositories owned by the other one.
RUN groupadd --gid 1001 agent \
 && useradd --uid 1001 --gid agent --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin agent \
 && usermod -aG agent node \
 && printf '%s\n' \
      'Defaults:node !requiretty, !use_pty, !lecture, !syslog, !pam_session' \
      'node ALL=(agent) NOPASSWD:SETENV: ALL' > /etc/sudoers.d/generic-corp-agent \
 && chmod 0440 /etc/sudoers.d/generic-corp-agent \
 && visudo -cf /etc/sudoers.d/generic-corp-agent \
 && git config --system --add safe.directory '*'

# The browser connector launches `npx -y @playwright/mcp@<pinned> --headless`,
# which drives Google Chrome by default. Install Chrome and its system
# libraries now, and warm the npx cache for the `node` user, so the first
# browser task does not download anything. Chrome only ships for amd64
# (which is what Railway runs); other architectures skip the browser.
RUN if [ "$INSTALL_BROWSER" = "true" ]; then \
      if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        npx -y -p "$PLAYWRIGHT_MCP_PACKAGE" playwright install --with-deps chrome \
        && su node -s /bin/sh -c "npx -y '$PLAYWRIGHT_MCP_PACKAGE' --help >/dev/null" \
        && rm -rf /root/.npm /var/lib/apt/lists/*; \
      else \
        echo "Skipping Chrome: it is not published for $(dpkg --print-architecture). The browser connector will not work in this image."; \
      fi; \
    fi

# Make the node binary execute-only for everyone but root. Linux marks a
# process that execs a binary it cannot read as non-dumpable, and the kernel
# then refuses other processes of the same user access to its
# /proc/<pid>/environ and memory. Agent shell commands run as the same user as
# the server, so this is what keeps them from reading the server's provider
# keys, DATABASE_URL and other secrets through /proc. Running node scripts
# still works: exec only needs the execute bit.
RUN chmod 0711 "$(command -v node)"

ENV NODE_ENV=production \
    GENERIC_CORP_AGENT_USER=agent \
    GENERIC_CORP_HOST=0.0.0.0 \
    PORT=3000 \
    GENERIC_CORP_DATA_DIR=/data

WORKDIR /app
# Owned by root and read-only for `node`: agent shell commands run as `node`,
# and must not be able to change the server code that runs on next start.
COPY --from=build /app /app
COPY --chmod=0755 apps/generic-corp/docker-entrypoint.sh /usr/local/bin/generic-corp-entrypoint

# Agent homes, memory files, workspaces and run artifacts. Mount a volume here.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The container starts as root only so the entrypoint can hand a freshly
# mounted volume (Railway mounts volumes as root) to the `node` user. The
# server itself always runs as `node`.
ENTRYPOINT ["tini", "--", "generic-corp-entrypoint"]
CMD ["node", "apps/generic-corp/dist/run.js"]
