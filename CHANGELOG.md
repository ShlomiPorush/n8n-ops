# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Sign-in with username, password and mandatory TOTP (Better Auth); first-run setup wizard (account, two-factor, backup key pair, Telegram, storage); `reset-password` command in the server container.
- Application shell (sidebar layout), settings with per-instance defaults, encryption keys, API and MCP tokens, audit log.
- Project foundation: pnpm workspace with `server`, `web`, `worker` and `shared`, container images, development stack, workflow scripts, CI and Dependabot.
