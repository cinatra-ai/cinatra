#!/usr/bin/env node
// Local `memory` CLI entry point. The implementation lives in ../src/cli.ts;
// Node's native type stripping runs the TypeScript source directly, so the
// bin works from the workspace with no build step (Node >= 22.18).
import { runMemoryCli } from "../src/cli.ts";

process.exitCode = runMemoryCli(process.argv.slice(2));
