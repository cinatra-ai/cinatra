#!/usr/bin/env node
// THE ANCHORS A CONTRACT REQUIRES MUST RESOLVE IN THE DRAWING IT CITES
// (cinatra#3144 G4).
//
// The anchor contract binds three inputs into one digest and re-ratifies by
// hand. It hashes NOTHING from the drawings, so a contract can record an anchor
// that no drawing under its pin draws, be re-ratified without anyone re-reading
// it, and stay green for ever. Two defects produce that state and this checker
// separates them:
//
//   · an anchor no governed drawing draws at all — the clerical re-ratification
//     the contract's own prose asks the maintainer to avoid;
//   · an anchor drawn in a SIBLING drawing the pin does not govern — invisible
//     while a pin named one drawing path, which is why the pin now carries the
//     SET of paths its revision governs (scripts/ci/lib/design-pin.mjs).
//
// WHAT IT READS. Every selector in `domExpectations.*.ownerAnchors`, and every
// capture requirement recomputed LIVE from the recorder contract by
// scripts/audit/lib/anchor-contract.mjs — the same third digest input the
// acceptance gate recomputes, so a requirement that changed is a requirement
// this check re-reads.
//
// WHERE THE DRAWINGS COME FROM. A checked-out copy named by
// DESIGN_DRAWINGS_DIR, or the authenticated reader design-pin-freshness uses,
// at the contract's own pinned revision. With neither, the gate exits 2 — the
// "could not run honestly" convention — rather than certifying anchors it never
// compared.
//
// MATCHING IS EXACT, NOT SUBSTRING. A raw text search over a drawing admits
// false positives: a selector quoted in prose or shown in a code sample would
// "resolve". This checker parses each drawing's TAGS, ignoring comments and the
// contents of pre/code/script/style, and matches attribute NAMES and VALUES
// exactly, element by element.
//
// THREE SELECTOR FORMS ARE DECIDED, and together they are every form the
// recorded set carries:
//
//   · ONE ATTRIBUTE PREDICATE — `[a]`, `[a="v"]` — resolved against the
//     drawing's attributes;
//   · a COMPOUND of attribute predicates — `[a][b="v"]` — resolved against ONE
//     ELEMENT satisfying every term, never against terms scattered over
//     different elements;
//   · a single CLASS TOKEN — `.frame` — resolved against the elements whose
//     class list carries that token, as a token and not as a substring.
//
// The last two are why a drawing is indexed per element as well as flat: a flat
// attribute index answers each term of a compound on its own, and a matcher
// that read it would certify an anchor no single element draws.
//
// EVERY OTHER SELECTOR FORM IS A HARD FAILURE, never a silent pass and never an
// approximated match — a descendant combinator, a tag or id selector, a
// compound of classes, a class beside an attribute predicate, an operator other
// than `=`, an unquoted value. It is REPORTED, by name, as `refused`, and the
// run exits 2 — the "could not run honestly" convention — because a selector
// this matcher cannot decide is one it may not certify in either direction. The
// rest of the set is still read and still printed, so a refusal names itself
// instead of hiding what the run did decide, and its suite pins that.
//
// WHAT IT PRINTS. Kind names, origins, the selectors it was given, and which
// GOVERNED DRAWING (by its position in the pin's own set) resolved each one.
// No drawing text, no drawing path, no revision: the report is about this
// repository's own recorded claims, and the drawings are not public.
//
// IT IS RED TODAY, and that is the point: the recorded owner anchors do not
// resolve at the pin the contract names. It is landed warn-first — its context
// is not required until a separate pull request adds it — so the state is
// visible without blocking, and it stays red until the anchor content itself
// moves.
//
// Usage:
//   node scripts/ci/design-anchor-resolution.mjs
//   node scripts/ci/design-anchor-resolution.mjs --github-annotations
//   node scripts/ci/design-anchor-resolution.mjs --print-unresolved
//
// Exit codes:
//   0  every recorded anchor resolves, or the finding only warns for this event
//   1  a recorded anchor resolves in no governed drawing, under a red event
//   2  the gate could not run honestly (no drawings, a missing drawing, a
//      refused selector form, an unreadable pin or contract)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANCHOR_CONTRACT_KINDS,
  captureAnchorExpectations,
  loadAnchorContract,
} from "../audit/lib/anchor-contract.mjs";
import { resolveEvent } from "./design-pin-drift.mjs";
import {
  ANCHOR_RESOLUTION_CHECKER_PATH,
  DRAWINGS_DIR_ENV,
  DesignPinError,
  DesignSourceError,
  GLOBAL_PATHS,
  MAP_PATH,
  TOKEN_ENV,
  createDesignSourceReader,
  loadGatePathMap,
  publicReason,
  readCommitBearingPins,
  resolveTouchedPins,
} from "./lib/design-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CHECKER_PATH = ANCHOR_RESOLUTION_CHECKER_PATH;
export { GLOBAL_PATHS, MAP_PATH };

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export class UnsupportedSelectorError extends Error {}

