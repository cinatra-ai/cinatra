#!/usr/bin/env node
// Design conformance PIN-DRIFT gate (cinatra#3057).
//
// The design-system source of truth decides how the app must look. This repo
// proves conformance against PINNED copies of the published conformance
// manifests (tests/e2e/design/conformance-pins.json). Nothing told anyone when
// a published manifest no longer matched its pin, so the app could keep
// testing against an older manifest indefinitely and no check said a word.
// This job makes that difference visible. It does not move a pin and it does
// not decide whether a pin should move — it refuses silence.
//
// For every pin it fetches `publishedBaseUrl + file` and classifies the result
// as EXACTLY ONE of:
//
//   http-failure   network error, or a non-2xx status
//   invalid-json   a body that does not parse as JSON (an HTML error page)
//   schema-failure parses, but is not a conformance manifest: schemaVersion is
//                  not "1.0.0", or contentHash is missing/not sha256:<64 hex>
//   drift          the published bytes do not hash to manifestSha256, or the
//                  published contentHash differs from specContentHash — BOTH
//                  compared unconditionally, so neither hash can hide behind
//                  the other
//   match          both hashes agree
//
// WHAT IT PRINTS. Pin ids, files, published URLs, hashes, outcome names, and
// the rule for moving a pin. Nothing else about the upstream source: a hash
// mismatch proves DIFFERENT, not BEHIND, and that is all a public gate can
// honestly say. There is no provenance field in the pin file for it to read
// one from, and the structural check below refuses one being added.
//
// WHEN IT IS RED (the trigger rule, cinatra#3057 Change 2):
//   pull_request / merge_group / a push to any other branch
//       red only for the non-match pins whose MAPPED paths this diff touched
//       (design-pin-drift.paths.json). Every other non-match is a warning
//       annotation and the job exits 0, so an unrelated PR is never blocked by
//       a manifest change it does not adopt, and a PR that fixes ONE pin is
//       never blocked by the others.
//   push to main / workflow_dispatch
//       red on ANY non-match outcome.
//
// Dependency-free (node builtins + git only) so the pure-node `gates` job runs
// it without an install. Its unit suite is vitest and rides the root include:
// scripts/ci/__tests__/design-pin-drift.test.mjs.
//
// Usage:
//   node scripts/ci/design-pin-drift.mjs
//   node scripts/ci/design-pin-drift.mjs --github-annotations
//   node scripts/ci/design-pin-drift.mjs --event push-main
//
// Environment:
//   GITHUB_EVENT_NAME / GITHUB_REF_NAME   the event class (CI sets both)
//   DESIGN_PIN_DRIFT_DIFF_BASE            base ref for the touched-path diff
//
// Exit codes:
//   0  no red outcome for this event (warnings may have been annotated)
//   1  at least one pin is red under the trigger rule
//   2  the gate could not run honestly (bad pin file, bad map, unresolvable
//      diff base) — fail-closed rather than certify an uninspected pin

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Constants — the paths the trigger rule and the docs page both depend on.
// ---------------------------------------------------------------------------

export const PINS_PATH = "tests/e2e/design/conformance-pins.json";
export const MAP_PATH = "scripts/ci/design-pin-drift.paths.json";
export const CHECKER_PATH = "scripts/ci/design-pin-drift.mjs";
export const WORKFLOW_PATH = ".github/workflows/gates.yml";

/**
 * The paths that change what this gate itself decides. Touching one of them
 * touches EVERY pin id. Held HERE, in the checker, and not read from the map:
 * a map that could drop its own path from the list would be a map that can
 * disarm the rule by editing itself. `loadMap` refuses a map whose
 * `globalPaths` is not exactly this set, so the two can never disagree
 * silently either.
 */
export const GLOBAL_PATHS = Object.freeze([CHECKER_PATH, MAP_PATH, WORKFLOW_PATH]);

/** Exactly the keys a pin entry may carry. Anything else is refused. */
export const PIN_ENTRY_KEYS = Object.freeze([
  "id",
  "file",
  "source",
  "manifestSha256",
  "specContentHash",
]);

/** Top-level keys the pin file may carry. `$comment` is the pinning contract. */
const PINS_TOP_LEVEL_KEYS = Object.freeze(["$comment", "publishedBaseUrl", "manifests"]);

export const OUTCOMES = Object.freeze([
  "match",
  "drift",
  "http-failure",
  "invalid-json",
  "schema-failure",
]);

