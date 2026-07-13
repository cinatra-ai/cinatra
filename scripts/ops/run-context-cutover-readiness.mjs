#!/usr/bin/env node
/**
 * Run-context registry cutover readiness (#1195, pre-metric remainder).
 *
 * Turns an AGGREGATED fleet log stream of the per-request emission
 *
 *   [mcp-run-ctx] served-by=<channel> run=<id|-> suppressed=<bool> count=<n>
 *
 * (emitted by recordMcpRunContextServedBy in src/lib/agent-run-context-durable.ts)
 * into the single go/no-go verdict that gates the owner-approved registry-
 * removal (flip) slice of #1195 — i.e. the PROOF that no production traffic
 * still rides the legacy in-process registry before it is deleted and before
 * the fail-closed deny posture is activated.
 *
 * FAIL-CLOSED. The verdict green-lights an IRREVERSIBLE deletion, so:
 *   - only full-shape emission lines are counted (one per line); a marker line
 *     that is not a well-formed emission is flagged and makes the stream
 *     untrustworthy (not ready);
 *   - an unknown channel, a below-threshold or verified-idle sample, and an
 *     empty/partial stream all resolve to NOT ready with a nonzero exit;
 *   - --min is REQUIRED (no silent default for an irreversible gate).
 *
 * EVIDENCE INTEGRITY IS THE OPERATOR'S RESPONSIBILITY. This tool trusts the
 * bytes it is given: feed it a CANONICAL, COMPLETE, DE-DUPLICATED fleet log
 * stream over an agreed window across every app instance/worker. Replayed or
 * duplicated lines would inflate the sample; the per-process
 * getDurableRunContextCounterSnapshot() is NOT fleet-wide proof.
 *
 * Usage:
 *   node --import tsx scripts/ops/run-context-cutover-readiness.mjs --min <N> [FILE]
 *   some-log-aggregator | node --import tsx scripts/ops/run-context-cutover-readiness.mjs --min <N>
 *   pnpm ops:run-context-readiness -- --min <N> [FILE]
 *
 * Exit codes: 0 = cutover-ready · 1 = not ready · 2 = usage/read error.
 */
import { readFileSync } from "node:fs";
import { judgeCutoverFromLogStream } from "@/lib/agent-run-context-cutover";

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n\n`);
  process.stderr.write(
    "Usage: node --import tsx scripts/ops/run-context-cutover-readiness.mjs --min <N> [FILE]\n" +
      "       (reads the aggregated fleet log stream from FILE, or from stdin if FILE is omitted)\n" +
      "  --min <N>   minimum total served-by observations required to trust the window (positive integer)\n" +
      "  FILE        path to the aggregated log file; omit to read stdin\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let min;
  let file;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage();
    else if (a === "--min" || a === "-m") min = argv[++i];
    else if (a.startsWith("--min=")) min = a.slice("--min=".length);
    else if (a === "--file" || a === "-f") file = argv[++i];
    else if (a.startsWith("--")) usage(`unknown flag "${a}"`);
    else if (file === undefined) file = a;
    else usage(`unexpected extra argument "${a}"`);
  }
  if (min === undefined) usage("--min is required");
  const minObservations = Number(min);
  if (!Number.isInteger(minObservations) || minObservations < 1) {
    usage(`--min must be a positive integer, got "${min}"`);
  }
  return { minObservations, file };
}

function readInput(file) {
  try {
    // fd 0 = stdin when no FILE is given.
    return readFileSync(file ?? 0, "utf8");
  } catch (err) {
    if (file === undefined && process.stdin.isTTY) {
      usage("no FILE given and stdin is a TTY — pipe the log stream or pass a file path");
    }
    process.stderr.write(
      `error: could not read ${file ? `file "${file}"` : "stdin"}: ${err?.message ?? err}\n`,
    );
    process.exit(2);
  }
}

const { minObservations, file } = parseArgs(process.argv.slice(2));
const text = readInput(file);
const { parse, readiness } = judgeCutoverFromLogStream(text, { minObservations });

const tally = Object.entries(parse.servedBy)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `    ${k.padEnd(10)} ${v}`)
  .join("\n");

process.stdout.write(
  [
    "run-context registry cutover readiness (#1195)",
    `  source:              ${file ?? "<stdin>"}`,
    `  lines scanned:       ${parse.linesScanned}`,
    `  emission lines:      ${parse.matchedLines}`,
    `  malformed markers:   ${parse.malformedMarkerLines}`,
    "  served-by tally:",
    tally || "    (none)",
    `  legacy served:       ${readiness.legacyServed}  (registry + header — must be 0)`,
    `  verified served:     ${readiness.verifiedServed}  (obo + durable — must be > 0)`,
    `  total observations:  ${readiness.total}  (threshold: ${minObservations})`,
    "",
    `  VERDICT: ${readiness.ready ? "CUTOVER-READY" : "NOT READY"}`,
    `  ${readiness.reason}`,
    "",
  ].join("\n"),
);

process.exit(readiness.ready ? 0 : 1);
