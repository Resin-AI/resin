# Client & Cloud Rollback Procedures

This document provides definitive, executable instructions for executing rollbacks across the local tool catalog, client CLI binaries, and AWS Serverless cloud infrastructure.

---

## 1. Local Tool-Level Rollback

If a specific evolved tool version behaves incorrectly, fails contract tests, or causes regressions within a local workspace:

### Instant Tool Rollback via CLI

```bash
# Roll back a specific tool to its prior stable promoted version
resin repair --rollback-tool git_branch_cleaner
```

### Tool Version Pinning

To prevent autonomous background updates or canaries for a specific tool:

```bash
# Pin tool to an explicit version in workspace configuration
resin config set tools.git_branch_cleaner.pinnedVersion "1.2.0"
```

---

## 2. Client Binary Rollback & Downgrade

If an upgraded CLI or daemon version causes operational regressions on developer workstations:

### Atomic Upgrade Rollback

The CLI preserves backup snapshots of the previous binary in `~/.resin/state/backups/`:

```bash
# Roll back to the previous installed version snapshot
resin upgrade --rollback
```

### Target Version Downgrade

```bash
# Force downgrade to an explicit release version
resin upgrade --target-version 0.1.0 --force
```

---

## 3. Cloud Infrastructure & Serverless Rollback Procedures

Resin's cloud platform runs on AWS Serverless infrastructure (AWS SAM / CloudFormation). Rollbacks do not require container orchestrator manipulations or destructive database reversals.

### A. Automated In-Flight Deployment Rollback

AWS CloudFormation automatically initiates a stack rollback if any resource fails to create, update, or pass health gates during deployment (`fail_on_empty_changeset = false`, with automatic cleanup).

### B. Manual Cloud Service Rollback to Prior Release

To roll back a deployed cloud release to a previous stable version:

1. **Checkout Previous Stable Commit or Tag**:
   ```bash
   git checkout tags/v1.0.0
   ```
2. **Rebuild Application Bundles**:
   ```bash
   pnpm build
   pnpm --filter @resin/web build:aws
   node scripts/build-serverless.mjs
   ```
3. **Redeploy CloudFormation Stack**:
   Deploy the prior version to the target environment:

   ```bash
   # Rollback Staging
   node scripts/deploy-serverless.mjs \
     --env staging \
     --region us-east-1

   # Rollback Production
   node scripts/deploy-serverless.mjs \
     --env production \
     --region us-east-1 \
     --enable-pitr true \
     --worker-concurrency 5 \
     --log-retention 90
   ```

4. **Alternative: Trigger via GitHub Actions Workflow**:
   Navigate to GitHub Actions → **Deploy Serverless Cloud & Web** → **Run workflow** → Select the prior release branch/tag and trigger deployment for `staging` or `production`.

5. **Verify Restored Endpoint Health**:
   ```bash
   curl -fsS "https://<api-id>.execute-api.us-east-1.amazonaws.com/health"
   ```

### C. Single-Table Database Compatibility & Data Recovery

- **Backward-Compatible Schema Design**: The DynamoDB single-table design (`resin-${env}-data`) uses additive, versioned attributes. Prior application versions continue reading existing partition/sort keys without requiring schema reversals.
- **Idempotent Metadata**: `scripts/migrate-serverless.mjs` is strictly non-destructive and idempotent. Re-running migrations during a rollback will not overwrite active workspace state.
- **Point-In-Time Recovery (PITR) for Logical Data Incidents**:
  If a faulty deployment corrupted table data, restore the DynamoDB table to the exact second prior to the incident:

  ```bash
  aws dynamodb restore-table-to-point-in-time \
    --source-table-name resin-production-data \
    --target-table-name resin-production-data-restored-<timestamp> \
    --restore-date-time <epoch-timestamp> \
    --region us-east-1
  ```

---

## 4. Emergency Global Tool Revocation

In the event that a published tool candidate contains a severe security vulnerability or defect across all client workstations:

1. **Issue Global Revocation in Cloud Registry**:
   Publish a revocation record to the cloud catalog:

   ```bash
   node scripts/migrate-serverless.mjs \
     --table-name resin-production-data \
     --region us-east-1
   ```

   _(Or invoke the administrative revocation endpoint via API)._

2. **Client Invalidation & Quarantine**:
   The cloud API emits revocation events. Observer daemons on connected workstations detect the revocation upon next sync, immediately quarantine the tool candidate, and fall back to the last verified safe version.

---

## Related Documentation

- [Deployment Architecture](../operator/deployment.md)
- [Backup & Disaster Recovery Guide](../operator/backup-and-restore.md)
- [ADR 0011: AWS Serverless Cloud Platform and Storage Architecture](../adr/0011-aws-serverless-cloud-platform.md)
- [Release Notes](v1.0.3-release-notes.md)
- [Compatibility Matrix](compatibility-matrix.md)
- [Release Evidence Trace](release-evidence.md)
- [Operational Runbooks](../operator/runbooks.md)