/** The rule every red message carries (cinatra#3057 Change 4). */
export const MOVE_RULE =
  "A pin moves only in an implementation or explicit reconciliation issue/PR " +
  "that validates the new published contract and updates the required drivers, " +
  "harness mounts and proofs together with it. A hash-only re-pin is never " +
  "accepted: the functional-acceptance suite's driver/allowlist ratchet is what " +
  "turns a blind re-pin red.";

const SUPPORTED_SCHEMA_VERSION = "1.0.0";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadPins(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(resolve(repoRoot, PINS_PATH), "utf8"));
}

export function loadMap(repoRoot = REPO_ROOT) {
  const map = JSON.parse(readFileSync(resolve(repoRoot, MAP_PATH), "utf8"));
  const declared = JSON.stringify(map.globalPaths);
  if (declared !== JSON.stringify([...GLOBAL_PATHS])) {
    throw new Error(
      `${MAP_PATH} declares globalPaths ${declared}, but the checker's own set is ` +
        `${JSON.stringify([...GLOBAL_PATHS])}. The map may not narrow the rule that ` +
        "makes a change to the checker, the map or the workflow touch every pin.",
    );
  }
  return map;
}

export function publishedUrlFor(pins, pin) {
  return `${pins.publishedBaseUrl}${pin.file}`;
}

// ---------------------------------------------------------------------------
// Structural check (cinatra#3057 Change 3)
// ---------------------------------------------------------------------------

/**
 * Refuse a pin file that has grown a provenance key, a non-canonical hash, or
 * a shape the suite cannot read. Returns `{ ok, errors: [{ pin, message }] }`
 * — the whole list, so one run names every problem rather than the first.
 */
export function checkPinsStructure(pins) {
  const errors = [];
  const fail = (pin, message) => errors.push({ pin, message });

  if (pins === null || typeof pins !== "object" || Array.isArray(pins)) {
    return { ok: false, errors: [{ pin: null, message: "the pin file is not an object" }] };
  }
  for (const key of Object.keys(pins)) {
    if (!PINS_TOP_LEVEL_KEYS.includes(key)) {
      fail(null, `unknown top-level key "${key}" — the pin file carries only ${PINS_TOP_LEVEL_KEYS.join(", ")}`);
    }
  }
  if (typeof pins.publishedBaseUrl !== "string" || !pins.publishedBaseUrl.startsWith("https://")) {
    fail(null, "publishedBaseUrl must be an https URL");
  } else if (!pins.publishedBaseUrl.endsWith("/")) {
    fail(null, "publishedBaseUrl must end with '/' — it is joined to `file` verbatim");
  }
  if (!Array.isArray(pins.manifests) || pins.manifests.length === 0) {
    fail(null, "manifests must be a non-empty array");
    return { ok: false, errors };
  }

  const seen = new Set();
  for (const pin of pins.manifests) {
    const id = typeof pin?.id === "string" ? pin.id : "<unnamed pin>";
    if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
      fail(id, "pin entry is not an object");
      continue;
    }
    for (const key of Object.keys(pin)) {
      if (!PIN_ENTRY_KEYS.includes(key)) {
        fail(
          id,
          `pin entry carries "${key}", which is not one of ${PIN_ENTRY_KEYS.join(", ")}. ` +
            "Every value in this public file is a published URL or the hash of a published " +
            "artifact; a free-text or structured provenance note is not one, and a hash " +
            "mismatch proves different, not behind.",
        );
      }
    }
    for (const key of PIN_ENTRY_KEYS) {
      if (!(key in pin)) fail(id, `pin entry is missing "${key}"`);
    }
    if (typeof pin.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(pin.id)) {
      fail(id, "id must be lowercase kebab-case");
    } else if (seen.has(pin.id)) {
      fail(id, "duplicate pin id");
    } else {
      seen.add(pin.id);
    }
    if (typeof pin.file !== "string" || !/^[a-z0-9][a-z0-9-]*\.json$/.test(pin.file)) {
      fail(id, "file must be a plain <name>.json under publishedBaseUrl");
    }
    if (pin.source !== "repo" && pin.source !== "published") {
      fail(id, 'source must be "repo" or "published"');
    }
    if (typeof pin.manifestSha256 !== "string" || !SHA256_HEX.test(pin.manifestSha256)) {
      fail(id, "manifestSha256 must be lowercase 64-hex (no prefix)");
    }
    if (typeof pin.specContentHash !== "string" || !PREFIXED_SHA256.test(pin.specContentHash)) {
      fail(id, "specContentHash must be lowercase sha256:<64 hex>");
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify ONE fetched manifest against its pin. `fetched` is
 * `{ ok, status, body }` or `{ ok: false, status, error }`.
 */
export function classifyPin({ pin, url, fetched }) {
  const base = {
    id: pin.id,
    file: pin.file,
    url,
    pinnedManifestSha256: pin.manifestSha256,
    pinnedSpecContentHash: pin.specContentHash,
    publishedManifestSha256: null,
    publishedSpecContentHash: null,
  };

  // Every `detail` below is CLOSED text chosen by this file plus, at most, a
  // numeric HTTP status. Nothing fetched is ever echoed into the output: a
  // published body is remote input, and a gate that prints remote input back
  // is a gate that can be made to print anything.
  if (!fetched || fetched.ok !== true) {
    const status = Number.isInteger(fetched?.status) ? fetched.status : 0;
    const detail =
      status > 0 ? `HTTP ${status}` : "the request failed before a response was read";
    return { ...base, outcome: "http-failure", detail };
  }

  const bytes = Buffer.isBuffer(fetched.body) ? fetched.body : Buffer.from(fetched.body ?? "");
  const publishedManifestSha256 = sha256Hex(bytes);

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ...base,
      publishedManifestSha256,
      outcome: "invalid-json",
      detail: "the body does not parse as JSON",
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...base,
      publishedManifestSha256,
      outcome: "schema-failure",
      detail: "the body is not a JSON object",
    };
  }
  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ...base,
      publishedManifestSha256,
      outcome: "schema-failure",
      detail: `schemaVersion is not "${SUPPORTED_SCHEMA_VERSION}"`,
    };
  }
  if (typeof parsed.contentHash !== "string" || !PREFIXED_SHA256.test(parsed.contentHash)) {
    return {
      ...base,
      publishedManifestSha256,
      outcome: "schema-failure",
      detail:
        parsed.contentHash === undefined
          ? "contentHash is missing"
          : "contentHash is not lowercase sha256:<64 hex>",
      // The malformed value itself is NOT reported: it is remote text.
    };
  }

  const publishedSpecContentHash = parsed.contentHash;
  const manifestMoved = publishedManifestSha256 !== pin.manifestSha256;
  const contentMoved = publishedSpecContentHash !== pin.specContentHash;
  if (manifestMoved || contentMoved) {
    const moved = [
      manifestMoved ? "manifestSha256" : null,
      contentMoved ? "specContentHash" : null,
    ].filter(Boolean);
    return {
      ...base,
      publishedManifestSha256,
      publishedSpecContentHash,
      outcome: "drift",
      detail: `published ${moved.join(" and ")} differ${moved.length === 1 ? "s" : ""} from the pin`,
    };
  }

  return {
    ...base,
    publishedManifestSha256,
    publishedSpecContentHash,
    outcome: "match",
    detail: "published manifest is the pinned artifact",
  };
}

