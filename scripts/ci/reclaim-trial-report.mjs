#!/usr/bin/env node
// The larger-runner trial MEASUREMENT (cinatra#3316, item 4).
//
// WHY: the three build-carrying jobs are reclaimed mid-build on the default
// hosted runner size. Whether a larger size makes that rarer is a question of
// numbers, not of opinion, so the trial needs a before-and-after reading taken
// the same way on both sides.
//
// WHAT THIS IS: the reading, and only the reading. It reads the SAME records
// the weekly count reads — the re-run watcher's ledger artifacts, whose names
// carry the workflow, the job id, the attempt and the RUNNER LABEL the
// reclaimed job ran on — and prints the before/after table for two named
// windows and two named runner sizes.
//
// WHAT THIS IS NOT: it changes no repository variable and no workflow. Routing
// is variable-driven (`vars.CI_RUNNER_<CLASS>`), so the trial is run by setting
// that variable for the measured week and reading this table afterwards; that
// switch is a deliberate separate act and stays outside this script.
//
// Pre-install-safe: node builtins only.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { countReclaims, isoDay, listArtifacts } from "./reclaim-weekly-count.mjs";

/**
 * The before/after table, as a pure function over the records.
 *
 * @param {object} input
 * @param {{name: string, created_at: string}[]} input.artifacts
 * @param {{runner: string, start: string, end: string}} input.before
 * @param {{runner: string, start: string, end: string}} input.after
 * @returns {{rows: {phase: string, runner: string, start: string, end: string,
 *            total: number, perWorkflow: {workflow: string, count: number}[]}[],
 *           text: string}}
 */
export function trialReport({ artifacts, before, after }) {
  const phases = [
    { phase: "before", ...before },
    { phase: "after", ...after },
  ];

  const rows = phases.map((p) => {
    const counted = countReclaims({
      artifacts,
      start: p.start,
      end: p.end,
      runner: p.runner,
    });
    return {
      phase: p.phase,
      runner: p.runner,
      start: p.start,
      end: p.end,
      total: counted.total,
      perWorkflow: counted.perWorkflow,
    };
  });

  const lines = [
    "| phase | week (UTC) | runner size | reclaimed jobs |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.phase} | ${isoDay(row.start)} to ${isoDay(row.end)} | ${row.runner} | ${row.total} |`,
    );
  }
  lines.push("");
  for (const row of rows) {
    const detail =
      row.perWorkflow.length === 0
        ? "no reclaimed jobs"
        : row.perWorkflow.map((w) => `${w.workflow} ${w.count}`).join(", ");
    lines.push(`- ${row.phase} (${row.runner}): ${detail}`);
  }
  lines.push("");
  lines.push(
    "One entry per job id; a second attempt is counted separately. Counted from the re-run watcher's own records, not from run logs.",
  );

  return { rows, text: lines.join("\n") };
}

/**
 * `--before 2026-08-31:2026-09-07:ubuntu-latest` -> the phase object.
 * The end bound is EXCLUSIVE, so a Monday-to-Monday pair is one whole week.
 */
export function parsePhase(value, flag) {
  const parts = String(value ?? "").split(":");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error(`${flag} expects <start>:<end>:<runner label>`);
  }
  const [start, end, runner] = parts;
  for (const bound of [start, end]) {
    if (Number.isNaN(new Date(bound).getTime())) {
      throw new Error(`${flag}: ${bound} is not a readable instant`);
    }
  }
  return { start, end, runner };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--before") out.before = parsePhase(argv[i + 1], "--before");
    if (argv[i] === "--after") out.after = parsePhase(argv[i + 1], "--after");
  }
  if (!out.before || !out.after) {
    throw new Error(
      "usage: reclaim-trial-report.mjs --before <start>:<end>:<runner> --after <start>:<end>:<runner>",
    );
  }
  return out;
}

export async function main({ argv = process.argv.slice(2), doFetch = fetch } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { before, after } = parseArgs(argv);
  const artifacts = await listArtifacts(token, doFetch);
  const report = trialReport({ artifacts, before, after });
  process.stdout.write(`${report.text}\n`);
  return report;
}

const invoked =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(
      `::error::reclaim-trial-report: ${error && error.message ? error.message : error}`,
    );
    process.exit(1);
  });
}
