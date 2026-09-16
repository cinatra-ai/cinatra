#!/usr/bin/env node
// Design pin FRESHNESS gate (cinatra#3144 G1).
//
// The drawings this application's screens are graded against live outside this
// repository, and this repository records which revision of them it grades
// against as a pin. Nothing checked that the pin was still the current one. So
// a drawing could be re-ratified, the pin stay where it was, no check turn red,
// and a capture taken afterwards be graded against a picture that was already
// replaced. This job refuses that silence. Like its sibling design-pin-drift it
// never moves a pin and never decides whether one should move.
//
// WHAT IT READS. The COMMIT-BEARING pins only — the `specCommit` the
// acceptance manifest declares and the mirror the anchor contract keeps
// (scripts/ci/lib/design-pin.mjs holds the list). The entries in
// tests/e2e/design/conformance-pins.json carry content hashes and file names
// rather than revisions and stay design-pin-drift's subject; this gate does not
// read them.
//
// WHAT "BEHIND" MEANS, MECHANICALLY. For each pin, and for EVERY drawing path
// the pin governs, list the revisions on the design source's DEFAULT BRANCH
// that touch that path, and the revisions reachable from the PINNED one that
// touch it. A revision in the first list and not the second is one the pin has
// not adopted, and a non-empty result means the pin is behind. There is no
// attempt to classify a revision as a "ratification": the default branch is the
// ratified line by definition.
//
// CREDENTIAL. The design source is not publicly readable, so an unauthenticated
// read cannot answer the question. The job runs with the installation
// credential this repository's workflows already mint for cross-repository
// reads, handed in through DESIGN_SOURCE_TOKEN. Where no credential is present,
// or the read fails, this gate exits 2 — design-pin-drift's own "the gate could
// not run honestly" convention — rather than certifying an uninspected pin.
//
// TRIGGER (design-pin-drift's rule, reused rather than reinvented):
//   pull_request / merge_group / a push to any other branch
//       red only for the behind pins whose MAPPED paths this diff touched
//       (design-pin-gates.paths.json); every other behind pin is a warning
//       annotation and the job exits 0.
//   push to main / workflow_dispatch
//       red on ANY behind pin.
//
// WHAT THE MESSAGE MAY SAY. Nothing about the design source: not a revision,
// not a drawing path, not a section, NOT A COUNT and not a date. A public CI
// log is public, and a count is still a fact about a private source. So the
// message says only that the pin has un-adopted ratifications against it, and
// points at the contract that governs moving it. The detail is available to a
// reader WITH ACCESS by running this same check locally with a credential and
// `--detail`, which this file refuses to do inside a public log.
//
// Dependency-free (node builtins plus git) so a pure-node job runs it without
// an install. Its unit suite is vitest and rides the root include:
// scripts/ci/__tests__/design-pin-freshness.test.mjs.
//
// Usage:
//   node scripts/ci/design-pin-freshness.mjs
//   node scripts/ci/design-pin-freshness.mjs --github-annotations
//   node scripts/ci/design-pin-freshness.mjs --event push-main
//   node scripts/ci/design-pin-freshness.mjs --detail     (local, with access)
//
// Environment:
//   DESIGN_SOURCE_TOKEN                   the read credential (required)
//   GITHUB_EVENT_NAME / GITHUB_REF_NAME   the event class (CI sets both)
//   DESIGN_PIN_DRIFT_DIFF_BASE            base ref for the touched-path diff
//
// Exit codes:
//   0  no behind pin is red for this event (warnings may have been annotated)
//   1  at least one pin is behind under the trigger rule
//   2  the gate could not run honestly (no credential, a failed or unreadable
//      answer, an unreadable pin, a bad map) — fail-closed rather than certify
//      an uninspected pin

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEvent } from "./design-pin-drift.mjs";
import {
  DesignPinError,
  DesignSourceError,
  FRESHNESS_CHECKER_PATH,
  GLOBAL_PATHS,
  MAP_PATH,
  TOKEN_ENV,
  WORKFLOW_PATH,
  createDesignSourceReader,
  loadGatePathMap,
  publicReason,
  readCommitBearingPins,
  resolveTouchedPins,
} from "./lib/design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CHECKER_PATH = FRESHNESS_CHECKER_PATH;

/**
 * The trigger rule's constants live in the shared library: this gate, its two
 * siblings and the one map they read all obey one set, and `loadGatePathMap`
 * refuses a map that declares a different one — a map that could drop its own
 * path from that list would be a map that can disarm the rule by editing
 * itself. Re-exported here so a reader of this checker sees what it obeys.
 */