/** Default fetcher — node's global fetch, normalised to the shape above. */
async function defaultFetchManifest(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { accept: "application/json" },
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, body };
}

/** Fetch and classify every pin, in pin-file order. */
export async function runCheck({ pins, fetchManifest = defaultFetchManifest }) {
  const results = [];
  for (const pin of pins.manifests) {
    const url = publishedUrlFor(pins, pin);
    let fetched;
    try {
      fetched = await fetchManifest(url);
    } catch {
      // The transport error text is remote-influenced; the outcome name and
      // the URL are what a reader needs, and they are already here.
      fetched = { ok: false, status: 0 };
    }
    results.push(classifyPin({ pin, url, fetched }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Trigger rule (cinatra#3057 Change 2)
// ---------------------------------------------------------------------------

function pathTouches(touched, mapped) {
  return mapped.endsWith("/") ? touched.startsWith(mapped) : touched === mapped;
}

/**
 * Which pin ids a diff touches.
 *
 *   - the checker, the map or the workflow  -> EVERY id (they change what the
 *     gate itself decides, so no pin's silence is trustworthy any more);
 *   - a mapped path                          -> that pin's id;
 *   - the pin file                           -> the ids whose ENTRY changed
 *     (`changedPinIds`). A whole-file rule would red a one-pin fix on the four
 *     drifts it did not touch, so entry granularity is load-bearing. When the
 *     changed entries cannot be determined (no base to compare against), the
 *     answer is EVERY id — fail-closed.
 */
export function resolveTouchedPinIds({ touchedPaths, map, changedPinIds }) {
  const allIds = Object.keys(map.pins);
  const touched = new Set();

  for (const p of touchedPaths) {
    if (GLOBAL_PATHS.some((g) => pathTouches(p, g))) return allIds;
    for (const [id, mapped] of Object.entries(map.pins)) {
      if (mapped.some((m) => pathTouches(p, m))) touched.add(id);
    }
    if (p === PINS_PATH) {
      if (changedPinIds === undefined) return allIds;
      for (const id of changedPinIds) touched.add(id);
    }
  }

  return allIds.filter((id) => touched.has(id));
}

/**
 * Which pin ids a pin-file edit changes. An entry that differs changes its own
 * id. A changed `publishedBaseUrl` changes EVERY id — it is the URL all five
 * fetches are built from, so editing it adopts every pin at once even though
 * no entry moved. A `$comment`-only edit changes nothing.
 */
export function changedPinIdsBetween(baseText, headText) {
  const before = JSON.parse(baseText);
  const after = JSON.parse(headText);
  const entries = (parsed) =>
    new Map(
      (parsed.manifests ?? []).map((pin) => [
        pin.id,
        JSON.stringify(pin, Object.keys(pin).sort()),
      ]),
    );
  const beforeEntries = entries(before);
  const afterEntries = entries(after);
  const allIds = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])];
  if (before.publishedBaseUrl !== after.publishedBaseUrl) return allIds;
  return allIds.filter((id) => beforeEntries.get(id) !== afterEntries.get(id));
}

/**
 * The verdict for one run. `event` is "pull_request", "merge_group", "push",
 * "push-main" or "workflow_dispatch".
 */
export function decide({ event, results, touchedPinIds }) {
  const nonMatch = results.filter((r) => r.outcome !== "match");
  const alwaysRed = event === "push-main" || event === "workflow_dispatch";
  const failing = alwaysRed
    ? nonMatch
    : nonMatch.filter((r) => touchedPinIds.includes(r.id));
  const warning = nonMatch.filter((r) => !failing.includes(r));
  return { red: failing.length > 0, exitCode: failing.length > 0 ? 1 : 0, failing, warning };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const shortOrDash = (hash) => hash ?? "(not read)";

/**
 * The per-pin table: id, file, BOTH pinned and published hash pairs, outcome.
 * Both pairs, because both are compared unconditionally — a table that showed
 * only the byte hash would leave a contentHash-only drift with no visible
 * evidence in the summary a reader sees first.
 */
export function formatTable(results) {
  const short = (hash) => (hash ?? "(not read)").replace(/^sha256:/, "").slice(0, 12);
  const rows = results.map((r) => [
    r.id,
    r.file,
    short(r.pinnedManifestSha256),
    short(r.publishedManifestSha256),
    short(r.pinnedSpecContentHash),
    short(r.publishedSpecContentHash),
    r.outcome,
  ]);
  const head = [
    "pin",
    "file",
    "pinned-bytes",
    "published-bytes",
    "pinned-content",
    "published-content",
    "outcome",
  ];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/**
 * The red message (cinatra#3057 Change 1 + criterion 4). Pin id, file,
 * published URL, pinned and published hashes, the outcome name, and the rule.
 */
export function formatRedMessage(failing) {
  const blocks = failing.map((r) =>
    [
      `${r.outcome.toUpperCase()} — pin "${r.id}"`,
      `  manifest file:              ${r.file}`,
      `  published URL:              ${r.url}`,
      `  pinned   manifestSha256:    ${r.pinnedManifestSha256}`,
      `  published manifestSha256:   ${shortOrDash(r.publishedManifestSha256)}`,
      `  pinned   specContentHash:   ${r.pinnedSpecContentHash}`,
      `  published contentHash:      ${shortOrDash(r.publishedSpecContentHash)}`,
      `  outcome:                    ${r.outcome} (${r.detail})`,
    ].join("\n"),
  );
  return [...blocks, "", `RULE: ${MOVE_RULE}`].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The event class for this run, from the CI environment or --event. */
export function resolveEvent({ argv = [], env = {} } = {}) {
  const explicit = argv.indexOf("--event");
  if (explicit !== -1 && argv[explicit + 1]) return argv[explicit + 1];
  const name = env.GITHUB_EVENT_NAME ?? "";
  if (name === "push") {
    const ref = env.GITHUB_REF_NAME ?? env.GITHUB_REF ?? "";
    return ref === "main" || ref.endsWith("/main") ? "push-main" : "push";
  }
  if (name === "") return "workflow_dispatch";
  return name;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
function annotate(log, level, title, message) {
  const one = message.replace(/\r?\n/g, "%0A");
  log(`::${level} title=${title}::${one}`);
}

/**
 * The whole run, as a function, so the CLI wiring itself is testable: the
 * touched-path diff, the warning annotations and the exit code are the parts
 * a pure-function test cannot reach, and they are exactly the parts whose
 * quiet regression would turn this gate fail-OPEN. Nothing here calls
 * `process.exit`; the exit code is RETURNED and the entry point below is the
 * only place that exits.
 *
 * `fetchManifest`, `runGit`, `log` and `logError` are injectable for that
 * suite and default to the real ones.
 */
export async function runCli({
  argv = [],
  env = {},
  fetchManifest,
  runGit = git,
  log = console.log,
  logError = console.error,
} = {}) {
  const annotations = argv.includes("--github-annotations");
  const event = resolveEvent({ argv, env });

  let pins;
  let map;
  try {
    pins = loadPins();
    map = loadMap();
  } catch (err) {
    logError(`ERROR: could not read the pin file or the path map: ${err.message}`);
    return 2;
  }

  const structure = checkPinsStructure(pins);
  if (!structure.ok) {
    logError(`ERROR: ${PINS_PATH} is not a valid pin file:`);
    for (const e of structure.errors) {
      logError(`  ${e.pin ? `[${e.pin}] ` : ""}${e.message}`);
    }
    return 2;
  }
  const mappedIds = Object.keys(map.pins).sort();
  const pinIds = pins.manifests.map((p) => p.id).sort();
  if (JSON.stringify(mappedIds) !== JSON.stringify(pinIds)) {
    logError(
      `ERROR: ${MAP_PATH} maps [${mappedIds.join(", ")}] but ${PINS_PATH} pins ` +
        `[${pinIds.join(", ")}] — every pin needs a path list before this gate can decide ` +
        "which diffs adopt it.",
    );
    return 2;
  }

  // Touched paths. The workflow sets the base; an unresolvable one is a
  // fail-loud misconfiguration rather than a silently empty diff.
  let touchedPinIds = Object.keys(map.pins);
  const alwaysRed = event === "push-main" || event === "workflow_dispatch";
  if (!alwaysRed) {
    const base = (env.DESIGN_PIN_DRIFT_DIFF_BASE ?? "").trim();
    if (base === "") {
      log(
        "::notice::DESIGN_PIN_DRIFT_DIFF_BASE is not set — treating every pin as touched (fail-closed).",
      );
    } else {
      try {
        runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
      } catch {
        logError(
          `ERROR: DESIGN_PIN_DRIFT_DIFF_BASE='${base}' does not resolve to a commit ` +
            "(a fetch-depth misconfiguration) — failing rather than diffing against nothing.",
        );
        return 2;
      }
      // THREE dots: the diff of this branch against its MERGE BASE with the
      // target. A two-dot diff (or a HEAD self-compare) would report paths the
      // base moved instead of the paths this change adopts — the fail-OPEN
      // direction, since a pin nobody is shown to adopt only warns.
      const touchedPaths = runGit(["diff", "--name-only", `${base}...HEAD`])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let changedPinIds;
      if (touchedPaths.includes(PINS_PATH)) {
        try {
          changedPinIds = changedPinIdsBetween(
            runGit(["show", `${base}:${PINS_PATH}`]),
            readFileSync(resolve(REPO_ROOT, PINS_PATH), "utf8"),
          );
        } catch {
          changedPinIds = undefined; // fail-closed: every id
        }
      }
      touchedPinIds = resolveTouchedPinIds({ touchedPaths, map, changedPinIds });
    }
  }

  const results = await runCheck(fetchManifest ? { pins, fetchManifest } : { pins });
  log(formatTable(results));
  log("");

  const verdict = decide({ event, results, touchedPinIds });

  for (const r of verdict.warning) {
    const text = formatRedMessage([r]);
    log(`WARNING (${event}: this diff does not adopt pin "${r.id}")\n${text}`);
    if (annotations) annotate(log, "warning", `design-pin-drift: ${r.id} (${r.outcome})`, text);
  }

  if (!verdict.red) {
    log(
      verdict.warning.length === 0
        ? `ok: all ${results.length} published conformance manifests match their pins.`
        : `ok (warnings only): ${verdict.warning.length} pin(s) differ from the published ` +
            "manifest, and this diff adopts none of them.",
    );
    return 0;
  }

  const text = formatRedMessage(verdict.failing);
  logError("ERROR: a pinned design conformance manifest differs from the published one.");
  logError("");
  logError(text);
  if (annotations) {
    annotate(
      log,
      "error",
      `design-pin-drift: ${verdict.failing.map((r) => r.id).join(", ")}`,
      text,
    );
  }
  return 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exit(await runCli({ argv: process.argv.slice(2), env: process.env }));
}
