# ADR 0007: Capability Envelope and Security Broker Architecture

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Application Security, Infrastructure Security, Runtime Engineering

## Context and Problem Statement

Autonomously evolved tools execute generated code on a developer's workstation. If a generated tool possessed unrestricted operating system privileges, a subtle prompt injection, flawed synthesis prompt, or malicious tool candidate could read sensitive private SSH keys, modify arbitrary system files, exfiltrate repository data, or spawn unauthorized shell subprocesses.

Relying solely on post-hoc manual review breaks the zero-approval autonomy model. Conversely, relying on coarse binary permissions (e.g., "allow all network access" or "allow all file access") is too permissive.

We must establish a fine-grained, pre-authorized security architecture centered on a **Capability Envelope** enforced by dedicated **Capability Brokers**.

## Decision Drivers

- **Least Privilege Enforcement**: Tools only receive the exact, minimal OS permissions needed to fulfill their declared tool specification.
- **Autonomous Safety**: Tools operating within the workspace's pre-authorized envelope can deploy autonomously without manual security prompts.
- **Deterministic Containment**: Violations must be intercepted at the capability broker layer before any unauthorized syscall or I/O occurs.
- **Tamper-Evident Auditing**: Every capability request, grant, and denial must be logged cryptographically for retroactive review.

## Considered Options

1. **Option 1: Ambient OS Permissions (Unrestricted Tool Execution)**
   - *Pros*: Maximum developer convenience; no permission configuration.
   - *Cons*: Catastrophic security vulnerability; generated code could destroy or exfiltrate local data.

2. **Option 2: Interactive Prompt on Every Privileged Syscall**
   - *Pros*: Full user awareness of every action.
   - *Cons*: Extreme modal fatigue; impossible for automated background canary runs; unusable developer experience.

3. **Option 3: Pre-Authorized Capability Envelope with Dedicated Runtime Brokers (Selected)**
   - *Pros*: Developers define security boundaries once per workspace/project; generated tools are statically and dynamically verified against the envelope; capability brokers mediate all I/O via Deno sandbox permissions and IPC mediation; zero prompts within envelope; immediate quarantine on breach.
   - *Cons*: Requires building and maintaining dedicated capability brokers for Filesystem, Network, and Command execution.

## Decision

We decide to implement the **Capability Envelope and Broker Architecture**:

### 1. The Workspace Capability Envelope

A **Capability Envelope** is a declaratively defined security policy (stored in `.resin/envelope.json` or managed via CLI) associated with a workspace. It defines the maximum allowable capability bounds:

```json
{
  "workspace": "/path/to/project",
  "filesystem": {
    "read": ["<WORKSPACE_ROOT>/**"],
    "write": ["<WORKSPACE_ROOT>/src/**", "<WORKSPACE_ROOT>/dist/**"],
    "deny": ["<WORKSPACE_ROOT>/.git/**", "<WORKSPACE_ROOT>/.env*"]
  },
  "network": {
    "allowedDomains": ["api.github.com", "registry.npmjs.org"],
    "allowLocalhost": false,
    "denyPorts": [22, 25, 3306, 5432]
  },
  "process": {
    "allowedCommands": ["git", "pnpm", "node", "cargo"],
    "denyShellSpawn": true,
    "maxSubprocesses": 2
  },
  "limits": {
    "timeoutMs": 30000,
    "maxMemoryMb": 64
  }
}
```

### 2. Runtime Capability Brokers

Tool execution inside the Deno sandbox cannot issue raw syscalls directly. Instead, all privileged I/O is mediated by specialized runtime brokers:

1. **Filesystem Broker (`FsBroker`)**:
   - Validates all target paths against canonicalized allow/deny path lists.
   - Resolves symlinks before evaluation to prevent symlink traversal attacks.
   - Explicitly denies access to sensitive paths (`~/.ssh`, `~/.aws`, `.env`, `.git/hooks`).

2. **Network Broker (`NetBroker`)**:
   - Enforces domain whitelisting, IP CIDR boundaries, and port restrictions.
   - Intercepts Deno `fetch` and socket requests, verifying host headers and preventing SSRF attacks against local loopback ports (unless explicitly permitted).

3. **Command / Subprocess Broker (`CommandBroker`)**:
   - Rejects arbitrary subshell execution (`/bin/sh -c`, `bash -c`, `cmd.exe`).
   - Validates executable paths against an allowed binary whitelist.
   - Sanitizes and enforces argument vectors to prevent command injection.

### 3. Breach Handling and Automatic Quarantine

- If a candidate tool requests capabilities outside the workspace envelope during synthesis or execution, the invocation is immediately aborted with a `CapabilityViolationException`.
- The offending tool candidate is instantly flagged as `quarantined` in the local registry, its canary traffic is set to 0%, and an audit alert is logged.

```
+---------------------------------------------------------------+
| Execution Sandbox (Deno Worker)                              |
|                                                               |
|  [Tool Logic: e.g., read workspace file]                     |
|           |                                                   |
|           v                                                   |
|  [Deno Restricted API Layer]                                  |
+-----------+---------------------------------------------------+
            | (IPC Request: Read "/project/src/index.ts")
            v
+---------------------------------------------------------------+
| Capability Broker Engine (Control Plane)                      |
|                                                               |
|  +----------------------------------------------------------+ |
|  | Capability Envelope Validator                            | |
|  | - Is path within WORKSPACE_ROOT? -> YES                  | |
|  | - Is path in deny list (.git, .env)? -> NO               | |
|  | - Symlink traversal check? -> PASSED                     | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|            +-----------------+-----------------+              |
|            | (Authorized)                      | (Violation)  |
|            v                                   v              |
|  +-------------------+               +----------------------+ |
|  | Execute I/O &     |               | REJECT, QUARANTINE,  | |
|  | Return File Data  |               | & RECORD AUDIT EVENT | |
|  +-------------------+               +----------------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Autonomous tool execution is safe by construction.
- Developers set high-level boundary policies once without being spammed with approval dialogues.
- Fine-grained mediation prevents supply chain and prompt-injection attacks.
- Provides complete tamper-evident audit trails for security and compliance teams.

### Negative / Trade-offs
- Tools requiring legitimate new capabilities outside the envelope require a one-time developer command to expand the workspace envelope.

### Mitigations
- Provide clear, actionable CLI notifications when an envelope expansion is required (`resin envelope expand --add-domain api.service.com`).

## Compliance and Verification

- Unit and penetration tests in `@resin/runtime` attempt unauthorized file reads, path escapes (`../../etc/passwd`), network calls to forbidden IPs, and shell injections to verify 100% rejection.
- Monorepo boundary rules prevent Deno workers from accessing unbrokered host APIs.
