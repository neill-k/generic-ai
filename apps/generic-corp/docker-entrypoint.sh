#!/bin/sh
# Entrypoint for the Generic Corp image.
#
# Railway (and some Docker setups) mount volumes owned by root. When the
# container starts as root, give the data directory to the `node` user and
# then run the command as `node`, so neither the server nor the agents' shell
# commands run as root. When it already starts as another user, run the
# command unchanged.
set -eu

data_dir="${GENERIC_CORP_DATA_DIR:-/data}"

# Files the server and agents create are not readable by other users. Agent
# homes are shared with the `agent` group, so the server and agent commands
# can both work in them.
umask 0007

# Adds the agent user's firewall rules in their own chains, replacing any from
# an earlier start. Fails when iptables is missing or not permitted.
wall_agent_network() {
  port="$1"
  command -v iptables >/dev/null 2>&1 || return 1
  iptables -w -N GENERIC_CORP_AGENT 2>/dev/null || iptables -w -F GENERIC_CORP_AGENT || return 1
  iptables -w -A GENERIC_CORP_AGENT -o lo -d 127.0.0.1 -p tcp --dport "$port" -j ACCEPT || return 1
  iptables -w -A GENERIC_CORP_AGENT -p tcp -j REJECT --reject-with tcp-reset || return 1
  iptables -w -A GENERIC_CORP_AGENT -j REJECT || return 1
  iptables -w -C OUTPUT -m owner --uid-owner agent -j GENERIC_CORP_AGENT 2>/dev/null \
    || iptables -w -I OUTPUT 1 -m owner --uid-owner agent -j GENERIC_CORP_AGENT || return 1
  # IPv6: nothing at all. Where the kernel has no IPv6 there is nothing to block.
  if command -v ip6tables >/dev/null 2>&1 && ip6tables -w -L OUTPUT >/dev/null 2>&1; then
    ip6tables -w -N GENERIC_CORP_AGENT 2>/dev/null || ip6tables -w -F GENERIC_CORP_AGENT || return 1
    ip6tables -w -A GENERIC_CORP_AGENT -j REJECT || return 1
    ip6tables -w -C OUTPUT -m owner --uid-owner agent -j GENERIC_CORP_AGENT 2>/dev/null \
      || ip6tables -w -I OUTPUT 1 -m owner --uid-owner agent -j GENERIC_CORP_AGENT || return 1
  fi
  return 0
}

if [ "$(id -u)" = "0" ]; then
  agents_dir="$data_dir/agents"
  mkdir -p "$agents_dir"
  # Only touch files that need it, so restarts stay fast.
  #
  # Server data (database, artifacts, anything outside agent homes) belongs to
  # node and is closed to everyone else. Agent commands run as `agent`, which
  # may pass through /data but not list or read it.
  find "$data_dir" -path "$agents_dir" -prune -o ! -user node -exec chown node:node {} +
  find "$data_dir" -path "$agents_dir" -prune -o -perm /o=rwx -exec chmod o-rwx {} +
  chmod 0711 "$data_dir"
  # Agent homes: owned by node (which creates them), group `agent`, readable
  # and writable by the group, and setgid so new files join the group.
  # Files an agent command created stay owned by `agent`.
  find "$agents_dir" ! -user node ! -user agent -exec chown node {} +
  find "$agents_dir" ! -group agent -exec chgrp agent {} +
  find "$agents_dir" -type d ! -perm -2770 -exec chmod g+rwxs {} +
  find "$agents_dir" ! -type d ! -type l ! -perm -0060 -exec chmod g+rw {} +
  find "$agents_dir" ! -type l -perm /o=rwx -exec chmod o-rwx {} +

  # The network wall (design decision 36). Packets from the `agent` user may go
  # to the egress proxy on loopback and nowhere else: no other host, no DNS, no
  # other local service (the app's own port, Postgres). The proxy, run by the
  # server, lets through only the hosts on the owner's allowlist. This needs the
  # NET_ADMIN capability (compose.yaml adds it); without it, agent commands are
  # only pointed at the proxy and /ready reports agentNetwork "proxy-only".
  if [ "${GENERIC_CORP_AGENT_NETWORK:-auto}" != "off" ] && id agent >/dev/null 2>&1; then
    egress_port="${GENERIC_CORP_EGRESS_PORT:-3128}"
    if wall_agent_network "$egress_port"; then
      echo "Agent network: commands from user agent can reach only the egress proxy on port $egress_port."
    else
      echo "WARNING: could not add the agent firewall rule (the container needs NET_ADMIN). Agent commands are pointed at the egress proxy but can connect directly." >&2
    fi
  fi

  # The server never needs to change the firewall, so drop those capabilities
  # for good before handing over to node.
  exec setpriv --reuid=node --regid=node --init-groups --bounding-set -net_admin,-net_raw \
    env HOME=/home/node USER=node "$@"
fi

exec "$@"
