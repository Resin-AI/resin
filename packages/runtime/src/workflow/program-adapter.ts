/**
 * The program runtime family: a callable whose recorded artifact is a program in a language.
 *
 * It runs through the interpreter its record names — `python3 -c`, the JavaScript runtime's `-e` —
 * as a single argument, so the source is never re-quoted by a shell. A recorded `typescript`
 * program is the text the JavaScript runtime actually accepted, so it is re-run as JavaScript: that
 * is what the record shows was run. A non-zero exit status throws, so the executor records the step
 * as failed rather than passing on a value the program never produced.
 */

import { type ProgramRunnerOptions, runRecordedCall } from "./program-runner.js";
import type { RecordedCallRequest, RuntimeAdapter } from "./recorded-workflow.js";
import { RESIN_PROGRAM_RUNTIME } from "./runtime-families.js";

/** Runtime knobs for recorded language programs: time and output bounds applied to every call. */
export type ProgramAdapterOptions = ProgramRunnerOptions;

export function createProgramAdapter(options: ProgramAdapterOptions = {}): RuntimeAdapter {
  return {
    runtime: RESIN_PROGRAM_RUNTIME,
    call: (request: RecordedCallRequest) => runRecordedCall(request, options),
  };
}
