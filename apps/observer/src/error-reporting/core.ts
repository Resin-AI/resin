/**
 * Error reporting without the PostHog client: consent, identity, sanitization, the process-wide
 * reporter registry and report helpers. Safe to import from any module or bundle.
 */
export {
  type DeviceReportingConfig,
  type DeviceReportingConfigRead,
  type ErrorReportingConsent,
  type ErrorReportingConsentReason,
  describeConsentReason,
  isDoNotTrack,
  isTestEnvironment,
  parseErrorReportingEnv,
  readDeviceReportingConfig,
  resolveErrorReportingConsent,
  withProcessTestMarker,
} from "./consent.js";
export {
  type CaptureExceptionOptions,
  type ErrorReporterLike,
  type EventProperties,
  type EventPropertyValue,
  type ExceptionLevel,
  RESIN_POSTHOG_DEFAULT_HOST,
  RESIN_POSTHOG_PROJECT_API_KEY,
  type ResinEnvironment,
  type ResinSurface,
  getErrorReporter,
  isUsableProjectKey,
  reportEvent,
  reportHandledError,
  resolveReportingHost,
  resolveReportingKey,
  setActiveErrorReporter,
  withErrorCapture,
} from "./facade.js";
export {
  ANALYTICS_ID_FILE_NAME,
  type CloudIdentity,
  isAnonymousId,
  isOpaqueId,
  peekAnonymousId,
  readCloudIdentity,
  readOrCreateAnonymousId,
} from "./identity.js";
export {
  type ErrorLogBridgeOptions,
  LoggedError,
  bridgeErrorLogs,
  logFingerprint,
} from "./log-bridge.js";
export {
  type CancellableTransport,
  type ReportingTransport,
  type TransportRequest,
  type TransportResponse,
  createUnrefTransport,
  isCancellableTransport,
} from "./transport.js";
export {
  MAX_FEEDBACK_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_STACK_FRAMES,
  type SanitizeContext,
  type SanitizedError,
  type SanitizedStackFrame,
  defaultSanitizeContext,
  parseStackFrames,
  redactText,
  sanitizeError,
  sanitizePaths,
  sanitizeStack,
  sanitizeText,
} from "./sanitize.js";
