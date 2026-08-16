#!/usr/bin/env node
/**
 * THE CHAT-HITL GATE MANIFEST CHECKER — what the `chat-hitl-gates` job runs, and
 * the proof that it ran exactly that, and really ran it.
 *
 * WHY A MANIFEST AND NOT A FILTER. A vitest positional argument is a
 * case-insensitive SUBSTRING filter over the root config's include. A filter
 * spelled `chat-hitl` therefore adopts every future file whose name happens to
 * contain it, and a "at least N files matched" floor stops detecting deletions
 * the moment the real set grows past N. Neither states what is merge-blocking.
 * `.github/chat-hitl-gate-suites.json` does, and because it sits on a protected
 * path, adding or removing a merge-blocking gate is a review-visible diff.
 *
 * WHY NOT PARSE THE REPORTER. The first cut of this step read "Test Files N
 * passed" with sed. That line is ANSI-wrapped on the runner and not on a local
 * non-TTY run, so it parsed zero over a suite that had just passed and failed
 * the job. Colour is not the defect; parsing prose meant for humans is. This
 * reads vitest's JSON report, and `--no-color` is deliberately not used — it
 * would hide that failure behind a parser that stays brittle.
 *
 * WHAT A GREEN RUN HAS TO MEAN, and the three ways it could have lied:
 *
 *   · A FILE COULD BE PRESENT AND SILENT. `describe.skip` still collects the
 *     file, still lists it in `testResults`, and still leaves the process
 *     successful. Set equality alone would call that green. So every expected
 *     file must carry at least one PASSED assertion and NO pending, todo or
 *     skipped one, and the run's own pending/todo counters must be zero.
 *   · A FILE COULD HIDE FROM DISCOVERY. `readdirSync` on three hand-picked
 *     directories misses `…/__tests__/regressions/held-turn-x.test.ts` and every
 *     other `src/**\/__tests__` directory, all of which the root config runs.
 *     Discovery therefore walks the roots RECURSIVELY, matches case-insensitively,
 *     and only counts files under a `__tests__` directory, which is what the root
 *     include covers.
 *   · A REPORT COULD BE STALE. `verify` would happily read a JSON file left by
 *     something else. The workflow deletes the destination before the run, so a
 *     report that is missing afterwards is a failure rather than a pass.
 *
 * TWO MODES:
 *   plan    — before the run. Every listed suite must EXIST, the list must carry
 *             no duplicates, and every convention-matching file discovered on
 *             disk must be LISTED. Writes the suite list for the shell.
 *   verify  — after the run. The executed set must EQUAL the manifest in both
 *             directions, and every suite in it must have really asserted.
 *
 * Exit 0 -> clean; exit 1 -> a violation, already printed as a workflow error.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MANIFEST_PATH = process.env.GATE_MANIFEST ?? ".github/chat-hitl-gate-suites.json";
const REPORT_PATH = process.env.GATE_REPORT ?? "";
const SUITE_LIST_PATH = join(
  process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
  "chat-hitl-gate-suites.txt",
);

/** Directories never worth walking. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) fail(`the gate manifest is missing at ${MANIFEST_PATH}`);
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

/** What a path really is, following a link. `null` when it resolves to nothing. */
function statKind(abs) {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

/**
 * Every convention-matching test file under the manifest's roots.
 *
 * RECURSIVE, and scoped to `__tests__` directories, because that is what the
 * root vitest include covers. A flat read of three chosen directories would miss
 * a nested one and call the tree clean.
 */
export function discover(manifest) {
  const { roots = [], pattern } = manifest.discovery ?? {};
  if (!pattern) fail("the gate manifest declares no discovery pattern");
  // Case-INSENSITIVE on purpose: the filter this replaces was, and a file named
  // `Held-Turn-x.test.ts` is the same gate to every reader.
  const re = new RegExp(pattern, "i");
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      // A SYMLINK IS NOT A HIDING PLACE. `isFile()` and `isDirectory()` are both
      // false for one, so skipping non-files would let a convention-named gate
      // committed as a symlink run in the root suite while discovery ignored it.
      // Resolve the target's kind and treat it as what it points at, which is
      // what vitest does when it walks the same tree.
      const kind = entry.isSymbolicLink() ? statKind(abs) : entry;
      if (kind === null) continue; // a broken link points at nothing
      if (kind.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!kind.isFile()) continue;
      if (!re.test(entry.name)) continue;
      // Mirror the root include: only files inside a `__tests__` directory run.
      if (!abs.split(sep).includes("__tests__")) continue;
      found.push(abs);
    }
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (statSync(root).isDirectory()) walk(root);
  }
  return [...new Set(found)].sort();
}

