/**
 * Wall-clock time a learned tool's recorded calls spend running.
 *
 * The gateway runs one invocation inside `RecordedExecutionClock.run`; each recorded call (a
 * recorded program's process, a display-filter stage's process, a recorded patch, a recorded MCP or
 * tool call) marks its own interval from launch to completion. Resin's own work around those calls
 * — validation, artifact checks, workspace setup, report building, presentation — marks nothing.
 * Calls that run one after another add up; calls that run at the same time count once, as the
 * union of their intervals. The clock travels with the async context, so concurrent invocations
 * never share one, and code running outside any invocation records nothing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

interface Interval {
  start: number;
  end?: number;
}

const activeClock = new AsyncLocalStorage<RecordedExecutionClock>();

export class RecordedExecutionClock {
  private readonly intervals: Interval[] = [];

  /** Runs `body` with this clock receiving the intervals of every recorded call it makes. */
  run<T>(body: () => Promise<T>): Promise<T> {
    return activeClock.run(this, body);
  }

  /** Opens one recorded call's interval; the returned function closes it (once). */
  begin(): () => void {
    const interval: Interval = { start: performance.now() };
    this.intervals.push(interval);
    return () => {
      interval.end ??= performance.now();
    };
  }

  /**
   * Milliseconds covered by at least one recorded call, rounded to an integer; an interval still
   * open counts up to now. Undefined when no recorded call started, so a failure before anything
   * ran reports no execution time rather than zero.
   */
  durationMs(): number | undefined {
    if (this.intervals.length === 0) return undefined;
    const now = performance.now();
    const spans = this.intervals
      .map(({ start, end }) => [start, end ?? now] as const)
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [currentStart, currentEnd] = spans[0]!;
    for (const [start, end] of spans.slice(1)) {
      if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end);
        continue;
      }
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
    total += currentEnd - currentStart;
    return Math.round(total);
  }
}

const NOTHING_TO_CLOSE = (): void => {};

/**
 * Opens a recorded call's interval on the invocation's clock and returns the function that closes
 * it. Outside a measured invocation it records nothing. Call it synchronously where the call
 * launches: callbacks that close it later (a child's `close` event) need not carry the context.
 */
export function beginRecordedCall(): () => void {
  return activeClock.getStore()?.begin() ?? NOTHING_TO_CLOSE;
}

/** Runs one recorded call, timing it from launch to completion whether it answers or throws. */
export async function timeRecordedCall<T>(call: () => Promise<T>): Promise<T> {
  const end = beginRecordedCall();
  try {
    return await call();
  } finally {
    end();
  }
}
