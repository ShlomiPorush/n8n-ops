import { proxyRules } from "@n8n-ops/shared"

export const SOCKET_PROXY_IMAGE = "wollomatic/socket-proxy:1.13.1"
export const WORKER_IMAGE = "ghcr.io/shlomiporush/n8n-ops-worker"

export { CONTAINER_PATTERN, proxyRules } from "@n8n-ops/shared"

export function workerTag(serverVersion: string): string {
  return /^\d+\.\d+\.\d+$/.test(serverVersion) ? serverVersion : "latest"
}

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
    ...(socketProxy
      ? [
          "    # Starts as root only to hand ./data to the worker's user, then runs as that user with no",
          "    # capability left.",
        ]
      : [
          "    # Starts as root only to hand ./data to the worker's user and join the Docker socket's group, then",
          "    # runs as that user with no capability left.",
        ]),
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
    "  # Only the proxy sees the Docker socket. It allows ping, listing containers (to find n8n queue workers)",
    "  # and exec in the n8n containers listed below;",
    "  # to allow another container, add its name to the (…|…) group in -allowPOST and run: docker compose up -d",
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
