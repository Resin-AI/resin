# Security Threat Model (V1)

This document presents the comprehensive Threat Model for the Resin V1 platform, analyzing trust boundaries, potential adversaries, attack surfaces, and runtime mitigations.

---

## 1. Trust Boundaries & Architecture

```text
  ┌────────────────────────────────────────────────────────┐
  │                   Host Machine                         │
  │                                                        │
  │  [ AI Coding Harness ]  (Claude / Codex / OMP)          │
  │             ▲                                          │
  │             │ (Trust Boundary 1: MCP Loopback SSE)     │
  │             ▼                                          │
  │  [ Resin Daemon & Gateway ]                     │
  │             ▲                                          │
  │             │ (Trust Boundary 2: Subprocess Sandbox)   │
  │             ▼                                          │
  │  [ Sandboxed Worker Runtime ] (Deno / Node Worker)     │
  │             ▲                                          │
  │             │ (Trust Boundary 3: TLS 1.3 / mTLS)       │
  │             ▼                                          │
  │  [ Resin Cloud API ]                            │
  └────────────────────────────────────────────────────────┘
```

---

## 2. Threat Actor Profiles

1. **Malicious Tool Candidate Generator**: An adversary attempting to inject malicious code via prompt injection into the AI coding session, causing synthesis of a backdoored tool.
2. **Untrusted Workspace Contributor**: A contributor submitting a repository containing malicious `.resin/` config files designed to escape sandbox boundaries.
3. **Network Attacker / Man-in-the-Middle**: An attacker attempting to intercept local loopback traffic or spoof cloud artifact downloads.
4. **Compromised Dependency / Supply Chain**: A malicious package in the npm or third-party dependency tree.

---

## 3. Threat Matrix & Mitigations

| Threat ID | Threat Description | Severity | Runtime Mitigations |
|-----------|--------------------|----------|---------------------|
| **THREAT-01** | **Sandbox Escape via Arbitrary Shell Execution** | Critical | Prohibit raw shell execution (`/bin/sh`, `execSync`). Subprocesses are spawned only via explicit parameter arrays with binary allowlisting. |
| **THREAT-02** | **Secret / Credential Theft** | Critical | Enforce strict file deny paths (`**/.ssh/**`, `**/.aws/**`, `**/.env*`). Secrets are mediated via env vars; direct disk reads are blocked. |
| **THREAT-03** | **Malicious Tool Distribution** | High | All tool bundles must be cryptographically signed with trusted Ed25519 keys. Unsigned or corrupted bundles are quarantined immediately. |
| **THREAT-04** | **Prompt Injection into Tool Synthesis** | High | Autonomous synthesis candidates undergo multi-stage static analysis, security vetting, and historical replay testing before canary evaluation. |
| **THREAT-05** | **Loopback Port Hijacking** | Medium | The Gateway binds strictly to `127.0.0.1`. Non-loopback interfaces are rejected. Authorization tokens guard API endpoints. |
| **THREAT-06** | **Denial of Service via Worker Exhaustion** | Medium | Hard caps on execution timeouts (30s default), memory limits (512MB), and worker pool concurrency (4 workers default). |

---

## 4. Adversarial Defenses

### A. Static Code & AST Inspection
Before any synthesized tool candidate is executed, an AST-based static analyzer inspects the TypeScript code for forbidden patterns:
- Dynamic evaluation (`eval()`, `new Function()`)
- Dynamic import of unapproved modules
- Access to forbidden Node.js built-in modules (`child_process`, `cluster`, `v8`)

### B. Quarantine & Rollback System
If a tool encounters unhandled security violations, permission errors, or abnormal error rates during canary execution, the runtime triggers an **Atomic Rollback** to the last known good version within milliseconds.

---

## Related Documentation

- [Privacy Inventory](privacy-inventory.md)
- [Vulnerability Reporting Policy](vulnerability-reporting.md)
- [Support Policy](support-policy.md)
- [User Security & Privacy Model](../user/security-and-privacy.md)
