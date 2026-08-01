#!/usr/bin/env node
/**
 * Vitest TIER-COVERAGE guard (cinatra#2316).
 *
 * WHY THIS EXISTS. The defect this script guards against is not "a test
 * failed" — it is "a whole tier of tests ran NOWHERE and nobody noticed".
 * `@cinatra-ai/execution-plane` shipped 36 unit files and 5 real-Docker
 * batteries whose assertions executed on no PR at all: the package declared
 * both runners itself, the root `vitest.config.ts` enumerates workspace tiers
 * glob-by-glob and simply had no `packages/execution-plane` entry, and no
 * workflow invoked either script. Typecheck still covered the SOURCES, so a
 * type error reded CI while a failing assertion did not. A silent zero-coverage
 * runner looks exactly like a healthy one from the outside — green, fast, and
 * proving nothing.
 *
 * So a job that runs a tier is not enough. The job has to PROVE it ran the
 * tier. This guard reads Vitest's own JSON report and asserts, after the fact:
 *
 *   1. the report exists and parses            — a runner that crashed before
 *                                                writing one never "passed";
 *   2. `success === true`                      — belt-and-braces beside the
 *                                                runner's exit code;
 *   3. at least one file executed              — `vitest run` over a pattern
 *                                                that matches nothing is the
 *                                                canonical silent green;
 *   4. EVERY file matching the tier's expected — the anti-recurrence clause. A
 *      glob was actually executed               config `include` that narrows,
 *                                                a stray `exclude`, or a new
 *                                                test file landing outside the
 *                                                runner's reach all red here.
 *
 * The `--expect` glob is therefore the TIER CONTRACT, held here deliberately
 * INDEPENDENTLY of the package's own vitest config. If the two disagree the
 * guard fails — which is the point: the package config narrowing its `include`
 * is precisely how a tier goes dark, and a guard that read the same config
 * would agree with the drift instead of catching it.
 *
 * It also emits a per-file duration table (GitHub-flavoured Markdown) so the
 * cost of each battery stays visible in the job summary rather than being
 * rediscovered the next time somebody asks whether a tier can gate a PR.
 *
 * Usage:
 *   node scripts/ci/vitest-tier-coverage.mjs \
 *     --report <path/to/vitest-report.json> \
 *     --package-dir <path/to/package> \
 *     --expect '<glob relative to --package-dir>' \
 *     [--exclude '<glob>' ...] \
 *     [--title '<human name for the tier>'] \
 *     [--summary <path to append the Markdown table to>]
 *
 * `--expect` and `--exclude` may each be repeated. Exit 0 = the tier provably
 * ran; exit 1 = it did not, with the reason on stderr.
 */

import { appendFileSync, globSync, readFileSync } from "node:fs";
import * as path from "node:path";

function parseArgs(argv) {
  const out = { expect: [], exclude: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--report":
        out.report = take();
        break;
      case "--package-dir":
        out.packageDir = take();
        break;
      case "--expect":
        out.expect.push(take());
        break;
      case "--exclude":
        out.exclude.push(take());
        break;
      case "--title":
        out.title = take();
        break;
      case "--summary":
        out.summary = take();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out.report) throw new Error("--report is required");
  if (!out.packageDir) throw new Error("--package-dir is required");
  if (out.expect.length === 0) throw new Error("at least one --expect glob is required");
  out.title ??= out.packageDir;
  return out;
}

/** Repo-relative, POSIX-separated — the one shape every comparison here uses. */
function normalize(fromDir, filePath) {
  return path.relative(fromDir, path.resolve(fromDir, filePath)).split(path.sep).join("/");
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageDir = path.resolve(args.packageDir);

  // --- 1. the report exists and parses ------------------------------------
  let report;
  try {
    report = JSON.parse(readFileSync(path.resolve(args.report), "utf8"));
  } catch (error) {
    fail(
      `${args.title}: no readable Vitest JSON report at ${args.report} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "A runner that never wrote a report never proved anything — refusing to report this tier as covered.",
    );
    return;
  }

  const executed = new Map();
  for (const result of report.testResults ?? []) {
    if (typeof result.name !== "string") continue;
    const rel = normalize(packageDir, result.name);
    const start = Number(result.startTime ?? 0);
    const end = Number(result.endTime ?? 0);
    executed.set(rel, {
      status: String(result.status ?? "unknown"),
      tests: Array.isArray(result.assertionResults) ? result.assertionResults.length : 0,
      ms: end > start ? Math.round(end - start) : 0,
    });
  }

  // --- 4. expected coverage (computed before reporting, used in the table) --
  const expected = new Set();
  for (const pattern of args.expect) {
    for (const hit of globSync(pattern, { cwd: packageDir })) {
      expected.add(hit.split(path.sep).join("/"));
    }
  }
  for (const pattern of args.exclude) {
    for (const hit of globSync(pattern, { cwd: packageDir })) {
      expected.delete(hit.split(path.sep).join("/"));
    }
  }

  const missing = [...expected].filter((file) => !executed.has(file)).sort();

  // --- summary table (always emitted, including on a red run) --------------
  const rows = [...executed.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([file, info]) => `| \`${file}\` | ${info.status} | ${info.tests} | ${(info.ms / 1000).toFixed(1)}s |`);
  const totalMs = [...executed.values()].reduce((sum, info) => sum + info.ms, 0);
  const table = [
    `### ${args.title}`,
    "",
    `Executed **${executed.size}** file(s), **${report.numTotalTests ?? 0}** test(s); ` +
      `slowest-first, in-runner wall time **${(totalMs / 1000).toFixed(1)}s** ` +
      "(job wall-clock additionally carries checkout + install + any image builds).",
    "",
    "| File | Status | Tests | Duration |",
    "| --- | --- | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
  console.log(table);
  if (args.summary) {
    try {
      appendFileSync(args.summary, `${table}\n`);
    } catch {
      // A summary-file hiccup must never be the thing that reds a tier gate.
    }
  }

  // --- 2. the run itself succeeded ----------------------------------------
  if (report.success !== true) {
    fail(
      `${args.title}: the Vitest run reported success=false ` +
        `(${report.numFailedTests ?? "?"} failed test(s), ${report.numFailedTestSuites ?? "?"} failed file(s)).`,
    );
  }

  // --- 3. something actually ran ------------------------------------------
  if (executed.size === 0) {
    fail(
      `${args.title}: the runner executed ZERO test files. ` +
        "A pattern that matches nothing is the exact silent-green failure this guard exists to catch.",
    );
    return;
  }

  // --- 4. everything expected actually ran --------------------------------
  if (missing.length > 0) {
    fail(
      `${args.title}: ${missing.length} file(s) match the tier contract but were NOT executed by this run:\n` +
        missing.map((file) => `  - ${file}`).join("\n") +
        "\nEither the runner's config narrowed (a tier going dark — the cinatra#2316 defect) " +
        "or a new test file landed outside its reach. Wire it in; do not widen this guard's exclusions to hide it.",
    );
  }
}

try {
  main();
} catch (error) {
  fail(`vitest-tier-coverage: ${error instanceof Error ? error.message : String(error)}`);
}
