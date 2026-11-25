#!/bin/sh
set -eu

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
