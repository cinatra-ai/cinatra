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
 * evidence file — the same trust boundary already applies to every screenshot a
 * capture run mints.
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
import { readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

// THE CANONICAL CONTRACT, imported rather than restated. The CI half (#2857) is
// ratified and on main; a second hand-written copy of the same hosts, kinds,
// selectors and states is exactly how the two halves drifted into disagreeing
// about what a record is. Everything below layers this tier's EXTRA rigor --
// painted counts, absent assertions, instance pinning, frame URLs -- on top of
// that set. It never renames one of its fields and never contradicts one of its
// selectors. Zero runtime dependencies on both sides, so the audit tier stays
// installable-free.
import {
  CANONICAL_CAPTURE_STATES,
  CAPTURE_HOSTS as CANONICAL_CAPTURE_HOSTS,
  CAPTURE_INDEX_PATH,
  CARD_KINDS,
  captureStatesFor,
  DECIDED_SUMMARY_SELECTOR,
  parseCellName,
  RECORDER_ID,
  absenceInstanceViolations,
  captureHostAdmissibility,
  CAPTURE_OUTPUT_ROOT,
  isHistoricalPermalink,
  PINNED_ARTIFACT_ROOT,
  repoPathOf,
  captureImageFormat,
  createCaptureTempFile,
  prepareCaptureTarget,
  recheckCaptureParent,
  requiredAssertionsFor,
  tempFileViolation,
  resolveLiveCapture,
  settledIsAbsence,
  sha256File,
  sha256Pinned,
} from "../../ci/lib/capture-record-contract.mjs";

// Re-exported so the anchor contract reads the canonical answers through the
// same door every other requirement comes through, rather than reaching past
// this tier into the contract for two of them.
export { absenceInstanceViolations, captureHostAdmissibility, settledIsAbsence };

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
  // TWO CLASSES, AND THE SECOND IS THE CONVERSATION (cinatra#2997). The
  // `run_card` host is the RUN'S OWN CARD, and that card is drawn on two
  // surfaces: the run page, and inside a conversation, where it is the inline
  // run panel. It has always been drawn in both — what changed is that it now
  // draws a LIFECYCLE CARD in the conversation too, because the maintainer ruled
  // the run card IS the review screen once the work opens one: "Once the agent
  // is done and the output generated, that 'Agentic Run Progress' card is being
  // automatically replaced with the 'Review requested' screen. On the run page,
  // the same is true." (the request for changes on pull request 2890; PLAN:
  // Agents Lifecycle (A) section 4.2 carries the same sentence). The canonical
  // half of this contract (`scripts/ci/lib/capture-record-contract.mjs`,
  // `HOST_URL_CLASS`) carries the identical pair, so the two halves still
  // classify identically.
  run_card: Object.freeze(["run_detail", "chat"]),
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
 *
 * IT IS NOW THE CANONICAL LIST ITSELF, not a second copy of it -- and it is NOT
 * "the states every kind resolves". It is the pair a card that asks for a
 * decision resolves, and the default for a kind the canonical contract's
 * `KIND_CAPTURE_STATES` does not name. The arms below read
 * `captureStatesFor(kind)`, which is exact per kind: the audit card resolves
 * `advisory` and nothing else, on every host it draws on. Two of its advisory
 * records stand in the index; the third was refused HERE, on `chat_thread`
 * alone, by an arm that enumerated this list for all four kinds (the driven
 * refusal is recorded in `https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2791-s9g-conformance/capture-results.json`).
 *
 * THIS LIST STAYS THE TWO, deliberately. The anchor contract builds one ratified
 * anchor set per (host, kind, state) from it, so moving it would move the
 * digest; the per-kind vocabulary adds no anchor at all -- an advisory capture
 * owes exactly the set both ratified sets are built from -- so the digest stands
 * where it was ratified.
 */
export const CAPTURE_STATES = CANONICAL_CAPTURE_STATES;

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
export function captureRequirementsFor(host, kind = null, state = null, cell = null) {
  // `cell` is CARRIED, not interpreted here: a kind whose reading differs by era
  // grades a picture on file against the reading it was actually taken of, and
  // the canonical half is the one authority on which era a cell belongs to. A
  // walk that is minting a NEW cell passes none, and is held to the shipped
  // reading in full (cinatra#3062).
  const { required, forbidden } = requiredAssertionsFor({ host, kind, state, cell });
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
  // A kind whose settled reading draws nothing has no root to count the host
  // declaration inside — the canonical set has already turned this cell's claim
  // into an ABSENCE, and this tier's addition cannot ask for a presence inside
  // it.
  if (root && !(settledIsAbsence(kind) && state === "decided")) {
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
 * WHERE A CAPTURE RUN WRITES.
 *
 * `test-results/` is the repo's existing run-artifact root: it is the Playwright
 * config's `outputDir`, it is already gitignored, other suites already mint into
 * it (`tests/e2e/setup/support/instance-state.ts`), and the CI job that runs the
 * held-turn flow already uploads it. So a run leaves the tree clean by
 * construction and nothing has to be pruned afterwards.
 *
 * It replaces the tracked proof-artifact tree that used to hold these files:
 * minting proof pictures into the repository is what this root exists to stop.
 * The path stays
 * repo-relative because a record's `screenshot` field must be one -- an OS temp
 * dir would need the record contract's path rule widened to absolute paths,
 * which is a bigger change than this one and would weaken it for every record.
 *
 * RE-EXPORTED, NEVER REDECLARED. The ratified contract owns this string because
 * BOTH tiers have to refuse the same paths, and a second copy here is exactly
 * how the two tiers came to disagree about it: the canonical tier never had the
 * rule at all, so a record naming any tracked file passed the required gate.
 */
export { CAPTURE_OUTPUT_ROOT };

/**
 * THE ROOT A COMMITTED WALK PLAN WAS WRITTEN AGAINST.
 *
 * Plans older than the tree cleanup name their output paths under the proof
 * tree that captures were minted into at the time. That tree is gone.
 */
export const HISTORICAL_OUTPUT_ROOT = PINNED_ARTIFACT_ROOT;

/**
 * Move a walk plan's OUTPUT paths onto the live capture root.
 *
 * A walk plan is a document: it says which cells to shoot and where to put the
 * pictures. The "where" is the only part that has moved, so it is the only part
 * rewritten here -- every cell id, host, kind, state, viewport, action and
 * assertion is left exactly as committed. A plan already written against
 * `CAPTURE_OUTPUT_ROOT` is returned unchanged; this is a no-op for anything
 * authored since the cleanup.
 *
 * IT IS SHIPPED CODE, not test scaffolding, because THE DRIVER LOADS PLANS
 * THROUGH IT. When only the suites re-rooted, the suites graded a plan the real
 * CLI never saw: `--walk <the committed fixture>` -- the command the capture
 * index documents -- died in preflight with ten output-root violations while
 * the tests were green. One loader, one plan, both halves.
 *
 * @returns {object} a deep copy; the caller may mutate it freely
 */
export function rerootWalkPlanOutputs(plan) {
  const out = structuredClone(plan);
  for (const step of out?.steps ?? []) {
    for (const cell of step?.cells ?? []) {
      if (typeof cell.screenshot === "string" && cell.screenshot.startsWith(HISTORICAL_OUTPUT_ROOT)) {
        cell.screenshot =
          CAPTURE_OUTPUT_ROOT + cell.screenshot.slice(HISTORICAL_OUTPUT_ROOT.length);
      }
    }
  }
  return out;
}

/** Read a walk plan from disk the ONE way — the driver's path and the suites'. */
export function readWalkPlan(path, readImpl = readFileSync) {
  return rerootWalkPlanOutputs(JSON.parse(readImpl(path, "utf8")));
}

/**
 * The path rules a screenshot must satisfy, as a reusable check.
 *
 * Shared by the observer and the validator so a path the record would be
 * REFUSED for is refused BEFORE the shutter. Round 1 wrote the image first and
 * validated afterwards, which left a file on disk for every capture the gate
 * then rejected — including paths that escape the tree entirely.
 */
export function screenshotPathViolation(screenshot, { allowPinned = false } = {}) {
  if (!isNonEmptyString(screenshot)) return "no screenshot path";
  // A PINNED record names a picture that has left the working tree. It is
  // graded, not written, so only the READER may accept one: an observer about
  // to fire the shutter and a walk plan describing what a run will write are
  // both declaring an output path, and a URL is not one.
  //
  // A PIN IS STILL ROOT-CHECKED. A permalink can name any path in the
  // repository, so accepting one unconditionally would let a record claim
  // `src/app/icon.png` as its capture and pass on a matching hash. A pinned
  // picture must come from the HISTORICAL proof-artifact root, exactly as a
  // live one must be written under the CURRENT capture root.
  if (allowPinned && isHistoricalPermalink(screenshot)) {
    const pinnedPath = repoPathOf(screenshot);
    if (!pinnedPath.startsWith(PINNED_ARTIFACT_ROOT)) {
      return (
        `a pinned screenshot must name a picture under ${PINNED_ARTIFACT_ROOT} — ` +
        `this one pins ${pinnedPath}`
      );
    }
    return null;
  }
  if (screenshot.startsWith("/") || screenshot.includes("..")) {
    return "screenshot must be a repo-relative path inside the tree";
  }
  if (!screenshot.startsWith(CAPTURE_OUTPUT_ROOT)) {
    return `screenshot must live under ${CAPTURE_OUTPUT_ROOT} — it is ${screenshot}`;
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
   * HOW THIS CAPTURE IS FRAMED — `window` (the browser window the operator
   * sees, with the navigation, the transcript and the composer around the card)
   * or `page` (the scrolled-out full document). It is written into the record
   * because it is a fact about the picture that the picture cannot state, and
   * because round 1 of S9d was rejected on framing alone. It is NOT a
   * requirement: a record that names none is judged without it.
   */
  framing = undefined,
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
  //
  //    LEXICALLY FIRST, for the clear message, and then RESOLVED. The lexical
  //    rule cannot see the filesystem, and a shutter is a WRITE: a symlinked
  //    capture root, a symlinked intermediate directory or an existing
  //    symlinked target each redirect the write out of the root, and refusing
  //    the record afterwards does not un-write the bytes -- which may have
  //    landed on top of something. `resolveCaptureTarget` answers all three.
  const pathViolation = screenshotPathViolation(screenshot);
  if (pathViolation) {
    throw new Error(`capture "${cell}" cannot be written: ${pathViolation}`);
  }
  //    THE FORMAT, BEFORE ANY DIRECTORY EXISTS. The shutter is an image writer
  //    and the temp file has to name the same image the destination does, so an
  //    extension outside the closed set is refused HERE -- ahead of the run
  //    directory being created for a capture that was never going to be taken.
  const imageFormat = captureImageFormat(screenshot);
  if (!imageFormat.ok) {
    throw new Error(`capture "${cell}" cannot be written: ${imageFormat.detail}`);
  }
  //    PREPARING, not merely resolving. A run's FIRST capture names a run
  //    directory that does not exist yet, and in a fresh checkout the capture
  //    root does not either -- it is gitignored. Playwright used to create both
  //    silently on its way to the file; resolving before the shutter took that
  //    away and broke the first capture of every run. `prepareCaptureTarget`
  //    creates the root and the parent INSIDE the resolved root and then
  //    re-resolves them, so what a run needs exists and every redirect is still
  //    refused.
  const target = prepareCaptureTarget(screenshot, { repoRoot });
  if (!target.ok) {
    throw new Error(`capture "${cell}" cannot be written: ${target.detail}`);
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
  // THE KIND IS MEASURED WHEREVER IT IS DECLARED. This used to read
  // `declaredHost === "chat_thread" && kind`, so a run_card or page_gate_region
  // capture measured the HOST anchors and nothing else — no card root, no state
  // declaration inside it, no absence of the decision controls. The record still
  // carried `declaredKind`, and the CANONICAL half derives its requirements from
  // the kind on ANY host, so this observer could only ever produce a run-page
  // record that the CI gate then refused for anchors it was never asked to look
  // for. Every non-chat record already committed carries them, because the
  // drivers that made them asked for them by hand. A walk cannot: it goes
  // through the observer. So the observer asks for what the kind owes, wherever
  // it is drawn — which is also what makes the S9d run-page cell recordable at
  // all, since the schedule step's controls ARE the kind's requirement set.
  const required = kind
    ? captureRequirementsFor(declaredHost, kind, state, cell ?? null)
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

  // 3. The image, written ATOMICALLY into the resolved directory and then
  //    hashed from disk.
  //
  //    THE SHUTTER FIRES AT A NAME NOTHING ELSE HOLDS. Writing straight to the
  //    final path would follow whatever sits there at that instant; the temp
  //    name is fresh, is created inside the PARENT THAT WAS RESOLVED, and is
  //    renamed into place. `rename` replaces the destination entry itself
  //    rather than writing through it, so an entry that appeared in the
  //    meantime is overwritten as a NAME and never followed as a link.
  //    THE LAST-MOMENT RE-CHECK. Everything above — the frames, the counts, the
  //    DOM walk — takes real time, and the destination was resolved before all
  //    of it. Node has no `openat`, so a path resolved once and used later is a
  //    time-of-check/time-of-use gap that cannot be closed from here; what can
  //    be done is to shrink it and fail closed. The parent is re-verified
  //    immediately before the shutter and again immediately before the rename,
  //    and the temp file is created EXCLUSIVELY under an unguessable name so no
  //    one can be holding it as a symlink when the shutter writes.
  const abs = target.absReal;
  const beforeShutter = recheckCaptureParent(target);
  if (beforeShutter) {
    throw new Error(`capture "${cell}" cannot be written: ${beforeShutter.detail}`);
  }
  // The temp file keeps the FINAL extension: the shutter is an image writer and
  // infers its format from the name, so an extensionless temp path made it
  // refuse outright. The rename target keeps its real name.
  const temp = createCaptureTempFile(target.parentReal, { extension: imageFormat.extension });
  if (!temp.ok) {
    throw new Error(`capture "${cell}" cannot be written: ${temp.detail}`);
  }
  const tmp = temp.path;
  try {
    // ...and the format is stated EXPLICITLY as well, so it never depends on
    // the name at all.
    await page.screenshot(tmp, {
      framing: framing ?? "page",
      type: imageFormat.type,
    });
    const beforeRename = recheckCaptureParent(target);
    if (beforeRename) {
      throw new Error(`capture "${cell}" cannot be written: ${beforeRename.detail}`);
    }
    const tempViolation = tempFileViolation(tmp);
    if (tempViolation) {
      throw new Error(`capture "${cell}" cannot be written: ${tempViolation.detail}`);
    }
    renameSync(tmp, abs);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the temp file may already be gone; the original error wins
    }
    throw err;
  }

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

  // THE ABSENCE INSTANCE — what a `decided` capture of a settled-absence kind
  // pins, and the reason a record of one used to be unwritable at all.
  //
  // A kind whose settled reading draws nothing owes its root ABSENT, so there is
  // no root-scoped requirement, so the pin above never ran and the record went
  // out with no `instance` — which the audit tier refuses of any record whose
  // kind has a card root. The absence is the claim, so the absence is what gets
  // pinned: the root that was owed, and the count that was read for it. That
  // count is NOT taken again here — it is the frame-scoped number this capture
  // already measured TWICE, before and after the shutter, and the drift check
  // above has already refused the capture if the two disagreed.
  if (instance === null && settledIsAbsence(kind) && state === "decided") {
    const absentRoot = cardRootFor(kind);
    const measured = absentRoot
      ? assertions.find(
          (a) =>
            a.selector === absentRoot &&
            (a.scope ?? "frame") === "frame" &&
            a.expect === "absent",
        )
      : null;
    if (measured) {
      instance = {
        selector: absentRoot,
        // MEASURED, never assumed. A root that is still on the screen is
        // written down as such and the validators refuse the record for it.
        matched: measured.count,
        // There is no card to be the nth of, and none to read an identity off.
        index: null,
        id: null,
        attributes: {},
        // THE CLAIM, in as many words — a record that pins a card it failed to
        // find is a different and still-refused thing from one that pins the
        // card's absence on purpose.
        absent: true,
      };
    }
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
  // EVERY HOST DECLARES ITS STATE, not only chat_thread. The canonical half
  // reads `record.declaredState ?? claim.state`, so a run_card or site_widget
  // record that omits it hands the question back to the file name — the one
  // thing this index exists to refuse to take anyone's word for. Omitted, a cell
  // called `__decided` silently answers for a capture photographed pending, and
  // the two halves disagree about what the record even claims.
  //
  // THE ASYMMETRY, DISCLOSED HERE RATHER THAN DISCOVERED — and it is smaller
  // than this comment used to say. What is OBLIGATORY for one host is OPTIONAL
  // for four: only a chat_thread record MUST carry a `declaredState`. What is
  // derived from it is NOT chat-only — `captureRequirementsFor(host, kind,
  // state)` is called with the declared state on every host (see
  // `hostRequirements` in `validateCaptureRecord`), so a run_card record
  // declaring `decided` owes the ABSENCE of its decision controls exactly as a
  // chat one does. The earlier text said the anchors were derived for
  // chat_thread alone; that stopped being true when the observer was widened to
  // read a kind's anchors on whatever host it declares, and it is corrected here
  // rather than left to be discovered by someone trusting it.
  if (state) record.declaredState = state;
  // ADDITIVE, and declined by every record written before the field existed.
  if (framing) record.framing = framing;
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
  // THE HAND-WRITTEN ALIASES, FIRST. These are spellings this tier has always
  // read and some of them (`schedule-proposal`) are not cell tokens of the
  // canonical contract at all, so they are kept rather than derived — and they
  // are kept FIRST, so no cell name that already resolved can change kind when
  // the derived set below grows.
  "review-card": "artifact_review_gate",
  "recommendation-hold": "recommendation_hold",
  "recommendation-card": "recommendation_hold",
  "schedule-proposal": "trigger_schedule_proposal",
  "schedule-card": "trigger_schedule_proposal",
  "verification-card": "verification_summary",
  "verification-summary": "verification_summary",
  // …AND THEN THE CANONICAL CONTRACT'S OWN CELL TOKENS, derived rather than
  // copied. A hand-kept copy of a list the contract already owns is how
  // `agent_hitl_screen` came to be unreadable HERE while the contract knew it
  // perfectly well: the kind was admitted and its cell names still parsed to
  // nothing, so a rule keyed on the kind never fired. Longest token first, so a
  // broad token can never answer for a name a specific one describes.
  ...Object.fromEntries(
    Object.entries(CARD_KINDS)
      .flatMap(([kind, spec]) => (spec.cellTokens ?? []).map((token) => [token, kind]))
      .sort((a, b) => b[0].length - a[0].length),
  ),
});

/**
 * The STATE a cell name claims, normalized. `decided` and `settled` are the same
 * claim written two ways; a name that claims neither returns null.
 *
 * The binding uses this so a record cannot answer a cell that says `decided`
 * with pending evidence, where the decision controls are REQUIRED rather than
 * required-absent and the bar is therefore lower.
 *
 * IT GRADES. Two callers read it: `validateWalkPlan`, where it refuses a plan
 * whose cell name contradicts what the plan says it will photograph, and
 * `chatThreadCellClaims` in `scripts/audit/chat-hitl-acceptance-gate.mjs`, whose
 * `claimedState` the gate compares against the record that answers the cell. A
 * wrong answer here is a wrong grade there, which is why it defers to the
 * canonical parser below rather than keeping its own opinion.
 */
export function stateTokenInCell(cell) {
  if (typeof cell !== "string") return null;
  // THE CANONICAL READING FIRST, and it wins whenever it reads anything.
  //
  // This matters because the two readers scan differently: `parseCellName`
  // splits on `__` and takes the first mapped token AFTER the host token, while
  // the arms below scan `[-_]` boundaries anywhere with a fixed precedence.
  // Those two rules answer `X__review-card__chat_thread__advisory__pending`
  // differently — `advisory` canonically, `pending` here — and a name the two
  // halves read differently is exactly what lets a walk's preflight admit a
  // cell the record validator then refuses. Deferring to the canonical parser
  // closes that class rather than describing it.
  //
  // It is NOT a no-op and it is NOT total. The arms below still answer the
  // names the canonical parser declines: names with no host token at all, and
  // names whose state is buried in a hyphenated phrase
  // (`…__held-at-recommendation-checkpoint`) — five committed names read that
  // way, and their readings are unchanged. This tier also keeps two spellings
  // the canonical map does not carry (`confirmed`, `skipped`). Where the two
  // still differ, this reader claims a state the canonical one does not, which
  // adds a check rather than dropping one.
  const claim = parseCellName(cell);
  if (claim?.state) return claim.state;
  const lower = cell.toLowerCase();
  // Normalized to the CANONICAL spelling: the ratified contract maps a cell's
  // `settled` token to `decided`, so returning "settled" here made every record
  // this tier wrote contradict its own cell name the moment that half read it.
  if (/(^|[-_])(settled|decided|confirmed|skipped|resolved|done)([-_]|$)/.test(lower)) {
    return "decided";
  }
  if (/(^|[-_])(pending|held|open)([-_]|$)/.test(lower)) return "pending";
  if (/(^|[-_])advisory([-_]|$)/.test(lower)) return "advisory";
  return null;
}

/**
 * THE STATE A WALK CELL WILL PHOTOGRAPH, derived ONCE.
 *
 * The plan is judged before the browser opens and the record is written after
 * it closes, and the two must be judging the same claim. They were not: the
 * preflight read `cell.state ?? <the name>` while `observeWalkCell` forwarded
 * `cell.state` alone, and `observeCapture` defaults an omitted state to
 * `pending`. So a cell named `…__advisory` with no declared state passed the
 * preflight and was then stamped `pending` — a walk the preflight admits and
 * the record validator cannot accept, which is the preflight promising
 * something it does not keep.
 *
 * `undefined` is a real answer: a cell that claims no state either way keeps
 * `observeCapture`'s own default, exactly as before.
 */
export function walkCellState(cell) {
  return cell?.state ?? stateTokenInCell(cell?.cell) ?? undefined;
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
 * `hashPinnedOf(url, io)` does the same job for a record whose picture is
 * pinned in history rather than on disk; it defaults to the ratified contract's
 * `sha256Pinned`, which reads the blob back with `git cat-file`.
 * `tier` selects the grading above; it defaults to `graded`.
 */
export function validateCaptureRecord(
  record,
  {
    hashOf,
    hashPinnedOf,
    repoRoot = process.cwd(),
    tier = "graded",
    virtualFilesystem: virtualFs = false,
  } = {},
) {
  // WHETHER THE CALLER BROUGHT ITS OWN FILESYSTEM — an EXPLICIT option, never
  // inferred from "it also passed a hasher". Inferring it is what let three
  // real-disk callers (the walk observer, the capture driver and the held-turn
  // producer) skip path resolution simply by supplying a reader. A hasher is
  // now just a hasher; only `virtualFilesystem: true` replaces the filesystem,
  // and only suites pass it.
  const virtualFilesystem = virtualFs === true;
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

  // --- the cell has a reachable subject -------------------------------------
  // Refused BEFORE the frame and anchor arms, because a cell nothing can reach
  // is not a badly-taken picture — it is a picture that should never have been
  // asked for, and the frame violations that follow would bury the reason.
  {
    // THE EFFECTIVE KIND, never only the declared one (convergence). A record
    // may leave `declaredKind` off — every host but chat_thread is allowed to —
    // and reading the declaration alone would let a cell with no reachable
    // subject walk straight past this rule by saying nothing. The cell NAME
    // carries the same claim and is what the canonical half reads.
    const effectiveKind = record?.declaredKind ?? kindTokenInCell(record?.cell);
    const admission = captureHostAdmissibility(effectiveKind, host);
    if (!admission.capturable) {
      v.push(
        `${where}: "${effectiveKind}" is recorded as composition-only on "${host}" — ` +
          admission.reason,
      );
      return v;
    }
  }

  // GRADED. `build` is this tier's own field; the canonical driver records the
  // runtime in prose (`runtime`) instead. A record that names a build must name
  // a real one; a record that names none is judged without it.
  if ((strict || record?.build !== undefined) && !CAPTURE_BUILDS.includes(record?.build)) {
    v.push(`${where}: build "${record?.build}" is not one of ${CAPTURE_BUILDS.join("/")}`);
  }
  // GRADED. A record that names how it was framed must name a real framing; a
  // record that names none is judged without it, which is every record committed
  // before the field existed -- including several that pin an instance and are
  // therefore read at the audit tier.
  if (record?.framing !== undefined && !CAPTURE_FRAMINGS.includes(record.framing)) {
    v.push(`${where}: framing "${record?.framing}" is not one of ${CAPTURE_FRAMINGS.join("/")}`);
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
  // disagree about which paths are writable -- widened here, and ONLY here, to
  // also take a record whose picture is pinned in history rather than on disk.
  const pathViolation = screenshotPathViolation(record?.screenshot, { allowPinned: true });
  if (pathViolation) {
    v.push(`${where}: ${pathViolation}`);
  } else if (!SHA256_RE.test(record?.sha256 ?? "")) {
    v.push(`${where}: sha256 must be 64 lowercase hex characters`);
  } else if (isHistoricalPermalink(record.screenshot)) {
    // PINNED: the picture is read back out of history at the commit the
    // permalink names, and the digest is re-derived from those bytes -- the
    // same binding a live record gets, off `git cat-file` instead of the tree.
    // GATED LIKE EVERY OTHER SEAM: an injected pinned reader is honoured only
    // when the caller asked for a virtual filesystem. A real record is read
    // back out of git history by the shipped reader.
    const got = (virtualFilesystem && hashPinnedOf ? hashPinnedOf : sha256Pinned)(
      record.screenshot,
      { repoRoot },
    );
    if (!got.ok) {
      v.push(`${where}: the pinned screenshot could not be read — ${got.reason}`);
    } else if (got.sha256 !== record.sha256) {
      v.push(
        `${where}: the screenshot at ${record.screenshot} hashes to ${got.sha256}, not the recorded ` +
          `${record.sha256} — the image and the record are not the same capture`,
      );
    }
  } else {
    // THE SAME RESOLUTION THIS TIER'S SIBLING DOES. A live path is only a
    // capture if it resolves to a regular, singly-linked file inside the real
    // capture root: a `test-results -> .` symlink, a symlinked parent, or a
    // hard link otherwise makes any file in the filesystem hash correctly under
    // a capture-looking name.
    let actual;
    if (virtualFilesystem) {
      try {
        actual = hashOf(record.screenshot);
      } catch {
        v.push(`${where}: screenshot not found at ${record.screenshot}`);
      }
    } else {
      const resolved = resolveLiveCapture(record.screenshot, { repoRoot });
      if (!resolved.ok) {
        v.push(`${where}: ${resolved.detail}`);
      } else {
        // HASHED AT THE RESOLVED PATH. Hashing the lexical path again would
        // re-walk every symlink in it, so a parent retargeted between the
        // resolution and the read would hand back different bytes than the ones
        // just proved to be a capture. The canonical tier does the same.
        // An injected hasher is consulted ONLY in virtual mode. On real disk
        // the bytes that count are the ones at the path just resolved, and
        // letting a caller substitute a reader here would reopen the seam this
        // option was split out to close.
        try {
          actual = sha256File(resolved.realPath);
        } catch {
          v.push(`${where}: screenshot not found at ${record.screenshot}`);
        }
      }
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
  //
  // WHAT IS ACTUALLY CHAT-ONLY, stated after this change made the old sentence
  // wrong twice over: the OBLIGATION to declare a kind and a state at all. It is
  // not the vocabulary — the arm above reads that on every host — and it is not
  // the anchors: `hostRequirements` below derives a kind's requirement set from
  // `record.declaredState` on whatever host the record declares, and has since
  // the observer was widened. The earlier sentence claimed both, and both were
  // untrue.
  // THE VOCABULARY IS THE KIND'S, AND IT IS READ ON EVERY HOST. A kind that
  // resolves a state resolves it wherever it draws, and a kind that does not
  // resolve one does not acquire it by being photographed on a page instead of
  // in a thread. This arm used to live inside the chat_thread block below,
  // which is exactly how the audit card became recordable on two hosts and
  // unrecordable on a third. What stays chat-only is the obligation to DECLARE
  // a state at all — that asymmetry is real and is documented below.
  {
    const statesHere = captureStatesFor(record?.declaredKind);
    const declared = record?.declaredState;
    if (declared !== undefined && declared !== null && !statesHere.includes(declared)) {
      v.push(
        `${where}: \`declaredState\` "${declared}" is not one "${record?.declaredKind}" resolves ` +
          `(${statesHere.join("/")}) — the vocabulary is the KIND's, on every host it draws on`,
      );
    }
  }
  if (host === "chat_thread") {
    const statesHere = captureStatesFor(record?.declaredKind);
    if (record?.declaredState === undefined || record?.declaredState === null) {
      v.push(
        `${where}: a chat_thread record must declare the \`declaredState\` it photographed ` +
          `(${statesHere.join("/")}) — a decided card owes the ABSENCE of its controls, ` +
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
  const cardRoot = LIFECYCLE_KINDS.includes(record?.declaredKind)
    ? cardRootFor(record.declaredKind)
    : null;
  // GRADED. The pin is this tier's own. A record that carries one must be able
  // to stand behind it, in every particular below; a record that carries none
  // simply does not pin a card, and is judged on what it does assert.
  // A KIND THAT SETTLES TO NO DOM PINS THE ABSENCE, and the rule for it is the
  // canonical contract's own — one function, called by both halves, so this tier
  // cannot refuse a record the other half writes.
  const pinsAnAbsence =
    (settledIsAbsence(record?.declaredKind) && record?.declaredState === "decided") ||
    record?.instance?.absent === true;
  if (pinsAnAbsence) {
    for (const detail of absenceInstanceViolations({
      instance: record?.instance ?? null,
      kind: record?.declaredKind,
      state: record?.declaredState,
    })) {
      v.push(`${where}: ${detail}`);
    }
  } else if (cardRoot !== null && (strict || record?.instance !== undefined)) {
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
  // The same widening as the observer's: a record that DECLARES a kind is read
  // against that kind's requirement set on whatever host it declares, because
  // the canonical half already reads it that way and two halves that derive
  // different requirements from one record is the drift this module exists to
  // close.
  const hostRequirements = LIFECYCLE_KINDS.includes(record?.declaredKind)
    ? captureRequirementsFor(
        host,
        record.declaredKind,
        record.declaredState ?? "pending",
        typeof record?.cell === "string" ? record.cell : null,
      )
    : captureRequirementsFor(host);
  // Keyed by scope, selector AND `within`. A root-scoped requirement names the
  // root it is counted inside; an observation that declares a DIFFERENT root
  // answers a different question, and matching on scope alone let it stand in.
  // An observation that declares no root is the canonical spelling and is read
  // as answering the requirement, which is how that half reads it.
  const observationFor = (selector, scope, within) =>
    assertions.find(
      (a) =>
        a?.selector === selector &&
        (a?.scope ?? "frame") === scope &&
        (a?.within === undefined || within === undefined || a.within === within),
    );
  const satisfiedAtLeastOnce = (selector, scope, within) => {
    const found = observationFor(selector, scope, within);
    return Boolean(found) && found.count >= 1;
  };
  for (const req of hostRequirements) {
    // A record that pins no card root cannot answer a requirement counted INSIDE
    // one, so this tier's root-scoped addition rides the same tier predicate.
    if (req.tier === "audit" && !strict) continue;
    // The canonical `any` group: Confirm OR Skip answers the requirement. This
    // tier requires every member (see `captureRequirementsFor`), so the group is
    // honoured only in the graded tier.
    if (
      !strict &&
      req.any &&
      req.any.some((sel) => satisfiedAtLeastOnce(sel, req.scope, req.within))
    ) {
      continue;
    }
    const wanted = req.expect ?? "present";
    const found = observationFor(req.selector, req.scope, req.within);
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
export function validateCaptureIndex({
  index,
  hashOf,
  hashPinnedOf,
  repoRoot = process.cwd(),
  tier = "graded",
  virtualFilesystem = false,
} = {}) {
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
      // KEYED ON THE REPOSITORY PATH. Two records pinning one path at two
      // different commits are two claims about one picture, and keying on the
      // whole citation let that pair through as if they were unrelated files.
      const shotPath = repoPathOf(record.screenshot);
      const first = byPath.get(shotPath);
      if (first !== undefined) {
        v.push(
          `"${cell}" reuses the screenshot ${shotPath} already claimed by "${first.cell}" — ` +
            "one image cannot be the evidence for two cells" +
            (first.citation !== record.screenshot
              ? " (and the two pin it at different commits)"
              : ""),
        );
      } else byPath.set(shotPath, { cell, citation: record.screenshot });
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
    v.push(...validateCaptureRecord(record, { hashOf, hashPinnedOf, repoRoot, tier, virtualFilesystem }));
  }
  return v;
}

// ---------------------------------------------------------------------------
// THE WALK — a capture round that is a PATH rather than a list of URLs.
//
// WHY THIS EXISTS, stated as the gap it closes. `driveCapture` above knows one
// shape of capture: open a URL, wait for a selector, shoot. Every cell gets its
// own context, its own page, and no cell can be reached by ACTING on the one
// before it. That shape cannot express the S9d walk at all:
//
//   · C1 and C2 are the SAME card in the SAME conversation, photographed before
//     and after ONE press of Confirm. There is no URL that means "after the
//     press" — the press is the only way there, and it is not repeatable, so the
//     two cells must share one live page.
//   · the schedule is STATED by typing a sentence into the shipped composer; the
//     conversation it creates has no address until it exists.
//   · C3 needs a real press of the run page's rail row to open the schedule step.
//   · light and dark are two contexts of the same walk, not two plans.
//
// So the S9d round-2 lane drove its own Playwright file, shot four cells, and
// could register none of them: nothing it produced was a recorder observation,
// and an index record's assertions are observations or they are inventions.
// This is the missing shape. A walk is CONTEXTS (a theme, a viewport, a session)
// and STEPS; a step runs ACTIONS on its context's live page and then names the
// CELLS to observe on the screen those actions produced. Everything written into
// a record is still read off the page by `observeCapture` — a walk says where to
// stand and what to press, never what was seen.
//
// THE PLAN IS CHECKED BEFORE THE BROWSER LAUNCHES. A walk is long, expensive and
// in S9d's case gated on a real 30-minute TTL; a cell name that contradicts its
// own declaration, a screenshot path outside the capture output root, two cells writing one
// file — each is a refusal the index would issue at the END, and each is worth
// issuing before the first click instead. Same reason the shutter check moved
// ahead of the shutter.
// ---------------------------------------------------------------------------

/**
 * HOW A CAPTURE WAS FRAMED, recorded rather than assumed.
 *
 * `window` is the browser window as the operator sees it — what the maintainer
 * asked for after round 1 ("close ups of the card, but I cannot tell the
 * surrounding"): the navigation, the transcript and the composer around the
 * card. `page` is the scrolled-out full document, which is what `driveCapture`
 * has always shot.
 *
 * GRADED WHEN PRESENT, NEVER REQUIRED. Every record committed before this field
 * existed declines it, and several of those records pin an instance and are
 * therefore judged at the audit tier — requiring the field would refuse them for
 * an omission that says nothing about their pixels. A record that names a
 * framing must name a real one; a record that names none is judged without it.
 */
export const CAPTURE_FRAMINGS = Object.freeze(["window", "page"]);

/**
 * THE CLOSED SET OF ACTIONS a walk step may take, with the argument each needs.
 *
 * Closed on purpose. An open action vocabulary — "run this snippet" — would let
 * a plan reach into the page and arrange what the recorder is about to measure,
 * which is the one thing this whole tier exists to prevent. Every action here
 * either moves the operator (goto, click, press, type, reload) or waits
 * (waitForSelector, waitForTimeout, scrollIntoView). None of them writes to the
 * DOM, and none of them can produce an assertion.
 */
export const WALK_ACTIONS = Object.freeze({
  goto: ["url"],
  // Navigate this context's page to the URL ANOTHER context's page is on.
  //
  // It is here because a walk photographs one screen in two themes, and the
  // screen is a conversation that had no address until the walk created it: the
  // schedule is STATED into the composer, and the thread the assistant answers
  // in is minted by the product. So the dark context cannot `goto` it — it can
  // only follow where the light context ended up. Still a navigation: it reads
  // one page's URL and drives another page to it, and touches no DOM.
  followContext: ["context"],
  click: ["selector"],
  type: ["selector", "text"],
  // SET a form field to an exact value, in one step.
  //
  // It is here because §VI's option rows are EDITABLE BY THE PERSON before they
  // confirm — the plan says so in as many words — and a walk that states a
  // schedule on the card has to be able to put a value into a `datetime-local`
  // input. `type` cannot: that control is segmented, so keystrokes land in
  // whichever segment the click happened to focus and the value that comes out
  // depends on the browser's locale rather than on the plan. `fill` states the
  // value and nothing else. It is an INPUT action, exactly like `type` and
  // `click` — it arranges what the PERSON did, never what the recorder is about
  // to measure, which is the property the closed vocabulary exists to protect.
  fill: ["selector", "value"],
  press: ["key"],
  reload: [],
  waitForSelector: ["selector"],
  waitForTimeout: ["ms"],
  scrollIntoView: ["selector"],
});

/** Every cell in a walk plan, in the order the walk reaches them. */
export function walkCellsOf(plan) {
  const out = [];
  for (const [stepIndex, step] of (plan?.steps ?? []).entries()) {
    for (const cell of step?.cells ?? []) {
      out.push({ ...cell, step: stepIndex, context: step?.context ?? null });
    }
  }
  return out;
}

/**
 * Refuse a walk plan that cannot produce valid records, BEFORE a browser opens.
 *
 * Returns a list of human-readable violations; an empty list means the plan is
 * WELL FORMED, which is a much smaller claim than "the walk will pass". Whether
 * the card is actually on the screen is a question only the page can answer, and
 * `observeWalkCell` asks it there.
 */
export function validateWalkPlan(plan) {
  const v = [];
  if (plan === null || typeof plan !== "object") return ["the walk plan is not an object"];
  if (!isNonEmptyString(plan.slice)) {
    v.push("the walk plan names no `slice` — a record set nobody can place is a record set nobody can retire");
  }
  const contexts = plan.contexts;
  if (contexts === null || typeof contexts !== "object" || Array.isArray(contexts)) {
    v.push("the walk plan declares no `contexts` map");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    v.push("the walk plan declares no `steps`");
    return v;
  }
  for (const [i, step] of plan.steps.entries()) {
    const at = `step ${i}`;
    if (step === null || typeof step !== "object") {
      v.push(`${at}: not an object`);
      continue;
    }
    if (!isNonEmptyString(step.context)) {
      v.push(`${at}: names no context — a step runs on a named context's own live page`);
    } else if (contexts && typeof contexts === "object" && !(step.context in contexts)) {
      v.push(`${at}: names context "${step.context}", which the plan does not declare`);
    }
    for (const [j, action] of (step.actions ?? []).entries()) {
      const label = `${at} action ${j}`;
      const name = action?.action;
      if (!Object.prototype.hasOwnProperty.call(WALK_ACTIONS, name)) {
        v.push(
          `${label}: "${name}" is not one of ${Object.keys(WALK_ACTIONS).join("/")} — the action ` +
            "vocabulary is closed so a plan cannot arrange what the recorder is about to measure",
        );
        continue;
      }
      for (const arg of WALK_ACTIONS[name]) {
        if (action[arg] === undefined || action[arg] === null || action[arg] === "") {
          v.push(`${label}: "${name}" needs \`${arg}\``);
        }
      }
    }
    if (step.id !== undefined && !isNonEmptyString(step.id)) {
      v.push(`${at}: \`id\` must be a non-empty string — it is how a pass names the steps it drives`);
    }
    if (!Array.isArray(step.cells)) {
      v.push(`${at}: \`cells\` must be an array — a step that observes nothing may declare []`);
    }
  }

  const seenStepId = new Set();
  for (const [i, step] of plan.steps.entries()) {
    if (!isNonEmptyString(step?.id)) continue;
    if (seenStepId.has(step.id)) v.push(`step ${i}: id "${step.id}" is declared twice`);
    seenStepId.add(step.id);
  }

  const cells = walkCellsOf(plan);
  const seenCell = new Map();
  const seenShot = new Map();
  for (const cell of cells) {
    const at = `cell "${cell?.cell ?? "(unnamed)"}"`;
    if (!isNonEmptyString(cell?.cell)) {
      v.push(`${at}: no cell name`);
      continue;
    }
    if (seenCell.has(cell.cell)) {
      v.push(`${at}: declared twice (steps ${seenCell.get(cell.cell)} and ${cell.step})`);
    } else seenCell.set(cell.cell, cell.step);

    if (!CAPTURE_HOSTS.includes(cell.declaredHost)) {
      v.push(`${at}: declaredHost "${cell.declaredHost}" is not one of ${CAPTURE_HOSTS.join("/")}`);
    }
    // THE NAME MAY NOT CONTRADICT THE DECLARATION — the same rule the record is
    // judged by, applied to the plan that will produce it, so a mislabel costs a
    // parse rather than a walk.
    const nameHost = hostTokenInCell(cell.cell);
    if (nameHost !== null && nameHost !== cell.declaredHost) {
      v.push(`${at}: the name says host "${nameHost}" and the cell declares "${cell.declaredHost}"`);
    }
    const nameState = stateTokenInCell(cell.cell);
    if (nameState !== null && cell.state !== undefined && nameState !== cell.state) {
      v.push(`${at}: the name says state "${nameState}" and the cell declares "${cell.state}"`);
    }
    const nameKind = kindTokenInCell(cell.cell);
    if (nameKind !== null && cell.kind !== undefined && nameKind !== cell.kind) {
      v.push(`${at}: the name says kind "${nameKind}" and the cell declares "${cell.kind}"`);
    }
    if (cell.kind !== undefined && !LIFECYCLE_KINDS.includes(cell.kind)) {
      v.push(`${at}: kind "${cell.kind}" is not one of ${LIFECYCLE_KINDS.join("/")}`);
    }
    {
      // A CELL WITH NO REACHABLE SUBJECT costs a parse rather than a walk. The
      // reason travels with the refusal, because "this cannot be photographed"
      // is a recorded fact about the shipped code and a reader is owed it.
      //
      // READ OFF THE EFFECTIVE KIND (convergence): `kind` is optional on a plan
      // cell, so a rule that only fired on a declared one could be stepped
      // around by leaving it off while the cell NAME still names the kind.
      const effectiveKind = cell.kind ?? kindTokenInCell(cell.cell);
      const admission = captureHostAdmissibility(effectiveKind, cell.declaredHost);
      if (!admission.capturable) {
        v.push(
          `${at}: "${effectiveKind}" is recorded as composition-only on "${cell.declaredHost}" — ` +
            admission.reason,
        );
      }
    }
    // The same per-kind vocabulary the RECORD is judged by, applied to the plan
    // that will produce it, so a state this tier would refuse costs a parse
    // rather than a walk. The state judged is `walkCellState`'s — the SAME
    // derivation the walk itself uses, so a preflight cannot admit a cell the
    // walk will then photograph under a different state, and the vocabulary is
    // read off the EFFECTIVE kind for the same reason the arm above is: a plan
    // cell may leave `kind` off while its NAME still names one.
    const plannedStates = captureStatesFor(cell.kind ?? kindTokenInCell(cell.cell));
    const plannedState = walkCellState(cell);
    if (plannedState !== undefined && !plannedStates.includes(plannedState)) {
      v.push(`${at}: state "${plannedState}" is not one of ${plannedStates.join("/")}`);
    }
    if (cell.build !== undefined && !CAPTURE_BUILDS.includes(cell.build)) {
      v.push(`${at}: build "${cell.build}" is not one of ${CAPTURE_BUILDS.join("/")}`);
    }
    if (cell.framing !== undefined && !CAPTURE_FRAMINGS.includes(cell.framing)) {
      v.push(`${at}: framing "${cell.framing}" is not one of ${CAPTURE_FRAMINGS.join("/")}`);
    }
    const pathViolation = screenshotPathViolation(cell.screenshot);
    if (pathViolation) {
      v.push(`${at}: ${pathViolation}`);
    } else if (seenShot.has(cell.screenshot)) {
      v.push(
        `${at}: writes ${cell.screenshot}, already written by "${seenShot.get(cell.screenshot)}" — ` +
          "one image cannot be the evidence for two cells",
      );
    } else seenShot.set(cell.screenshot, cell.cell);
  }

  for (const retired of plan.retires ?? []) {
    if (!isNonEmptyString(retired)) v.push("`retires` must name cells as strings");
    else if (seenCell.has(retired)) {
      v.push(
        `the plan both retires and produces "${retired}" — a cell this walk writes is replaced by ` +
          "the write, and naming it as retired would delete the record the walk just made",
      );
    }
  }
  return v;
}

/**
 * OBSERVE one walk cell, and refuse to hand back a record the index would not take.
 *
 * This is the recorder's own walk path. `observeCapture` measures the screen;
 * this wraps it in the promise the driver above makes only for its own output —
 * that a record is validated at the AUDIT tier, against the image on disk,
 * BEFORE anything holds it. A walk is expensive and mostly unrepeatable, so a
 * cell that did not come out has to say so at the cell rather than at the end of
 * the round, when the page it failed on is long gone.
 *
 * It takes the same `CapturePage` port `observeCapture` takes, so it runs
 * against a fake page in a unit test and against Playwright in the driver, and
 * neither of those is a special case of the other.
 */
export async function observeWalkCell({
  page,
  cell,
  repoRoot = process.cwd(),
  readImpl = readFileSync,
  now = () => new Date().toISOString(),
  // TEST-ONLY, and named so it reads as one. A real walk never passes it.
  virtualFilesystem = false,
}) {
  const record = await observeCapture({
    page,
    cell: cell.cell,
    declaredHost: cell.declaredHost,
    kind: cell.kind,
    state: walkCellState(cell),
    instance: cell.instance ?? null,
    screenshot: cell.screenshot,
    build: cell.build ?? "development",
    framing: cell.framing ?? "window",
    repoRoot,
    readImpl,
    now,
  });
  // THE VIRTUAL FILESYSTEM IS AN EXPLICIT REQUEST, NEVER AN INFERENCE. This
  // used to read `readImpl !== readFileSync` and treat any non-default reader
  // as "the caller brought its own filesystem" -- so the implicit bypass simply
  // moved up a layer, and any wrapped or instrumented reader silently skipped
  // the final on-disk resolution. A walk driven for real ALWAYS validates its
  // own output from disk; only a suite that says `virtualFilesystem: true` is
  // answered from its own bytes.
  const violations = validateCaptureRecord(record, {
    repoRoot,
    tier: "audit",
    ...(virtualFilesystem
      ? { virtualFilesystem: true, hashOf: (rel) => hashFile(join(repoRoot, rel), readImpl) }
      : {}),
  });
  if (violations.length > 0) {
    throw new Error(
      `walk cell "${cell.cell}" produced a record the index would refuse:\n  ` +
        violations.join("\n  "),
    );
  }
  return record;
}

/**
 * MERGE a walk's records into an index, surgically.
 *
 * `main` below rewrote `records` with ONLY the run's own output, which meant a
 * lane adding four cells silently deleted the other fifty-four. Nothing caught
 * it because a smaller index is still a valid index. So a walk MERGES: every
 * record it did not write survives untouched and in place, a record it rewrote
 * is replaced where it stood, and the cells the plan RETIRES are dropped. The
 * retirement is part of the plan rather than a separate act, because a round
 * that replaces an earlier round's pictures is the only thing that has standing
 * to say the earlier records are stale.
 */
export function mergeWalkRecords({ index, records, retires = [] }) {
  const retired = new Set(retires);
  const written = new Map(records.map((r) => [r.cell, r]));
  const out = [];
  for (const existing of index?.records ?? []) {
    if (retired.has(existing?.cell)) continue;
    if (written.has(existing?.cell)) {
      out.push(written.get(existing.cell));
      written.delete(existing.cell);
      continue;
    }
    out.push(existing);
  }
  for (const record of records) {
    if (written.has(record.cell)) out.push(record);
  }
  return { ...index, records: out };
}
