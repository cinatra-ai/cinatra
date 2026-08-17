/**
 * THE HOST-ANCHORED CANONICAL CAPTURE INDEX — one recorder, one index, and a
 * validator that will not take a file name's word for anything.
 *
 * WHY THIS EXISTS. A capture round filed screenshots of the Agents page under
 * chat-cell names. Nothing caught it, because nothing in the pipeline ever
 * compared what a capture CLAIMED to show against what it RECORDED. A file name
 * is a label a human typed; it carries no authority. What carries authority is
 * the pair the recorder writes at capture time: the URL the page actually ended
 * on, and the frame-scoped anchors it actually found, with their counts.
 *
 * THE RULE. A capture declares a host. That host implies a URL class and a set
 * of frame-scoped anchors. If the declared host, the recorded URL and the
 * recorded anchors do not agree, the capture is mislabeled and the gate says so
 * — whatever the file is called, and whatever the README says.
 *
 * WHY THE VOCABULARY IS FRAME-SCOPED. `[data-conversation-list]` alone does NOT
 * identify a chat thread: the widget's transcript renders the same list inside
 * the embed frame. So chat_thread needs the `/chat` URL class AND the card
 * root's own `data-lifecycle-card-host="chat_thread"`, and site_widget needs the
 * outer `.cw-frame` and then the embed frame's own anchors. A selector found in
 * the wrong frame proves the wrong host.
 *
 * THERE IS ONE WAY TO MAKE A RECORD, and it is a browser. `observeCapture` is
 * the only exported record producer; the earlier `buildCaptureRecord`, which
 * stamped this module's provenance onto assertions handed to it, is gone. A
 * caller that wants an official record has to drive a page.
 *
 * IT OBSERVES; IT DOES NOT TAKE DICTATION. `observeCapture` resolves the outer
 * frame itself, counts it, ENTERS it, reads the frame's own URL, and counts the
 * inner anchors there. Nothing about the frames or the counts is accepted from
 * the caller, because a recorder that writes down what it was told is a
 * transcription of the claim, not evidence against it. The browser reaches this
 * module through a tiny `CapturePage` port (`url`, `count`, `frame`,
 * `screenshot`), so the audit tier stays dependency-free and runnable without an
 * install while the real driver is Playwright.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMIT, stated because a gate that overclaims is worse than none.
 * ---------------------------------------------------------------------------
 * `recordedBy` is a STRING, not provenance. Nothing here can stop a committer
 * hand-writing a record with the recorder's id, a real screenshot's real hash,
 * and fabricated counts of one. Binding pixels to assertions would need an
 * attested capture run, which this repo does not have for ANY committed
 * evidence file — the same trust boundary already applies to every screenshot in
 * `evidence/`.
 *
 * So be exact about what IS closed. This gate catches the mislabel and the
 * omission: a capture whose recorded URL contradicts its declared host, a
 * required anchor that was never looked for, one that was looked for and not
 * found, a cell name that contradicts its own record, a hash that does not match
 * the file, and — since the duplicate check below — one image doing duty as the
 * proof of several different cells. Those are the failures that actually
 * happened. Deliberate fabrication is a review and trust problem, and this
 * module does not pretend to solve it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The recorder's identity, stamped on every record it writes. */
export const RECORDER_ID = "scripts/audit/lib/chat-hitl-capture-recorder.mjs@1";

/** The current index schema. Bumping it is a deliberate, reviewed act. */
export const CAPTURE_INDEX_SCHEMA_VERSION = 1;

/** The four ruled hosts (§IX). */
export const CAPTURE_HOSTS = Object.freeze([
  "chat_thread",
  "run_card",
  "page_gate_region",
  "site_widget",
]);

/** How a capture was built. Dispatch-dependent cells are labeled, never hidden. */
export const CAPTURE_BUILDS = Object.freeze(["production", "development"]);

/**
 * URL CLASSES, most specific first — a review page is also a run-detail path, so
 * order is part of the meaning.
 */
