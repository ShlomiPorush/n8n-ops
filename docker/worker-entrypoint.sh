#!/bin/sh
# The worker image starts as root only to hand /data to node and, when the worker talks to Docker
# through a mounted socket (no socket proxy), to give node the socket's group, which differs from
# host to host. Then it runs the worker as node through the base image's entrypoint. Started as node
# already, it runs it as is.
set -eu

# The socket the worker uses, chosen as the worker does (apps/worker/src/docker.ts): DOCKER_HOST,
# then DOCKER_SOCKET, then the default path; tcp:// and http:// mean no socket, unix:// is stripped.
socket_path() {
  endpoint="${DOCKER_HOST:-${DOCKER_SOCKET:-/var/run/docker.sock}}"
  case "$endpoint" in
    tcp://* | http://*) ;;
    *) echo "${endpoint#unix://}" ;;
  esac
}

if [ "$(id -u)" = 0 ]; then
  chown -R node:node /data
  socket="$(socket_path)"
  if [ -n "$socket" ] && [ -S "$socket" ]; then
    HOME=/home/node exec setpriv --reuid=node --regid=node --groups="$(id -g node),$(stat -c %g "$socket")" \
      -- docker-entrypoint.sh "$@"
  fi
fi
exec as-node docker-entrypoint.sh "$@"
