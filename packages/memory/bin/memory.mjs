#!/usr/bin/env node
// Local `memory` CLI entry point. The implementation lives in ../src/cli.ts;
// Node's native type stripping runs the TypeScript source directly, so the
// bin works from the workspace with no build step (Node >= 22.18).
//
// The async entry is used because ONE command (`sync`) talks to a server;
// every other command still runs through the synchronous `runMemoryCli`
// underneath it.
import { runMemoryCliAsync } from "../src/cli.ts";

process.exitCode = await runMemoryCliAsync(process.argv.slice(2));
