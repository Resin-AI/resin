# Resin

Resin turns repeated coding-agent workflows into reusable tools. It works with Claude Code, Codex CLI, and Oh My Pi through a local MCP gateway.

## Features

- Turns recurring coding-agent workflows into qualified tools
- Runs tools with filesystem, network, command, and secret limits
- Pins tool versions and SHA-256 digests in `.resin/resin.lock`
- Keeps raw prompts, transcripts, and source code on the local machine
- Continues serving locked tools while offline

## Install

Resin requires Node.js 22 or newer and supports Linux, macOS, and WSL2 on x64 and arm64.

### Linux, macOS, and WSL2

```sh
curl -fsSL https://resin.sh/install.sh | sh
```

### PowerShell

```powershell
irm https://resin.sh/install.ps1 | iex
```
The installer prompts for device authorization, configures detected coding agents, starts the local service, and verifies the installation.

## Quick start

Check the local service and gateway:

```sh
resin status
```

Resin detects the current project when a supported coding agent starts. It creates two files in the project root:

```text
.resin/
├── project.json   # Project identity
└── resin.lock     # Pinned tool versions and digests
```

Ask your coding agent to search for a tool:

```text
Search for tools that can inspect this repository's structure.
```

## How it works

1. Resin observes supported coding-agent sessions locally.
2. Repeated workflows become candidates for reusable tools.
3. Candidates are qualified and versioned before activation.
4. The local MCP gateway makes active tools available to coding agents.
5. Each tool runs within its declared capability limits.

## Documentation

- [Getting Started](docs/user/getting-started.md)
- [Configuration](docs/user/configuration.md)
- [Coding Agent Integrations](docs/user/harness-guide.md)
- [Security and Privacy](docs/user/security-and-privacy.md)
- [Troubleshooting](docs/user/troubleshooting.md)
- [Architecture](docs/architecture/overview.md)

## Contributing

Resin uses Node.js 22+, pnpm 10+, and a pnpm workspace.

```sh
git clone https://github.com/Resin-AI/resin.git
cd resin
pnpm install --frozen-lockfile
```

Run the full verification suite before opening a pull request:

```sh
pnpm check:all
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, package boundaries, and pull request requirements.

## Repository layout

```text
apps/       CLI, gateway, observer, and web applications
packages/   Runtime, protocol, contracts, crypto, and shared libraries
adapters/   Claude Code, Codex CLI, and Oh My Pi integrations
fixtures/   Conformance and end-to-end fixtures
docs/       User, architecture, security, and operations documentation
scripts/    Build, verification, release, and repository tooling
```

## Security

Report vulnerabilities using the process in [Security Vulnerability Reporting](docs/security/vulnerability-reporting.md).