const URL_CLASS_ORDER = Object.freeze([
  ["embed_assistant", /^https?:\/\/[^/]+\/embed\/assistant(?:[/?#]|$)/],
  [
    "review_page",
    /^https?:\/\/[^/]+\/agents\/[^/]+\/[^/]+\/[^/?#]+\/review\/[^/?#]+(?:[/?#]|$)/,
  ],
  ["run_detail", /^https?:\/\/[^/]+\/agents\/[^/]+\/[^/]+\/[^/?#]+(?:[/?#]|$)/],
  ["agents_index", /^https?:\/\/[^/]+\/agents(?:[/?#]|$)/],
  ["chat", /^https?:\/\/[^/]+\/chat(?:[/?#]|$)/],
]);

/** The URL class of a final URL. `other` means no app class matched. */
export function classifyUrl(finalUrl) {
  if (typeof finalUrl !== "string") return "other";
  for (const [name, re] of URL_CLASS_ORDER) {
    if (re.test(finalUrl)) return name;
  }
  return "other";
}

/**
 * The URL classes each host may be captured on.
 *
 * `site_widget` is deliberately unconstrained on the OUTER url — the widget
 * lives on somebody else's site, and its identity comes from the frames, which
 * are checked separately and strictly.
 */
export const HOST_URL_CLASSES = Object.freeze({
  chat_thread: Object.freeze(["chat"]),
  run_card: Object.freeze(["run_detail"]),
  page_gate_region: Object.freeze(["review_page"]),
  site_widget: null,
});

/**
 * The frame-scoped anchors a host REQUIRES. Every one must be recorded present
 * with a count of at least one; a required anchor that was never looked for is
 * exactly as bad as one that was not found.
 */
export const HOST_ANCHOR_REQUIREMENTS = Object.freeze({
  chat_thread: Object.freeze([
    { frame: "main", selector: "[data-conversation-list]" },
    { frame: "main", selector: '[data-lifecycle-card-host="chat_thread"]' },
  ]),
  run_card: Object.freeze([
    { frame: "main", selector: '[data-lifecycle-card-host="run_card"]' },
  ]),
  page_gate_region: Object.freeze([
    { frame: "main", selector: '[data-lifecycle-card-host="page_gate_region"]' },
  ]),
  site_widget: Object.freeze([
    { frame: "widget", selector: '[data-embed-assistant][data-phase="active"]' },
    { frame: "widget", selector: "[data-conversation-list]" },
    { frame: "widget", selector: '[data-lifecycle-card-host="site_widget"]' },
  ]),
});

/**
 * The DECISION CONTROLS a kind's card must show, per kind.
 *
 * A chat_thread capture of a lifecycle card proves the card is THERE; these
 * prove it is OPERABLE. A screenshot of a card with no controls is a screenshot
 * of a placeholder. Pinned against the held-turn contract's own owner anchors by
 * `chat-hitl-capture-index.test.mjs`, so the two cannot drift.
 */
export const KIND_REQUIRED_ACTIONS = Object.freeze({
  recommendation_hold: Object.freeze([
    '[data-action="confirm-run-recommendation"]',
    '[data-action="skip-run-recommendation"]',
  ]),
  artifact_review_gate: Object.freeze(['[data-conformance-id="review-gate-card"]']),
  trigger_schedule_proposal: Object.freeze([
    '[data-action="cancel-trigger-schedule"]',
    '[data-action="release-trigger-now"]',
  ]),
  verification_summary: Object.freeze([]),
});

export const LIFECYCLE_KINDS = Object.freeze(Object.keys(KIND_REQUIRED_ACTIONS));

/**
 * The states a capture can photograph, and why the distinction is not cosmetic.
 *
 * A PENDING card owes its decision controls; a SETTLED one owes their ABSENCE
 * and its own decided summary. Requiring the controls on every capture would
 * make an honest settled screenshot unindexable, and requiring nothing would let
 * a placeholder pass as either. So the required set is state-relative, and a
 * record has to say which state it photographed.
 */
export const CAPTURE_STATES = Object.freeze(["pending", "settled"]);

/** What a kind draws once it is decided. */
export const KIND_SETTLED_MARKERS = Object.freeze({
  recommendation_hold: "[data-run-recommendation-decision]",
  artifact_review_gate: '[data-conformance-id="review-gate-blocked"]',
  trigger_schedule_proposal: '[data-lifecycle-card-state="settled"]',
  verification_summary: '[data-lifecycle-card-state="settled"]',
});

/**
 * The anchors a chat_thread capture of `kind` must record present, IN THE SAME
 * FRAME: the conversation list, the card's own root, the host declaration, and
 * the kind's decision controls. This is the set the manifest binding requires,
 * so a cell that names chat_thread cannot be satisfied by a photograph of a
 * transcript with no card in it.
 */
export function chatThreadRequirementsFor(kind, state = "pending") {
  // The card's own root. Everything that describes THE CARD is counted inside
  // it: without that, a host declaration on an unrelated wrapper and a settled
  // marker borrowed from a different card satisfy the set while the card this
  // record names never settled at all.
  const root = `[data-lifecycle-card="${kind}"]`;
  const base = [
    // The transcript is a page-level fact, so it stays page-scoped.
    { frame: "main", selector: "[data-conversation-list]" },
    { frame: "main", selector: root },
    { frame: "main", within: root, selector: '[data-lifecycle-card-host="chat_thread"]' },
  ];
  if (state === "settled") {
    // The decision is done: its controls must be GONE, and the decided summary
    // must be there in their place. Both are observations, not inferences.
    return [
      ...base,
      { frame: "main", within: root, selector: KIND_SETTLED_MARKERS[kind], expect: "present" },
      ...(KIND_REQUIRED_ACTIONS[kind] ?? []).map((selector) => ({
        frame: "main",
        within: root,
        selector,
        expect: "absent",
      })),
    ];
  }
  return [
    ...base,
    ...(KIND_REQUIRED_ACTIONS[kind] ?? []).map((selector) => ({
      frame: "main",
      within: root,
      selector,
    })),
  ];
}

/** The frames a host must declare, with the selector that reaches each. */
export const HOST_FRAME_REQUIREMENTS = Object.freeze({
  chat_thread: Object.freeze([]),
  run_card: Object.freeze([]),
  page_gate_region: Object.freeze([]),
  site_widget: Object.freeze([
    { name: "widget", selector: ".cw-frame", urlClass: "embed_assistant" },
  ]),
});

const SHA256_RE = /^[0-9a-f]{64}$/;

/** The sha256 of a file on disk. */
export function hashFile(absPath, readImpl = readFileSync) {
  return createHash("sha256").update(readImpl(absPath)).digest("hex");
}

/**
 * Count each selector in each frame, through a caller-supplied reader.
 *
 * `queryCount(frameName, selector)` returns the number of matching elements in
 * that frame. The recorder never guesses a count and never records one it did
 * not observe.
 */
export function collectAssertions(specs, queryCount) {
  return specs.map((spec) => {
    const expected = spec.expect ?? "present";
    return {
      frame: spec.frame ?? "main",
      selector: spec.selector,
      expect: expected,
      count: queryCount(spec.frame ?? "main", spec.selector),
    };
  });
}

/**
 * OBSERVE one capture cell and write the record from what was seen.
 *
 * `page` is the CapturePage port:
 *   · `url()`               — the URL the page actually ended on
 *   · `count(selector)`     — how many elements match, in the MAIN frame
 *   · `countWithin(root, selector)` — how many match INSIDE the first `root`.
 *                             Card-relative anchors go through this, so a host
 *                             declaration on an unrelated wrapper cannot stand
 *                             in for the card's own
 *   · `frame(selector)`     — resolve the frame element `selector` reaches and
 *                             return `{ url(), count(selector) }` for INSIDE it,
 *                             or null when it does not resolve
 *   · `screenshot(absPath)` — write the image
 *
 * The recorder does the resolving, entering and counting. Nothing about frames,
 * URLs or counts is accepted from the caller: a host's required anchors are
 * derived from the host (and, for chat_thread, from the kind), looked for where
 * the host says they live, and written down with the counts observed — including
 * a count of zero, which is what makes a failed capture visible instead of
 * absent.
 */
export async function observeCapture({
  page,
  cell,
  declaredHost,
  kind = undefined,
  state = "pending",
  screenshot,
  build,
  extraAssertions = [],
  repoRoot = process.cwd(),
  readImpl = readFileSync,
  now = () => new Date().toISOString(),
}) {
  const finalUrl = await page.url();

  // 1. The frames the host requires: resolve, COUNT, enter, read the URL there.
  const frames = {};
  const frameHandles = new Map();
  for (const req of HOST_FRAME_REQUIREMENTS[declaredHost] ?? []) {
    const outerCount = await page.count(req.selector);
    const entered = outerCount > 0 ? await page.frame(req.selector) : null;
    frames[req.name] = {
      selector: req.selector,
      outerCount,
      // A frame that did not resolve records an empty URL, which fails the
      // URL-class check below rather than being quietly dropped.
      url: entered ? await entered.url() : "",
    };
    if (entered) frameHandles.set(req.name, entered);
  }

  // 2. The anchors the host (and kind) require, counted WHERE THEY LIVE.
  const required =
    declaredHost === "chat_thread" && kind
      ? chatThreadRequirementsFor(kind, state)
      : [...HOST_ANCHOR_REQUIREMENTS[declaredHost]];
  const specs = [
    ...required.map((r) => ({ ...r, expect: r.expect ?? "present" })),
    ...extraAssertions,
  ];

  const measure = async () => {
    const out = [];
    for (const spec of specs) {
      const frameName = spec.frame ?? "main";
      const reader = frameName === "main" ? page : (frameHandles.get(frameName) ?? null);
      const entry = {
        frame: frameName,
        selector: spec.selector,
        expect: spec.expect ?? "present",
        // An unresolved frame counts ZERO rather than skipping the assertion.
        count: 0,
      };
      if (spec.within) entry.within = spec.within;
      if (reader) {
        entry.count = spec.within
          ? await reader.countWithin(spec.within, spec.selector)
          : await reader.count(spec.selector);
      }
      out.push(entry);
    }
    return out;
  };

  const assertions = await measure();

  // 3. The image, written and then hashed from disk.
  const abs = join(repoRoot, screenshot);
  await page.screenshot(abs);

  // 4. MEASURE AGAIN. A page can move between the counts and the shutter —
  //    hydration, a poll, a streamed state change — and a record whose numbers
  //    describe one screen while its image shows another is worse than none.
  //    Anything that shifted fails the capture instead of being written down.
  const after = await measure();
  const drifted = assertions
    .map((a, i) => ({ a, b: after[i] }))
    .filter(({ a, b }) => !b || a.count !== b.count);
  if (drifted.length > 0) {
    throw new Error(
      `capture "${cell}" is not stable: ` +
        drifted
          .map(({ a, b }) => `${a.selector} counted ${a.count} then ${b?.count ?? "n/a"}`)
          .join("; ") +
        ". The screen changed between the measurement and the screenshot.",
    );
  }

  const record = {
    cell,
    declaredHost,
    finalUrl,
    build,
    screenshot,
    sha256: hashFile(abs, readImpl),
    capturedAt: now(),
    assertions,
    recordedBy: RECORDER_ID,
  };
  if (kind) record.kind = kind;
  if (declaredHost === "chat_thread") record.state = state;
  if (Object.keys(frames).length > 0) {
    record.frames = Object.fromEntries(
      Object.entries(frames).map(([name, f]) => [name, { selector: f.selector, url: f.url }]),
    );
  }
  return record;
}

/** The `__<host>__` token a cell name carries, when it carries one. */
export function hostTokenInCell(cell) {
  if (typeof cell !== "string") return null;
  for (const host of CAPTURE_HOSTS) {
    if (cell.includes(`__${host}__`) || cell.endsWith(`__${host}`)) return host;
  }
  return null;
}

/**
 * The lifecycle KIND a cell name claims, when its label maps to one.
 *
 * Cell names carry a card label rather than the wire kind (`review-card`, not
 * `artifact_review_gate`), so the mapping is explicit and closed. A name that
 * claims no kind returns null and the record's own declaration stands; a name
 * that DOES claim one must agree with the record.
 */
const CELL_KIND_LABELS = Object.freeze({
  "review-card": "artifact_review_gate",
  "recommendation-hold": "recommendation_hold",
  "recommendation-card": "recommendation_hold",
  "schedule-proposal": "trigger_schedule_proposal",
  "schedule-card": "trigger_schedule_proposal",
  "verification-card": "verification_summary",
  "verification-summary": "verification_summary",
});

/**
 * The STATE a cell name claims, normalized. `decided` and `settled` are the same
 * claim written two ways; a name that claims neither returns null.
 *
 * The binding uses this so a record cannot answer a cell that says `decided`
 * with pending evidence, where the decision controls are REQUIRED rather than
 * required-absent and the bar is therefore lower.
 */
export function stateTokenInCell(cell) {
  if (typeof cell !== "string") return null;
  const lower = cell.toLowerCase();
  if (/(^|[-_])(settled|decided|confirmed|skipped)([-_]|$)/.test(lower)) return "settled";
  if (/(^|[-_])(pending|held|open)([-_]|$)/.test(lower)) return "pending";
  return null;
}

export function kindTokenInCell(cell) {
  if (typeof cell !== "string") return null;
  for (const [label, kind] of Object.entries(CELL_KIND_LABELS)) {
    if (cell.includes(label)) return kind;
  }
  for (const kind of LIFECYCLE_KINDS) {
    if (cell.includes(kind)) return kind;
  }
  return null;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate ONE record. Returns a list of human-readable violations.
 *
 * `hashOf(relPath)` returns the file's sha256, or throws when the file is
 * missing — injected so the pinned tests drive the same validator CI runs.
 */
export function validateCaptureRecord(record, { hashOf } = {}) {
  const v = [];
  const where = isNonEmptyString(record?.cell) ? `record "${record.cell}"` : "an unnamed record";

  if (!isNonEmptyString(record?.cell)) {
    v.push(`${where}: no cell name`);
  }
  if (!CAPTURE_HOSTS.includes(record?.declaredHost)) {
    v.push(`${where}: declaredHost "${record?.declaredHost}" is not one of ${CAPTURE_HOSTS.join("/")}`);
    return v; // Everything below is host-relative.
  }
  const host = record.declaredHost;

  if (!CAPTURE_BUILDS.includes(record?.build)) {
    v.push(`${where}: build "${record?.build}" is not one of ${CAPTURE_BUILDS.join("/")}`);
  }
  if (record?.recordedBy !== RECORDER_ID) {
    v.push(
      `${where}: recordedBy "${record?.recordedBy}" — every record is written by the ONE shared recorder (${RECORDER_ID})`,
    );
  }

  // --- the name carries no authority, but it may not CONTRADICT the record ---
  const token = hostTokenInCell(record.cell);
  if (token !== null && token !== host) {
    v.push(
      `${where}: the cell name says host "${token}" and the record declares "${host}" — ` +
        "a name that contradicts the record is the mislabeling this index exists to catch",
    );
  }

  // --- the URL class ---
  if (!isNonEmptyString(record?.finalUrl) || !/^https?:\/\//.test(record.finalUrl)) {
    v.push(`${where}: finalUrl must be the absolute URL the page ended on`);
  } else {
    const allowed = HOST_URL_CLASSES[host];
    const actual = classifyUrl(record.finalUrl);
    if (allowed !== null && !allowed.includes(actual)) {
      v.push(
        `${where}: declared host "${host}" needs a ${allowed.join("/")} URL, but the capture ` +
          `ended on ${record.finalUrl} (class: ${actual})`,
      );
    }
  }

  // --- the screenshot and its hash ---
  if (!isNonEmptyString(record?.screenshot)) {
    v.push(`${where}: no screenshot path`);
  } else if (record.screenshot.startsWith("/") || record.screenshot.includes("..")) {
    v.push(`${where}: screenshot must be a repo-relative path inside the tree`);
  } else if (!record.screenshot.startsWith("evidence/")) {
    v.push(`${where}: screenshot must live under evidence/ — it is ${record.screenshot}`);
  } else if (!SHA256_RE.test(record?.sha256 ?? "")) {
    v.push(`${where}: sha256 must be 64 lowercase hex characters`);
  } else if (typeof hashOf === "function") {
    let actual;
    try {
      actual = hashOf(record.screenshot);
    } catch {
      v.push(`${where}: screenshot not found at ${record.screenshot}`);
    }
    if (actual !== undefined && actual !== record.sha256) {
      v.push(
        `${where}: the screenshot at ${record.screenshot} hashes to ${actual}, not the recorded ` +
          `${record.sha256} — the image and the record are not the same capture`,
      );
    }
  }

  // --- the frames ---
  const frames = record?.frames ?? {};
  for (const req of HOST_FRAME_REQUIREMENTS[host]) {
    const declared = frames[req.name];
    if (!declared) {
      v.push(`${where}: host "${host}" must declare the "${req.name}" frame reached by ${req.selector}`);
      continue;
    }
    if (declared.selector !== req.selector) {
      v.push(
        `${where}: the "${req.name}" frame must be reached by ${req.selector}, not ${declared.selector}`,
      );
    }
    const frameClass = classifyUrl(declared.url);
    if (frameClass !== req.urlClass) {
      v.push(
        `${where}: the "${req.name}" frame ended on ${declared.url} (class: ${frameClass}); ` +
          `host "${host}" requires ${req.urlClass}`,
      );
    }
  }

  // --- the assertions ---
  const assertions = Array.isArray(record?.assertions) ? record.assertions : null;
  if (assertions === null || assertions.length === 0) {
    v.push(`${where}: no recorded selector assertions — a screenshot alone asserts nothing`);
    return v;
  }
  const knownFrames = new Set(["main", ...Object.keys(frames)]);
  for (const a of assertions) {
    const label = `${where}: assertion ${a?.selector ?? "(no selector)"}`;
    if (!isNonEmptyString(a?.selector)) {
      v.push(`${where}: an assertion has no selector`);
      continue;
    }
    const frame = a.frame ?? "main";
    if (!knownFrames.has(frame)) {
      v.push(`${label}: frame "${frame}" is not declared on this record`);
    }
    if (!Number.isInteger(a?.count) || a.count < 0) {
      v.push(`${label}: count must be the observed non-negative integer`);
      continue;
    }
    const expected = a.expect ?? "present";
    if (expected !== "present" && expected !== "absent") {
      v.push(`${label}: expect must be "present" or "absent"`);
      continue;
    }
    if (expected === "present" && a.count < 1) {
      v.push(`${label}: recorded as present but observed ${a.count} times`);
    }
    if (expected === "absent" && a.count !== 0) {
      v.push(`${label}: recorded as absent but observed ${a.count} times`);
    }
  }

  // --- a chat_thread record names the KIND it photographed ---
  // Without it the record proves a transcript was on screen, not that a card
  // was in it, which is the whole distance between a capture and evidence.
  if (host === "chat_thread") {
    if (!CAPTURE_STATES.includes(record?.state)) {
      v.push(
        `${where}: a chat_thread record must declare the \`state\` it photographed ` +
          `(${CAPTURE_STATES.join("/")}) — a settled card owes the ABSENCE of its controls, ` +
          `not their presence; it declares "${record?.state}"`,
      );
    }
    if (!LIFECYCLE_KINDS.includes(record?.kind)) {
      v.push(
        `${where}: a chat_thread record must declare the lifecycle \`kind\` it photographed ` +
          `(one of ${LIFECYCLE_KINDS.join("/")}) — it declares "${record?.kind}"`,
      );
    }
  }

  // --- every required host anchor, observed present ---
  const hostRequirements =
    host === "chat_thread" && LIFECYCLE_KINDS.includes(record?.kind)
      ? chatThreadRequirementsFor(record.kind, record.state ?? "pending")
      : HOST_ANCHOR_REQUIREMENTS[host];
  for (const req of hostRequirements) {
    const found = assertions.find(
      (a) =>
        a?.selector === req.selector &&
        (a?.frame ?? "main") === req.frame &&
        (a?.within ?? null) === (req.within ?? null),
    );
    if (!found) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} in the ${req.frame} frame` +
          `${req.within ? `, inside ${req.within}` : ""}, and the record does not assert it at all`,
      );
      continue;
    }
    // The requirement carries its OWN expectation: a settled capture owes the
    // ABSENCE of the decision controls, and asserting them present there would
    // reject the honest screenshot.
    const wanted = req.expect ?? "present";
    const got = found.expect ?? "present";
    if (got !== wanted) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} ${wanted.toUpperCase()} in the ` +
          `${req.frame} frame; the record asserts it ${got}`,
      );
      continue;
    }
    if (wanted === "present" && !(found.count >= 1)) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} PRESENT in the ${req.frame} frame; ` +
          `the record observed ${found.count}`,
      );
    }
    if (wanted === "absent" && found.count !== 0) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} ABSENT in the ${req.frame} frame; ` +
          `the record observed ${found.count}`,
      );
    }
  }

  return v;
}

/** Validate the whole index: shape, then every record. */
export function validateCaptureIndex({ index, hashOf } = {}) {
  const v = [];
  if (index === null || typeof index !== "object") {
    return ["the capture index is not an object"];
  }
  if (index.schemaVersion !== CAPTURE_INDEX_SCHEMA_VERSION) {
    v.push(
      `schemaVersion ${index.schemaVersion} — this gate reads version ${CAPTURE_INDEX_SCHEMA_VERSION}`,
    );
  }
  if (index.recorder !== RECORDER_ID) {
    v.push(`recorder "${index.recorder}" — the index names the ONE shared recorder (${RECORDER_ID})`);
  }
  if (!Array.isArray(index.records)) {
    v.push("records must be an array");
    return v;
  }
  const seen = new Set();
  // One image cannot be the proof of several cells. Without this, a single
  // screenshot plus a set of hand-written assertion blocks "proves" every cell
  // and every kind at once — the cheapest way to make a full index out of one
  // picture, and a shape no honest capture run produces.
  const byPath = new Map();
  const byHash = new Map();
  for (const record of index.records) {
    if (isNonEmptyString(record?.cell)) {
      if (seen.has(record.cell)) v.push(`duplicate cell name "${record.cell}"`);
      seen.add(record.cell);
    }
    const cell = record?.cell ?? "(unnamed)";
    if (isNonEmptyString(record?.screenshot)) {
      const first = byPath.get(record.screenshot);
      if (first !== undefined) {
        v.push(
          `"${cell}" reuses the screenshot ${record.screenshot} already claimed by "${first}" — ` +
            "one image cannot be the evidence for two cells",
        );
      } else byPath.set(record.screenshot, cell);
    }
    if (SHA256_RE.test(record?.sha256 ?? "")) {
      const first = byHash.get(record.sha256);
      if (first !== undefined) {
        v.push(
          `"${cell}" records the same image bytes as "${first}" (sha256 ${record.sha256}) — ` +
            "two cells cannot be the same photograph",
        );
      } else byHash.set(record.sha256, cell);
    }
    v.push(...validateCaptureRecord(record, { hashOf }));
  }
  return v;
}
