# Platform & Harness Support Policy

This document defines the official support tiers, operating system matrix, harness compatibility guarantees, and version lifecycle policies for Resin.

---

## 1. Supported Operating System Matrix

| Tier | Operating System | Architecture | Minimum Version | Support Level |
|------|------------------|--------------|-----------------|---------------|
| **Tier 1** | Linux (Ubuntu, Debian, Fedora, Arch) | `x86_64`, `arm64` | Kernel 5.4+ (glibc >= 2.31) | Full Support & Automated CI Qualification |
| **Tier 1** | macOS (Apple Silicon & Intel) | `arm64`, `x86_64` | macOS 12 Monterey+ | Full Support & Automated CI Qualification |
| **Tier 1** | Windows Subsystem for Linux (WSL2) | `x86_64`, `arm64` | WSL2 (Ubuntu 22.04+) | Full Support & Automated CI Qualification |
| **Tier 2** | Windows Native (`win32`) | `x86_64` | Windows 11 | Community / Best Effort (WSL2 recommended) |

---

## 2. Supported AI Coding Harnesses

| Harness | Vendor / Runtime | Protocol | Supported Versions | Qualified Qualification Profile |
|---------|------------------|----------|--------------------|---------------------------------|
| **Claude Code CLI** | Anthropic | MCP (SSE & Stdio) | `>= 0.1.0` | `0.2.29`, `1.0.0` |
| **Codex CLI** | OpenAI | MCP (SSE) | `>= 0.1.0` | `0.1.0`, `0.2.0` |
| **Oh My Pi (OMP)** | Canary Laboratories | MCP (SSE & IPC) | `>= 0.1.0` | `0.1.0`, `0.2.0` |

---

## 3. Node.js & Runtime Dependencies

| Runtime Engine | Minimum Version | Recommended Version | Lifecycle Status |
|----------------|-----------------|---------------------|------------------|
| **Node.js** | `>= 22.0.0` | `24.x LTS` | Active Support |
| **pnpm** | `>= 10.0.0` | `10.24.x` | Active Support |
| **Deno** (Optional Worker) | `>= 2.0.0` | `2.1.x` | Supported Sandbox |

---

## 4. Release Support & Maintenance Tiers

| Release Line | Status | Release Target | Maintenance Window | Security Fixes |
|--------------|--------|----------------|--------------------|----------------|
| **v1.x (Current)** | **Active / Stable** | Current release | 12 Months from release | 24 Months from release |
| **v0.1.x (Pre-release)** | Deprecated | Pre-release | Retired | Discontinued |

---

## 5. Deprecation & Breaking Change Policy

1. **Semantic Versioning**: Resin adheres to [SemVer 2.0.0](https://semver.org/).
2. **Deprecation Notice**: Any deprecated API, protocol feature, or configuration option will be flagged with a warning for at least one minor release cycle before removal.
3. **Backward Compatibility**: Tool manifests and capability envelopes retain backward compatibility across major versions via automated schema migrations.

---

## 6. Support & Security Inquiries

For technical support, privacy data requests, or security issues:
- **Support & Inquiries**: `hello@resin.sh`
- **Security Disclosures**: `hello@resin.sh` (or submit via secure channels described in the [Vulnerability Reporting Guide](vulnerability-reporting.md))

---

## Related Documentation

- [Privacy Inventory](privacy-inventory.md)
- [Security Threat Model](threat-model.md)
- [Vulnerability Reporting](vulnerability-reporting.md)
- [Compatibility Matrix (Release)](../release/compatibility-matrix.md)
