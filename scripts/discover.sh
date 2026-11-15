#!/usr/bin/env bash
# Read-only discovery of the n8n Docker host for n8n-ops.
# Changes nothing: only runs docker inspect/ps/info and df.
# Environment variables are filtered to n8n, database and queue names, and their values are
# masked where the variable name looks secret (keys, passwords, tokens). For each container the
# report shows only its program and the number of its arguments, never the arguments.
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

show_command() {
  # Print "Command: <program> (<n> arguments, not shown)" for container $1. Entrypoint and Cmd
  # come from one inspect call, one JSON-encoded element per line and then "end", so a value
  # with line breaks stays one element and an incomplete answer is recognised. No argument is
  # printed, and the program only when its whole name is a plain path.
  local out line program
  local -a argv=()
  if ! out=$(docker inspect -f '{{range .Config.Entrypoint}}{{json .}}{{"\n"}}{{end}}{{range .Config.Cmd}}{{json .}}{{"\n"}}{{end}}end' "$1" 2>/dev/null) ||
    [ "${out##*$'\n'}" != end ]; then
    echo "Command: (not available)"
    return
  fi
  while IFS= read -r line; do
    argv+=("$line")
  done <<<"$out"
  unset "argv[$((${#argv[@]} - 1))]"
  if [ ${#argv[@]} -eq 0 ]; then
    echo "Command: (none)"
    return
  fi
  if [[ "${argv[0]}" =~ ^\"[A-Za-z0-9_./][A-Za-z0-9_./-]*\"$ ]]; then
    program="${argv[0]:1:${#argv[0]}-2}"
  else
    program="(name not shown)"
  fi
  case $((${#argv[@]} - 1)) in
    0) echo "Command: $program" ;;
    1) echo "Command: $program (1 argument, not shown)" ;;
    *) echo "Command: $program ($((${#argv[@]} - 1)) arguments, not shown)" ;;
  esac
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
Networks: {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}
Compose project: {{index .Config.Labels "com.docker.compose.project"}}
Compose file: {{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c"
    show_command "$c"

    echo "Mounts:"
    docker inspect -f '{{range .Mounts}}  {{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$c"

    echo "Environment (filtered; values masked where the name looks secret):"
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
echo "Review it before sharing. Values are masked only where the variable name looks secret, and URLs and hostnames are included."
