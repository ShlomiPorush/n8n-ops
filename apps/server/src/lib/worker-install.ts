/**
 * The files and commands that install a worker on an n8n Docker host.
 *
 * With the socket proxy, only wollomatic/socket-proxy mounts the Docker socket. The worker reaches it over an
 * internal network, and the proxy allows exactly the calls the worker makes: ping, and exec in the listed n8n
 * containers. Without it, the worker mounts the socket itself (full Docker access).
 */

export const SOCKET_PROXY_IMAGE = "wollomatic/socket-proxy:1.13.1"
export const WORKER_DIR = "/srv/n8n-ops-worker"

/** A container name, or a pattern with * for names added later (for example n8n*). */
export const CONTAINER_PATTERN = /^[a-zA-Z0-9*][a-zA-Z0-9_.*-]*$/

/** Turns container names and * patterns into one regular expression alternative group. */
export function containerRegex(containers: string[]): string {
  const parts = containers.map((name) =>
    name
      .split("*")
      .map((piece) => piece.replace(/[.\\+?^${}()|[\]]/g, "\\$&"))
      .join("[^/]*"),
  )
  return `(${parts.join("|")})`
}

/** The proxy's allowlist. Paths may carry an API version prefix; the proxy anchors each pattern. */
export function proxyRules(containers: string[]) {
  const version = String.raw`(/v1\.[0-9]+)?`
  return {
    get: `${version}/(_ping|exec/[0-9a-f]+/json)`,
    post: `${version}/(containers/${containerRegex(containers)}/exec|exec/[0-9a-f]+/start)`,
  }
}

export type WorkerInstall = { compose: string; commands: string }

export function workerInstall(options: {
  serverUrl: string
  token: string
  socketProxy: boolean
  containers: string[]
}): WorkerInstall {
  const { serverUrl, token, socketProxy, containers } = options
  const worker = [
    "  worker:",
    "    image: ghcr.io/shlomiporush/n8n-ops-worker:latest",
    "    restart: unless-stopped",
    "    env_file: .env",
    ...(socketProxy
      ? [
          "    environment:",
          "      DOCKER_HOST: tcp://socket-proxy:2375",
          "    depends_on:",
          "      socket-proxy:",
          "        condition: service_healthy",
          "    networks: [default, docker-proxy]",
          "    volumes:",
          "      - ./data:/data",
        ]
      : [
          "    group_add:",
          '      - "${DOCKER_SOCKET_GID}"',
          "    volumes:",
          "      - /var/run/docker.sock:/var/run/docker.sock",
          "      - ./data:/data",
        ]),
  ]
  const rules = proxyRules(containers)
  const proxy = [
    "  # Only the proxy sees the Docker socket. It allows ping and exec in the n8n containers listed below;",
    "  # to allow another container, add it to -allowPOST and run: docker compose up -d",
    "  socket-proxy:",
    `    image: ${SOCKET_PROXY_IMAGE}`,
    "    restart: unless-stopped",
    '    user: "65534:${DOCKER_SOCKET_GID}"',
    "    read_only: true",
    "    mem_limit: 64M",
    "    cap_drop: [ALL]",
    "    security_opt: [no-new-privileges]",
    "    command:",
    "      - -listenip=0.0.0.0",
    "      - -allowfrom=worker",
    "      - -allowhealthcheck",
    `      - '-allowGET=${rules.get}'`,
    `      - '-allowPOST=${rules.post}'`,
    "    healthcheck:",
    '      test: ["CMD", "./healthcheck"]',
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 2",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
    "    networks: [docker-proxy]",
  ]
  const compose = [
    "services:",
    ...worker,
    ...(socketProxy ? ["", ...proxy, "", "networks:", "  docker-proxy:", "    internal: true"] : []),
    "",
  ].join("\n")
  const commands = [
    `mkdir -p ${WORKER_DIR}/data && chown 1000:1000 ${WORKER_DIR}/data && cd ${WORKER_DIR}`,
    "cat > .env <<EOF",
    `N8N_OPS_SERVER_URL=${serverUrl}`,
    `PAIRING_TOKEN=${token}`,
    "DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)",
    "EOF",
    "chmod 600 .env",
    "# Save the docker-compose.yml below in this directory, then:",
    "docker compose up -d",
  ].join("\n")
  return { compose, commands }
}