export { GLOBAL_PATHS, MAP_PATH, WORKFLOW_PATH };

/** The rule every behind message carries. Closed text: no number, no source. */
export const MOVE_RULE =
  "A pin moves only in an issue or pull request that RE-EXAMINES the recorded " +
  "anchors against the drawings at the new revision and re-derives the anchor " +
  "digest with the canonical script — never by hand, and never by copying a " +
  "value the script did not print on that tree. A mechanical re-pin is refused " +
  "by the anchor contract, and a graded record must name the pin it was graded " +
  "against.";

export const OUTCOMES = Object.freeze(["current", "behind"]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify ONE pin. `perPath` is `[{ path, head, reachable }]` — the revisions
 * touching that governed drawing on the default branch, and the ones reachable
 * from the pinned revision. Pure, so the suite drives exactly what CI drives.
 */
export function classifyPinFreshness({ pin, perPath }) {
  const reachable = new Set();
  for (const entry of perPath) for (const sha of entry.reachable) reachable.add(sha);
  const unadopted = [];
  for (const entry of perPath) {
    for (const sha of entry.head) {
      if (!reachable.has(sha) && !unadopted.includes(sha)) unadopted.push(sha);
    }
  }
  return {
    id: pin.id,
    authority: pin.authority,
    mirror: pin.mirror,
    outcome: unadopted.length > 0 ? "behind" : "current",
    unadopted,
  };
}

/** Ask the source for one pin and classify the answer. */
export async function checkPin({ pin, reader, defaultBranch }) {
  const perPath = [];
  for (const path of pin.paths) {
    perPath.push({
      path,
      head: await reader.revisionsTouching({ ref: defaultBranch, path }),
      reachable: await reader.revisionsTouching({ ref: pin.revision, path }),
    });
  }
  return classifyPinFreshness({ pin, perPath });
}

/** Every pin, in list order. */
export async function runCheck({ pins, reader }) {
  const defaultBranch = await reader.defaultBranch();
  const results = [];
  for (const pin of pins) results.push(await checkPin({ pin, reader, defaultBranch }));
  return results;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export function decide({ event, results, touchedPinIds }) {
  const behind = results.filter((r) => r.outcome === "behind");
  const alwaysRed = event === "push-main" || event === "workflow_dispatch";
  const failing = alwaysRed ? behind : behind.filter((r) => touchedPinIds.includes(r.id));
  const warning = behind.filter((r) => !failing.includes(r));
  return { red: failing.length > 0, exitCode: failing.length > 0 ? 1 : 0, failing, warning };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * The public message. Every word of it is chosen HERE. It names the pin id and
 * the two files in THIS repository that carry the pin, says the pin has
 * un-adopted ratifications against it, and states the rule. It carries no
 * revision, no drawing path, no count and no date — and its suite asserts the
 * bound by refusing a digit anywhere in it.
 */
export function formatBehindMessage(failing) {
  const blocks = failing.map((r) =>
    [
      `BEHIND — pin "${r.id}" has un-adopted ratifications against it.`,
      `  declared in: ${r.authority}`,
      `  mirrored in: ${r.mirror}`,
      "  what this means: the drawings this pin governs have moved on since the",
      "  revision it names, so a capture graded under this pin may have been graded",
      "  against a picture that was already replaced.",
      "  the detail is not public: run this check locally, with a credential, and",
      "  the --detail flag to see which ratifications are un-adopted.",
    ].join("\n"),
  );
  return [...blocks, "", `RULE: ${MOVE_RULE}`].join("\n");
}

/** The per-pin table — ids and outcome names, nothing else. */
export function formatTable(results) {
  const rows = results.map((r) => [r.id, r.outcome]);
  const head = ["pin", "outcome"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/**
 * The LOCAL detail. Only a reader who already holds a credential can produce
 * it, and the CLI refuses to produce it inside a public log at all.
 */
export function formatDetail(results) {
  return results
    .filter((r) => r.outcome === "behind")
    .map((r) => [`${r.id}: un-adopted`, ...r.unadopted.map((sha) => `  ${sha}`)].join("\n"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function annotate(log, level, title, message) {
  log(`::${level} title=${title}::${message.replace(/\r?\n/g, "%0A")}`);
}

/**
 * The whole run, as a function, so the CLI wiring is testable: the touched-path
 * diff, the warning annotations and the exit code are exactly the parts whose
 * quiet regression would turn this gate fail-OPEN. Nothing here calls
 * `process.exit`; the exit code is RETURNED.
 */
export async function runCli({
  argv = [],
  env = {},
  repoRoot = REPO_ROOT,
  pins: pinsInput,
  createReader = createDesignSourceReader,
  runGit = git,
  log = console.log,
  logError = console.error,
} = {}) {
  const annotations = argv.includes("--github-annotations");
  const detail = argv.includes("--detail");
  const event = resolveEvent({ argv, env });

  if (detail && (annotations || env.GITHUB_ACTIONS === "true")) {
    logError(
      "ERROR: the gate could not run honestly: --detail names what a public log may not " +
        "carry. Run this check locally, with a credential, for the detail.",
    );
    return 2;
  }

  let pins;
  try {
    pins = typeof pinsInput === "function" ? pinsInput() : (pinsInput ?? readCommitBearingPins(repoRoot));
  } catch (err) {
    logError(
      `ERROR: the gate could not run honestly: ${err instanceof DesignPinError ? err.message : "the pin could not be read"}`,
    );
    return 2;
  }

  let map;
  try {
    map = loadGatePathMap(repoRoot);
  } catch (err) {
    logError(
      `ERROR: the gate could not run honestly: ${err instanceof DesignPinError ? err.message : "the path map could not be read"}`,
    );
    return 2;
  }
  const mappedIds = Object.keys(map.pins).sort();
  const pinIds = pins.map((p) => p.id).sort();
  if (JSON.stringify(mappedIds) !== JSON.stringify(pinIds)) {
    logError(
      `ERROR: the gate could not run honestly: ${MAP_PATH} maps [${mappedIds.join(", ")}] but the ` +
        `tree carries [${pinIds.join(", ")}] — every pin needs a path list before this gate can ` +
        "decide which diffs adopt it.",
    );
    return 2;
  }

  // Touched paths. Same rule, same environment variable and the same
  // fail-closed direction as design-pin-drift: an absent base means EVERY pin
  // is treated as touched, so a fetch-depth misconfiguration over-reports
  // rather than hiding an adopting pull request.
  let touchedPinIds = Object.keys(map.pins);
  const alwaysRed = event === "push-main" || event === "workflow_dispatch";
  if (!alwaysRed) {
    const base = (env.DESIGN_PIN_DRIFT_DIFF_BASE ?? "").trim();
    if (base === "") {
      log("::notice::no diff base is set — treating every pin as touched (fail-closed).");
    } else {
      let touchedPaths;
      try {
        runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
        touchedPaths = runGit(["diff", "--name-only", `${base}...HEAD`])
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      } catch {
        logError(
          "ERROR: the gate could not run honestly: the diff base does not resolve to a revision " +
            "in this checkout (a fetch-depth misconfiguration) — failing rather than diffing " +
            "against nothing.",
        );
        return 2;
      }
      touchedPinIds = resolveTouchedPins({ touchedPaths, map, globalPaths: GLOBAL_PATHS });
    }
  }

  const reader = createReader({ token: env[TOKEN_ENV] });
  if (!reader) {
    logError(`ERROR: the gate could not run honestly: ${publicReason("no-credential")}.`);
    logError(
      "  This gate reads a source that is not publicly readable, so it refuses to certify a pin " +
        "it could not inspect.",
    );
    return 2;
  }

  let results;
  try {
    results = await runCheck({ pins, reader });
  } catch (err) {
    const reason = err instanceof DesignSourceError ? err.message : publicReason("read-failed");
    logError(`ERROR: the gate could not run honestly: ${reason}.`);
    return 2;
  }

  log(formatTable(results));
  log("");

  if (detail) log(formatDetail(results));

  const verdict = decide({ event, results, touchedPinIds });

  for (const r of verdict.warning) {
    const text = formatBehindMessage([r]);
    log(`WARNING (this diff does not adopt pin "${r.id}")\n${text}`);
    if (annotations) annotate(log, "warning", `design-pin-freshness: ${r.id}`, text);
  }

  if (!verdict.red) {
    log(
      verdict.warning.length === 0
        // NOT "every commit-bearing pin": the word `commit` is one of the
        // words this repository's public gate output may not carry, and the
        // clean path is public output like every other.
        ? "ok: every design pin this gate reads is current."
        : "ok (warnings only): a pin has un-adopted ratifications against it, and this diff " +
            "adopts none of them.",
    );
    return 0;
  }

  const text = formatBehindMessage(verdict.failing);
  logError("ERROR: a design pin has un-adopted ratifications against it.");
  logError("");
  logError(text);
  if (annotations) {
    annotate(log, "error", `design-pin-freshness: ${verdict.failing.map((r) => r.id).join(", ")}`, text);
  }
  return 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exit(await runCli({ argv: process.argv.slice(2), env: process.env }));
}
