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
 * module through a tiny `CapturePage` port (`url`, `count`, `countVisible`,
 * `identifyWithin`, `pinWithin`, `frame`, `screenshot`), so the audit tier stays
 * dependency-free and runnable without an install while the real driver is
 * Playwright.
 *
 * IT MEASURES ONE CARD, AND SAYS WHICH. Everything a chat_thread record claims
 * about the card is counted inside a card root, and a transcript can hold
 * several roots of one kind. So the ELEMENT is resolved ONCE per capture, its
 * own attributes are read off it and written into the record, and a page with
 * several candidate cards and no declaration is REFUSED rather than answered
 * with the first match. Root-scoped counts are `:scope`-inclusive, because the
 * shipped cards put the card root's own declarations ON the root.
 *
 * IT SPEAKS THE CANONICAL CONTRACT. The record's field names, scopes, selectors
 * and state spellings are the ratified CI half's (scripts/ci/lib/
 * capture-record-contract.mjs), imported rather than restated, so ONE driver run
 * produces a record BOTH halves accept. What this tier adds — painted counts,
 * measured absences, the pinned instance, frame URLs — it adds as extra fields
 * that half ignores, never as a rename of one of its own.
 *
 * IT REQUIRES THE PIXELS. Every anchor is counted twice: attached, and PAINTED.
 * `present` needs a painted match, because a card behind `display:none` or
 * collapsed to nothing satisfies a selector while appearing nowhere in the
 * screenshot the record is filed with. `absent` stays answered by attachment, so
 * a decision control that is merely hidden can never read as gone.
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
 * found, one that was found only as unpainted DOM, a capture that cannot say
 * which of several same-kind cards it measured, a cell name that contradicts its
 * own record, a hash that does not match the file, and — since the duplicate
 * check below — one image doing duty as the proof of several different cells.
 * Those are the failures that actually happened. Deliberate fabrication is a review and trust problem, and this
 * module does not pretend to solve it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE CANONICAL CONTRACT, imported rather than restated. The CI half (#2857) is
// ratified and on main; a second hand-written copy of the same hosts, kinds,
// selectors and states is exactly how the two halves drifted into disagreeing
// about what a record is. Everything below layers this tier's EXTRA rigor --
// painted counts, absent assertions, instance pinning, frame URLs -- on top of
// that set. It never renames one of its fields and never contradicts one of its
// selectors. Zero runtime dependencies on both sides, so the audit tier stays
// installable-free.
import {
  CAPTURE_HOSTS as CANONICAL_CAPTURE_HOSTS,
  CAPTURE_INDEX_PATH,
  CARD_KINDS,
  DECIDED_SUMMARY_SELECTOR,
  RECORDER_ID,
  requiredAssertionsFor,
} from "../../ci/lib/capture-record-contract.mjs";

/**
 * The recorder's identity, stamped on every record it writes and named by the
 * index header -- ONE string, re-exported from the canonical contract rather
 * than spelled again here. There were three spellings of it in the tree; a
 * second literal is how there came to be three.
 */
export { RECORDER_ID, CAPTURE_INDEX_PATH };

/** The current index schema. Bumping it is a deliberate, reviewed act. */
export const CAPTURE_INDEX_SCHEMA_VERSION = 1;

/** The four ruled hosts (§IX), re-exported from the canonical contract. */
export const CAPTURE_HOSTS = Object.freeze([...CANONICAL_CAPTURE_HOSTS]);

/** The canonical decided marker, re-exported so callers have one spelling. */
export { DECIDED_SUMMARY_SELECTOR };

/** How a capture was built. Dispatch-dependent cells are labeled, never hidden. */
export const CAPTURE_BUILDS = Object.freeze(["production", "development"]);

/**
 * URL CLASSES, most specific first — a review page is also a run-detail path, so
 * order is part of the meaning.
 */
const URL_CLASS_ORDER = Object.freeze([
  ["embed_assistant", /^\/embed\/assistant(?:[/?#]|$)/],
  ["review_page", /^\/agents\/[^/]+\/[^/]+\/[^/?#]+\/review\/[^/?#]+(?:[/?#]|$)/],
  ["run_detail", /^\/agents\/[^/]+\/[^/]+\/[^/?#]+(?:[/?#]|$)/],
  ["agents_index", /^\/agents(?:[/?#]|$)/],
  ["chat", /^\/chat(?:[/?#]|$)/],
]);

/**
 * THE PATH a URL classifies on, in EITHER canonical spelling.
 *
 * This tier used to require an absolute `http(s)://` URL and classify the whole
 * string. The ratified contract's own `pathOf` accepts a bare repo-style path
 * too, and every one of the eight committed records is written that way -- so
 * the stricter spelling was refusing the canonical records over a notation, not
 * over anything observed. The CLASS is what carries meaning; the origin does
 * not. An absolute URL still has its origin stripped before matching, so
 * `http://localhost:3000/chat/x` and `/chat/x` classify identically.
 */
export function urlPathOf(finalUrl) {
  if (typeof finalUrl !== "string" || finalUrl === "") return null;
  if (/^https?:\/\//.test(finalUrl)) {
    try {
      const u = new URL(finalUrl);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return null;
    }
  }
  return finalUrl.startsWith("/") ? finalUrl : null;
}

/** The URL class of a final URL. `other` means no app class matched. */
export function classifyUrl(finalUrl) {
  const path = urlPathOf(finalUrl);
  if (path === null) return "other";
  for (const [name, re] of URL_CLASS_ORDER) {
    if (re.test(path)) return name;
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
 * WHICH FRAME the canonical `frame` scope MEANS, per host.
 *
 * The canonical contract scopes every observation `page`, `frame` or `root`.
 * `frame` is "the frame the picture was taken in": the embed frame for the
 * widget, the main document for everything else. `page` is the outer document
 * regardless, which is where the widget's own `.cw-frame` is counted.
 */
export const CAPTURE_FRAME_FOR_HOST = Object.freeze({
  chat_thread: "main",
  run_card: "main",
  page_gate_region: "main",
  site_widget: "widget",
});

/** The card root a `root`-scoped observation is counted inside. */
export function cardRootFor(kind) {
  return CARD_KINDS[kind]?.root ?? null;
}

/**
 * The DECISION CONTROLS a kind's card must show, per kind — taken from the
 * canonical contract's `CARD_KINDS` rather than spelled again. This tier used to
 * carry its own list, and it had drifted: it named `review-gate-card` (the card
 * ROOT's own conformance id, which is present whatever state the card is in, so
 * it proved nothing about operability) where the canonical set names
 * `review-decision-bar` (the control the card actually mounts).
 */
export const KIND_REQUIRED_ACTIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(CARD_KINDS).map(([kind, spec]) => [
      kind,
      Object.freeze([...spec.decisionControls]),
    ]),
  ),
);

export const LIFECYCLE_KINDS = Object.freeze(Object.keys(CARD_KINDS));

/**
 * The states a capture can photograph, in the CANONICAL spelling.
 *
 * This tier used to say `settled` where the canonical contract says `decided`.
 * That is not a synonym problem: the canonical contract normalizes a cell name's
 * `settled` token TO `decided`, so a record declaring "settled" contradicted its
 * own cell name the moment the other half read it.
 *
 * A PENDING card owes its decision controls; a DECIDED one owes their ABSENCE
 * and its own decided summary. Requiring the controls on every capture would
 * make an honest decided screenshot unindexable, and requiring nothing would let
 * a placeholder pass as either.
 */
export const CAPTURE_STATES = Object.freeze(["pending", "decided"]);

/** The scopes an observation can be counted in, per the canonical contract. */
export const CAPTURE_SCOPES = Object.freeze(["page", "frame", "root"]);

/**
 * THE ONE REQUIREMENT SET, in the canonical contract's vocabulary.
 *
 * Built from `requiredAssertionsFor` so the two halves cannot disagree about
 * which anchors a claim owes. What this tier adds is stated as ADDITIONS, never
 * as replacements:
 *
 *   · the host declaration counted INSIDE the pinned card root, as well as
 *     frame-wide. The canonical set counts it frame-wide, which a wrapper
 *     elsewhere on the screen satisfies; counting it in the root too says the
 *     CARD declared the host, not merely the page.
 *   · the canonical `forbidden` set, turned into `absent` assertions that are
 *     MEASURED and written down, so a decided capture's absence is an
 *     observation rather than an omission.
 *   · EVERY member of a decision-control group, not any one of them. The
 *     canonical contract rules Confirm/Skip an `any` group; the shipped
 *     `run-recommendation-chip-row.tsx` renders both unconditionally in one row,
 *     so requiring both refuses no honest capture and catches a card that lost
 *     one. This is strictly STRONGER than the canonical rule, so a record this
 *     tier accepts is still one that half accepts — the direction that matters.
 *
 * Every spec carries the canonical `scope` plus this tier's own `frame` /
 * `within` / `expect`, which the canonical validator ignores as unknown fields.
 */
export function captureRequirementsFor(host, kind = null, state = null) {
  const { required, forbidden } = requiredAssertionsFor({ host, kind, state });
  const root = cardRootFor(kind);
  const frameOf = (scope) =>
    scope === "page" ? "main" : (CAPTURE_FRAME_FOR_HOST[host] ?? "main");
  const spec = (r, expect) => {
    const out = { frame: frameOf(r.scope), scope: r.scope, selector: r.selector, expect };
    if (r.scope === "root" && root) out.within = root;
    // The canonical `any` group, CARRIED rather than dropped. This tier requires
    // every member (see above); the GRADED tier honours the group, so a record
    // written by the canonical driver -- which satisfies Confirm OR Skip, as its
    // own contract rules -- is not refused here for a rule only this tier has.
    if (r.any) out.any = r.any;
    return out;
  };
  const specs = required.map((r) => spec(r, "present"));
  if (root) {
    specs.push({
      frame: frameOf("root"),
      scope: "root",
      within: root,
      selector: `[data-lifecycle-card-host="${host}"]`,
      expect: "present",
      // AN ADDITION OF THIS TIER, marked as one. The canonical set counts the
      // host declaration frame-wide; counting it inside the pinned card root as
      // well says the CARD declared the host rather than merely the page. A
      // record that pins no card root cannot answer it, so the graded tier asks
      // it only of records that carry an `instance` -- see `validateCaptureRecord`.
      tier: "audit",
    });
  }
  specs.push(...forbidden.map((r) => spec(r, "absent")));
  return specs;
}

/**
 * The frame-scoped anchors a host REQUIRES, with no card kind in play. Every one
 * must be recorded present with a count of at least one; a required anchor that
 * was never looked for is exactly as bad as one that was not found.
 */
export const HOST_ANCHOR_REQUIREMENTS = Object.freeze(
  Object.fromEntries(
    CAPTURE_HOSTS.map((host) => [host, Object.freeze(captureRequirementsFor(host))]),
  ),
);

/**
 * The anchors a chat_thread capture of `kind` must record, for `state`: the
 * conversation list, the card's own root, the host declaration (frame-wide AND
 * inside the card), and the kind's decision controls — present when pending,
 * absent when decided, beside the decided summary.
 */
export function chatThreadRequirementsFor(kind, state = "pending") {
  return captureRequirementsFor("chat_thread", kind, state);
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
  return specs.map((spec) => ({
    selector: spec.selector,
    scope: spec.scope ?? "frame",
    count: queryCount(spec.frame ?? "main", spec.selector),
    frame: spec.frame ?? "main",
    expect: spec.expect ?? "present",
  }));
}

/**
 * The path rules a screenshot must satisfy, as a reusable check.
 *
 * Shared by the observer and the validator so a path the record would be
 * REFUSED for is refused BEFORE the shutter. Round 1 wrote the image first and
 * validated afterwards, which left a file on disk for every capture the gate
 * then rejected — including paths that escape the tree entirely.
 */
export function screenshotPathViolation(screenshot) {
  if (!isNonEmptyString(screenshot)) return "no screenshot path";
  if (screenshot.startsWith("/") || screenshot.includes("..")) {
    return "screenshot must be a repo-relative path inside the tree";
  }
  if (!screenshot.startsWith("evidence/")) {
    return `screenshot must live under evidence/ — it is ${screenshot}`;
  }
  return null;
}

/**
 * PIN THE ROOT ELEMENT, once per capture.
 *
 * `resolveCardInstance` pins an INDEX, and an index is re-resolved against DOM
 * order on every single read. A transcript that reorders between the two
 * measurements below — a card streamed in above another, an optimistic row
 * settling — silently swaps which card the record describes, and because the
 * COUNTS are equal nothing downstream notices. So the ELEMENT is resolved once,
 * here, and every root-scoped count in the capture is answered from it.
 *
 * The reader it returns is `:scope`-INCLUSIVE: a selector matching the root
 * ITSELF counts, alongside its descendants. The shipped review-gate card renders
 * `data-lifecycle-card`, `data-lifecycle-card-host`, `data-lifecycle-card-state`
 * and its conformance id on ONE element, so a descendant-only reader answers an
 * honest pending capture with zero and refuses it — which is exactly what this
 * tier did before.
 */
async function pinRoot(reader, rootSelector, index) {
  if (typeof reader.pinWithin !== "function") {
    throw new Error(
      `capture cannot pin the root element for ${rootSelector}: the page port has no ` +
        "pinWithin(), so every root-scoped count would be re-resolved by DOM order and a " +
        "reorder with equal counts would swap the card mid-capture",
    );
  }
  return reader.pinWithin(rootSelector, index);
}

/**
 * PIN THE CARD INSTANCE this capture measures.
 *
 * WHY THIS IS NOT "THE FIRST ONE". Everything a chat_thread record says about
 * the card — its host declaration, its decision controls, its settled marker —
 * is counted INSIDE the card root. A transcript can hold several cards of one
 * kind, and `.first()` silently answers every one of those counts from whichever
 * happens to lead the DOM. The record then describes a card the reader may never
 * find in the screenshot, and nothing in it says which card was meant. So the
 * instance is resolved ONCE, here, and written into the record.
 *
 * WHAT COUNTS AS IDENTITY. Whatever the element itself renders. The recorder
 * reads the matched roots' own attributes and writes them down rather than
 * looking for a blessed `data-run-id`: a closed list of identity spellings is a
 * list a renamed attribute walks past, and a card that carries no identifying
 * attribute at all is a fact worth recording, not one worth guessing around.
 *
 * THE AMBIGUITY RULE. One match needs no declaration. Several matches need one,
 * and it must select exactly one of them; otherwise the capture FAILS. A gate
 * that answers an ambiguous question with the first available answer is the
 * mislabeling this module exists to refuse.
 */
export async function resolveCardInstance(page, selector, declaredInstance = null) {
  if (typeof page.identifyWithin !== "function") {
    throw new Error(
      `capture cannot pin a card instance for ${selector}: the page port has no ` +
        "identifyWithin(), so every card-scoped count would silently fall back to " +
        "whichever match leads the DOM",
    );
  }
  const matches = (await page.identifyWithin(selector)) ?? [];
  const attributesAt = (i) => (matches[i] && typeof matches[i] === "object" ? matches[i] : {});

  if (matches.length === 0) {
    // Not an error: the required-anchor check below reports the missing card
    // with an observed count of zero, which is the failure stated as evidence.
    return { selector, matched: 0, index: 0, id: declaredInstance, attributes: {} };
  }

  if (declaredInstance !== null && declaredInstance !== undefined) {
    const hits = matches
      .map((attrs, index) => ({ attrs, index }))
      .filter(({ attrs }) => Object.values(attrs ?? {}).includes(declaredInstance));
    if (hits.length !== 1) {
      throw new Error(
        `capture declares instance "${declaredInstance}" for ${selector}, and ${hits.length} of ` +
          `the ${matches.length} matching card(s) carry that value in an attribute — a ` +
          "declaration that does not select exactly one card selects none",
      );
    }
    return {
      selector,
      matched: matches.length,
      index: hits[0].index,
      id: declaredInstance,
      attributes: hits[0].attrs,
    };
  }

  if (matches.length > 1) {
    throw new Error(
      `capture found ${matches.length} elements matching ${selector} and the cell declares no ` +
        "instance — every card-scoped count would describe one of them and the record would not " +
        "say which. Add `instance` to the cell, naming a value the intended card renders",
    );
  }

  return { selector, matched: 1, index: 0, id: null, attributes: attributesAt(0) };
}

/**
 * OBSERVE one capture cell and write the record from what was seen.
 *
 * `page` is the CapturePage port:
 *   · `url()`               — the URL the page actually ended on
 *   · `count(selector)`     — how many elements match, in the MAIN frame
 *   · `countVisible(selector)` — how many of those are actually PAINTED
 *   · `identifyWithin(selector)` — one attribute map per match, in DOM order,
 *                             read off the elements' own attributes. This is
 *                             what lets a record name WHICH card it measured
 *   · `pinWithin(root, index)` — resolve the `index`-th `root` ONCE and return
 *                             `{count, countVisible}` bound to that ELEMENT.
 *                             Root-scoped anchors go through this, so a host
 *                             declaration on an unrelated wrapper cannot stand in
 *                             for the card's own; the pin is an element rather
 *                             than an index, so a reorder cannot swap the card
 *                             mid-capture; and the reader is `:scope`-INCLUSIVE,
 *                             so a selector matching the root itself counts
 *   · `frame(selector)`     — resolve the frame element `selector` reaches and
 *                             return the same readers for INSIDE it, or null
 *                             when it does not resolve
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
  /**
   * WHICH card instance this cell photographs, when the page holds more than
   * one of the kind. It is a SELECTOR of the instance, not a fact about it:
   * the value has to appear in some attribute the card itself renders, and the
   * attributes actually found are what get written down. A page with one card
   * needs no declaration; a page with several and no declaration is refused as
   * ambiguous rather than answered with the first match.
   */
  instance: declaredInstance = null,
  extraAssertions = [],
  repoRoot = process.cwd(),
  readImpl = readFileSync,
  now = () => new Date().toISOString(),
}) {
  const finalUrl = await page.url();

  // 0. THE PATH, BEFORE THE SHUTTER. Round 1 wrote the image and validated the
  //    path afterwards, so every capture the gate went on to reject had already
  //    put a file on disk -- including one named by a path that escapes the
  //    tree. A path the record would be refused for is refused here instead.
  const pathViolation = screenshotPathViolation(screenshot);
  if (pathViolation) {
    throw new Error(`capture "${cell}" cannot be written: ${pathViolation}`);
  }

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

  // 2. The anchors the host (and kind) require, in the CANONICAL vocabulary.
  const required =
    declaredHost === "chat_thread" && kind
      ? captureRequirementsFor(declaredHost, kind, state)
      : captureRequirementsFor(declaredHost);
  const specs = [...required, ...extraAssertions.map((a) => ({ scope: "frame", ...a }))];

  // 2a. The reader each scope is answered from. `page` scope is always the outer
  //     document; `frame` scope is the frame the picture was taken in.
  const captureFrame = CAPTURE_FRAME_FOR_HOST[declaredHost] ?? "main";
  const frameReader = captureFrame === "main" ? page : (frameHandles.get(captureFrame) ?? null);
  const readerFor = (spec) => {
    const scope = spec.scope ?? "frame";
    if (scope === "page") return page;
    // An explicit `frame` on an extra assertion still wins, so a caller can
    // measure the outer document deliberately.
    if (spec.frame === "main") return page;
    if (spec.frame && spec.frame !== captureFrame) return frameHandles.get(spec.frame) ?? null;
    return frameReader;
  };

  // 2b. PIN THE CARD INSTANCE, and then pin the ELEMENT it resolved to. The
  //     index alone is re-resolved by DOM order on every read, so a transcript
  //     that reorders between the two measurements below would answer the second
  //     one from a different card without either count changing.
  const rootSpecs = specs.filter((spec) => (spec.scope ?? "frame") === "root");
  const rootSelectors = [...new Set(rootSpecs.map((spec) => spec.within ?? null))];
  if (rootSelectors.length > 1) {
    // ONE pin per capture, so more than one root would mean some root-scoped
    // count was answered from a root it does not belong to — silently, since
    // every such count still comes back a plausible number.
    throw new Error(
      `capture "${cell}" asks for root-scoped counts inside ${rootSelectors.length} different ` +
        `roots (${rootSelectors.join(", ")}), and a record pins ONE card. Split the capture.`,
    );
  }
  const rootSelector = rootSelectors[0] ?? null;
  let instance = null;
  let pinnedRoot = null;
  // The root lives in the frame the picture was taken in. When that frame did
  // not resolve there is nothing to pin, and the frame's own URL check already
  // fails the capture — counting the card in the OUTER document instead would
  // answer a widget's question with the embedding page's DOM.
  if (rootSelector && frameReader) {
    instance = await resolveCardInstance(frameReader, rootSelector, declaredInstance);
    pinnedRoot =
      instance.matched > 0 ? await pinRoot(frameReader, rootSelector, instance.index) : null;
  }

  const measure = async () => {
    const out = [];
    for (const spec of specs) {
      const scope = spec.scope ?? "frame";
      const entry = {
        // The CANONICAL triple, spelled the canonical way.
        selector: spec.selector,
        scope,
        // An unresolved frame or an unfound root counts ZERO rather than
        // skipping the assertion.
        count: 0,
        // --- additive, beyond the canonical record ---------------------------
        // Which frame the count was taken in, which root a root-scoped count was
        // taken inside, what the capture CLAIMS, and how many matches were
        // PAINTED. `present` needs a painted match, because a card behind
        // `display:none` satisfies a selector and appears nowhere in the
        // screenshot; `absent` stays answered by ATTACHMENT, so a control that is
        // merely hidden can never read as gone.
        frame: scope === "page" ? "main" : (spec.frame ?? captureFrame),
        expect: spec.expect ?? "present",
        visible: 0,
      };
      if (spec.within) entry.within = spec.within;
      if (scope === "root") {
        if (pinnedRoot) {
          entry.count = await pinnedRoot.count(spec.selector);
          entry.visible = await pinnedRoot.countVisible(spec.selector);
        }
      } else {
        const reader = readerFor(spec);
        if (reader) {
          entry.count = await reader.count(spec.selector);
          entry.visible = await reader.countVisible(spec.selector);
        }
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
    .filter(({ a, b }) => !b || a.count !== b.count || a.visible !== b.visible);
  if (drifted.length > 0) {
    throw new Error(
      `capture "${cell}" is not stable: ` +
        drifted
          .map(
            ({ a, b }) =>
              `${a.selector} counted ${a.count}/${a.visible} visible then ` +
              `${b?.count ?? "n/a"}/${b?.visible ?? "n/a"} visible`,
          )
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
  // THE CANONICAL FIELD NAMES. This tier wrote `kind` / `state`; the ratified
  // contract reads `declaredKind` / `declaredState`, and it wins.
  if (kind) record.declaredKind = kind;
  // EVERY HOST DECLARES ITS STATE, not only chat_thread. The state-derived
  // requirements are chat_thread's alone (see the honest limit in the header),
  // but the DECLARATION is not: the canonical half reads
  // `record.declaredState ?? claim.state`, so a run_card or site_widget record
  // that omits it hands the question back to the file name — the one thing this
  // index exists to refuse to take anyone's word for. Omitted, a cell called
  // `__decided` silently answers for a capture photographed pending, and the
  // two halves disagree about what the record even claims.
  if (state) record.declaredState = state;
  // WHICH card the root-scoped counts came from, so the record names an instance
  // rather than leaving a reader to assume the screenshot holds only one.
  if (instance) record.instance = instance;
  if (Object.keys(frames).length > 0) {
    record.frames = Object.fromEntries(
      Object.entries(frames).map(([name, f]) => [name, { selector: f.selector, url: f.url }]),
    );
    // ADDITIVE: the canonical contract checks the widget's URL class against
    // `frameUrl`. Same fact as `frames.widget.url`, under the name that half
    // already reads, so one record answers both.
    if (captureFrame !== "main" && frames[captureFrame]) {
      record.frameUrl = frames[captureFrame].url;
    }
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
  // Normalized to the CANONICAL spelling: the ratified contract maps a cell's
  // `settled` token to `decided`, so returning "settled" here made every record
  // this tier wrote contradict its own cell name the moment that half read it.
  if (/(^|[-_])(settled|decided|confirmed|skipped|resolved|done)([-_]|$)/.test(lower)) {
    return "decided";
  }
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
 * THE TWO TIERS a record can be judged at.
 *
 *   `graded` (default) — the CANONICAL contract is the floor for every record,
 *       and this tier's EXTRAS are checked WHEN THE RECORD CARRIES THEM. The
 *       eight committed records were written by the canonical driver, which
 *       emits no `build`, no painted `visible`, no `expect` label and no pinned
 *       `instance`; judging them against extras they never claimed produced 166
 *       violations that said nothing about the pictures, and refused the
 *       canonical index wholesale.
 *   `audit` — every extra REQUIRED. This is what `observeCapture` produces and
 *       what `chat-hitl-capture-driver.mjs` validates its own output against
 *       before writing, so the strictness lands on the records this tier makes
 *       rather than on records made honestly by the other half.
 *
 * THE HONEST LIMIT of that split, stated because a graded gate that reads as a
 * strict one is worse than none: a record can decline an extra by omitting it,
 * and then it is judged without that extra. What it CANNOT do is claim one
 * falsely — an `expect` that disagrees with the requirement, a `visible` above
 * its own `count`, an `instance` naming a card the recorder never found are all
 * still refused, and the canonical floor still applies to every record either
 * way. Omission is visible in the record; a false claim is not.
 */
export const RECORD_TIERS = Object.freeze(["graded", "audit"]);

/**
 * Validate ONE record. Returns a list of human-readable violations.
 *
 * `hashOf(relPath)` returns the file's sha256, or throws when the file is
 * missing — injected so the pinned tests drive the same validator CI runs.
 * `tier` selects the grading above; it defaults to `graded`.
 */
export function validateCaptureRecord(record, { hashOf, tier = "graded" } = {}) {
  const v = [];
  // A record is judged at the AUDIT tier when it is asked for (the driver, on
  // its own output) or when it SPEAKS that tier: a pinned `instance` is this
  // tier's own vocabulary, and a record that pins a card root owes the rest of
  // the set that root exists to support. One predicate rather than a per-field
  // guess, so a record cannot claim half the tier and be graded on the other
  // half. The eight canonical records pin no instance and are graded.
  const strict = tier === "audit" || record?.instance !== undefined;
  const where = isNonEmptyString(record?.cell) ? `record "${record.cell}"` : "an unnamed record";

  if (!isNonEmptyString(record?.cell)) {
    v.push(`${where}: no cell name`);
  }
  if (!CAPTURE_HOSTS.includes(record?.declaredHost)) {
    v.push(`${where}: declaredHost "${record?.declaredHost}" is not one of ${CAPTURE_HOSTS.join("/")}`);
    return v; // Everything below is host-relative.
  }
  const host = record.declaredHost;

  // GRADED. `build` is this tier's own field; the canonical driver records the
  // runtime in prose (`runtime`) instead. A record that names a build must name
  // a real one; a record that names none is judged without it.
  if ((strict || record?.build !== undefined) && !CAPTURE_BUILDS.includes(record?.build)) {
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
  if (urlPathOf(record?.finalUrl) === null) {
    v.push(
      `${where}: finalUrl must be the URL the page ended on — an absolute http(s) URL or the ` +
        "repo-style path the canonical contract reads",
    );
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
  // The SAME check the observer runs before the shutter, so the two cannot
  // disagree about which paths are writable.
  const pathViolation = screenshotPathViolation(record?.screenshot);
  if (pathViolation) {
    v.push(`${where}: ${pathViolation}`);
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
      // GRADED. The `frames` block is this tier's own; the canonical contract
      // records the SAME fact for the capture frame under `frameUrl`, and
      // `observeCapture` writes both for exactly that reason. A record carrying
      // only the canonical spelling has its frame URL classified here — the
      // check that carries the meaning — while the selector that reached the
      // frame is answered by the page-scoped `.cw-frame` assertion the host
      // requires anyway. A record carrying NEITHER declares no frame at all.
      const canonicalFrameUrl = strict ? undefined : record?.frameUrl;
      if (canonicalFrameUrl === undefined) {
        v.push(
          `${where}: host "${host}" must declare the "${req.name}" frame reached by ${req.selector}`,
        );
        continue;
      }
      const canonicalClass = classifyUrl(canonicalFrameUrl);
      if (canonicalClass !== req.urlClass) {
        v.push(
          `${where}: the capture frame ended on ${canonicalFrameUrl} (class: ${canonicalClass}); ` +
            `host "${host}" requires ${req.urlClass}`,
        );
      }
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
    const scope = a.scope ?? "frame";
    if (!CAPTURE_SCOPES.includes(scope)) {
      v.push(`${label}: scope "${scope}" is not one of ${CAPTURE_SCOPES.join("/")}`);
    }
    if (!Number.isInteger(a?.count) || a.count < 0) {
      v.push(`${label}: count must be the observed non-negative integer`);
      continue;
    }
    // GRADED. The painted count is this tier's own; the canonical driver records
    // attachment only. An observation that CLAIMS a painted count must be able to
    // stand behind it — a `visible` above its own `count` is a false claim, not an
    // omission — but one that claims none is judged on attachment, as that half
    // judges it.
    const hasVisible = a?.visible !== undefined;
    if (strict || hasVisible) {
      if (!Number.isInteger(a?.visible) || a.visible < 0 || a.visible > a.count) {
        v.push(
          `${label}: visible must be the observed count of PAINTED matches, ` +
            `between 0 and ${a.count}; it is ${JSON.stringify(a?.visible)}`,
        );
        continue;
      }
    }
    // GRADED. `expect` is this tier's LABEL on an observation. Unlabeled, the
    // observation carries no claim of its own and the requirement loop below
    // judges it against what the host actually owes — which is exactly how the
    // canonical validator reads the same record.
    const expected = a.expect;
    if (strict && expected === undefined) {
      v.push(`${label}: every observation must be labeled expect "present" or "absent"`);
      continue;
    }
    if (expected !== undefined && expected !== "present" && expected !== "absent") {
      v.push(`${label}: expect must be "present" or "absent"`);
      continue;
    }
    if (expected === "present" && a.count < 1) {
      v.push(`${label}: recorded as present but observed ${a.count} times`);
    }
    // ATTACHED IS NOT SHOWN. A card in a collapsed panel, behind `display:none`
    // or sized to nothing counts as present to a selector and appears nowhere in
    // the screenshot — which is a capture whose record describes a screen the
    // image does not show, the exact defect this index exists to catch.
    if (expected === "present" && a.count >= 1 && hasVisible && a.visible < 1) {
      v.push(
        `${label}: recorded as present with ${a.count} match(es), and NONE of them was ` +
          "painted — attached DOM is not a photograph",
      );
    }
    if (expected === "absent" && a.count !== 0) {
      v.push(`${label}: recorded as absent but observed ${a.count} times`);
    }
  }

  // --- a chat_thread record names the KIND it photographed ---
  // Without it the record proves a transcript was on screen, not that a card
  // was in it, which is the whole distance between a capture and evidence.
  if (host === "chat_thread") {
    if (!CAPTURE_STATES.includes(record?.declaredState)) {
      v.push(
        `${where}: a chat_thread record must declare the \`declaredState\` it photographed ` +
          `(${CAPTURE_STATES.join("/")}) — a decided card owes the ABSENCE of its controls, ` +
          `not their presence; it declares "${record?.declaredState}"`,
      );
    }
    if (!LIFECYCLE_KINDS.includes(record?.declaredKind)) {
      v.push(
        `${where}: a chat_thread record must declare the lifecycle \`declaredKind\` it ` +
          `photographed (one of ${LIFECYCLE_KINDS.join("/")}) — it declares "${record?.declaredKind}"`,
      );
    }
  }

  // --- the record names WHICH card it measured ---
  // Every card-scoped count is answered from one resolved root. A record that
  // does not say which root that was is a measurement of "a card of this kind
  // somewhere on the page", and the reader comparing it to the screenshot has
  // no way to check the two describe the same thing.
  const cardRoot =
    host === "chat_thread" && LIFECYCLE_KINDS.includes(record?.declaredKind)
      ? cardRootFor(record.declaredKind)
      : null;
  // GRADED. The pin is this tier's own. A record that carries one must be able
  // to stand behind it, in every particular below; a record that carries none
  // simply does not pin a card, and is judged on what it does assert.
  if (cardRoot !== null && (strict || record?.instance !== undefined)) {
    const inst = record?.instance;
    if (inst === null || typeof inst !== "object") {
      v.push(
        `${where}: a chat_thread record must carry the \`instance\` its card-scoped counts were ` +
          "read from — without it the counts describe whichever card led the DOM",
      );
    } else if (inst.selector !== cardRoot) {
      v.push(
        `${where}: the recorded instance pins ${inst.selector}, but this record's card-scoped ` +
          `counts are taken inside ${cardRoot}`,
      );
    } else if (!Number.isInteger(inst.matched) || inst.matched < 1) {
      v.push(
        `${where}: the recorded instance matched ${JSON.stringify(inst.matched)} card(s) — a ` +
          "record whose card root was never found asserts nothing about a card",
      );
    } else if (!Number.isInteger(inst.index) || inst.index < 0 || inst.index >= inst.matched) {
      v.push(
        `${where}: the recorded instance index ${JSON.stringify(inst.index)} is not one of the ` +
          `${inst.matched} card(s) it matched`,
      );
    } else if (inst.matched > 1 && !isNonEmptyString(inst.id)) {
      v.push(
        `${where}: ${inst.matched} cards matched ${cardRoot} and the record names no instance id — ` +
          "a capture that cannot say which of several cards it photographed is ambiguous, and " +
          "an ambiguous capture is a mislabeled one waiting to happen",
      );
    } else if (inst.attributes === null || typeof inst.attributes !== "object") {
      v.push(
        `${where}: the recorded instance carries no observed attributes — identity is read OFF ` +
          "the element, and a record that read none says so with an empty object, not by omission",
      );
    } else if (isNonEmptyString(inst.id) && !Object.values(inst.attributes).includes(inst.id)) {
      v.push(
        `${where}: the record pins instance "${inst.id}", and no attribute observed on the card ` +
          `carries that value (${JSON.stringify(inst.attributes)}) — the id names a card the ` +
          "recorder did not find",
      );
    }
  }

  // --- every required host anchor, observed present ---
  // Keyed by SCOPE and selector — the same pair the canonical contract keys its
  // own observed map by. The earlier arm matched on frame alone and IGNORED
  // `within`, so a frame-wide count answered a requirement that was supposed to
  // be taken inside the card root.
  const hostRequirements =
    host === "chat_thread" && LIFECYCLE_KINDS.includes(record?.declaredKind)
      ? captureRequirementsFor(host, record.declaredKind, record.declaredState ?? "pending")
      : captureRequirementsFor(host);
  const observationFor = (selector, scope) =>
    assertions.find((a) => a?.selector === selector && (a?.scope ?? "frame") === scope);
  const satisfiedAtLeastOnce = (selector, scope) => {
    const found = observationFor(selector, scope);
    return Boolean(found) && found.count >= 1;
  };
  for (const req of hostRequirements) {
    // A record that pins no card root cannot answer a requirement counted INSIDE
    // one, so this tier's root-scoped addition rides the same tier predicate.
    if (req.tier === "audit" && !strict) continue;
    // The canonical `any` group: Confirm OR Skip answers the requirement. This
    // tier requires every member (see `captureRequirementsFor`), so the group is
    // honoured only in the graded tier.
    if (!strict && req.any && req.any.some((sel) => satisfiedAtLeastOnce(sel, req.scope))) {
      continue;
    }
    const wanted = req.expect ?? "present";
    const found = observationFor(req.selector, req.scope);
    if (!found) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} ${req.scope}-scoped` +
          `${req.within ? ` inside ${req.within}` : ""}, and the record does not assert it at all`,
      );
      continue;
    }
    // An UNLABELED observation carries no claim of its own, so it is read
    // against what the host owes -- the canonical reading. A LABELED one that
    // disagrees with the requirement is a contradiction and is refused.
    const got = found.expect ?? wanted;
    if (got !== wanted) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} ${wanted.toUpperCase()} ` +
          `(${req.scope}-scoped); the record asserts it ${got}`,
      );
      continue;
    }
    if (wanted === "present" && !(found.count >= 1)) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} PRESENT (${req.scope}-scoped); ` +
          `the record observed ${found.count}`,
      );
    } else if (wanted === "present" && found.visible !== undefined && !(found.visible >= 1)) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} PRESENT (${req.scope}-scoped); ` +
          `the record observed ${found.count} attached and ${found.visible} painted — a required ` +
          "anchor that renders nowhere is not in the photograph",
      );
    }
    if (wanted === "absent" && found.count !== 0) {
      v.push(
        `${where}: host "${host}" requires ${req.selector} ABSENT (${req.scope}-scoped); ` +
          `the record observed ${found.count}`,
      );
    }
  }

  return v;
}

/**
 * Validate the whole index: shape, then every record.
 *
 * `tier` is passed through to each record (see `RECORD_TIERS`). The CANONICAL
 * FLOOR is not re-implemented here — `chat-hitl-acceptance-gate.mjs` runs the
 * ratified contract's own `validateCaptureIndex` beside this one, so every
 * record is judged by that half whatever this half grades.
 */
export function validateCaptureIndex({ index, hashOf, tier = "graded" } = {}) {
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
    v.push(...validateCaptureRecord(record, { hashOf, tier }));
  }
  return v;
}
