import type {
  CapabilityEnvelope,
  CapabilityManifest,
  ProbeResultEntry,
  SignatureMetadata,
  ToolManifest,
  VerificationChecks,
  VerificationDigests,
  VerificationEvidenceRecord,
} from "@resin/contracts";
import type ts from "typescript";

export type {
  VerificationEvidenceRecord,
  VerificationDigests,
  VerificationChecks,
  ProbeResultEntry,
};

/**
 * Diagnostic from TypeScript compilation or type checking.
 */
export interface TypeCheckDiagnostic {
  category: "error" | "warning" | "message" | "suggestion";
  code: number;
  message: string;
  line?: number;
  character?: number;
  file?: string;
}

/**
 * Result of TypeScript compilation and type-check analysis.
 */
export interface TypeCheckResult {
  passed: boolean;
  errors: string[];
  diagnostics: TypeCheckDiagnostic[];
  jsCode?: string;
  sourceMap?: string;
}

/**
 * Options for pinned TypeScript compilation.
 */
export interface CompilerOptions {
  strict?: boolean;
  target?: ts.ScriptTarget;
  module?: ts.ModuleKind;
  extraDeclarations?: Record<string, string>;
  fileName?: string;
}

/**
 * Severity of static analysis finding.
 */
export type StaticFindingSeverity = "error" | "warning" | "info";

/**
 * Category of static analysis finding.
 */
export type StaticFindingCategory =
  | "forbidden_import"
  | "forbidden_api"
  | "dynamic_import_escape"
  | "undeclared_capability"
  | "unsupported_runtime"
  | "nondeterministic_dependency"
  | "relative_path_escape"
  | "schema_mismatch"
  | "malicious_pattern"
  | "ast_complexity";

/**
 * Individual finding from AST static analysis.
 */
export interface StaticAnalysisFinding {
  severity: StaticFindingSeverity;
  category: StaticFindingCategory;
  message: string;
  line?: number;
  column?: number;
  nodeText?: string;
  fixHint?: string;
}
/**
 * Result of AST static analysis.
 */
export interface StaticAnalysisResult {
  passed: boolean;
  findings: StaticAnalysisFinding[];
  inferredCapabilities?: Partial<CapabilityManifest>;
  detectedImports: string[];
  hasDynamicImports: boolean;
  hasRawHostApis: boolean;
}

/**
 * Options for candidate static analysis.
 */
export interface StaticAnalyzerOptions {
  allowedImports?: string[];
  maxAstDepth?: number;
  envelope?: CapabilityEnvelope;
  strictCapabilities?: boolean;
}

/**
 * Result of schema consistency and structural validation on a tool manifest.
 */
export interface ManifestSchemaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
/**
 * Platform security probe definition.
 */
export interface SecurityProbe {
  id: string;
  name: string;
  description: string;
  requiredForProduction: boolean;
  run: (context: SecurityProbeContext) => Promise<ProbeExecutionResult>;
}

/**
 * Context provided to security probes during execution.
 */
export interface SecurityProbeContext {
  manifest: ToolManifest;
  sourceCode: string;
  bundleDir?: string;
  archiveBuffer?: Buffer;
  timeoutMs?: number;
}

/**
 * Result of an individual security probe execution.
 */
export interface ProbeExecutionResult {
  probeId: string;
  name: string;
  passed: boolean;
  error?: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

/**
 * Result of running the full platform security probe suite.
 */
export interface ProbeSuiteResult {
  passed: boolean;
  probes: ProbeExecutionResult[];
  failedProbes: ProbeExecutionResult[];
  durationMs: number;
}

/**
 * Options for running security probes.
 */
export interface ProbeRunnerOptions {
  timeoutMs?: number;
  includeOptional?: boolean;
  probes?: SecurityProbe[];
  workerExecutable?: string;
}

/**
 * Parameters for generating a content-addressed VerificationEvidenceRecord.
 */
export interface CreateEvidenceParams {
  toolId: string;
  version: string;
  sourceCode: string;
  manifest: ToolManifest;
  testsCode?: string;
  artifactBuffer: Buffer;
  artifactDigest?: string;
  sdkVersion?: string;
  runtimeVersion?: string;
  brokerProtocolVersion?: string;
  policyVersion?: string;
  denoVersion?: string;
  checkResults: {
    compilationAndTypeCheck: boolean;
    staticAnalysis: boolean;
    schemaValidation: boolean;
    unitTests: boolean;
    securityProbes: boolean;
    deterministicPackaging: boolean;
  };
  probeResults?: ProbeExecutionResult[];
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
  signature?: SignatureMetadata;
}

/**
 * Expected context for verifying an existing VerificationEvidenceRecord.
 */
export interface ExpectedVerificationContext {
  artifactDigest?: string;
  sourceCode?: string;
  manifest?: ToolManifest;
  testsCode?: string;
  runtimeVersion?: string;
  policyVersion?: string;
  now?: Date;
}

/**
 * Result of verifying an evidence record.
 */
export interface EvidenceVerificationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}