function plan() {
  const manifest = loadManifest();
  const suites = manifest.suites ?? [];
  if (suites.length === 0) {
    fail("the gate manifest lists no suites — this job would verify nothing");
  }

  const dupes = duplicates(suites);
  if (dupes.length > 0) {
    fail(
      `the gate manifest lists these suites more than once: ${dupes.join(", ")}. ` +
        "A duplicate makes the exact-set check meaningless.",
    );
  }

  const gone = suites.filter((f) => !existsSync(f));
  if (gone.length > 0) {
    fail(
      `gate suites listed in the manifest do not exist: ${gone.join(", ")}. ` +
        "A deleted or renamed gate has to leave the manifest deliberately.",
    );
  }

  const listed = new Set(suites);
  const unregistered = discover(manifest).filter((f) => !listed.has(f));
  if (unregistered.length > 0) {
    fail(
      `these files match the gate-suite convention but are not in ${MANIFEST_PATH}: ` +
        `${unregistered.join(", ")}. Register a new gate deliberately, or rename it out of the convention.`,
    );
  }

  // A report left by anything else must not be able to answer for this run.
  if (REPORT_PATH && existsSync(REPORT_PATH)) rmSync(REPORT_PATH, { force: true });

  writeFileSync(SUITE_LIST_PATH, `${suites.join("\n")}\n`);
  console.log(
    `gate manifest: ${suites.length} suite(s) listed and present; ` +
      "discovery agrees, nothing unregistered.",
  );
}

/** Assertion statuses that mean "this did not actually run". */
const NON_RUNNING = new Set(["pending", "todo", "skipped", "disabled"]);

function verify() {
  const manifest = loadManifest();
  if (!REPORT_PATH || !existsSync(REPORT_PATH)) {
    fail(
      `vitest wrote no JSON report to ${REPORT_PATH || "(unset)"} — the executed set cannot be ` +
        "verified. The destination is deleted before the run, so a missing report means the run " +
        "did not produce one.",
    );
  }
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  if (report.success !== true) fail("the JSON report says the run did not succeed");

  const suites = manifest.suites ?? [];
  const expected = new Set(suites);
  const ranList = (report.testResults ?? []).map((t) => relative(process.cwd(), t.name));
  const ranDupes = duplicates(ranList);
  if (ranDupes.length > 0) {
    fail(`the report lists these files more than once: ${ranDupes.join(", ")}`);
  }
  const ran = new Set(ranList);

  const missing = suites.filter((f) => !ran.has(f));
  const extra = ranList.filter((f) => !expected.has(f));
  if (missing.length > 0) console.log(`::error::manifest suites did not run: ${missing.join(", ")}`);
  if (extra.length > 0) {
    console.log(`::error::files ran that the manifest does not list: ${extra.join(", ")}`);
  }
  if (missing.length > 0 || extra.length > 0) process.exit(1);

  // PRESENT IS NOT THE SAME AS RUN. A file whose tests are all skipped is
  // collected, listed and successful; without this it would satisfy every check
  // above while asserting nothing.
  const silent = [];
  const skipped = [];
  for (const result of report.testResults ?? []) {
    const file = relative(process.cwd(), result.name);
    const assertions = result.assertionResults ?? [];
    const passed = assertions.filter((a) => a.status === "passed").length;
    const inert = assertions.filter((a) => NON_RUNNING.has(a.status));
    if (assertions.length === 0 || passed === 0) silent.push(file);
    if (inert.length > 0) skipped.push(`${file} (${inert.length})`);
  }
  if (silent.length > 0) {
    console.log(
      `::error::these gate suites ran no passing assertion: ${silent.join(", ")}. ` +
        "A collected but silent suite is not a gate.",
    );
  }
  if (skipped.length > 0) {
    console.log(
      `::error::these gate suites carry skipped or todo tests: ${skipped.join(", ")}. ` +
        "A merge-blocking gate does not get to opt out of itself.",
    );
  }
  const counters = [report.numPendingTests, report.numTodoTests].filter(
    (n) => typeof n === "number" && n > 0,
  );
  if (counters.length > 0) {
    console.log(
      `::error::the run reports ${report.numPendingTests} pending and ${report.numTodoTests} todo test(s).`,
    );
  }
  if (silent.length > 0 || skipped.length > 0 || counters.length > 0) process.exit(1);

  console.log(
    `chat-HITL gate suites: ${ran.size} file(s), ${report.numTotalTests} test(s), ` +
      `${report.numPassedTests} passed, none skipped; the executed set equals the manifest.`,
  );
}

const mode = process.argv[2];
if (mode === "plan") plan();
else if (mode === "verify") verify();
else fail(`unknown mode "${mode ?? ""}" — use plan or verify`);
