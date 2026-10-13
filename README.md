# n8n-ops

An operations console for teams that run many self-hosted n8n instances: failure monitoring with low-noise alerts, an MCP and REST interface for AI agents, encrypted workflow and credential backups, and tools for consolidating instances.

## Status

**Early development. No product features yet.** The repository contains the project foundation: a server that reports its health, a placeholder UI page, a worker that reports its connection, container images, development and verification scripts, and CI.

- Product requirements: [docs/requirements.md](docs/requirements.md)
- What exists, what is planned, and how the repository works: [docs/project-foundation.md](docs/project-foundation.md)

## Development

Requirements: WSL (or Linux) with Docker. Node.js and pnpm are not needed on the host; the scripts run them in a container.

```bash
cp docker/docker-compose-dev.example.yml docker-compose-dev.yml   # once per machine
scripts/local.sh start     # build and start the development stack on http://localhost:8080
scripts/local.sh status    # containers, health, runtime users
scripts/local.sh down      # stop; data is kept
scripts/verify.sh          # everything CI checks
```

## Tools

- `scripts/discover.sh`: a read-only script that inventories an n8n Docker host (containers, images, n8n-related environment with secrets masked, mounts, networks, disk usage) and writes one report file. It changes nothing on the host. Review the report before sharing it; hostnames and URLs are included.

## License

[MIT](LICENSE)
