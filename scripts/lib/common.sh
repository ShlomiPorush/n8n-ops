# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

TOOLCHAIN_IMAGE="n8n-ops-toolchain:local"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/n8n-ops"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not available. Run this inside WSL with Docker running."
  docker info >/dev/null 2>&1 || die "docker is installed but not reachable. Start Docker and try again."
}

build_toolchain() {
  require_docker
  docker build --quiet -f "$REPO_ROOT/docker/toolchain.Dockerfile" -t "$TOOLCHAIN_IMAGE" "$REPO_ROOT/docker" >/dev/null ||
    die "building the toolchain image failed"
}

in_toolchain() {
  mkdir -p "$CACHE_DIR/pnpm-store"
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/repo" \
    -v "$CACHE_DIR/pnpm-store:/pnpm-store" \
    -e npm_config_store_dir=/pnpm-store \
    -e CI="${CI:-}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLCHAIN_EXTRA_ARGS[@]}" \
    "$TOOLCHAIN_IMAGE" bash -c "$*"
}
TOOLCHAIN_EXTRA_ARGS=()

install_deps() {
  in_toolchain "pnpm install --frozen-lockfile --reporter=append-only"
}

build_images() {
  local tag="$1"
  require_docker
  local app
  for app in server worker; do
    info "Building n8n-ops-$app:$tag"
    docker build -f "$REPO_ROOT/docker/$app.Dockerfile" -t "n8n-ops-$app:$tag" "$REPO_ROOT" ||
      die "building n8n-ops-$app:$tag failed"
  done
}

declare -gA PULL_PIDS=()

start_pulls() {
  local image
  for image in "$@"; do
    [ -z "${PULL_PIDS[$image]:-}" ] || continue
    docker image inspect "$image" >/dev/null 2>&1 && continue
    docker pull --quiet "$image" >/dev/null 2>&1 &
    PULL_PIDS[$image]=$!
  done
}

wait_for_pulls() {
  local image pid
  for image in "$@"; do
    pid="${PULL_PIDS[$image]:-}"
    [ -n "$pid" ] || continue
    wait "$pid" || docker pull --quiet "$image" || { sleep 5 && docker pull --quiet "$image"; } ||
      die "could not pull $image"
    unset 'PULL_PIDS[$image]'
  done
}

check_non_root() {
  local project="$1" service cid uids try
  shift
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    for try in 1 2 3 4 5; do
      uids="$(docker top "$cid" -o pid,uid | awk 'NR > 1 { print $2 }' | sort -u | tr '\n' ' ')"
      grep -qw 0 <<<"$uids" || break
      [ "$try" = 5 ] && die "service $service runs a process as root (UIDs: $uids)"
      sleep 1
    done
    echo "    $service runs as UID ${uids% }"
  done
}

check_socket_proxy() {
  local project="$1" cid
  cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=socket-proxy")"
  [ -n "$cid" ] || die "service socket-proxy is not running"
  [ "$(docker inspect -f '{{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}}' "$cid")" = '["ALL"] null' ] ||
    die "socket-proxy holds capabilities"
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || die "socket-proxy has a writable file system"
  docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$cid" | grep -qxE 'no-new-privileges(:true)?' ||
    die "socket-proxy may gain new privileges"
  [ -z "$(docker port "$cid")" ] || die "socket-proxy publishes a port"
  echo "    socket-proxy holds no capabilities, read-only, no new privileges, no published port"
}

check_socket_proxy_config() {
  local project="$1" file cid want got
  shift
  local files=()
  for file in "$@"; do
    files+=(-f "$file")
  done
  cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=socket-proxy")" ||
    return 1
  if [ -z "$cid" ] || [ "$(wc -l <<<"$cid")" != 1 ]; then
    echo "$project does not run exactly one socket-proxy" >&2
    return 1
  fi
  want="$(N8N_OPS_DATA_DIR=/unused N8N_OPS_ENV_DIR=/unused docker compose -p "$project" --project-directory "$REPO_ROOT" \
    "${files[@]}" config --hash socket-proxy | awk '$1 == "socket-proxy" { print $2 }')" || return 1
  got="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$cid")" || return 1
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "the socket-proxy of $project was not made from $*" >&2
    return 1
  fi
}

