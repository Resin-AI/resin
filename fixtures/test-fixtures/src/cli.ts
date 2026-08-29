#!/usr/bin/env node

import { runConformanceCli } from "./conformance-runner.js";

const exitCode = await runConformanceCli(process.argv.slice(2));
process.exit(exitCode);
