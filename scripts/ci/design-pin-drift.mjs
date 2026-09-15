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
//       A file SHARED by every pin is attributed per pin rather than to all of
//       them (cinatra#3421): the pin file and the path map by the ENTRY that
//       changed, the shared driver file by the DRIVER BLOCK that changed. Only
//       the checker and the workflow touch every id.
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

/** The one driver file every pin's surfaces are answered from. */
export const DRIVER_FILE_PATH = "tests/e2e/design/conformance/contract.ts";

/** Where a pin's committed manifest copy lives — its declared surface ids. */
export const MANIFEST_DIR = "tests/e2e/design/conformance/manifests/";

/**
 * The paths that change what this gate itself decides. Touching one of them
 * touches EVERY pin id. Held HERE, in the checker, and not read from the map:
 * a map that could drop a path from the list would be a map that can disarm
 * the rule by editing itself. `loadMap` refuses a map whose `globalPaths` is
 * not exactly this set, so the two can never disagree silently either.
 *
 * The map itself is NOT one of them (cinatra#3421). It is shared by every pin
 * the way the pin file is, and reading a one-line map edit as "every pin" red
 * an adoption PR on the four drifts it did not touch — the very thing entry
 * granularity exists to prevent. A map edit is attributed by the ENTRY that
 * changed instead, and a map edit that moves `globalPaths` or the set of pin
 * ids still answers with every id (`changedMapPinIdsBetween`), so nothing the
 * map can say about itself narrows the rule.
 */
