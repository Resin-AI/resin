/**
 * OMP's background jobs, as its transcripts record them.
 *
 * A `bash` call made with `async: true` (or one OMP backgrounded itself after a wait threshold)
 * returns at once: its result is only a launch acknowledgement (`Backgrounded as job bg_N …`,
 * `details.async = { state: "running", jobId }`), and the command's real output and status arrive
 * later, in one of two records:
 *
 * - the result of a job-joining call — the `wait` tool, or the older `hub` tool's `wait` and `jobs`
 *   operations — whose `details.jobs[]` reports each job by `id` with its terminal `status`
 *   (`completed`, `failed`, `cancelled`), `durationMs`, and its exact `resultText` / `errorText`;
 * - an auto-delivered `async-result` custom message, whose `details.jobs[]` names each job by
 *   `jobId` (with its `label` and `durationMs`, but no status) and whose `content` is OMP's rendered
 *   notice carrying each job's text: the result text of a job that completed, the error text of
 *   one that failed.
 *
 * OMP's job manager marks a bash job `completed` only when its command exited 0 in time; a non-zero
 * exit, a timeout and a cancellation all end it `failed` (or `cancelled`), with the bash tool's own
 * trailer (`Command exited with code N`, `[Command timed out …]`, `[Command aborted]`) ending the
 * error text. These helpers are pure: they read records and never hold state.
 */

import type { DecoderMetadataRecord, DecoderMetadataValue } from "@resin/harness-contracts";

/** OMP's tool that blocks until background jobs (or peer messages) settle. */
export const OMP_JOB_WAIT_TOOL = "wait";

/** OMP's older coordination tool; its `wait` and `jobs` operations join background jobs. */
export const OMP_HUB_TOOL = "hub";

/** `customType` of OMP's auto-delivered background-job completion message. */
export const OMP_ASYNC_RESULT_CUSTOM_TYPE = "async-result";

/** The keys a job-joining result carries when it reports nothing but background jobs. */
const JOB_REPORT_KEYS: Readonly<Record<string, true>> = { op: true, meta: true, jobs: true };

/**
 * The trailer the bash tool appends to a run that did not exit 0 in time; a job whose text ends
 * with one failed. Matched only at the very end of the text, on its own line.
 */
const FAILED_RUN_TRAILER =
  /(?:^|\n)(?:Command exited with code -?\d+|\[?Command timed out(?: after \d+ seconds)?\]?|\[?Command (?:aborted|cancelled)\]?|Command failed: missing exit status)$/;

/** How a background job ended, joined back to the call that launched it. */
export interface OmpJobCompletion {
  jobId: string;
  /** The job's output: its result text when it completed, its error text when it failed. */
  output: string;
  failed: boolean;
  /**
   * Whether the record stated the job's terminal status (a job-joining result does; an
   * `async-result` notice does not, so its status is read from the bash tool's failure trailer
   * and a run without one is not proven to have exited 0).
   */
  statusStated: boolean;
  durationMs?: number;
}

