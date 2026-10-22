#!/bin/sh
# The worker image starts as root only to hand /data to node and, when the Docker socket is mounted
# (no socket proxy), to give node the socket's group, which differs from host to host. Then it runs
# the worker as node through the base image's entrypoint. Started as node already, it runs it as is.
set -eu
if [ "$(id -u)" = 0 ]; then
  chown -R node:node /data
  socket="${DOCKER_SOCKET:-/var/run/docker.sock}"
  if [ -S "$socket" ]; then
    HOME=/home/node exec setpriv --reuid=node --regid=node --groups="$(id -g node),$(stat -c %g "$socket")" \
      -- docker-entrypoint.sh "$@"
  fi
fi
exec as-node docker-entrypoint.sh "$@"