// One `[name]` or `[name="value"]` term, matched STICKILY so a compound is read
// term by term and anything between two terms — a space, a dot, a combinator —
// ends the parse instead of being skipped over.
const ATTRIBUTE_TERM_RE = /\[([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:=(?:"([^"]*)"|'([^']*)'))?\]/y;
const CLASS_SELECTOR_RE = /^\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)$/;

/**
 * The three selector forms this matcher decides, as a parsed shape:
 *
 *   `[a]` / `[a="v"]`   -> { form: "attribute", attribute, value, terms: [term] }
 *   `[a][b="v"]`        -> { form: "compound", terms: [term, term, …] }
 *   `.token`            -> { form: "class", className }
 *
 * `attribute` and `value` stay on the single-predicate shape so that form reads
 * exactly as it always has. Everything else — a descendant combinator, a tag or
 * id selector, a compound of classes, a class beside an attribute predicate, an
 * operator other than `=`, an unquoted value, an empty selector — is refused,
 * because approximating it would be a verdict this matcher did not reach.
 */
export function parseAnchorSelector(selector) {
  if (typeof selector !== "string") throw new UnsupportedSelectorError("a selector must be text");
  const text = selector.trim();
  const refuse = () => {
    throw new UnsupportedSelectorError(
      `the selector ${selector} is outside the forms this matcher decides — one attribute ` +
        "predicate, a compound of attribute predicates, or one class token; this matcher " +
        "refuses a form it would have to approximate",
    );
  };

  if (text.startsWith(".")) {
    const match = CLASS_SELECTOR_RE.exec(text);
    if (!match) refuse();
    return { form: "class", className: match[1], attribute: null, value: null, terms: [] };
  }

  if (!text.startsWith("[")) refuse();
  const terms = [];
  ATTRIBUTE_TERM_RE.lastIndex = 0;
  while (ATTRIBUTE_TERM_RE.lastIndex < text.length) {
    const match = ATTRIBUTE_TERM_RE.exec(text);
    if (!match) refuse();
    terms.push({ attribute: match[1], value: match[2] ?? match[3] ?? null });
  }
  if (terms.length === 0) refuse();
  if (terms.length === 1) {
    return { form: "attribute", attribute: terms[0].attribute, value: terms[0].value, terms };
  }
  return { form: "compound", attribute: null, value: null, terms };
}

// ---------------------------------------------------------------------------
// The drawing, as attributes
// ---------------------------------------------------------------------------

const HIDDEN_BLOCKS = /<(pre|code|script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Index one drawing, reading TAGS only, in two shapes over the SAME parse:
 *
 *   `attributes` — `Map<attribute, Set<value|null>>` for the whole drawing,
 *                  which decides a single attribute predicate;
 *   `elements`   — one `{ attributes: Map<name, value|null>, classes: Set }`
 *                  per tag, which is what a compound predicate and a class
 *                  token are questions ABOUT: both ask what ONE element
 *                  carries, and the flat index cannot answer that.
 *
 * Comments and the contents of pre/code/script/style are removed first: a
 * selector shown as a code sample is documentation, not a drawn anchor, and a
 * matcher that counted it would certify an anchor nothing draws.
 */
export function drawingIndexOf(text) {
  const scrubbed = String(text)
    .replace(COMMENTS, " ")
    .replace(HIDDEN_BLOCKS, (_all, tag, attrs) => `<${tag}${attrs}></${tag}>`);
  const attributes = new Map();
  const elements = [];
  for (const tag of scrubbed.matchAll(TAG)) {
    const attrs = tag[2] ?? "";
    const own = new Map();
    const classes = new Set();
    for (const attr of attrs.matchAll(ATTR)) {
      // HTML attribute names are case-insensitive, so the index folds them.
      // A drawing written `DATA-CONFORMANCE=` draws the same anchor as one
      // written `data-conformance=`, and a matcher that said otherwise would
      // report a drawn anchor unresolved. Values are NOT folded: an attribute
      // VALUE is case-sensitive and a conformance id is one.
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? null;
      if (!attributes.has(name)) attributes.set(name, new Set());
      attributes.get(name).add(value);
      // A repeated attribute on one tag is the FIRST one, which is what an HTML
      // parser keeps; the flat index above still records both values, because
      // there it is a question about the drawing rather than about an element.
      const firstOnThisElement = !own.has(name);
      if (firstOnThisElement) own.set(name, value);
      if (name === "class" && firstOnThisElement && value !== null) {
        // A class attribute is a TOKEN LIST. Splitting it is the difference
        // between `.cw-frame` resolving against `class="cw-frame is-open"` and
        // resolving against `class="cw-frame-outer"`, which it must not.
        //
        // Only the FIRST `class` on an element is tokenized, for the same
        // reason the first value is the one kept: an HTML parser drops a
        // second `class` attribute, so tokenizing it would answer for a
        // class the DOM does not carry.
        //
        // The split is ASCII whitespace ONLY - space, tab, line feed, form
        // feed, carriage return - which is what HTML calls a class-token
        // separator. A `\s` split would also break on a no-break space,
        // and `class="a\u00a0b"` is ONE token in the DOM, not two.
        for (const token of value.split(/[ \t\n\f\r]+/)) if (token !== "") classes.add(token);
      }
    }
    elements.push({ attributes: own, classes });
  }
  return { attributes, elements };
}

/**
 * The flat half of the index, on its own. Kept because a single attribute
 * predicate is a question about the DRAWING and reads no elements — the form
 * this matcher has always decided, decided exactly as it was.
 */
export function attributeIndexOf(text) {
  return drawingIndexOf(text).attributes;
}

/**
 * Does `selector` resolve in an indexed drawing? Exact, name and value, and —
 * for the two per-element forms — exact about WHICH element carries what.
 *
 * `index` is a drawing index from `drawingIndexOf`, or the flat map
 * `attributeIndexOf` returns, which can only answer for one attribute
 * predicate and says so rather than guessing.
 */
export function resolvesIn(index, selector) {
  const parsed = parseAnchorSelector(selector);
  const attributes = index instanceof Map ? index : index.attributes;
  const elements = index instanceof Map ? null : index.elements;

  if (parsed.form === "attribute") {
    const values = attributes.get(parsed.attribute.toLowerCase());
    if (!values) return false;
    return parsed.value === null ? true : values.has(parsed.value);
  }

  if (elements === null) {
    throw new UnsupportedSelectorError(
      `the selector ${selector} is decided one element at a time, and this index carries only ` +
        "the drawing's attributes; index the drawing with drawingIndexOf",
    );
  }

  if (parsed.form === "class") {
    return elements.some((element) => element.classes.has(parsed.className));
  }

  // A compound resolves against ONE element satisfying EVERY term. Terms found
  // on different elements are not a match, and that is the whole point of it.
  return elements.some((element) =>
    parsed.terms.every((term) => {
      const name = term.attribute.toLowerCase();
      if (!element.attributes.has(name)) return false;
      return term.value === null ? true : element.attributes.get(name) === term.value;
    }),
  );
}

// ---------------------------------------------------------------------------
// The recorded anchors
// ---------------------------------------------------------------------------

/**
 * Every anchor this repository RECORDS: the owner anchors the contract carries,
 * and the capture requirements recomputed live from the recorder. The capture
 * entries are `"<selector> <scope> <expect> <within> <tier>"` and the cells with
 * no reachable subject record a `composition-only …` reason where their anchors
 * would be — the reason is not a selector and is skipped.
 */
export function collectRecordedAnchors({ anchorContract, captureAnchors = null }) {
  const anchors = [];
  const carriage = anchorContract?.domExpectations?.carriage ?? {};
  for (const kind of ANCHOR_CONTRACT_KINDS) {
    for (const selector of carriage[kind]?.ownerAnchors ?? []) {
      anchors.push({ kind, origin: "ownerAnchors", selector });
    }
  }
  if (captureAnchors) {
    const seen = new Set();
    for (const [host, cells] of Object.entries(captureAnchors)) {
      for (const [cell, entries] of Object.entries(cells)) {
        for (const entry of entries) {
          if (typeof entry !== "string" || entry.startsWith("composition-only")) continue;
          const selector = entry.split(" ")[0];
          const kind = cell === "*" ? host : cell.split("|")[0];
          const key = `${kind}::${selector}`;
          if (seen.has(key)) continue;
          seen.add(key);
          anchors.push({ kind, origin: "capture", selector });
        }
      }
    }
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Resolve every anchor against the drawings the pin governs. `governed` is in
 * the pin's own path order — the reported position is that order's, never the
 * path itself. `others` are drawings the pin does NOT govern: an anchor found
 * only there is UNRESOLVED, and the report says so in those words, because that
 * is the second defect and it is not the same as an anchor drawn nowhere.
 *
 * A selector this matcher cannot decide is `refused` — never quietly counted as
 * resolved and never counted as unresolved either, because both would be a
 * verdict the matcher did not reach. The caller turns a non-empty `refused`
 * into exit 2.
 */
export function checkAnchorResolution({ pin, anchors, governed, others = [], siblingsKnown = true }) {
  const governedIndexes = governed.map((d) => drawingIndexOf(d.text));
  const otherIndexes = others.map((d) => drawingIndexOf(d.text));
  const results = [];
  for (const anchor of anchors) {
    try {
      parseAnchorSelector(anchor.selector);
    } catch (err) {
      if (!(err instanceof UnsupportedSelectorError)) throw err;
      results.push({ ...anchor, status: "refused", governedIndex: null, elsewhere: false });
      continue;
    }
    let governedIndex = null;
    for (let i = 0; i < governedIndexes.length; i += 1) {
      if (resolvesIn(governedIndexes[i], anchor.selector)) {
        governedIndex = i + 1;
        break;
      }
    }
    const elsewhere =
      governedIndex === null && otherIndexes.some((idx) => resolvesIn(idx, anchor.selector));
    results.push({
      ...anchor,
      status: governedIndex === null ? "unresolved" : "resolved",
      governedIndex,
      elsewhere,
    });
  }
  return {
    pinId: pin.id,
    governedCount: governed.length,
    siblingsKnown,
    results,
    unresolved: results.filter((r) => r.status === "unresolved"),
    refused: results.filter((r) => r.status === "refused"),
  };
}

/** The report. Kinds, origins, selectors, positions — no drawing text. */
export function formatReport(report) {
  const lines = [`pin "${report.pinId}" — ${report.results.length} recorded anchor(s)`];
  const byKind = new Map();
  for (const r of report.results) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  for (const [kind, entries] of byKind) {
    lines.push(`  ${kind}`);
    for (const r of entries) {
      const where =
        r.status === "refused"
          ? "REFUSED — this matcher does not decide a selector of this form"
          : r.status === "resolved"
            ? `resolved in governed drawing ${r.governedIndex}`
            : r.elsewhere
              ? "UNRESOLVED — it resolves only in a drawing this pin does not govern"
              : report.siblingsKnown === false
                ? "UNRESOLVED — no governed drawing draws it (the sibling drawings were not read, " +
                  "so this run cannot say whether one of them does)"
                : "UNRESOLVED — no governed drawing draws it";
      lines.push(`    ${r.selector}  [${r.origin}]  ${where}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The subject of this gate is the pin set as a whole, so any diff that touches
 * a mapped path adopts the finding. Warn-annotate elsewhere; red on a push to
 * main and on dispatch.
 */
export function decide({ event, report, touchedPinIds }) {
  const any = report.unresolved.length > 0;
  const alwaysRed = event === "push-main" || event === "workflow_dispatch";
  const red = any && (alwaysRed || touchedPinIds.length > 0);
  return { red, warn: any && !red, exitCode: red ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

/** Read the governed drawings, and the siblings a local copy also carries. */
export async function loadDrawings({ pin, env, createReader = createDesignSourceReader }) {
  const dir = (env[DRAWINGS_DIR_ENV] ?? "").trim();
  if (dir !== "") {
    const governed = pin.paths.map((path) => {
      const absolute = join(dir, path);
      if (!existsSync(absolute)) {
        throw new DesignPinError("a drawing this pin governs is missing from the local copy");
      }
      return { path, text: readFileSync(absolute, "utf8") };
    });
    const others = [];
    const specs = join(dir, "specs");
    if (existsSync(specs)) {
      for (const name of readdirSync(specs)) {
        const path = `specs/${name}`;
        if (!name.endsWith(".html") || pin.paths.includes(path)) continue;
        others.push({ path, text: readFileSync(join(specs, name), "utf8") });
      }
    }
    return { governed, others, siblingsKnown: true };
  }

  const reader = createReader({ token: env[TOKEN_ENV] });
  if (!reader) throw new DesignPinError(publicReason("no-credential"));
  const governed = [];
  for (const path of pin.paths) {
    governed.push({ path, text: await reader.drawingAt({ path, revision: pin.revision }) });
  }
  // A remote read answers for the drawings the pin NAMES and nothing else: the
  // sibling set is only knowable from a copy, and guessing it would invent the
  // very distinction this check exists to make. So the run says it did not read
  // them rather than reporting "no governed drawing draws it" as though it had
  // looked — an unread sibling is an unanswered question, not a negative answer.
  return { governed, others: [], siblingsKnown: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function annotate(log, level, title, message) {
  log(`::${level} title=${title}::${message.replace(/\r?\n/g, "%0A")}`);
}

export async function runCli({
  argv = [],
  env = {},
  repoRoot = REPO_ROOT,
  pins: pinsInput,
  anchors: anchorsInput,
  recordedUnresolved: recordedUnresolvedInput,
  createReader = createDesignSourceReader,
  runGit = git,
  log = console.log,
  logError = console.error,
} = {}) {
  const annotations = argv.includes("--github-annotations");
  const printUnresolved = argv.includes("--print-unresolved");
  const event = resolveEvent({ argv, env });
  const cannotRun = (message) => {
    logError(`ERROR: the gate could not run honestly: ${message}`);
    return 2;
  };

  let pins;
  let anchors;
  let recordedUnresolved;
  try {
    pins = typeof pinsInput === "function" ? pinsInput() : (pinsInput ?? readCommitBearingPins(repoRoot));
    const contract = anchorsInput && recordedUnresolvedInput !== undefined ? null : loadAnchorContract();
    anchors =
      anchorsInput ??
      collectRecordedAnchors({
        anchorContract: contract,
        captureAnchors: captureAnchorExpectations(),
      });
    recordedUnresolved =
      recordedUnresolvedInput !== undefined
        ? recordedUnresolvedInput
        : contract?.anchorsUnresolvedAtPin;
  } catch (err) {
    return cannotRun(err instanceof DesignPinError ? err.message : "the pin or the contract could not be read");
  }

  let touchedPinIds = [];
  const alwaysRed = event === "push-main" || event === "workflow_dispatch";
  if (!alwaysRed) {
    let map;
    try {
      map = loadGatePathMap(repoRoot);
    } catch (err) {
      return cannotRun(err instanceof DesignPinError ? err.message : "the path map could not be read");
    }
    const base = (env.DESIGN_PIN_DRIFT_DIFF_BASE ?? "").trim();
    if (base === "") {
      log("::notice::no diff base is set — treating every pin as touched (fail-closed).");
      touchedPinIds = Object.keys(map.pins);
    } else {
      let touchedPaths;
      try {
        runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
        touchedPaths = runGit(["diff", "--name-only", `${base}...HEAD`])
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      } catch {
        return cannotRun("the diff base does not resolve to a revision in this checkout");
      }
      touchedPinIds = resolveTouchedPins({ touchedPaths, map, globalPaths: GLOBAL_PATHS });
    }
  }

  const reports = [];
  for (const pin of pins) {
    let drawings;
    try {
      drawings = await loadDrawings({ pin, env, createReader });
    } catch (err) {
      if (err instanceof DesignSourceError) return cannotRun(`${err.message}.`);
      return cannotRun(
        err instanceof DesignPinError ? `${err.message}.` : "the drawings could not be read.",
      );
    }
    const pinAnchors = anchors.filter((a) => a.pinId === undefined || a.pinId === pin.id);
    reports.push(
      checkAnchorResolution({
        pin,
        anchors: pinAnchors,
        governed: drawings.governed,
        others: drawings.others,
        siblingsKnown: drawings.siblingsKnown !== false,
      }),
    );
  }

  const merged = {
    unresolved: reports.flatMap((r) => r.unresolved),
    refused: reports.flatMap((r) => r.refused),
  };

  if (printUnresolved) {
    // This is the road the adoption script reads. A refused selector means this
    // matcher reached NO verdict on it, so the set is incomplete — printing it
    // anyway would let an adoption record a partial `anchorsUnresolvedAtPin`
    // and derive a valid digest over it. Answer nothing, and say why.
    if (merged.refused.length > 0) {
      return cannotRun(
        "the recorded set carries a selector form this matcher refuses to approximate, so the " +
          "unresolved set is incomplete and is not printed: " +
          `${merged.refused.map((r) => r.selector).join(", ")}.`,
      );
    }
    log(JSON.stringify([...new Set(merged.unresolved.map((r) => r.selector))].sort()));
    return 0;
  }

  // G0 records `anchorsUnresolvedAtPin` as the set THIS check reports at the
  // pin, and the digest binds it — but a digest only proves the array was not
  // edited afterwards, never that it was true when it was written. So while the
  // key is present, this is the script that compares the two. It is absent
  // today, so this decides nothing yet and cannot.
  if (Array.isArray(recordedUnresolved)) {
    const found = [...new Set(merged.unresolved.map((r) => r.selector))].sort();
    const recorded = [...new Set(recordedUnresolved)].sort();
    if (JSON.stringify(found) !== JSON.stringify(recorded)) {
      const missing = found.filter((s) => !recorded.includes(s));
      const extra = recorded.filter((s) => !found.includes(s));
      logError(
        "ERROR: `anchorsUnresolvedAtPin` is not what this check finds at the pin it is recorded " +
          "under — a digest proves the array was not edited, never that it was true.",
      );
      if (missing.length > 0) logError(`  unresolved and unrecorded: ${missing.join(", ")}`);
      if (extra.length > 0) logError(`  recorded and not unresolved: ${extra.join(", ")}`);
      return 1;
    }
  }

  for (const report of reports) log(formatReport(report));
  log("");

  const verdict = decide({ event, report: merged, touchedPinIds });
  const text = reports.map(formatReport).join("\n");

  if (merged.refused.length > 0) {
    logError(text);
    return cannotRun(
      "the recorded set carries a selector form this matcher refuses to approximate: " +
        `${merged.refused.map((r) => r.selector).join(", ")}. Every other anchor is reported above.`,
    );
  }

  if (merged.unresolved.length === 0) {
    log("ok: every recorded anchor resolves in a drawing its pin governs.");
    return 0;
  }
  if (verdict.warn) {
    log(`WARNING (this diff touches no path mapped to the pin)\n${text}`);
    if (annotations) annotate(log, "warning", "design-anchor-resolution", text);
    return 0;
  }
  logError("ERROR: a recorded anchor resolves in no drawing the pin it is recorded under governs.");
  logError("");
  logError(text);
  if (annotations) annotate(log, "error", "design-anchor-resolution", text);
  return 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exit(await runCli({ argv: process.argv.slice(2), env: process.env }));
}