function fields(value: DecoderMetadataValue): DecoderMetadataRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function text(value: DecoderMetadataValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function duration(value: DecoderMetadataValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Whether a call only joins OMP's own background jobs: every `wait`, and a `hub` call whose
 * operation is `wait` or `jobs`. Whether it is harness bookkeeping is settled by its result (see
 * {@link isOmpJobReportOnly}): a wait can also return a peer message, which is not.
 */
export function isOmpJobJoinCall(
  toolName: string,
  parameters: DecoderMetadataRecord | undefined,
): boolean {
  if (toolName === OMP_JOB_WAIT_TOOL) return true;
  const op = parameters?.op;
  return toolName === OMP_HUB_TOOL && (op === "wait" || op === "jobs");
}

/**
 * Whether a job-joining call's result reports background jobs and nothing else: a successful
 * result whose details hold a `jobs` list (possibly empty: nothing was running) beside only the
 * operation and its display metadata. A result that carries a peer message, a supervised process,
 * an interruption or an error is something the agent acted on, and is kept.
 */
export function isOmpJobReportOnly(
  details: DecoderMetadataRecord | undefined,
  isError: boolean,
): boolean {
  if (isError || details === undefined || !Array.isArray(details.jobs)) return false;
  return Object.keys(details).every((key) => JOB_REPORT_KEYS[key] === true);
}

/**
 * The background job a bash result launched, when the result is only its launch acknowledgement:
 * a successful result whose details report the job still running under an id.
 */
export function ompBackgroundLaunchJobId(
  toolName: string,
  details: DecoderMetadataRecord | undefined,
  isError: boolean,
): string | undefined {
  if (toolName !== "bash" || isError) return undefined;
  const launch = fields(details?.async);
  const jobId = text(launch?.jobId);
  return launch?.state === "running" && jobId !== undefined && jobId.length > 0 ? jobId : undefined;
}

/**
 * The bash jobs a job-joining result (or any result listing jobs) reports finished, with the exact
 * text OMP kept for each. A job still running, a non-bash job, and a completed job whose result
 * text the record did not carry (OMP lists jobs it already delivered without it) are skipped.
 */
export function ompJobReportCompletions(
  details: DecoderMetadataRecord | undefined,
): OmpJobCompletion[] {
  if (details === undefined || !Array.isArray(details.jobs)) return [];
  const completions: OmpJobCompletion[] = [];
  for (const entry of details.jobs) {
    const job = fields(entry);
    const jobId = text(job?.id);
    if (job === undefined || jobId === undefined || job.type !== "bash") continue;
    const durationMs = duration(job.durationMs);
    if (job.status === "completed") {
      const output = text(job.resultText);
      if (output === undefined) continue;
      completions.push({ jobId, output, failed: false, statusStated: true, durationMs });
    } else if (job.status === "failed" || job.status === "cancelled") {
      const output = text(job.errorText) ?? text(job.resultText) ?? "";
      completions.push({ jobId, output, failed: true, statusStated: true, durationMs });
    }
  }
  return completions;
}

function noticeText(content: DecoderMetadataValue): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((part) => text(fields(part)?.text));
  return parts.every((part) => part !== undefined) ? parts.join("\n") : undefined;
}

/**
 * The bash jobs an `async-result` notice delivers, each with the text OMP rendered for it.
 *
 * The notice is `<system-notice>` + a header + each job's text + `</system-notice>`; with several
 * jobs, each text follows a `── Job <id> (<label>) ──` line built from the job's own details. Each
 * section is located by that exact header line, in the order the details list the jobs. When any
 * job cannot be located, no section boundary can be trusted, so nothing is read from the notice
 * rather than guessed at. OMP's rendering trims trailing whitespace and collapses blank lines, so
 * the text is the job's output as the agent was shown it, not byte-exact. The notice states no
 * status: a text ending in the bash tool's failure trailer failed; any other is taken as
 * completed, but not as proof the run exited 0.
 */
export function ompAsyncResultCompletions(
  content: DecoderMetadataValue,
  details: DecoderMetadataRecord | undefined,
): OmpJobCompletion[] {
  const notice = noticeText(content);
  if (notice === undefined || details === undefined || !Array.isArray(details.jobs)) return [];
  const jobs = details.jobs.map((entry) => {
    const job = fields(entry);
    return { job, jobId: text(job?.jobId) };
  });
  if (jobs.length === 0 || jobs.some(({ jobId }) => jobId === undefined)) return [];
  const body = notice.replace(/^<system-notice>\n/, "").replace(/\n?<\/system-notice>\s*$/, "");
  const headers =
    jobs.length === 1
      ? [`Background job ${jobs[0]!.jobId} has completed. Resume your work using the result below.`]
      : jobs.map(({ job, jobId }) => {
          const label = text(job?.label);
          return `── Job ${jobId}${label ? ` (${label})` : ""} ──`;
        });
  // Where each job's header line starts and its text begins, found in order.
  const sections: { header: number; text: number }[] = [];
  let cursor = 0;
  for (const header of headers) {
    const at = headerLineAt(body, header, cursor);
    if (at === undefined) return [];
    const end = at + header.length;
    const textStart = body[end] === "\n" ? end + 1 : end;
    sections.push({ header: at, text: textStart });
    cursor = textStart;
  }
  return jobs.flatMap(({ job, jobId }, index) => {
    const section = sections[index]!;
    if (jobId === undefined || job?.type !== "bash") return [];
    const end = sections[index + 1]?.header ?? body.length;
    const output = body.slice(section.text, Math.max(section.text, end)).replace(/\n$/, "");
    return [
      {
        jobId,
        output,
        failed: FAILED_RUN_TRAILER.test(output.trimEnd()),
        statusStated: false,
        durationMs: duration(job.durationMs),
      },
    ];
  });
}

/** The index of `header` as a whole line of `body` at or after `from`, if there is one. */
function headerLineAt(body: string, header: string, from: number): number | undefined {
  let at = body.indexOf(header, from);
  while (at !== -1) {
    const end = at + header.length;
    if ((at === 0 || body[at - 1] === "\n") && (end === body.length || body[end] === "\n")) {
      return at;
    }
    at = body.indexOf(header, at + 1);
  }
  return undefined;
}
