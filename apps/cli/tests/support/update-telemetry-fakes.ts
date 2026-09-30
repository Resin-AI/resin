import type { ErrorReporterLike, EventProperties } from "@resin/observer/error-reporting/core";
import type { UpdateTelemetryState } from "../../src/updates/auto-update-state.js";
import { UpdateTelemetry, type UpdateTelemetryStore } from "../../src/updates/update-telemetry.js";

export interface CapturedEvent {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface CapturedException {
  readonly error: unknown;
  readonly errorCode?: string;
  readonly failureClass?: string;
  readonly handled: boolean;
  readonly properties?: EventProperties;
}

export interface FakeReporter extends ErrorReporterLike {
  readonly events: CapturedEvent[];
  readonly exceptions: CapturedException[];
  flushCalls: number;
  eventsNamed(name: string): Array<Readonly<Record<string, unknown>>>;
}

/**
 * An in-memory reporter. `enabled: false` models DO_NOT_TRACK / opt-out; `throws` makes every
 * method throw; `hangs` makes flush (and the immediate sends) never settle.
 */
export function createFakeReporter(
  options: { enabled?: boolean; throws?: boolean; hangs?: boolean } = {},
): FakeReporter {
  const enabled = options.enabled ?? true;
  const never = (): Promise<void> => Promise.withResolvers<void>().promise;
  const events: CapturedEvent[] = [];
  const exceptions: CapturedException[] = [];
  const reporter: FakeReporter = {
    surface: "updater",
    events,
    exceptions,
    flushCalls: 0,
    eventsNamed(name) {
      return events.filter((entry) => entry.event === name).map((entry) => entry.properties);
    },
    isConfigured: () => true,
    isEnabled() {
      if (options.throws) throw new Error("reporter exploded");
      return enabled;
    },
    consent: () => ({ enabled, reason: enabled ? "enabled" : "do_not_track" }),
    captureException(error, captureOptions) {
      if (options.throws) throw new Error("reporter exploded");
      if (!enabled) return;
      exceptions.push({
        error,
        errorCode: captureOptions.errorCode,
        failureClass: captureOptions.failureClass,
        handled: captureOptions.handled,
        properties: captureOptions.properties,
      });
    },
    async captureExceptionImmediate() {
      if (options.hangs) return never();
    },
    capture(event, properties) {
      if (options.throws) throw new Error("reporter exploded");
      if (!enabled) return;
      const recorded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties ?? {})) {
        if (value !== undefined) recorded[key] = value;
      }
      events.push({ event, properties: recorded });
    },
    async captureImmediate() {
      if (options.hangs) return never();
    },
    identifyCloudUser() {},
    async submitFeedback() {
      return false;
    },
    async flush() {
      reporter.flushCalls += 1;
      if (options.throws) throw new Error("reporter exploded");
      if (options.hangs) return never();
    },
  };
  return reporter;
}

export interface MemoryTelemetryStore extends UpdateTelemetryStore {
  state: UpdateTelemetryState | null;
  writes: number;
}

export function createMemoryTelemetryStore(
  initial: UpdateTelemetryState | null = null,
): MemoryTelemetryStore {
  const store: MemoryTelemetryStore = {
    state: initial,
    writes: 0,
    async read() {
      return store.state;
    },
    async write(state) {
      store.writes += 1;
      store.state = state;
    },
  };
  return store;
}

export function createTestTelemetry(
  reporter: ErrorReporterLike,
  store: UpdateTelemetryStore = createMemoryTelemetryStore(),
  clock: () => number = Date.now,
): UpdateTelemetry {
  return new UpdateTelemetry({ reporter: () => reporter, store, clock });
}
