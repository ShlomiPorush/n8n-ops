#!/bin/sh
# The server image starts as root only to hand /data to node: a host directory that Docker creates
# for the bind mount belongs to root, and the server must write its app key there. Then it runs the
# server as node through the base image's entrypoint. Started as node already, it skips the chown.
set -eu
if [ "$(id -u)" = 0 ]; then
  chown -R node:node /data
fi
exec as-node docker-entrypoint.sh "$@"
