import {
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type DeploymentRecord,
  DeploymentRecordSchema,
  type InstallationRecord,
  InstallationRecordSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
  canonicalJson,
} from "@resin/contracts";
import type { LocalDatabaseConnection } from "../connection.js";

/**
 * Harness plugin installation record.
 */
export interface HarnessInstallationRecord {
  harnessId: string;
  pluginId: string;
  version: string;
  installedAt: string;
  state: "active" | "disabled" | "degraded" | "uninstalled";
  metadata: Record<string, unknown>;
}

/**
 * Repository managing tool manifests, versions, catalog snapshots,
 * deployments, workspace installations, and harness plugin installations.
 */
export class ToolRepository {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  // ---------------------------------------------------------------------------
  // Tool Manifests
  // ---------------------------------------------------------------------------

  async saveManifest(manifest: ToolManifest): Promise<void> {
    const validated = ToolManifestSchema.parse(manifest);
    this.conn.run(
      `INSERT INTO tool_manifests (
        tool_id, name, version, description, scope,
        parameters_json, output_schema_json, runtime_json, capabilities_json, limits_json,
        digest, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        description = excluded.description,
        scope = excluded.scope,
        parameters_json = excluded.parameters_json,
        output_schema_json = excluded.output_schema_json,
        runtime_json = excluded.runtime_json,
        capabilities_json = excluded.capabilities_json,
        limits_json = excluded.limits_json,
        digest = excluded.digest,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at;`,
      [
        validated.id,
        validated.name,
        validated.version,
        validated.description,
        validated.scope,
        canonicalJson(validated.parameters),
        validated.outputSchema ? canonicalJson(validated.outputSchema) : null,
        canonicalJson(validated.runtime),
        canonicalJson(validated.capabilities),
        canonicalJson(validated.limits),
        validated.digest,
        canonicalJson(validated.metadata),
        validated.createdAt,
        validated.updatedAt ?? null,
      ],
    );
  }

