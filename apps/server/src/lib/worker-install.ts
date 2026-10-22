/**
 * The docker-compose.yml that installs a worker on an n8n Docker host: saved in an empty folder and started with
 * "docker compose up -d", nothing else. The server URL and the one-time pairing token are written in it; after
 * pairing, the worker keeps its identity in ./data. The worker image hands ./data to its user and, without the
 * proxy, joins the Docker socket's group by itself (docker/worker-entrypoint.sh), so no value is filled in by hand.
 *
 * With the socket proxy, only wollomatic/socket-proxy mounts the Docker socket. The worker reaches it over an
 * internal network, and the proxy allows exactly the calls the worker makes: ping, and exec in the listed n8n
 * containers. Without it, the worker mounts the socket itself (full Docker access).
 */

export const SOCKET_PROXY_IMAGE = "wollomatic/socket-proxy:1.13.1"
export const WORKER_IMAGE = "ghcr.io/shlomiporush/n8n-ops-worker"

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

/** The worker image tag for this server: its own release, or latest for a development build. */
export function workerTag(serverVersion: string): string {
  return /^\d+\.\d+\.\d+$/.test(serverVersion) ? serverVersion : "latest"
}

/** A value Compose takes literally: a YAML double-quoted string, with $ doubled so it is not interpolated. */
function literal(value: string): string {
  return JSON.stringify(value.replaceAll("$", "$$$$"))
}

export function workerInstall(options: {
  serverUrl: string
  token: string
  socketProxy: boolean
  containers: string[]
  serverVersion: string
}): { compose: string } {
  const { serverUrl, token, socketProxy, containers, serverVersion } = options
  const worker = [
    "  worker:",
    `    image: ${WORKER_IMAGE}:${workerTag(serverVersion)}`,
    "    restart: unless-stopped",
    "    environment:",
    `      N8N_OPS_SERVER_URL: ${literal(serverUrl)}`,
    `      PAIRING_TOKEN: ${literal(token)}`,
    ...(socketProxy ? ["      DOCKER_HOST: tcp://socket-proxy:2375"] : []),
    "    # Starts as root only to hand ./data to the worker's user and join the Docker socket's group, then",
    "    # runs as that user with no capability left.",
    "    security_opt: [no-new-privileges:true]",
    "    cap_drop: [ALL]",
    "    cap_add: [CHOWN, DAC_READ_SEARCH, SETUID, SETGID]",
    ...(socketProxy
      ? [
          "    depends_on:",
          "      socket-proxy:",
          "        condition: service_healthy",
          "    networks: [default, docker-proxy]",
          "    volumes:",
          "      - ./data:/data",
        ]
      : ["    volumes:", "      - /var/run/docker.sock:/var/run/docker.sock", "      - ./data:/data"]),
  ]
  const rules = proxyRules(containers)
  const proxy = [
    "  # Only the proxy sees the Docker socket. It allows ping and exec in the n8n containers listed below;",
    "  # to allow another container, add it to -allowPOST and run: docker compose up -d",
    "  socket-proxy:",
    `    image: ${SOCKET_PROXY_IMAGE}`,
    "    restart: unless-stopped",
    "    # Root only to open the Docker socket, which belongs to root: no capabilities, a read-only file",
    "    # system, and reachable only by the worker on an internal network.",
    '    user: "0:0"',
    "    read_only: true",
    "    mem_limit: 64M",
    "    cap_drop: [ALL]",
    "    security_opt: [no-new-privileges:true]",
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
    "# n8n-ops worker. In an empty folder on the n8n host, save this as docker-compose.yml and run:",
    "#   docker compose up -d",
    "# The pairing token works once; after pairing, the worker keeps its identity in ./data.",
    "services:",
    ...worker,
    ...(socketProxy ? ["", ...proxy, "", "networks:", "  docker-proxy:", "    internal: true"] : []),
    "",
  ].join("\n")
  return { compose }
}
