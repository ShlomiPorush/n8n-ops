#!/usr/bin/env bash
# Read-only discovery of the n8n Docker host for n8n-ops.
# Changes nothing: only runs docker inspect/ps/info and df.
# Secret values (keys, passwords, tokens) are masked in the report.
#
# Usage: ./discover.sh [output-file]

set -u

OUTPUT="${1:-./n8n-discovery-$(date +%Y%m%d_%H%M%S).txt}"
ENV_PATTERN='^(N8N_|DB_|QUEUE_|EXECUTIONS_|WEBHOOK_URL|GENERIC_TIMEZONE|TZ=|NODE_ENV|POSTGRES_|REDIS_)'
SECRET_PATTERN='(PASSWORD|PASS|SECRET|TOKEN|KEY|LICENSE)'

section() {
  printf '\n===== %s =====\n' "$1"
}

mask_env() {
  # Print NAME=value, replacing the value of secret-looking names with ***
  while IFS= read -r line; do
    local name="${line%%=*}"
    if [[ "$name" =~ $SECRET_PATTERN ]]; then
      if [ -n "${line#*=}" ]; then
        echo "$name=*** (set)"
      else
        echo "$name= (empty)"
      fi
    else
      echo "$line"
    fi
  done
}

{
  section "Host"
  echo "Date: $(date -Is)"
  echo "Hostname: $(hostname)"
  uname -a
  docker version --format 'Docker server: {{.Server.Version}}' 2>&1

  section "Disk usage"
  df -h
  docker system df 2>&1

  section "All containers"
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

  for c in $(docker ps -a --format '{{.Names}}'); do
    image=$(docker inspect -f '{{.Config.Image}}' "$c")
    # Only n8n, Postgres and Redis containers get a detailed section
    if ! [[ "$image" =~ (n8n|postgres|redis) ]]; then
      continue
    fi

    section "Container: $c"
    docker inspect -f 'Image: {{.Config.Image}}
State: {{.State.Status}} (started {{.State.StartedAt}})
Restart policy: {{.HostConfig.RestartPolicy.Name}}
Command: {{json .Config.Cmd}}
Entrypoint: {{json .Config.Entrypoint}}
Networks: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}
Compose project: {{index .Config.Labels "com.docker.compose.project"}}
Compose file: {{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c"

    echo "Mounts:"
    docker inspect -f '{{range .Mounts}}  {{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$c"

    echo "Environment (filtered, secrets masked):"
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" |
      grep -E "$ENV_PATTERN" | sort | mask_env | sed 's/^/  /'

    if [[ "$image" =~ n8n ]] && [ "$(docker inspect -f '{{.State.Running}}' "$c")" = "true" ]; then
      echo "n8n version: $(docker exec "$c" n8n --version 2>&1 | tail -1)"
    fi
  done

  section "Networks"
  docker network ls
} >"$OUTPUT" 2>&1

echo "Discovery report written to: $OUTPUT"
echo "Review it before sharing. Secret values are masked, but URLs and hostnames are included."