  async getManifest(toolId: string): Promise<ToolManifest | null> {
    const row = this.conn.get<{
      tool_id: string;
      name: string;
      version: string;
      description: string;
      scope: "workspace" | "user" | "global" | "session";
      parameters_json: string;
      output_schema_json: string | null;
      runtime_json: string;
      capabilities_json: string;
      limits_json: string;
      digest: string;
      metadata_json: string;
      created_at: string;
      updated_at: string | null;
    }>("SELECT * FROM tool_manifests WHERE tool_id = ?;", [toolId]);

    if (!row) {
      return null;
    }

    return ToolManifestSchema.parse({
      id: row.tool_id,
      name: row.name,
      version: row.version,
      description: row.description,
      scope: row.scope,
      parameters: JSON.parse(row.parameters_json || "{}"),
      outputSchema: row.output_schema_json ? JSON.parse(row.output_schema_json) : undefined,
      runtime: JSON.parse(row.runtime_json || "{}"),
      capabilities: JSON.parse(row.capabilities_json || "{}"),
      limits: JSON.parse(row.limits_json || "{}"),
      digest: row.digest,
      metadata: JSON.parse(row.metadata_json || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    });
  }

  async listManifests(options?: { scope?: string }): Promise<ToolManifest[]> {
    let sql = "SELECT * FROM tool_manifests";
    const params: unknown[] = [];
    if (options?.scope) {
      sql += " WHERE scope = ?";
      params.push(options.scope);
    }
    sql += " ORDER BY name ASC, version ASC;";

    const rows = this.conn.all<{
      tool_id: string;
      name: string;
      version: string;
      description: string;
      scope: "workspace" | "user" | "global" | "session";
      parameters_json: string;
      output_schema_json: string | null;
      runtime_json: string;
      capabilities_json: string;
      limits_json: string;
      digest: string;
      metadata_json: string;
      created_at: string;
      updated_at: string | null;
    }>(sql, params);

    return rows.map((row) =>
      ToolManifestSchema.parse({
        id: row.tool_id,
        name: row.name,
        version: row.version,
        description: row.description,
        scope: row.scope,
        parameters: JSON.parse(row.parameters_json || "{}"),
        outputSchema: row.output_schema_json ? JSON.parse(row.output_schema_json) : undefined,
        runtime: JSON.parse(row.runtime_json || "{}"),
        capabilities: JSON.parse(row.capabilities_json || "{}"),
        limits: JSON.parse(row.limits_json || "{}"),
        digest: row.digest,
        metadata: JSON.parse(row.metadata_json || "{}"),
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Tool Versions
  // ---------------------------------------------------------------------------

  async saveToolVersion(version: ToolVersion): Promise<void> {
    const validated = ToolVersionSchema.parse(version);
    // Ensure parent manifest exists
    await this.saveManifest(validated.manifest);

    this.conn.run(
      `INSERT INTO tool_versions (
        tool_id, version, manifest_digest, artifact_digest, manifest_json, artifact_json, provenance_json, signature_json, status, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_id, version) DO UPDATE SET
        manifest_digest = excluded.manifest_digest,
        artifact_digest = excluded.artifact_digest,
        manifest_json = excluded.manifest_json,
        artifact_json = excluded.artifact_json,
        provenance_json = excluded.provenance_json,
        signature_json = excluded.signature_json,
        status = excluded.status;`,
      [
        validated.toolId,
        validated.version,
        validated.manifestDigest,
        validated.artifactDigest,
        canonicalJson(validated.manifest),
        canonicalJson(validated.artifact),
        canonicalJson(validated.provenance),
        validated.signature ? canonicalJson(validated.signature) : null,
        validated.status,
        validated.createdAt,
        validated.createdBy,
      ],
    );
  }

  async getToolVersion(toolId: string, version: string): Promise<ToolVersion | null> {
    const row = this.conn.get<{
      tool_id: string;
      version: string;
      manifest_digest: string;
      artifact_digest: string;
      manifest_json: string;
      artifact_json: string;
      provenance_json: string;
      signature_json: string | null;
      status: "draft" | "active" | "deprecated" | "revoked";
      created_at: string;
      created_by: string;
    }>("SELECT * FROM tool_versions WHERE tool_id = ? AND version = ?;", [toolId, version]);

    if (!row) {
      return null;
    }

    return ToolVersionSchema.parse({
      toolId: row.tool_id,
      version: row.version,
      manifestDigest: row.manifest_digest,
      artifactDigest: row.artifact_digest,
      manifest: JSON.parse(row.manifest_json),
      artifact: JSON.parse(row.artifact_json),
      provenance: JSON.parse(row.provenance_json),
      signature: row.signature_json ? JSON.parse(row.signature_json) : undefined,
      status: row.status,
      createdAt: row.created_at,
      createdBy: row.created_by,
    });
  }

  async listToolVersions(toolId: string): Promise<ToolVersion[]> {
    const rows = this.conn.all<{
      tool_id: string;
      version: string;
      manifest_digest: string;
      artifact_digest: string;
      manifest_json: string;
      artifact_json: string;
      provenance_json: string;
      signature_json: string | null;
      status: "draft" | "active" | "deprecated" | "revoked";
      created_at: string;
      created_by: string;
    }>("SELECT * FROM tool_versions WHERE tool_id = ? ORDER BY created_at DESC;", [toolId]);

    return rows.map((row) =>
      ToolVersionSchema.parse({
        toolId: row.tool_id,
        version: row.version,
        manifestDigest: row.manifest_digest,
        artifactDigest: row.artifact_digest,
        manifest: JSON.parse(row.manifest_json),
        artifact: JSON.parse(row.artifact_json),
        provenance: JSON.parse(row.provenance_json),
        signature: row.signature_json ? JSON.parse(row.signature_json) : undefined,
        status: row.status,
        createdAt: row.created_at,
        createdBy: row.created_by,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Catalog Snapshots
  // ---------------------------------------------------------------------------

  async saveCatalogSnapshot(snapshot: CatalogSnapshot): Promise<void> {
    const validated = CatalogSnapshotSchema.parse(snapshot);
    this.conn.run(
      `INSERT INTO catalog_snapshots (
        snapshot_id, workspace_id, timestamp, tools_json, digest
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        timestamp = excluded.timestamp,
        tools_json = excluded.tools_json,
        digest = excluded.digest;`,
      [
        validated.snapshotId,
        validated.workspaceId,
        validated.timestamp,
        canonicalJson(validated.tools),
        validated.digest,
      ],
    );
  }

  async getCatalogSnapshot(snapshotId: string): Promise<CatalogSnapshot | null> {
    const row = this.conn.get<{
      snapshot_id: string;
      workspace_id: string;
      timestamp: string;
      tools_json: string;
      digest: string;
    }>("SELECT * FROM catalog_snapshots WHERE snapshot_id = ?;", [snapshotId]);

    if (!row) {
      return null;
    }

    return CatalogSnapshotSchema.parse({
      snapshotId: row.snapshot_id,
      workspaceId: row.workspace_id,
      timestamp: row.timestamp,
      tools: JSON.parse(row.tools_json),
      digest: row.digest,
    });
  }

  async getLatestCatalogSnapshot(workspaceId: string): Promise<CatalogSnapshot | null> {
    const row = this.conn.get<{
      snapshot_id: string;
      workspace_id: string;
      timestamp: string;
      tools_json: string;
      digest: string;
    }>("SELECT * FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT 1;", [
      workspaceId,
    ]);

    if (!row) {
      return null;
    }

    return CatalogSnapshotSchema.parse({
      snapshotId: row.snapshot_id,
      workspaceId: row.workspace_id,
      timestamp: row.timestamp,
      tools: JSON.parse(row.tools_json),
      digest: row.digest,
    });
  }

  // ---------------------------------------------------------------------------
  // Deployment Records
  // ---------------------------------------------------------------------------

  async saveDeployment(deployment: DeploymentRecord): Promise<void> {
    const validated = DeploymentRecordSchema.parse(deployment);
    this.conn.run(
      `INSERT INTO deployment_records (
        deployment_id, workspace_id, tool_id, tool_version, state,
        canary_config_json, history_json, active_traffic_percentage, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deployment_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        tool_id = excluded.tool_id,
        tool_version = excluded.tool_version,
        state = excluded.state,
        canary_config_json = excluded.canary_config_json,
        history_json = excluded.history_json,
        active_traffic_percentage = excluded.active_traffic_percentage,
        updated_at = excluded.updated_at;`,
      [
        validated.deploymentId,
        validated.workspaceId,
        validated.toolId,
        validated.toolVersion,
        validated.state,
        validated.canaryConfig ? canonicalJson(validated.canaryConfig) : null,
        canonicalJson(validated.history),
        validated.activeTrafficPercentage,
        validated.createdAt,
        validated.updatedAt ?? null,
      ],
    );
  }

  async getDeployment(deploymentId: string): Promise<DeploymentRecord | null> {
    const row = this.conn.get<{
      deployment_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      state:
        | "drafted"
        | "validating"
        | "rejected"
        | "replaying"
        | "eligible"
        | "canary"
        | "promoted"
        | "suspended"
        | "rolling_back"
        | "rolled_back"
        | "retired";
      canary_config_json: string | null;
      history_json: string;
      active_traffic_percentage: number;
      created_at: string;
      updated_at: string | null;
    }>("SELECT * FROM deployment_records WHERE deployment_id = ?;", [deploymentId]);

    if (!row) {
      return null;
    }

    return DeploymentRecordSchema.parse({
      deploymentId: row.deployment_id,
      workspaceId: row.workspace_id,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      state: row.state,
      canaryConfig: row.canary_config_json ? JSON.parse(row.canary_config_json) : undefined,
      history: JSON.parse(row.history_json || "[]"),
      activeTrafficPercentage: row.active_traffic_percentage,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    });
  }

  async getDeploymentByTool(
    workspaceId: string,
    toolId: string,
    toolVersion?: string,
  ): Promise<DeploymentRecord | null> {
    let sql = "SELECT * FROM deployment_records WHERE workspace_id = ? AND tool_id = ?";
    const params: unknown[] = [workspaceId, toolId];
    if (toolVersion) {
      sql += " AND tool_version = ?";
      params.push(toolVersion);
    }
    sql += " ORDER BY created_at DESC LIMIT 1;";

    const row = this.conn.get<{
      deployment_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      state:
        | "drafted"
        | "validating"
        | "rejected"
        | "replaying"
        | "eligible"
        | "canary"
        | "promoted"
        | "suspended"
        | "rolling_back"
        | "rolled_back"
        | "retired";
      canary_config_json: string | null;
      history_json: string;
      active_traffic_percentage: number;
      created_at: string;
      updated_at: string | null;
    }>(sql, params);

    if (!row) {
      return null;
    }

    return DeploymentRecordSchema.parse({
      deploymentId: row.deployment_id,
      workspaceId: row.workspace_id,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      state: row.state,
      canaryConfig: row.canary_config_json ? JSON.parse(row.canary_config_json) : undefined,
      history: JSON.parse(row.history_json || "[]"),
      activeTrafficPercentage: row.active_traffic_percentage,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    });
  }

  async listDeployments(options?: {
    workspaceId?: string;
    toolId?: string;
    state?: string;
  }): Promise<DeploymentRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options?.toolId) {
      conditions.push("tool_id = ?");
      params.push(options.toolId);
    }
    if (options?.state) {
      conditions.push("state = ?");
      params.push(options.state);
    }

    let sql = "SELECT * FROM deployment_records";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY created_at DESC;";

    const rows = this.conn.all<{
      deployment_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      state:
        | "drafted"
        | "validating"
        | "rejected"
        | "replaying"
        | "eligible"
        | "canary"
        | "promoted"
        | "suspended"
        | "rolling_back"
        | "rolled_back"
        | "retired";
      canary_config_json: string | null;
      history_json: string;
      active_traffic_percentage: number;
      created_at: string;
      updated_at: string | null;
    }>(sql, params);

    return rows.map((row) =>
      DeploymentRecordSchema.parse({
        deploymentId: row.deployment_id,
        workspaceId: row.workspace_id,
        toolId: row.tool_id,
        toolVersion: row.tool_version,
        state: row.state,
        canaryConfig: row.canary_config_json ? JSON.parse(row.canary_config_json) : undefined,
        history: JSON.parse(row.history_json || "[]"),
        activeTrafficPercentage: row.active_traffic_percentage,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Installations
  // ---------------------------------------------------------------------------

  async saveInstallation(installation: InstallationRecord): Promise<void> {
    const validated = InstallationRecordSchema.parse(installation);
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO installations (
        installation_id, workspace_id, tool_id, tool_version, deployment_id, installed_at, state, config_overrides_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        tool_id = excluded.tool_id,
        tool_version = excluded.tool_version,
        deployment_id = excluded.deployment_id,
        installed_at = excluded.installed_at,
        state = excluded.state,
        config_overrides_json = excluded.config_overrides_json,
        updated_at = excluded.updated_at;`,
      [
        validated.installationId,
        validated.workspaceId,
        validated.toolId,
        validated.toolVersion,
        validated.deploymentId,
        validated.installedAt,
        validated.state,
        canonicalJson(validated.configOverrides),
        now,
        null,
      ],
    );
  }

  async getInstallation(installationId: string): Promise<InstallationRecord | null> {
    const row = this.conn.get<{
      installation_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      deployment_id: string;
      installed_at: string;
      state: "active" | "inactive" | "broken" | "uninstalled";
      config_overrides_json: string;
    }>("SELECT * FROM installations WHERE installation_id = ?;", [installationId]);

    if (!row) {
      return null;
    }

    return InstallationRecordSchema.parse({
      installationId: row.installation_id,
      workspaceId: row.workspace_id,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      deploymentId: row.deployment_id,
      installedAt: row.installed_at,
      state: row.state,
      configOverrides: JSON.parse(row.config_overrides_json || "{}"),
    });
  }

  async listInstallations(workspaceId?: string): Promise<InstallationRecord[]> {
    let sql = "SELECT * FROM installations";
    const params: unknown[] = [];
    if (workspaceId) {
      sql += " WHERE workspace_id = ?";
      params.push(workspaceId);
    }
    sql += " ORDER BY installed_at DESC;";

    const rows = this.conn.all<{
      installation_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      deployment_id: string;
      installed_at: string;
      state: "active" | "inactive" | "broken" | "uninstalled";
      config_overrides_json: string;
    }>(sql, params);

    return rows.map((row) =>
      InstallationRecordSchema.parse({
        installationId: row.installation_id,
        workspaceId: row.workspace_id,
        toolId: row.tool_id,
        toolVersion: row.tool_version,
        deploymentId: row.deployment_id,
        installedAt: row.installed_at,
        state: row.state,
        configOverrides: JSON.parse(row.config_overrides_json || "{}"),
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Harness Installations
  // ---------------------------------------------------------------------------

  async saveHarnessInstallation(record: HarnessInstallationRecord): Promise<void> {
    this.conn.run(
      `INSERT INTO harness_installations (
        harness_id, plugin_id, version, installed_at, state, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(harness_id, plugin_id) DO UPDATE SET
        version = excluded.version,
        installed_at = excluded.installed_at,
        state = excluded.state,
        metadata_json = excluded.metadata_json;`,
      [
        record.harnessId,
        record.pluginId,
        record.version,
        record.installedAt,
        record.state,
        canonicalJson(record.metadata),
      ],
    );
  }

  async getHarnessInstallation(
    harnessId: string,
    pluginId: string,
  ): Promise<HarnessInstallationRecord | null> {
    const row = this.conn.get<{
      harness_id: string;
      plugin_id: string;
      version: string;
      installed_at: string;
      state: "active" | "disabled" | "degraded" | "uninstalled";
      metadata_json: string;
    }>("SELECT * FROM harness_installations WHERE harness_id = ? AND plugin_id = ?;", [
      harnessId,
      pluginId,
    ]);

    if (!row) {
      return null;
    }

    return {
      harnessId: row.harness_id,
      pluginId: row.plugin_id,
      version: row.version,
      installedAt: row.installed_at,
      state: row.state,
      metadata: JSON.parse(row.metadata_json || "{}"),
    };
  }

  async listHarnessInstallations(harnessId?: string): Promise<HarnessInstallationRecord[]> {
    let sql = "SELECT * FROM harness_installations";
    const params: unknown[] = [];
    if (harnessId) {
      sql += " WHERE harness_id = ?";
      params.push(harnessId);
    }
    sql += " ORDER BY installed_at DESC;";

    const rows = this.conn.all<{
      harness_id: string;
      plugin_id: string;
      version: string;
      installed_at: string;
      state: "active" | "disabled" | "degraded" | "uninstalled";
      metadata_json: string;
    }>(sql, params);

    return rows.map((row) => ({
      harnessId: row.harness_id,
      pluginId: row.plugin_id,
      version: row.version,
      installedAt: row.installed_at,
      state: row.state,
      metadata: JSON.parse(row.metadata_json || "{}"),
    }));
  }
}