export const GLOBAL_PATHS = Object.freeze([CHECKER_PATH, WORKFLOW_PATH]);

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
        "makes a change to the checker or the workflow touch every pin.",
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
 *   - the checker or the workflow  -> EVERY id (they change what the gate
 *     itself decides, so no pin's silence is trustworthy any more);
 *   - a mapped path                -> that pin's id;
 *   - the pin file                 -> the ids whose ENTRY changed
 *     (`changedPinIds`);
 *   - the path map                 -> the ids whose ENTRY changed
 *     (`changedMapPinIds`);
 *   - the shared driver file       -> the ids whose DRIVER BLOCK changed
 *     (`driverPinIds`), and none when the changed block is a shared helper.
 *
 * The last three are the files EVERY pin lists. A whole-file rule on one of
 * them reds a one-pin adoption on the drifts it did not touch, which is why
 * each is attributed by the part of it that changed (cinatra#3057 for the pin
 * file, cinatra#3421 for the map and the driver file). When the changed part
 * cannot be determined — no base to compare against, an unreadable file — the
 * answer is EVERY id: fail-closed.
 */
export function resolveTouchedPinIds({
  touchedPaths,
  map,
  changedPinIds,
  changedMapPinIds,
  driverPinIds,
}) {
  const allIds = Object.keys(map.pins);
  const touched = new Set();

  for (const p of touchedPaths) {
    if (GLOBAL_PATHS.some((g) => pathTouches(p, g))) return allIds;
    for (const [id, mapped] of Object.entries(map.pins)) {
      // The driver file is mapped under every pin — it IS the shared driver —
      // so its own attribution answers for it, never the flat path list.
      if (mapped.some((m) => m !== DRIVER_FILE_PATH && pathTouches(p, m))) touched.add(id);
    }
    if (p === PINS_PATH) {
      if (changedPinIds === undefined) return allIds;
      for (const id of changedPinIds) touched.add(id);
    }
    if (p === MAP_PATH) {
      if (changedMapPinIds === undefined) return allIds;
      for (const id of changedMapPinIds) touched.add(id);
    }
    if (p === DRIVER_FILE_PATH) {
      if (driverPinIds === undefined) return allIds;
      for (const id of driverPinIds) touched.add(id);
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

// ---------------------------------------------------------------------------
// Shared-file attribution (cinatra#3421)
// ---------------------------------------------------------------------------

/**
 * Which pin ids a PATH-MAP edit changes. An entry whose path list differs
 * changes its own id. A changed `globalPaths`, or a pin id added or removed,
 * changes EVERY id — those decide what the gate reads rather than what one pin
 * adopts, so no map edit can narrow the rule by editing the map. A
 * `$comment`-only edit changes nothing. Entry granularity is the same answer
 * `changedPinIdsBetween` gives for the pin file, for the same reason: the map
 * is shared by all five pins, and a whole-file rule reds a one-pin adoption on
 * the drifts it did not touch.
 */
export function changedMapPinIdsBetween(baseText, headText) {
  const before = JSON.parse(baseText);
  const after = JSON.parse(headText);
  const beforePins = before.pins ?? {};
  const afterPins = after.pins ?? {};
  const allIds = [...new Set([...Object.keys(beforePins), ...Object.keys(afterPins)])];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.globalPaths, after.globalPaths)) return allIds;
  if (!same(Object.keys(beforePins).sort(), Object.keys(afterPins).sort())) return allIds;
  return allIds.filter((id) => !same(beforePins[id], afterPins[id]));
}

/** A top-level declaration: where one block of the driver file begins. */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/** The table the driver file uses to say which block drives which surface. */
const SURFACE_TABLE_DECLARATION = "export const SURFACE_DRIVERS";

/**
 * The driver file's own blocks, stated by the file's own structure: ONE block
 * per top-level declaration (the exported driver constants per drawing, and
 * every helper beside them), from the declaration line — with the comment
 * written directly above it — to the line before the next declaration. The
 * lines above the first declaration, the imports and the preamble, are in no
 * block. Returns `[{ name, start, end }]`, 1-based and inclusive.
 */
export function driverBlocks(text) {
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = TOP_LEVEL_DECLARATION.exec(lines[i]);
    if (match === null) continue;
    let start = i;
    while (start > 0 && COMMENT_LINE.test(lines[start - 1])) start -= 1;
    starts.push({ name: match[1], declaration: i, start });
  }
  return starts.map((block, index) => {
    const next = starts[index + 1];
    return {
      name: block.name,
      start: block.start + 1,
      end: next === undefined ? lines.length : Math.max(block.declaration + 1, next.start),
    };
  });
}

/** Index of the closing quote of the literal that opens at `start`. */
function skipLiteral(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return text.length;
}

/** First index in [from, to) that is neither whitespace nor a comment. */
function skipTrivia(text, from, to) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 || newline >= to ? to : newline + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 || close + 2 > to ? to : close + 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * The `SURFACE_DRIVERS` table as entries with their own line ranges:
 * `{ start, end, entries: [{ surfaceId, dynamic, idents, start, end }] }`, or
 * `null` when the table cannot be read (the fail-closed answer upstream).
 *
 * A LITERAL entry (`"connector-setup": CONNECTOR_SETUP_DRIVER`) names both the
 * manifest surface and the block that drives it. A COMPUTED entry (a family
 * factory spread over a fixture list) names the block but not the surfaces —
 * this file cannot say which surfaces it drives without running it — and is
 * marked `dynamic`.
 */
export function surfaceDriverTable(text, blockNames = new Set()) {
  const at = text.indexOf(SURFACE_TABLE_DECLARATION);
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  if (open === -1) return null;
  const lineAt = (index) => text.slice(0, index).split("\n").length;

  const spans = [];
  let depth = 0;
  let entryStart = open + 1;
  let closed = -1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipLiteral(text, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth === 0) {
        spans.push([entryStart, i]);
        closed = i;
        break;
      }
      continue;
    }
    if (c === "," && depth === 1) {
      spans.push([entryStart, i]);
      entryStart = i + 1;
    }
  }
  if (closed === -1) return null;

  const entries = [];
  for (const [from, to] of spans) {
    const begin = skipTrivia(text, from, to);
    if (begin >= to) continue;
    const source = text.slice(begin, to);
    const spread = source.startsWith("...");
    const keyed = spread
      ? null
      : /^(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:/.exec(source);
    const surfaceId = keyed === null ? null : (keyed[1] ?? keyed[2] ?? keyed[3]);
    const value = keyed === null ? source : source.slice(keyed[0].length);
    entries.push({
      surfaceId,
      dynamic: surfaceId === null,
      idents: [...value.matchAll(/[A-Za-z_$][\w$]*/g)]
        .map((m) => m[0])
        .filter((name) => blockNames.has(name)),
      start: lineAt(begin),
      end: lineAt(to),
    });
  }
  return { start: lineAt(at), end: lineAt(closed), entries };
}

/** The head-side line ranges a `git diff --unified=0` names, 1-based. */
export function parseChangedLineRanges(diffText) {
  const ranges = [];
  for (const line of String(diffText).split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // A pure deletion names the position the removed lines sat BETWEEN, so
    // both sides of the cut answer for it.
    ranges.push(
      count === 0
        ? { start: Math.max(1, start), end: start + 1 }
        : { start, end: start + count - 1 },
    );
  }
  return ranges;
}

/** The BASE-side line ranges a `git diff --unified=0` names, 1-based. */
export function parseRemovedLineRanges(diffText) {
  const ranges = [];
  for (const line of String(diffText).split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // A pure addition removes nothing, so it has no base-side line to own.
    if (count === 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

/**
 * Each pin's declared surface ids, read from the committed manifest copy the
 * map names for that pin. The manifests are the ground truth for WHICH
 * surfaces a pin owns; the driver file is the ground truth for which block
 * drives one.
 */
export function loadPinSurfaceIds(map, repoRoot = REPO_ROOT) {
  const surfaces = {};
  for (const [pinId, paths] of Object.entries(map.pins)) {
    const manifestPath = paths.find((p) => p.startsWith(MANIFEST_DIR));
    if (manifestPath === undefined) continue;
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8"));
    surfaces[pinId] = (manifest.surfaces ?? []).map((surface) => surface.id);
  }
  return surfaces;
}

/**
 * Which pin ids an edit to the SHARED DRIVER FILE touches.
 *
 * The driver file is listed under every pin, so a whole-file rule reads a
 * seed-helper edit as every pin at once (cinatra#3421). The file says who owns
 * what itself: `SURFACE_DRIVERS` binds a manifest surface id to the block that
 * drives it, and each pin's manifest declares the surface ids that pin owns.
 * A changed line is therefore attributed by the BLOCK it sits in, and there
 * are exactly three answers:
 *
 *   - a block the table binds to pinned surfaces -> those pins;
 *   - a block the table reaches only through a COMPUTED entry (a family
 *     factory spread over a fixture list, whose surface ids the file cannot
 *     name without running it), and the table's own braces and comments ->
 *     EVERY pin, fail-closed;
 *   - a block the table never names — a shared helper such as the seed helper,
 *     the imports, the preamble -> NO pin.
 *
 * An unreadable table, like an unreadable base, answers with every id.
 */
const EVERY_PIN = "every";

/**
 * A declaration keyword left alone on a line — `const` with its name on the
 * next line — is a block boundary this reader cannot see, so the file's
 * structure is not readable and the answer is every id.
 */
const DANGLING_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s*$/m;

/**
 * One side of the driver file as an owner per line: a pin-id set, the EVERY_PIN
 * sentinel, or null for a line no pin owns. `null` (the return value) when the
 * file's structure cannot be read at all — the fail-closed answer upstream.
 */
function driverLineOwners(text, pinSurfaceIds) {
  if (DANGLING_DECLARATION.test(text)) return null;
  const blocks = driverBlocks(text);
  const table = surfaceDriverTable(text, new Set(blocks.map((b) => b.name)));
  if (table === null) return null;

  const pinsOfSurface = new Map();
  for (const [pinId, surfaceIds] of Object.entries(pinSurfaceIds)) {
    for (const surfaceId of surfaceIds) {
      if (!pinsOfSurface.has(surfaceId)) pinsOfSurface.set(surfaceId, new Set());
      pinsOfSurface.get(surfaceId).add(pinId);
    }
  }
  const ownerOf = (entry) =>
    entry.dynamic ? EVERY_PIN : (pinsOfSurface.get(entry.surfaceId) ?? new Set());

  const ownerOfBlock = new Map();
  for (const entry of table.entries) {
    const owner = ownerOf(entry);
    for (const name of entry.idents) {
      const held = ownerOfBlock.get(name);
      if (held === EVERY_PIN) continue;
      if (owner === EVERY_PIN) {
        ownerOfBlock.set(name, EVERY_PIN);
        continue;
      }
      const merged = held ?? new Set();
      for (const pinId of owner) merged.add(pinId);
      ownerOfBlock.set(name, merged);
    }
  }

  const lineCount = text.split("\n").length;
  const owners = new Array(lineCount + 1).fill(null);
  const paint = (from, to, owner) => {
    for (let line = Math.max(1, from); line <= Math.min(to, lineCount); line += 1) {
      owners[line] = owner;
    }
  };
  for (const block of blocks) paint(block.start, block.end, ownerOfBlock.get(block.name) ?? null);
  paint(table.start, table.end, EVERY_PIN);
  for (const entry of table.entries) paint(entry.start, entry.end, ownerOf(entry));
  return owners;
}

export function driverFilePinIds({
  contractText,
  baseContractText,
  diffText,
  pinSurfaceIds,
  allIds,
}) {
  const every = [...allIds];
  // Nothing at all in the diff output: the file is in the touched list without
  // a change this reader has to place (a re-add of identical bytes).
  if (String(diffText).trim() === "") return [];
  const added = parseChangedLineRanges(diffText);
  const removed = parseRemovedLineRanges(diffText);
  // Output that carries no hunk at all — "Binary files ... differ", a
  // mode-only record — is a change whose lines cannot be read: fail closed
  // rather than read it as "nothing changed".
  if (added.length === 0 && removed.length === 0) return every;

  const touched = new Set();
  // BOTH sides of the cut. A deleted or rebound line exists only in the BASE
  // file, so a head-only reader attributes a removal to the entries that
  // closed over the gap and loses the pin that owned it (cinatra#3421).
  for (const side of [
    { text: contractText, ranges: added },
    { text: baseContractText, ranges: removed },
  ]) {
    if (side.ranges.length === 0) continue;
    if (side.text === undefined) return every;
    const owners = driverLineOwners(side.text, pinSurfaceIds);
    if (owners === null) return every;
    const lineCount = owners.length - 1;
    for (const range of side.ranges) {
      for (let line = Math.max(1, range.start); line <= Math.min(range.end, lineCount); line += 1) {
        const owner = owners[line];
        if (owner === EVERY_PIN) return every;
        if (owner !== null) for (const pinId of owner) touched.add(pinId);
      }
    }
  }
  return every.filter((id) => touched.has(id));
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
      // The path diff is three-dot, so its base side is the MERGE BASE — every
      // base-side read has to name the same commit or it compares against a
      // target tip the branch never saw.
      let mergeBase;
      try {
        mergeBase = runGit(["merge-base", base, "HEAD"]).trim() || base;
      } catch {
        mergeBase = undefined; // fail-closed: every id
      }
      let changedMapPinIds;
      if (touchedPaths.includes(MAP_PATH)) {
        try {
          if (mergeBase === undefined) throw new Error("no merge base");
          changedMapPinIds = changedMapPinIdsBetween(
            runGit(["show", `${mergeBase}:${MAP_PATH}`]),
            readFileSync(resolve(REPO_ROOT, MAP_PATH), "utf8"),
          );
        } catch {
          changedMapPinIds = undefined; // fail-closed: every id
        }
      }
      let driverPinIds;
      if (touchedPaths.includes(DRIVER_FILE_PATH)) {
        try {
          if (mergeBase === undefined) throw new Error("no merge base");
          driverPinIds = driverFilePinIds({
            contractText: readFileSync(resolve(REPO_ROOT, DRIVER_FILE_PATH), "utf8"),
            // The base-side text the removed lines are numbered against.
            baseContractText: runGit(["show", `${mergeBase}:${DRIVER_FILE_PATH}`]),
            // Zero context: a hunk header must name the lines that changed and
            // not the three either side, or a one-block edit would read as the
            // blocks around it.
            diffText: runGit(["diff", "--unified=0", `${base}...HEAD`, "--", DRIVER_FILE_PATH]),
            pinSurfaceIds: loadPinSurfaceIds(map),
            allIds: Object.keys(map.pins),
          });
        } catch {
          driverPinIds = undefined; // fail-closed: every id
        }
      }
      touchedPinIds = resolveTouchedPinIds({
        touchedPaths,
        map,
        changedPinIds,
        changedMapPinIds,
        driverPinIds,
      });
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
