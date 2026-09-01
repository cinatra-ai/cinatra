// THE DESIGN PIN, as a grammar, a reader and a trigger rule (cinatra#3144).
//
// Three gates in this directory ask the same three questions of the same pin:
//
//   design-pin-freshness.mjs      is the pin still the current one?
//   design-anchor-resolution.mjs  do the anchors it records resolve in the
//                                 drawings it governs?
//   design-record-grammar.mjs     does a graded record name the pin it was
//                                 graded against?
//
// Everything the three share lives here so the grammar cannot be read one way
// by one gate and another way by the next: the pin's own syntax, the reader
// that asks the design source, and the touched-path rule the gates trigger on.
//
// THE GRAMMAR. A pin is
//
//     design@<forty-character revision id> <drawing path> [<drawing path> ...]
//
// One revision, and the SET of drawing paths that revision governs. The set is
// the part cinatra#3144 adds: a pin naming one path while the kinds it governs
// are drawn across more than one cannot tell an anchor drawn in a sibling
// drawing apart from an anchor drawn nowhere, and that ambiguity is exactly
// what design-anchor-resolution.mjs exists to remove. Existing single-path
// values parse unchanged — a set of one is a set.
//
// WHAT MAY BE SAID OUT LOUD. The design source is not publicly readable, so
// every string this file hands a gate to print is CLOSED text chosen here. No
// revision id, no drawing path, no count, no date, and none of the answer the
// source gave. `publicReason` below is the whole vocabulary a failed read may
// be described with, and its suites assert that the vocabulary carries no
// digit at all — a count and a date are both facts about a private source, and
// the cheapest way to keep them out of a public log is to keep every number
// out.
//
// Dependency-free: node builtins only, so the pure-node gate jobs run the
// three checkers without an install.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// The design source
// ---------------------------------------------------------------------------

/**
 * The source the pin points into. It is named HERE, in a gate's own source,
 * and nowhere a gate prints — exactly as design-pin-drift.mjs's subject is
 * named by the pin file it reads rather than by the messages it writes.
 */
export const DESIGN_SOURCE_OWNER = "cinatra-ai";
export const DESIGN_SOURCE_NAME = "design";
export const DESIGN_SOURCE_API = "https://api.github.com";

/** The environment the job hands the credential and the local copy through. */
export const TOKEN_ENV = "DESIGN_SOURCE_TOKEN";
export const DRAWINGS_DIR_ENV = "DESIGN_DRAWINGS_DIR";

/** The namespace every pin value begins with. */
export const PIN_NAMESPACE = "design";

// ---------------------------------------------------------------------------
// The three gates, and the ONE global set they share
// ---------------------------------------------------------------------------

export const FRESHNESS_CHECKER_PATH = "scripts/ci/design-pin-freshness.mjs";
export const ANCHOR_RESOLUTION_CHECKER_PATH = "scripts/ci/design-anchor-resolution.mjs";
export const RECORD_GRAMMAR_CHECKER_PATH = "scripts/ci/design-record-grammar.mjs";
export const PIN_LIB_PATH = "scripts/ci/lib/design-pin.mjs";
export const MAP_PATH = "scripts/ci/design-pin-gates.paths.json";
export const WORKFLOW_PATH = ".github/workflows/gates.yml";

/**
 * The paths that change what these gates decide. Touching one of them touches
 * EVERY pin id: after a change to a checker, to this shared library, to the map
 * or to the workflow, no pin's silence is trustworthy any more. The three gates
 * share ONE set and ONE map because they share one rule — a set per gate would
 * let a change to the rule look untouched from two of the three.
 */
export const GLOBAL_PATHS = Object.freeze([
  FRESHNESS_CHECKER_PATH,
  ANCHOR_RESOLUTION_CHECKER_PATH,
  RECORD_GRAMMAR_CHECKER_PATH,
  PIN_LIB_PATH,
  MAP_PATH,
  WORKFLOW_PATH,
]);

const REVISION_RE = /^[0-9a-f]{40}$/;
const DRAWING_PATH_RE = /^specs\/[a-z0-9][a-z0-9-]*\.html$/;

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

export class DesignPinError extends Error {}

/**
 * Parse a pin into `{ revision, paths }`. Throws `DesignPinError` with CLOSED
 * text — the offending value is never echoed, because a malformed pin is still
 * a statement about a private source.
 */
