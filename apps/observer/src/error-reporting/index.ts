/** The full error-reporting module: {@link ./core.js} plus the PostHog-backed reporter. */
export * from "./core.js";
export {
  type CrashHandlerOptions,
  ErrorReporter,
  type ErrorReporterOptions,
  type ReportingClient,
  type ReportingClientConfig,
  type ReportingMessage,
  configureErrorReporting,
  createSilentFetch,
  installCrashHandlers,
  resetCrashHandlersForTesting,
  resolveReportingEnvironment,
} from "./reporter.js";
