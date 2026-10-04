# Client Rollback Procedures

This document covers rolling back what runs on a developer workstation: the installed Resin client (CLI, daemon and gateway) and the learned tools it serves. Rolling back the hosted Resin cloud is an operator procedure and is not part of the public client.

---

## 1. Learned Tool Rollback

Learned tools are managed through the `manage_tools` meta-tool, which every connected harness can call (see [Meta-Tools](../user/meta-tools.md#4-manage_tools)):

- `list_versions` shows a tool's versions.
- `rollback` with a `version` activates that earlier version.
- `pin` / `unpin` keeps a tool on one version.
- `disable` / `enable` stops or resumes serving a tool.

A tool the cloud revokes or removes from the catalog stops being served after the next catalog sync.

---

## 2. Client Binary Rollback

Every upgrade is staged, activated, and then health-checked. If the health gate fails, the previous version is reactivated automatically unless `--no-rollback` was given.

### Roll back to the previous version

The client records the previous known-good version when it activates a new one:

```bash
resin upgrade --rollback
```

### Install an exact signed version

```bash
resin upgrade --target-version <version> --force
```

`--target-version` succeeds only when the signed release channel resolves to that exact version; the client never installs an unsigned or unlisted build.

### Roll back a failed install

```bash
npx resin init --rollback-install
```

This restores the previous installation from the saved install journal. See [Doctor & Repair](../user/doctor-and-repair.md) for diagnosing an install before rolling it back.

---

## Related Documentation

- [Getting Started Guide](../user/getting-started.md)
- [Troubleshooting Guide](../user/troubleshooting.md)
- [Doctor & Repair Guide](../user/doctor-and-repair.md)
- [ADR 0007: Capability Envelope and Security](../adr/0007-capability-envelope-and-security.md)
- [Compatibility Matrix](compatibility-matrix.md)
- [Release Signing Trust](signing-trust.md)
