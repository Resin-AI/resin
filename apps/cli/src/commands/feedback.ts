import process from "node:process";
import {
  type ErrorReporterLike,
  MAX_FEEDBACK_LENGTH,
  describeConsentReason,
  getErrorReporter,
} from "@resin/observer/error-reporting/core";

interface Output {
  write: (chunk: string) => boolean | undefined;
}

export interface FeedbackCommandOptions {
  stdout?: Output;
  stderr?: Output;
  reporter?: ErrorReporterLike;
}

const HELP = `Usage:
  resin feedback <message...>

Sends your message to the Resin team with this install's anonymous id (or your Resin account id
when paired), Resin version, OS and architecture. Paths, e-mail addresses and secrets in the
message are redacted, and it is capped at ${MAX_FEEDBACK_LENGTH} characters.

Feedback follows your error-reporting choice: it is not sent when DO_NOT_TRACK is set,
RESIN_ERROR_REPORTING=0, or error reporting or telemetry is disabled with 'resin privacy'.
`;

export async function feedbackCommand(
  args: string[],
  options: FeedbackCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    (args.length === 0 ? stderr : stdout).write(HELP);
    return args.length === 0 ? 1 : 0;
  }
  const message = args.join(" ").trim();
  if (!message) {
    stderr.write(HELP);
    return 1;
  }

  const reporter = options.reporter ?? getErrorReporter();
  if (!reporter.isConfigured()) {
    stderr.write("Feedback is not available in this build of Resin; nothing was sent.\n");
    return 1;
  }
  const consent = reporter.consent();
  if (!consent.enabled) {
    stderr.write(
      `Feedback was not sent: error reporting is ${describeConsentReason(consent.reason)}.\n`,
    );
    stderr.write("Run 'resin privacy error-reporting status' for details.\n");
    return 1;
  }
  const sent = await reporter.submitFeedback(message);
  if (!sent) {
    stderr.write("Feedback could not be sent.\n");
    return 1;
  }
  if (message.length > MAX_FEEDBACK_LENGTH) {
    stdout.write(`Your message was shortened to ${MAX_FEEDBACK_LENGTH} characters.\n`);
  }
  stdout.write("Thanks! Your feedback was submitted to the Resin team.\n");
  return 0;
}
