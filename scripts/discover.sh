#!/usr/bin/env bash

set -u
set +x

OUTPUT="${1:-./n8n-discovery-$(date +%Y%m%d_%H%M%S).txt}"
ENV_PATTERN='^(N8N_|DB_|QUEUE_|EXECUTIONS_|WEBHOOK_URL|GENERIC_TIMEZONE|TZ=|NODE_ENV|POSTGRES_|REDIS_)'
SECRET_PATTERN='(PASSWORD|PASS|SECRET|TOKEN|KEY|LICENSE)'

section() {
  printf '\n===== %s =====\n' "$1"
}

mask_env() {
  local line name rest
  while IFS= read -r line; do
    name="${line%%=*}"
    if [[ "$name" =~ $SECRET_PATTERN ]]; then
      if [ -n "${line#*=}" ]; then
        printf '%s=*** (set)\n' "$name"
      else
        printf '%s= (empty)\n' "$name"
      fi
      continue
    fi
    if [[ "$line" == *:*@* ]]; then
      rest="${line#*:}"
      line="${line%%:*}:${rest%%[!/]*}***@${rest##*@}"
    fi
    printf '%s\n' "$line"
  done
}

show_env() {
  local out
  if ! out=$(docker inspect -f '{{range .Config.Env}}{{json .}}{{"\n"}}{{end}}' "$1" 2>/dev/null); then
    echo "  (not available)"
    return
  fi
  printf '%s\n' "$out" | sed -n 's/^"\(.*\)"$/\1/p' | grep -E "$ENV_PATTERN" | sort | mask_env | sed 's/^/  /'
}

show_command() {
  local out line program
  local -a argv=()
  if ! out=$(docker inspect -f '{{range .Config.Entrypoint}}{{json .}}{{"\n"}}{{end}}{{range .Config.Cmd}}{{json .}}{{"\n"}}{{end}}' "$1" 2>/dev/null); then
    echo "Command: (not available)"
    return
  fi
  while IFS= read -r line; do
    [ -z "$line" ] || argv+=("$line")
  done <<<"$out"
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

    echo "Environment (filtered; values masked where the name looks secret, URL users and passwords masked):"
    show_env "$c"

    if [[ "$image" =~ n8n ]] && [ "$(docker inspect -f '{{.State.Running}}' "$c")" = "true" ]; then
      echo "n8n version: $(docker exec "$c" n8n --version 2>&1 | tail -1)"
    fi
  done

  section "Networks"
  docker network ls
} >"$OUTPUT" 2>&1

echo "Discovery report written to: $OUTPUT"
echo "Review it before sharing. Environment values are masked where the variable name looks secret, and the user and password of URLs are masked; hostnames and other values are included."