export function parseSpecCommit(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new DesignPinError("the design pin is empty");
  }
  const parts = text.trim().split(/\s+/);
  const head = parts.shift();
  if (!head.startsWith(`${PIN_NAMESPACE}@`)) {
    throw new DesignPinError("the design pin does not begin with its own namespace prefix");
  }
  const revision = head.slice(PIN_NAMESPACE.length + 1);
  if (!REVISION_RE.test(revision)) {
    throw new DesignPinError("the design pin does not name a lowercase forty-character revision id");
  }
  if (parts.length === 0) {
    throw new DesignPinError("the design pin governs no drawing path");
  }
  const seen = new Set();
  for (const path of parts) {
    if (!DRAWING_PATH_RE.test(path)) {
      throw new DesignPinError("the design pin names a drawing path in an unsupported form");
    }
    if (seen.has(path)) {
      throw new DesignPinError("the design pin names the same drawing twice");
    }
    seen.add(path);
  }
  return { revision, paths: parts };
}

/** The inverse — the one place a pin value is composed. */
export function formatSpecCommit({ revision, paths }) {
  const pin = `${PIN_NAMESPACE}@${revision} ${[...paths].join(" ")}`;
  parseSpecCommit(pin); // never emit a value this file would refuse to read
  return pin;
}

// ---------------------------------------------------------------------------
// The commit-bearing pins
// ---------------------------------------------------------------------------

/**
 * The pins that carry a REVISION, which are the only ones a freshness question
 * can be asked of. `tests/e2e/design/conformance-pins.json` carries content
 * hashes and file names rather than revisions and stays design-pin-drift's
 * subject; this list does not name it.
 *
 * `authority` is the file the program declares the pin in; `mirror` is the
 * readable copy the anchor contract keeps. The two must agree — the acceptance
 * gate already refuses a disagreement, and the gates here refuse to answer
 * while one exists rather than answering for whichever file they read first.
 */
export const COMMIT_BEARING_PINS = Object.freeze([
  Object.freeze({
    id: "chat-hitl-lifecycle",
    authority: "scripts/audit/chat-hitl-acceptance-manifest.json",
    mirror: "scripts/audit/chat-hitl-anchor-contract.json",
  }),
]);

/**
 * Read every commit-bearing pin from a tree. Returns
 * `[{ id, authority, mirror, revision, paths }]`.
 *
 * Throws `DesignPinError` (CLOSED text) when a file is unreadable, a pin is
 * missing, a pin does not parse, or the mirror disagrees with the authority.
 */
export function readCommitBearingPins(repoRoot, { readImpl = readFileSync } = {}) {
  const out = [];
  for (const pin of COMMIT_BEARING_PINS) {
    let authority;
    let mirror;
    try {
      authority = JSON.parse(readImpl(resolve(repoRoot, pin.authority), "utf8"));
      mirror = JSON.parse(readImpl(resolve(repoRoot, pin.mirror), "utf8"));
    } catch {
      throw new DesignPinError(`the pin files for "${pin.id}" could not be read`);
    }
    if (typeof authority.specCommit !== "string") {
      throw new DesignPinError(`"${pin.id}" declares no design pin in ${pin.authority}`);
    }
    if (authority.specCommit !== mirror.specCommit) {
      throw new DesignPinError(
        `"${pin.id}" is mirrored in ${pin.mirror} as a different value than ${pin.authority} declares`,
      );
    }
    const parsed = parseSpecCommit(authority.specCommit);
    out.push({ ...pin, revision: parsed.revision, paths: parsed.paths });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** The whole vocabulary a failed read may be described with. No digits. */
export const READ_REASONS = Object.freeze({
  "no-credential": "no credential for the design source is present",
  unauthorized: "the design source refused the read",
  "read-failed": "the read did not complete",
  "unreadable-answer": "the answer could not be read as data",
  "answer-too-long": "the answer is longer than this gate reads in one run",
});

export class DesignSourceError extends Error {
  constructor(reason) {
    super(READ_REASONS[reason] ?? READ_REASONS["read-failed"]);
    this.reason = reason;
  }
}

/** The public sentence for a failed read — CLOSED text, never the answer. */
export function publicReason(reason) {
  return READ_REASONS[reason] ?? READ_REASONS["read-failed"];
}

const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * A reader for the design source, or `null` when no credential is present —
 * the caller turns that into the fail-closed exit rather than certifying an
 * uninspected pin.
 *
 * `fetchImpl` is injected by the suites; nothing here parses or echoes a body
 * beyond the two fields it needs (`default_branch`, `sha`).
 */
export function createDesignSourceReader({
  token,
  fetchImpl = fetch,
  api = DESIGN_SOURCE_API,
  owner = DESIGN_SOURCE_OWNER,
  name = DESIGN_SOURCE_NAME,
} = {}) {
  if (typeof token !== "string" || token.trim() === "") return null;
  const base = `${api}/repos/${owner}/${name}`;

  async function get(url, { raw = false } = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "cinatra-design-pin-gate",
        },
      });
    } catch {
      throw new DesignSourceError("read-failed");
    }
    const status = Number.isInteger(res?.status) ? res.status : 0;
    if (status === 401 || status === 403 || status === 404) {
      throw new DesignSourceError("unauthorized");
    }
    if (res?.ok !== true) throw new DesignSourceError("read-failed");
    if (raw) {
      try {
        return await res.text();
      } catch {
        throw new DesignSourceError("unreadable-answer");
      }
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new DesignSourceError("unreadable-answer");
    }
    return body;
  }

  return {
    async defaultBranch() {
      const body = await get(base);
      const branch = body?.default_branch;
      if (typeof branch !== "string" || branch === "") {
        throw new DesignSourceError("unreadable-answer");
      }
      return branch;
    },

    /**
     * Every revision reachable from `ref` that touches `path`, newest first.
     * Fully paginated: a truncated list would make an un-adopted revision look
     * adopted, which is the fail-OPEN direction, so a list longer than this
     * gate reads in one run is refused instead.
     */
    async revisionsTouching({ ref, path }) {
      const shas = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url =
          `${base}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}` +
          `&per_page=${PER_PAGE}&page=${page}`;
        const body = await get(url);
        if (!Array.isArray(body)) throw new DesignSourceError("unreadable-answer");
        for (const entry of body) {
          if (typeof entry?.sha !== "string" || !REVISION_RE.test(entry.sha)) {
            throw new DesignSourceError("unreadable-answer");
          }
          shas.push(entry.sha);
        }
        if (body.length < PER_PAGE) return shas;
      }
      throw new DesignSourceError("answer-too-long");
    },

    async drawingAt({ path, revision }) {
      const url = `${base}/contents/${path}?ref=${encodeURIComponent(revision)}`;
      const text = await get(url, { raw: true });
      if (typeof text !== "string") throw new DesignSourceError("unreadable-answer");
      return text;
    },
  };
}