remove_data_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  build_toolchain
  docker run --rm --user 0 -v "$dir:/target" "$TOOLCHAIN_IMAGE" bash -c 'shopt -s dotglob; rm -rf /target/*' ||
    die "could not empty $dir"
  rmdir "$dir"
}

SECRET_PLACEHOLDERS='^(|replace-with.*|change-?me.*|example.*|placeholder.*|password|secret|postgres|n8n_ops|test)$'

random_secret() {
  local value
  if command -v openssl >/dev/null 2>&1; then
    value="$(openssl rand -hex 32)"
  else
    value="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  fi
  [ ${#value} -eq 64 ] || die "could not generate a random secret"
  printf '%s' "$value"
}

require_owner_only() {
  local path="$1" mode="$2"
  [ "$(stat -c %u "$path")" = "$(id -u)" ] || die "$path is not yours; secrets must be readable by their owner only"
  [ "$(stat -c %a "$path")" = "$mode" ] ||
    die "$path has mode $(stat -c %a "$path"), not $mode. Its file system does not keep owner-only permissions (for example /mnt/c); keep the data directory on the Linux file system."
}

prepare_env_dir() {
  local dir="$1" probe
  (umask 077 && mkdir -p "$dir") || die "could not create $dir"
  chmod 0700 "$dir" || die "could not make $dir owner-only"
  require_owner_only "$dir" 700
  probe="$(mktemp "$dir/.probe.XXXXXX")" || die "could not write in $dir"
  chmod 0600 "$probe"
  require_owner_only "$probe" 600
  rm -f "$probe"
}

env_value() {
  sed -n "s/^$2=//p" "$1" | head -n 1
}

publish_env_file() {
  local dir="$1" name="$2" content="$3" tmp
  [ -e "$dir/$name" ] && return 0
  tmp="$(mktemp "$dir/.$name.XXXXXX")" || die "could not write in $dir"
  chmod 0600 "$tmp"
  printf '%s\n' "$content" >"$tmp"
  ln "$tmp" "$dir/$name" 2>/dev/null || true
  rm -f "$tmp"
  [ -f "$dir/$name" ] || die "could not write $dir/$name"
}

fill_env_example() {
  local name="$1" line key given found
  shift
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Z0-9_]+)=$ ]]; then
      key="${BASH_REMATCH[1]}"
      found=""
      for given in "$@"; do
        [ "${given%%=*}" = "$key" ] && found="${given#*=}"
      done
      [ -n "$found" ] || die "docker/env/$name.env.example leaves $key empty and nothing fills it"
      line="$key=$found"
    fi
    printf '%s\n' "$line"
  done <"$REPO_ROOT/docker/env/$name.env.example"
}

STACK_ENV_FILES=(postgres server worker n8n s3)

write_stack_env() {
  local dir="$1" password user db key content
  prepare_env_dir "$dir"
  if [ -f "$dir/postgres.env" ]; then
    password="$(env_value "$dir/postgres.env" POSTGRES_PASSWORD)"
  else
    password="$(random_secret)" || exit 1
  fi
  content="$(fill_env_example postgres "POSTGRES_PASSWORD=$password")" || exit 1
  publish_env_file "$dir" postgres.env "$content"
  user="$(env_value "$dir/postgres.env" POSTGRES_USER)"
  db="$(env_value "$dir/postgres.env" POSTGRES_DB)"
  content="$(fill_env_example server "DATABASE_URL=postgres://$user:$password@postgres:5432/$db")" || exit 1
  publish_env_file "$dir" server.env "$content"
  content="$(fill_env_example worker)" || exit 1
  publish_env_file "$dir" worker.env "$content"
  key="$(random_secret)" || exit 1
  content="$(fill_env_example n8n "N8N_ENCRYPTION_KEY=$key")" || exit 1
  publish_env_file "$dir" n8n.env "$content"
  content="$(fill_env_example s3)" || exit 1
  publish_env_file "$dir" s3.env "$content"
}

