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
 * IT OBSERVES; IT DOES NOT TAKE DICTATION. `observeCapture` resolves the outer
 * frame itself, counts it, ENTERS it, reads the frame's own URL, and counts the
 * inner anchors there. Nothing about the frames or the counts is accepted from
 * the caller, because a recorder that writes down what it was told is a
 * transcription of the claim, not evidence against it. The browser reaches this
 * module through a tiny `CapturePage` port (`url`, `count`, `frame`,
 * `screenshot`), so the audit tier stays dependency-free and runnable without an
 * install while the real driver is Playwright.
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
 * The anchors a chat_thread capture of `kind` must record present, IN THE SAME
 * FRAME: the conversation list, the card's own root, the host declaration, and
 * the kind's decision controls. This is the set the manifest binding requires,
 * so a cell that names chat_thread cannot be satisfied by a photograph of a
 * transcript with no card in it.
 */
export function chatThreadRequirementsFor(kind) {
  return [
    { frame: "main", selector: "[data-conversation-list]" },
    { frame: "main", selector: `[data-lifecycle-card="${kind}"]` },
    { frame: "main", selector: '[data-lifecycle-card-host="chat_thread"]' },
    ...(KIND_REQUIRED_ACTIONS[kind] ?? []).map((selector) => ({ frame: "main", selector })),
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
 * Build one record from ALREADY-OBSERVED assertions. `screenshot` is
 * repo-relative; the hash is computed from the file on disk, so a record can
 * never carry a hash for a file it does not have.
 *
 * Prefer `observeCapture`: this entry point trusts its `assertions`, which is
 * only safe when they came from `collectAssertions` against a live driver.
 */
export function buildCaptureRecord({
  cell,
  declaredHost,
  kind = undefined,
  finalUrl,
  build,
  screenshot,
  assertions,
  frames = undefined,
  capturedAt = new Date().toISOString(),
  repoRoot = process.cwd(),
  readImpl = readFileSync,
}) {
  const record = {
    cell,
    declaredHost,
    finalUrl,
    build,
    screenshot,
    sha256: hashFile(join(repoRoot, screenshot), readImpl),
    capturedAt,
    assertions,
    recordedBy: RECORDER_ID,
  };
  if (kind) record.kind = kind;
  if (frames) record.frames = frames;
  return record;
}

/**
 * OBSERVE one capture cell and write the record from what was seen.
 *
 * `page` is the CapturePage port:
 *   · `url()`               — the URL the page actually ended on
 *   · `count(selector)`     — how many elements match, in the MAIN frame
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
      ? chatThreadRequirementsFor(kind)
      : [...HOST_ANCHOR_REQUIREMENTS[declaredHost]];
  const specs = [...required.map((r) => ({ ...r, expect: "present" })), ...extraAssertions];

  const assertions = [];
  for (const spec of specs) {
    const frameName = spec.frame ?? "main";
    const reader = frameName === "main" ? page : (frameHandles.get(frameName) ?? null);
    assertions.push({
      frame: frameName,
      selector: spec.selector,
      expect: spec.expect ?? "present",
      // An unresolved frame counts ZERO rather than skipping the assertion.
      count: reader ? await reader.count(spec.selector) : 0,
    });
  }

  // 3. The image, written and then hashed from disk.
  const abs = join(repoRoot, screenshot);
  await page.screenshot(abs);

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
      ? chatThreadRequirementsFor(record.kind)
      : HOST_ANCHOR_REQUIREMENTS[host];
  for (const req of hostRequirements) {
    const found = assertions.find(
      (a) => a?.selector === req.selector && (a?.frame ?? "main") === req.frame,
    );
    if (!found) {
      v.push(
        `${where}: host "${host}" requires the ${req.frame}-frame anchor ${req.selector}, and the ` +
          "record does not assert it at all",
      );
      continue;
    }
    if ((found.expect ?? "present") !== "present" || !(found.count >= 1)) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} PRESENT in the ${req.frame} frame; ` +
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
  for (const record of index.records) {
    if (isNonEmptyString(record?.cell)) {
      if (seen.has(record.cell)) v.push(`duplicate cell name "${record.cell}"`);
      seen.add(record.cell);
    }
    v.push(...validateCaptureRecord(record, { hashOf }));
  }
  return v;
}