// ---------------------------------------------------------------------------
// The trigger rule
// ---------------------------------------------------------------------------

function pathTouches(touched, mapped) {
  return mapped.endsWith("/") ? touched.startsWith(mapped) : touched === mapped;
}

/**
 * design-pin-drift's rule, generalised over its global set so the three gates
 * here can reuse it rather than invent one: touching a global path touches
 * EVERY id (a change to a checker, its map or the workflow changes what the
 * gate itself decides, so no pin's silence is trustworthy afterwards), and
 * touching a mapped path touches that pin's id.
 */
export function resolveTouchedPins({ touchedPaths, map, globalPaths }) {
  const allIds = Object.keys(map.pins);
  const touched = new Set();
  for (const p of touchedPaths) {
    if (globalPaths.some((g) => pathTouches(p, g))) return allIds;
    for (const [id, mapped] of Object.entries(map.pins)) {
      if (mapped.some((m) => pathTouches(p, m))) touched.add(id);
    }
  }
  return allIds.filter((id) => touched.has(id));
}

/**
 * Load a path map and refuse one whose `globalPaths` is not exactly the
 * checker's own set — a map that could drop its own path from that list would
 * be a map that can disarm the rule by editing itself. Same refusal, and the
 * same reason, as design-pin-drift's `loadMap`.
 */
export function loadPathMap({ repoRoot, mapPath, globalPaths, readImpl = readFileSync }) {
  const map = JSON.parse(readImpl(resolve(repoRoot, mapPath), "utf8"));
  const declared = JSON.stringify(map.globalPaths);
  if (declared !== JSON.stringify([...globalPaths])) {
    throw new DesignPinError(
      `${mapPath} declares globalPaths ${declared}, but the checker's own set is ` +
        `${JSON.stringify([...globalPaths])}. The map may not narrow the rule that makes a ` +
        "change to the checker, the map or the workflow touch every pin.",
    );
  }
  if (map.pins === null || typeof map.pins !== "object" || Array.isArray(map.pins)) {
    throw new DesignPinError(`${mapPath} declares no pins object`);
  }
  return map;
}

/** The shared map, loaded against the shared global set. */
export function loadGatePathMap(repoRoot, { readImpl = readFileSync } = {}) {
  return loadPathMap({ repoRoot, mapPath: MAP_PATH, globalPaths: GLOBAL_PATHS, readImpl });
}