require_secret() {
  local what="$1" value="$2"
  [ -n "$value" ] || die "$what is missing"
  grep -qiE "$SECRET_PLACEHOLDERS" <<<"$value" && die "$what is a placeholder, not a secret"
  [ ${#value} -ge 32 ] || die "$what is shorter than a generated secret (32 characters)"
  return 0
}

check_stack_env() {
  local dir="$1" name password url
  require_owner_only "$dir" 700
  for name in "${STACK_ENV_FILES[@]}"; do
    [ -f "$dir/$name.env" ] || die "$dir/$name.env is missing"
    require_owner_only "$dir/$name.env" 600
  done
  password="$(env_value "$dir/postgres.env" POSTGRES_PASSWORD)"
  require_secret "POSTGRES_PASSWORD in $dir/postgres.env" "$password"
  require_secret "N8N_ENCRYPTION_KEY in $dir/n8n.env" "$(env_value "$dir/n8n.env" N8N_ENCRYPTION_KEY)"
  url="$(env_value "$dir/server.env" DATABASE_URL)"
  [[ "$url" == *":$password@"* ]] || die "DATABASE_URL in $dir/server.env does not hold the password in $dir/postgres.env"
}

DEV_PROJECT="n8n-ops-dev"
DEV_COMPOSE_FILE="$REPO_ROOT/docker-compose-dev.yml"
DEV_DEFAULT_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/n8n-ops-dev"

dev_data_dir() {
  printf '%s' "${N8N_OPS_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
}

dev_compose() {
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing. Create it with:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  local data
  data="$(dev_data_dir)"
  N8N_OPS_DATA_DIR="$data" N8N_OPS_ENV_DIR="$data/env" N8N_OPS_IMAGE_TAG=dev \
    docker compose -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}

require_dev_secrets() {
  local data env name complete=1
  data="$(dev_data_dir)"
  env="$data/env"
  for name in "${STACK_ENV_FILES[@]}"; do
    [ -f "$env/$name.env" ] || complete=0
  done
  if [ $complete -eq 0 ] && [ -n "$(ls -A "$data/postgres" 2>/dev/null)" ]; then
    die "the secrets in $env are missing, but the database in $data/postgres is kept; new secrets would not open it.
Put $env back, or start over with scripts/local.sh nuke (deletes the development data)."
  fi
  write_stack_env "$env"
  check_stack_env "$env"
  make_mail_tls "$data"
}

make_mail_tls() {
  local data="$1" dir="$1/mail-tls" tmp
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    check_mail_tls "$dir"
    return
  fi
  tmp="$(mktemp -d "$data/.mail-tls.XXXXXX")" || die "could not make a folder for the mail certificate in $data"
  require_owner_only "$tmp" 700
  build_toolchain
  if ! (TOOLCHAIN_EXTRA_ARGS=(-v "$tmp:/tls") && in_toolchain "openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj /CN=mail -addext subjectAltName=DNS:mail -keyout /tls/key.pem -out /tls/cert.pem 2>/dev/null") ||
    ! chmod 0600 "$tmp/key.pem" || ! chmod 0644 "$tmp/cert.pem" || [ ! -s "$tmp/key.pem" ] || [ ! -s "$tmp/cert.pem" ]; then
    rm -rf "$tmp"
    die "could not make the mail server's certificate"
  fi
  require_owner_only "$tmp/key.pem" 600
  if ! mv -T "$tmp" "$dir" 2>/dev/null; then
    rm -rf "$tmp"
    if [ ! -s "$dir/cert.pem" ] || [ ! -s "$dir/key.pem" ]; then
      die "could not put the mail server's certificate in $dir"
    fi
  fi
  check_mail_tls "$dir"
}

check_mail_tls() {
  local dir="$1"
  if [ ! -s "$dir/cert.pem" ] || [ ! -s "$dir/key.pem" ]; then
    die "$dir does not hold a complete mail certificate (cert.pem and key.pem). Remove the folder; the next start makes a new one."
  fi
  require_owner_only "$dir" 700
  require_owner_only "$dir/key.pem" 600
}

prepare_data_dirs() {
  local dir="$1"
  mkdir -p "$dir/server" "$dir/postgres" "$dir/worker" "$dir/pairing" "$dir/backups"
}
