#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CAPTURE-RECORD CONTRACT — the evidence half of the chat-HITL anti-fraud gates
// (cinatra#2821, epic #2784 S9h).
//
// WHAT IT REFUSES. A screenshot filed under a host it does not show. #2794's
// first round filed pictures of the Agents page under chat-cell names, and
// nothing ever compared a capture's CLAIM to what was observed on the screen,
// because the claim lived in the FILENAME and a filename carries no authority.
//
// SO: a cell name is a claim, and a claim needs a record. Each record carries
// the cell it answers, the host it declares, the final URL, the screenshot with
// its SHA-256, and frame-scoped selector assertions with the counts observed on
// that screen. This contract checks the record against the claim:
//
//   - the cell name's host/kind/state tokens must equal the record's;
//   - the final URL must be of the host's URL class (a `/chat` claim answered by
//     an `/agents/...` URL is the exact #2794 defect);
//   - the host's required anchors must have been observed, IN THE SAME FRAME,
//     with counts >= 1 -- `[data-conversation-list]` alone does NOT identify
//     chat_thread, because the widget transcript ships the same list, so the
//     card root's own `data-lifecycle-card-host` declaration is required beside
//     it;
//   - a `pending` capture owes its decision controls; a `decided` capture owes
//     their ABSENCE and a decided summary, so the easier requirement set cannot
//     answer the harder claim;
//   - a LIVE screenshot must exist where it says, be repo-relative, and hash to
//     the recorded digest; a PINNED one names a historical permalink into this
//     repository at a full 40-char commit, and its bytes are read back out of
//     history (`git cat-file`, one `git fetch --depth=1` per commit on a
//     shallow checkout) and hashed to the SAME requirement -- a blob that
//     cannot be produced is a finding, not a pass; and no two records may share
//     a path or a digest either way, so one picture cannot furnish a whole
//     index.
//
// THE HONEST LIMIT, stated because a gate that overclaims is worse than none:
// these records are text, and text is forgeable. A person can hand-write a
// record with a real image and invented counts, and this contract will accept
// it. What it does catch is the accidental mislabel, the missing observation,
// the drifted hash, the re-used picture, and the cell that cites nothing at
// all -- which is every failure #2794's round actually produced. Binding pixels
// to assertions needs an attested capture run, which no committed evidence file
// in this repository has.
//
// Zero runtime dependencies (node builtins only).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * THE ONE CANONICAL CAPTURE INDEX, named ONCE.
 *
 * Both halves read the same file, so both halves must compute the same path,
 * and the only way to guarantee that is to compute it in ONE place. Each reader
 * used to `join(__dirname, "chat-hitl-capture-index.json")` from its OWN
 * directory, which produced two different files that each called itself
 * canonical: the CI half's (populated) and the audit half's (empty). The empty
 * one was also the capture driver's default output, so an honest capture run
 * wrote its records where nothing would ever bind them.
 *
 * `CAPTURE_INDEX_PATH` is the absolute path every reader resolves;
 * `CAPTURE_INDEX_RELATIVE_PATH` is the same file as a repo-relative string, for
 * usage lines and messages. `scripts/ci/__tests__/capture-index-path.test.mjs`
 * pins that the CI gate, the audit gate and the driver all land on the one file.
 */
export const CAPTURE_INDEX_RELATIVE_PATH = "scripts/ci/chat-hitl-capture-index.json";
export const CAPTURE_INDEX_PATH = join(__dirname, "..", "chat-hitl-capture-index.json");

/**
 * THE ONE RECORDER IDENTITY, named ONCE, for the index header AND the per-record
 * `recordedBy` field.
 *
 * There were three: the CI index header said `chat-hitl-capture-recorder@1`, the
 * audit index header said `scripts/audit/lib/chat-hitl-capture-recorder.mjs@1`,
 * and every one of the eight committed records said this. This value wins
 * because it is the one already stamped on real records, and the same string is
 * mirrored in each lane's own `capture-records.json` twin beside its captures --
 * changing the index copies would silently desynchronize them from evidence
 * this branch does not own. Identity here is PROSE: neither validator hashes it
 * or derives anything from it, so the choice is about which committed text stays
 * true, not about what a check can verify.
 */
export const RECORDER_ID = "cinatra-lifecycle-capture-recorder@1";

/** The four hosts, mirroring `LIFECYCLE_CARD_HOSTS` in agent-ui-protocol. */
export const CAPTURE_HOSTS = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
];

/**
 * The URL classes. A claim about a host is a claim about WHERE the picture was
 * taken, so the class is checked against the recorded final URL rather than
 * against the requested one (a redirect is exactly how a capture ends up on the
 * wrong screen without anybody noticing).
 *
 * `review_page` IS THE GATE-REGION DEEP LINK, not the queue. It used to read
 * /^\/agents\/reviews/, which is `/agents/reviews` -- the org's open-review
 * QUEUE, a navigation-and-volume screen that mounts no lifecycle card at all.
 * The surface that actually declares `host="page_gate_region"` is the ONE named
 * by the host-parity ratchet (`HOST_COMPOSITION_SOURCES` in
 * `src/lib/lifecycle/lifecycle-host-parity-ratchet.ts`):
 * `/agents/<vendor>/<package>/<runId>/review/<reviewTaskId>`. So the class as
 * written could not be satisfied by ANY truthful page_gate_region record, and
 * was satisfied instead by a picture of a screen with no card on it -- the
 * #2794 defect inverted. The audit half already spelled the shipped shape
 * (`URL_CLASS_ORDER` in `scripts/audit/lib/chat-hitl-capture-recorder.mjs`);
 * this is the same regex, so the two halves now classify identically instead of
 * disagreeing about the same URL.
 *
 * Note the deliberate overlap the audit half resolves by ORDER: a review page is
 * also a run-detail path. That ordering is meaningful there because it
 * CLASSIFIES an unknown URL; here each host names exactly one class and only
 * that class is tested, so no ordering is needed.
 */
export const URL_CLASSES = {
  chat: /^\/chat(?:[/?#]|$)/,
  run_detail: /^\/agents\/[^/]+\/[^/]+\/[0-9a-fA-F-]{36}(?:[/?#]|$)/,
  review_page: /^\/agents\/[^/]+\/[^/]+\/[^/?#]+\/review\/[^/?#]+(?:[/?#]|$)/,
  embed_assistant: /^\/embed\/assistant(?:[/?#]|$)/,
};

/**
 * Which URL class each host is photographed on.
 *
 * A HOST CAN LEGITIMATELY APPEAR ON TWO CLASSES, and exactly one does
 * (cinatra#2997). The `run_card` host is the RUN'S OWN CARD, and that card is
 * drawn on two surfaces: the run page, and inside a conversation, where it is
 * the inline run panel. It has always been drawn in both — what changed is that
 * it now draws a LIFECYCLE CARD in the conversation too, because the maintainer
 * ruled the run card IS the review screen once the work opens one:
 *
 *   "Once the agent is done and the output generated, that 'Agentic Run
 *    Progress' card is being automatically replaced with the 'Review requested'
 *    screen. On the run page, the same is true."
 *   — the request for changes on pull request 2890; PLAN: Agents Lifecycle (A)
 *     section 4.2 carries the same sentence.
 *
 * So a `run_card` record taken on a `/chat` path is not a mislabelled cell any
 * more; it is the conversation's own reading of that host. Every other host
 * keeps exactly one class, and the list is still closed — a host may only be
 * photographed on a class named here.
 */
export const HOST_URL_CLASS = {
  chat_thread: "chat",
  run_card: ["run_detail", "chat"],
  page_gate_region: "review_page",
  site_widget: "embed_assistant",
};

/**
 * The card kinds, their cell-name tokens, their shipped root selector and the
 * decision controls a PENDING capture owes. Selectors are read off the shipped
 * components, not invented here:
 *   `packages/agents/src/review-gate-card.tsx`          (root + decision bar)
 *   `packages/agents/src/run-recommendation-chip-row.tsx` (per-chip confirm /
 *                                                        adjust / skip)
 */
export const CARD_KINDS = {
  artifact_review_gate: {
    cellTokens: ["review-card", "review-gate-card", "review"],
    root: '[data-lifecycle-card="artifact_review_gate"]',
    decisionControls: ['[data-conformance-id="review-decision-bar"]'],
  },
  recommendation_hold: {
    cellTokens: ["recommendation-hold", "recommendation-card", "recommendation"],
    // The row IS the card (§V), so this root is the chip-row's own outermost
    // element, which carries the kind/host/state declaration from cinatra#2841
    // exactly as `ReviewGateCard` does. Before that fix no truthful capture of
    // this card could satisfy this contract, because the shipped row emitted
    // none of the three.
    root: '[data-lifecycle-card="recommendation_hold"]',
    // REDRAWN by cinatra#2841 to the ratified §V drawing: the card's decision
    // controls are PER CHIP (Confirm / Adjust / Skip on each skill), and the
    // row-level Confirm/Skip pair the previous selectors named no longer exists.
    // A pending capture owes at least one of the three; a decided capture owes
    // the absence of all three, which is exactly what a settled row draws.
    decisionControls: [
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ],
  },
  trigger_schedule_proposal: {
    cellTokens: ["trigger-card", "schedule-card", "trigger-schedule-proposal"],
    root: '[data-lifecycle-card="trigger_schedule_proposal"]',
    // §VI's DECISION floor is **Confirm**, and it is the only thing a capture of
    // this kind owes: present while the card is undecided, absent once it is
    // settled.
    //
    // TWO CORRECTIONS ARE FOLDED IN HERE. The placeholder-era `[data-action]`
    // was written before any of the card existed and matched too much — the
    // settled reading draws Save changes, and on the two page hosts Cancel
    // schedule and Run now as well — so a truthful settled capture was
    // refused as "still offers a decision". And the interim wording named an
    // `adjust-schedule-proposal` control that no longer exists: plan (A) §7.2,
    // "The option rows are editable as they stand: until you confirm, you change
    // the proposal directly on the card — the rows are never locked behind a
    // separate step. The floor is **Confirm**". Naming a retired control would
    // make a correct card unindexable.
    //
    // ONE MEMBER, and it is the same one in every undecided phase: a live
    // proposal and an EXPIRED one both end on Confirm ("an expired proposal
    // **stays visible**, still editable, with **Confirm** to propose again",
    // §7.2 step 2). So there is no group to read as "any" or "every" — the
    // requirement is the same selector for both, which is what makes the two
    // tiers agree without either weakening.
    //
    // SAVE CHANGES IS DELIBERATELY NOT LISTED. It is the settled card's control,
    // and a DECIDED capture owes the ABSENCE of the decision controls — listing
    // Save changes would make every honest armed capture fail for showing the
    // control the plan puts on it. What a settled capture owes is graded by the
    // anchor set instead, where `[data-action="save-schedule-changes"]` is a
    // ratified member.
    decisionControls: ['[data-action="confirm-schedule-proposal"]'],
  },
  verification_summary: {
    cellTokens: ["verification-card", "audit-card", "verification"],
    root: '[data-lifecycle-card="verification_summary"]',
    decisionControls: ["[data-action]"],
  },
  // THE FIFTH KIND (cinatra#2930, lifecycle-b W3) — the agent paused mid-run to
  // ask a person for input. It was registered as a kind before it had a card,
  // and this vocabulary still refused it after the card landed, which made its
  // pictures unindexable: a truthful capture of the shipped screen could not be
  // named here at all.
  agent_hitl_screen: {
    cellTokens: ["hitl-card", "hitl-screen", "agent-hitl-screen"],
    root: '[data-lifecycle-card="agent_hitl_screen"]',
    // ONE MEMBER, and it is deliberately the FIELDS REGION rather than the
    // Continue. The screen has two shapes and only one of them draws a
    // Continue: a MID-RUN gate carries the card's own Continue, and a
    // SETUP-LOOP gate submits on change and draws none
    // (`packages/agents/src/agent-hitl-screen-card.tsx`). Requiring the
    // Continue would refuse an honest capture of the setup screen; and a
    // multi-member group is read by the audit tier as "every member present",
    // which is the same trap `trigger_schedule_proposal` was caught in. The
    // fields region is what a pending screen ALWAYS draws, on both shapes and
    // on both capturable hosts, and it is what a settled one stops drawing.
    // The Continue is ratified as an ANCHOR in the one-card gate's set for this
    // kind instead, exactly as `save-schedule-changes` is.
    decisionControls: ['[data-conformance-id="hitl-screen-fields"]'],
    // THE SETTLED READING OF THIS KIND IS AN ABSENCE, and it is the only kind
    // that is. A decided review card is still drawn — its floor is replaced by
    // its outcome — so `decided` owes the card's root and its state
    // declaration. This card's settled state is `none`, which is NO DOM AT ALL
    // (the card returns null), because a question that has been answered is not
    // a question the transcript should keep asking. So a `decided` capture of
    // this kind owes the ABSENCE of the root and of the fields region rather
    // than their presence, which is exactly what the shipped card draws after
    // the answer lands.
    settledIsAbsence: true,
    // WHERE A TRUTHFUL PICTURE OF THIS KIND CAN BE TAKEN AT ALL. The kind is
    // MOUNTED on all four hosts and the parity ratchet records all four; what
    // this says is narrower and is about the CAMERA, not the mount — two of
    // those cells cannot be reached by any sequence the shipped code offers, so
    // asking for a picture of them would be asking for one that has to be
    // staged.
    capturableHosts: ["chat_thread", "run_card"],
    compositionOnly: {
      site_widget:
        "a card travels from the run's own turn, and a widget conversation cannot start a " +
        "run that reaches `pending_approval`: `agent_run` is not in the delegated widget " +
        "allowlist (packages/mcp-server/src/delegated-widget-tool-policy.ts), and the " +
        "content-editor launch claims no present human and runs queued -> running -> " +
        "completed without ever parking (src/lib/host-content-editor-dispatch.ts). The " +
        "mount is real and is proven by the card suite's widget arms and the real-store " +
        "submit tier; it is the PICTURE that has no reachable subject.",
      page_gate_region:
        "the review page draws a gate region for ONE review task, and this card refuses a " +
        "MARKED artifact-review gate (packages/agents/src/agent-hitl-screen-core.ts) while " +
        "the run's HITL context answers only for `pending_approval` — so a single-gate run " +
        "shows the review gate or this one, never both, and no sequence reaches a run " +
        "parked on a non-review gate while a review page for a different review task of the " +
        "same run exists. The region composes the card; the composition is what is " +
        "recorded, not a photograph of it.",
    },
  },
};

/**
 * MAY A CAPTURE OF THIS KIND BE TAKEN ON THIS HOST?
 *
 * The smallest notion the gate and the plan validator can both enforce: a kind
 * may declare the hosts a truthful picture of it can be taken on, and must give
 * the REASON for each host it leaves out. A kind that declares nothing is
 * capturable on every host, which is what the four kinds that came before this
 * one say by saying nothing — so this adds a rule without moving any of them.
 *
 * This is not a claim about the MOUNT. A composition-only cell is still drawn,
 * still recorded by the host-parity ratchet and still asserted by the render
 * suites; what it has no reachable subject for is a PHOTOGRAPH.
 */
export function captureHostAdmissibility(kind, host) {
  const spec = kind ? CARD_KINDS[kind] : null;
  if (!spec || !Array.isArray(spec.capturableHosts)) return { capturable: true, reason: null };
  if (spec.capturableHosts.includes(host)) return { capturable: true, reason: null };
  return {
    capturable: false,
    reason: spec.compositionOnly?.[host] ?? "declared composition-only, with no reason recorded",
  };
}

/** Does this kind's SETTLED reading draw nothing at all? */
export function settledIsAbsence(kind) {
  return (kind ? CARD_KINDS[kind]?.settledIsAbsence : false) === true;
}

/**
 * WHAT A `decided` RECORD OF A SETTLED-ABSENCE KIND PINS — the one rule both
 * tiers enforce, so neither can drift into refusing what the other writes.
 *
 * THE HOLE THIS CLOSES. `settledIsAbsence` makes `requiredAssertionsFor` owe the
 * card ABSENT, so a decided capture of such a kind has no root-scoped
 * requirement; the recorder resolves a root only for root-scoped requirements,
 * so it wrote no `instance`; and the audit tier requires an `instance` of any
 * record whose kind has a card root. Each rule was right on its own and
 * together they refused EVERY truthful `decided` record of the one kind that
 * settles to no DOM — measured twice, on two real runs, on the pictures this
 * program exists to index.
 *
 * THE SMALLEST THING THAT CLOSES IT is to say what such a record pins instead of
 * a card: THE ABSENCE. The kind's own root, the count that was read for it —
 * which must be zero, and which the recorder takes twice around the shutter
 * like every other number — an empty attribute set, because identity is read off
 * an element and there was none, and the claim itself in as many words.
 *
 * IT IS A NARROW ADMISSION, NOT A LOOSENING. An absence instance is admissible
 * ONLY on a `decided` capture of a kind whose settled reading draws nothing; a
 * kind whose settled reading is a card with an outcome on it still owes the card
 * it measured, and a record claiming otherwise is refused here rather than
 * quietly indexed. Nothing in this function is a digest input: it grades a
 * record, it does not change which anchors a claim owes.
 *
 * @returns {string[]} the reasons this record's `instance` is not that — empty when it is.
 */
export function absenceInstanceViolations({ instance, kind, state }) {
  const spec = kind ? CARD_KINDS[kind] : null;
  const root = spec?.root ?? null;
  const settledAbsent = spec?.settledIsAbsence === true && state === "decided";
  const inst = instance ?? null;
  const claimsAbsence = inst !== null && typeof inst === "object" && inst.absent === true;
  const out = [];
  if (claimsAbsence && !settledAbsent) {
    out.push(
      `the record pins an ABSENCE instance, and "${kind ?? "(no kind)"}" at state ` +
        `"${state ?? "(none)"}" has no absence to pin — only a decided capture of a kind whose ` +
        "settled reading draws nothing at all may say the card it measured was not there",
    );
    return out;
  }
  if (!settledAbsent || root === null) return out;
  if (inst === null || typeof inst !== "object") {
    out.push(
      "a decided capture of a kind whose settled reading is an ABSENCE must pin that absence — " +
        `the root it was owed (${root}), the count it read for it, and \`absent: true\` — rather ` +
        "than carrying no instance at all, which reads the same as never having looked",
    );
    return out;
  }
  if (inst.absent !== true) {
    out.push(
      "this kind settles to no DOM at all, so a decided record of it pins the ABSENCE of its root " +
        `(\`absent: true\`) rather than a card: it pins ${JSON.stringify(inst.selector)}`,
    );
  }
  if (inst.selector !== root) {
    out.push(
      `the recorded absence pins ${JSON.stringify(inst.selector)}, and this kind's own root is ${root}`,
    );
  }
  if (inst.matched !== 0) {
    out.push(
      `the recorded absence counted ${JSON.stringify(inst.matched)} card(s) at ${root} — a root ` +
        "that is still on the screen is not a settled reading, whatever the record calls it",
    );
  }
  // THE WHOLE SHAPE, not only the parts that are easy to check. An absence that
  // still names WHICH card it was (an index, an id) or what was read off it
  // (attributes) is claiming a measurement of something that was not on the
  // screen, and half-checking the shape is how a forged one gets in.
  if (inst.index !== null) {
    out.push(
      `the recorded absence pins index ${JSON.stringify(inst.index)} — there is no card for it to ` +
        "be the nth of, so an absence records `index: null`",
    );
  }
  if (inst.id !== null && inst.id !== undefined) {
    out.push(
      `the recorded absence names instance ${JSON.stringify(inst.id)} — a card that was not on ` +
        "the screen cannot have been identified",
    );
  }
  // A PLAIN, EMPTY OBJECT — checked as such rather than by `typeof`, which a
  // Date, a Map, an array and anything with a prototype of its own all satisfy,
  // and by EVERY own key rather than the enumerable string ones, which a symbol
  // key or a non-enumerable one both slip past.
  const attrs = inst.attributes;
  const proto =
    attrs !== null && typeof attrs === "object" ? Object.getPrototypeOf(attrs) : undefined;
  if (
    attrs === null ||
    typeof attrs !== "object" ||
    (proto !== Object.prototype && proto !== null)
  ) {
    out.push(
      "identity is read OFF the element and there was no element — an absence records an empty " +
        "plain `attributes` OBJECT rather than omitting it or standing something else in its place",
    );
  } else if (Reflect.ownKeys(attrs).length > 0) {
    out.push(
      `the recorded absence carries attributes ${Reflect.ownKeys(attrs)
        .map(String)
        .join(", ")} — an element that was not on the screen cannot have been read`,
    );
  }
  return out;
}

/**
 * Cell-name state tokens, normalized to the states evidence claims.
 *
 * `advisory` IS ONE OF THEM. The audit card resolves it -- it reports a reading
 * and asks for no decision -- and two records of exactly that state already
 * stand in the index, on `run_card` and on `page_gate_region`. They stand
 * because this map did NOT carry the token: an unmapped token leaves
 * `parseCellName` with a null state, and a null state asks a record for neither
 * a pending card's controls nor a decided card's absences. That is the right
 * requirement set for this state, arrived at by silence -- and silence did not
 * survive the third host, where the audit tier enumerates the states a record
 * may declare and refused the same card (the driven refusal is recorded in
 * `https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2791-s9g-conformance/capture-results.json`). Naming the token makes
 * both halves read one vocabulary instead of one reading a state and the other
 * reading nothing.
 */
export const STATE_ALIASES = {
  pending: "pending",
  held: "pending",
  open: "pending",
  "live-run": "pending",
  // `agent_hitl_screen` draws `data-lifecycle-card-state="asking"` — the run is
  // waiting at the screen. It is the same claim `pending` makes and it is
  // normalized to it rather than admitted as a third state, so one vocabulary
  // still grades every kind.
  asking: "pending",
  answered: "decided",
  decided: "decided",
  settled: "decided",
  resolved: "decided",
  done: "decided",
  advisory: "advisory",
};

/**
 * The two states a card that ASKS FOR A DECISION resolves, named ONCE for both
 * halves. The audit tier re-exports this list as its own `CAPTURE_STATES`, and
 * the anchor contract computes its digest over one anchor set per
 * (host, kind, state) drawn from it -- so THIS list is a digest input, and the
 * per-kind vocabulary below is deliberately not one.
 *
 * It is NOT "the states every kind resolves". Three kinds resolve exactly these
 * two; the fourth resolves neither. `KIND_CAPTURE_STATES` is the authority on
 * what a kind may declare, and this list is the default a kind the map does not
 * name falls back to.
 */
export const CANONICAL_CAPTURE_STATES = Object.freeze(["pending", "decided"]);

/**
 * THE STATE VOCABULARY, PER KIND -- exact, not additive.
 *
 * A card asking for a decision is `pending` until it is taken and `decided`
 * after. The audit card asks for none: it resolves `advisory`, the reading, or
 * `absent`, which draws NO DOM AT ALL and therefore has nothing to photograph
 * ("TWO STATES DRAW, AND ONLY TWO", packages/agents/src/verification-summary-card.tsx).
 * So `verification_summary` resolves `advisory` and NOTHING ELSE: a `pending`
 * record of it would be a reading asking for a decision it has no floor to take,
 * and a `decided` one a verdict the resolver never issues. Listing it as
 * "the two, plus advisory" would admit both.
 *
 * Two advisory records of that card already stand in the index (`run_card`,
 * `page_gate_region`); a third was DRIVEN on `chat_thread` and refused by the
 * audit tier, which enumerated one list for four kinds. The refusal is recorded
 * in `https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2791-s9g-conformance/capture-results.json`.
 *
 * IT ADDS NO ANCHOR. A kind's advisory requirement set is the set its two
 * ratified sets are BUILT from: a pending capture is that set plus the decision
 * controls, a decided one is that set plus the decided summary and the
 * controls' measured absence. Every selector an advisory record owes therefore
 * already appears inside this kind's ratified `pending` and `decided` anchor
 * entries -- stated precisely, because there is no `<kind>|advisory` entry in
 * the digest and this change does not add one: the anchor map is enumerated
 * over `CANONICAL_CAPTURE_STATES` and is left exactly where it was ratified.
 * `scripts/ci/__tests__/capture-record-contract.test.mjs` pins the subset
 * relation so it cannot quietly stop being true.
 */
export const KIND_CAPTURE_STATES = Object.freeze({
  artifact_review_gate: CANONICAL_CAPTURE_STATES,
  recommendation_hold: CANONICAL_CAPTURE_STATES,
  trigger_schedule_proposal: CANONICAL_CAPTURE_STATES,
  // The HITL screen asks a question and is answered, so it resolves the two
  // like any other card that asks for something. Its own spellings — `asking`
  // and `answered` — are NORMALIZED to them by `STATE_ALIASES` rather than
  // admitted as states of their own, which is what keeps one vocabulary
  // grading every kind. What is unusual about this kind is its settled
  // READING, not its settled state: `settledIsAbsence` above.
  agent_hitl_screen: CANONICAL_CAPTURE_STATES,
  verification_summary: Object.freeze(["advisory"]),
});

/**
 * The closed set of states a record of this kind may declare.
 *
 * A kind the map does not name falls back to the two -- a record that names no
 * kind, or names one outside `CARD_KINDS`, is refused by its own arm, and this
 * one must not answer that question a second time in a different voice.
 */
export function captureStatesFor(kind) {
  return KIND_CAPTURE_STATES[kind] ?? CANONICAL_CAPTURE_STATES;
}

/** The marker a decided capture owes -- the card says what was decided. */
export const DECIDED_SUMMARY_SELECTOR = "[data-lifecycle-card-state]";

/**
 * Parse a cell name into its claim. Returns null when the name carries no host
 * token -- an unclassifiable name is reported by the caller as its own finding,
 * never silently skipped.
 */
export function parseCellName(cellName) {
  if (typeof cellName !== "string" || cellName === "") return null;
  const base = cellName.replace(/\.[a-z0-9]+$/i, "");
  const tokens = base.split("__").filter(Boolean);
  const hostIndex = tokens.findIndex((t) => CAPTURE_HOSTS.includes(t));
  if (hostIndex < 0) return null;
  const host = tokens[hostIndex];
  const kindToken = hostIndex > 0 ? tokens[hostIndex - 1] : null;
  const kind =
    Object.entries(CARD_KINDS).find(([, spec]) =>
      spec.cellTokens.includes(kindToken ?? ""),
    )?.[0] ?? null;
  let state = null;
  for (const t of tokens.slice(hostIndex + 1)) {
    if (STATE_ALIASES[t]) {
      state = STATE_ALIASES[t];
      break;
    }
  }
  return { cell: base, host, kindToken, kind, state, tokens };
}

/**
 * The anchors a record must carry for its claim, each with the SCOPE it must
 * have been counted in:
 *   "frame" -- counted in the frame the picture was taken in;
 *   "root"  -- counted INSIDE the card's own root, so a marker borrowed from a
 *              different card on the same screen cannot answer for this one.
 */
export function requiredAssertionsFor({ host, kind, state }) {
  const spec = kind ? CARD_KINDS[kind] : null;
  const required = [];
  const forbidden = [];
  // A kind whose SETTLED reading is no DOM at all cannot owe its own root — see
  // `settledIsAbsence` on the kind. Everything else about the frame still holds:
  // the conversation list is still there, and the widget frame is still the
  // widget frame. What changes is that the card is owed ABSENT rather than
  // present, which is the claim its `decided` picture actually makes.
  const settledAbsence = spec?.settledIsAbsence === true && state === "decided";
  if (host === "chat_thread") {
    required.push({ selector: "[data-conversation-list]", scope: "frame" });
  }
  if (host === "site_widget") {
    required.push({ selector: ".cw-frame", scope: "page" });
    required.push({
      selector: '[data-embed-assistant][data-phase="active"]',
      scope: "frame",
    });
    required.push({ selector: "[data-conversation-list]", scope: "frame" });
  }
  if (!settledAbsence) {
    required.push({
      selector: `[data-lifecycle-card-host="${host}"]`,
      scope: "frame",
    });
  }
  if (spec) {
    if (!settledAbsence) required.push({ selector: spec.root, scope: "frame" });
    if (state === "pending") {
      for (const sel of spec.decisionControls) {
        required.push({ selector: sel, scope: "root", any: spec.decisionControls });
      }
    }
    if (state === "decided") {
      if (settledAbsence) {
        // THE WHOLE CARD IS THE ABSENCE, counted frame-wide because there is no
        // root left to count anything inside. The host declaration is neither
        // required nor forbidden: another kind's card may legitimately be on the
        // same screen, and refusing that would refuse an honest picture.
        forbidden.push({ selector: spec.root, scope: "frame" });
        for (const sel of spec.decisionControls) {
          forbidden.push({ selector: sel, scope: "frame" });
        }
      } else {
        required.push({ selector: DECIDED_SUMMARY_SELECTOR, scope: "root" });
        for (const sel of spec.decisionControls) {
          forbidden.push({ selector: sel, scope: "root" });
        }
      }
    }
  }
  return { required, forbidden };
}

function pathOf(url) {
  try {
    return new URL(url).pathname + (new URL(url).search || "");
  } catch {
    return typeof url === "string" && url.startsWith("/") ? url : null;
  }
}

/** sha256 of a file, read from DISK -- never re-derived from the record. */
export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A HISTORICAL PERMALINK into this repository, pinned to a full 40-char commit.
 *
 * Deliberately strict about the host, the repository and the sha length: a
 * branch ref (`/blob/main/…`) moves under the claim and a short sha is
 * ambiguous, so neither is a pin and neither is accepted here.
 */
export const PERMALINK_PREFIX = "https://github.com/cinatra-ai/cinatra/blob/";
const PERMALINK = /^https:\/\/github\.com\/cinatra-ai\/cinatra\/blob\/[0-9a-f]{40}\/.+$/;
export function isHistoricalPermalink(value) {
  return typeof value === "string" && PERMALINK.test(value);
}

/**
 * The in-repository path a permalink points at, or the value unchanged when it
 * is already a repo-relative path. Lets a reader compare a pinned record and a
 * live one on the SAME axis -- which is what the directory binding needs.
 */
export function repoPathOf(value) {
  if (!isHistoricalPermalink(value)) return value;
  return value.slice(PERMALINK_PREFIX.length).replace(/^[0-9a-f]{40}\//, "");
}

/**
 * THE ROOT A PIN MAY POINT INTO.
 *
 * A permalink into this repository can name ANY path in it, and a record whose
 * "screenshot" is `src/app/icon.png` -- pinned, hashing correctly, and not a
 * capture of anything -- would otherwise satisfy every other rule. The old gate
 * refused that implicitly by requiring the proof-artifact root on disk; the pin
 * has to carry the same requirement or the root check was simply deleted.
 *
 * `evidence/` is the HISTORICAL root: the tree these pictures were committed in
 * before they left the product tree. It is a read-only fact about the past --
 * nothing writes there any more (a live run writes under the recorder's
 * `CAPTURE_OUTPUT_ROOT`), which is exactly why it is safe to keep naming it.
 */
export const PINNED_ARTIFACT_ROOT = "evidence/";

/**
 * THE ROOT A LIVE CAPTURE IS WRITTEN INTO.
 *
 * The counterpart of `PINNED_ARTIFACT_ROOT`: `evidence/` is where captures USED
 * to be committed, this is where a run mints them now. `test-results/` is the
 * Playwright config's own `outputDir` and is gitignored, so a passing run leaves
 * the tree clean by construction.
 *
 * IT IS DEFINED HERE, ONCE, because the RECORD CONTRACT is what both tiers read
 * and the canonical tier is the one the required workflow invokes. It used to be
 * declared in the recorder alone, so the audit tier enforced it and this tier
 * did not -- and a record citing `package.json` with that file's real hash
 * satisfied every canonical rule there was. The recorder now re-exports this
 * constant rather than keeping a second copy of the string.
 */
export const CAPTURE_OUTPUT_ROOT = "test-results/";

/** The commit and the path a pin names, or null when it is not a pin. */
export function parsePermalink(value) {
  if (!isHistoricalPermalink(value)) return null;
  const rest = value.slice(PERMALINK_PREFIX.length);
  return { sha: rest.slice(0, 40), path: rest.slice(41) };
}

// A PNG in this index runs to a few hundred KB; the ceiling is set well above
// the largest committed capture so a legitimate blob is never truncated into a
// hash mismatch, which would read as fraud rather than as a buffer limit.
const PINNED_MAX_BUFFER = 64 * 1024 * 1024;

// ONE fetch attempt per commit per process, and one read per (commit, path).
// The index carries 111 records over 8 commits and both gates validate it, so
// without these a run would spawn `git` hundreds of times and re-fetch the same
// commit for every record that cites it.
const pinnedFetchAttempts = new Set();
const pinnedBytes = new Map();

/**
 * READ A PINNED ARTIFACT OUT OF THIS REPOSITORY'S OWN HISTORY.
 *
 * The picture left the working tree; it did NOT leave the repository. The blob
 * is still reachable at the commit the permalink pins, so every check that used
 * to read it off disk still runs -- it just reads `git cat-file` instead of
 * `fs`. Nothing here is skipped and nothing is taken on trust.
 *
 * THE SHALLOW CHECKOUT. A CI job cloned at `fetch-depth: 1` does not have the
 * pinned commit locally, so a miss is followed by ONE `git fetch --depth=1
 * origin <sha>` for that commit and one retry. It is once per commit per
 * process: a second record citing the same commit reuses the first attempt
 * rather than re-fetching.
 *
 * A FAILURE IS A FINDING, NEVER A PASS. If the object cannot be produced --
 * unreachable commit, deleted branch, no network, a path that is not in that
 * tree -- the caller reports `capture/pinned-object-unreachable`. An
 * unverifiable record is not a verified one.
 *
 * @param {string} url a pinned permalink
 * @param {{repoRoot?: string, run?: Function, fetched?: Set<string>, cache?: Map<string, Buffer>}} [io]
 * @returns {{ok: true, bytes: Buffer} | {ok: false, reason: string}}
 */
export function readPinnedArtifact(url, io = {}) {
  const pin = parsePermalink(url);
  if (!pin) return { ok: false, reason: `"${url}" is not a pinned permalink` };
  const repoRoot = io.repoRoot ?? process.cwd();
  const run = io.run ?? spawnSync;
  const fetched = io.fetched ?? pinnedFetchAttempts;
  const cache = io.cache ?? pinnedBytes;

  const key = `${repoRoot}\u0000${pin.sha}:${pin.path}`;
  const hit = cache.get(key);
  if (hit) return { ok: true, bytes: hit };

  const spec = `${pin.sha}:${pin.path}`;
  const cat = () =>
    run("git", ["cat-file", "blob", spec], { cwd: repoRoot, maxBuffer: PINNED_MAX_BUFFER });

  let res = cat();
  let fetchNote = "";
  if (res?.status !== 0) {
    // Not local. On a shallow clone that is expected, so ask for the ONE commit.
    if (!fetched.has(pin.sha)) {
      fetched.add(pin.sha);
      const f = run("git", ["fetch", "--depth=1", "origin", pin.sha], { cwd: repoRoot });
      if (f?.status !== 0) {
        fetchNote = ` (fetch of ${pin.sha} failed: ${errText(f)})`;
      }
    } else {
      fetchNote = ` (a fetch of ${pin.sha} was already attempted in this run)`;
    }
    res = cat();
  }
  if (res?.status !== 0 || !res?.stdout) {
    return {
      ok: false,
      reason: `git cat-file could not produce ${spec}: ${errText(res)}${fetchNote}`,
    };
  }
  const bytes = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout);
  cache.set(key, bytes);
  return { ok: true, bytes };
}

function errText(res) {
  if (!res) return "no result";
  if (res.error) return String(res.error.message ?? res.error);
  const err = res.stderr ? Buffer.from(res.stderr).toString("utf8").trim() : "";
  return err || `exit ${res.status}`;
}

/** The sha256 of a pinned artifact, read from history. */
export function sha256Pinned(url, io = {}) {
  const read = io.readPinned ?? readPinnedArtifact;
  const got = read(url, io);
  if (!got.ok) return got;
  return { ok: true, sha256: createHash("sha256").update(got.bytes).digest("hex") };
}

/**
 * Validate ONE record against its own claim.
 *
 * @param {object} record
 * @param {{repoRoot?: string, fileExists?: (p: string) => boolean, hashFile?: (p: string) => string,
 *          hashPinned?: (url: string, io: object) => object, readPinned?: Function, run?: Function}} [io]
 * @returns {Array<{code: string, detail: string}>}
 */
export function validateCaptureRecord(record, io = {}) {
  const repoRoot = io.repoRoot ?? process.cwd();
  const fileExists = io.fileExists ?? existsSync;
  const hashFile = io.hashFile ?? sha256File;
  const hashPinned = io.hashPinned ?? sha256Pinned;
  const v = [];
  const push = (code, detail) => v.push({ code, detail });

  if (!record || typeof record !== "object") {
    return [{ code: "record/malformed", detail: "not an object" }];
  }
  const claim = parseCellName(record.cell);
  if (!claim) {
    push(
      "record/unclassifiable-cell",
      `cell "${record.cell}" carries no host token -- a name nobody can class is a claim nobody can check`,
    );
    return v;
  }
  if (record.declaredHost !== claim.host) {
    push(
      "record/host-claim-mismatch",
      `the cell name claims host "${claim.host}" but the record declares "${record.declaredHost}"`,
    );
  }
  if (claim.kind && record.declaredKind && record.declaredKind !== claim.kind) {
    push(
      "record/kind-claim-mismatch",
      `the cell name claims kind "${claim.kind}" but the record declares "${record.declaredKind}"`,
    );
  }
  if (claim.state && record.declaredState && record.declaredState !== claim.state) {
    push(
      "record/state-claim-mismatch",
      `the cell name claims state "${claim.state}" but the record declares "${record.declaredState}"`,
    );
  }

  // --- the cell has a reachable subject ------------------------------------
  // A kind may declare the hosts a truthful picture of it can be taken on. A
  // record for a cell it left out is refused WITH THE REASON, so the refusal
  // reads as the recorded fact it is rather than as an unexplained "no".
  {
    const claimedKind = record.declaredKind ?? claim.kind;
    const claimedHost = record.declaredHost ?? claim.host;
    const admission = captureHostAdmissibility(claimedKind, claimedHost);
    if (!admission.capturable) {
      push(
        "record/host-composition-only",
        `"${claimedKind}" is recorded as composition-only on "${claimedHost}" — ${admission.reason}`,
      );
    }
  }

  // AN EMPTY DECLARATION IS NOT A CLAIM, and it must not read as one. `""` is
  // not nullish, so `record.declaredKind ?? claim.kind` keeps the empty string
  // rather than falling back to the name -- and every arm that guards on
  // truthiness then skips silently, which turns a blank field into a way to
  // switch off the checks the claim owes. It is refused as malformed instead.
  for (const field of ["declaredKind", "declaredState"]) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value === "") {
      push(
        "record/empty-declaration",
        `\`${field}\` is present and empty -- an empty declaration is not a claim, and it answers no question the record is asked`,
      );
    }
  }

  // THE STATE MUST BE ONE THIS KIND RESOLVES. Before this arm an unmapped state
  // token did not fail -- it DISABLED the state-derived requirements, so a
  // `__advisory` review-gate cell was graded as if it claimed no state at all,
  // which is a pending card's controls dropped rather than met. The vocabulary
  // is per kind and EXACT, so the card that resolves `advisory` resolves only
  // that, and the three that resolve a decision resolve only their two.
  const kindForState = record.declaredKind ?? claim.kind;
  const stateForKind = record.declaredState ?? claim.state;
  if (
    kindForState &&
    stateForKind &&
    !captureStatesFor(kindForState).includes(stateForKind)
  ) {
    push(
      "record/state-not-in-kind-vocabulary",
      `"${kindForState}" resolves ${captureStatesFor(kindForState).join("/")}; this record claims state "${stateForKind}"`,
    );
  }

  // --- the URL class -------------------------------------------------------
  const host = record.declaredHost ?? claim.host;
  const wantedClasses = [HOST_URL_CLASS[host] ?? []].flat();
  const urlForClass =
    host === "site_widget" ? record.frameUrl ?? record.finalUrl : record.finalUrl;
  const p = pathOf(urlForClass);
  if (!p) {
    push("record/no-final-url", `no usable URL recorded for host "${host}"`);
  } else if (!wantedClasses.some((c) => URL_CLASSES[c]?.test(p))) {
    push(
      "record/url-class-mismatch",
      `host "${host}" is photographed on the ${wantedClasses.join(" or ")} URL class; this record was taken on "${p}"`,
    );
  }

  // --- the screenshot ------------------------------------------------------
  //
  // TWO SHAPES, and only two. A LIVE record names a repo-relative path a run
  // just wrote, and it is stat-ed and re-hashed here: the bytes on disk must be
  // the bytes the record claims. A PINNED record names a HISTORICAL PERMALINK
  // into this repository's own history, which is what a record becomes once its
  // picture leaves the working tree.
  //
  // THE SAME RULE, A DIFFERENT SOURCE. The picture left the working tree; it did
  // NOT leave the repository. A pinned record's bytes are read back out of
  // history with `git cat-file` at the commit the permalink names, and the
  // sha256 is RE-DERIVED from them and compared exactly as a live record's is.
  // Nothing is skipped: a blob that cannot be produced is its own finding
  // (`capture/pinned-object-unreachable`), never a pass.
  const shot = record.screenshot;
  if (typeof shot !== "string" || shot === "") {
    push("record/no-screenshot", "the record names no screenshot");
  } else if (isHistoricalPermalink(shot)) {
    const pinnedPath = repoPathOf(shot);
    if (!pinnedPath.startsWith(PINNED_ARTIFACT_ROOT)) {
      push(
        "record/pinned-screenshot-outside-proof-root",
        `"${shot}" pins ${pinnedPath}, which is not under ${PINNED_ARTIFACT_ROOT} — a pin may only ` +
          "name a picture from the proof-artifact tree, not an arbitrary file in the repository",
      );
    } else if (!HEX64.test(String(record.sha256 ?? ""))) {
      push("record/sha256-malformed", `"${record.sha256}" is not a sha256 digest`);
    } else {
      const got = hashPinned(shot, { repoRoot, readPinned: io.readPinned, run: io.run });
      if (!got.ok) {
        push("capture/pinned-object-unreachable", got.reason);
      } else if (got.sha256 !== record.sha256) {
        push(
          "record/sha256-mismatch",
          `"${shot}" hashes to ${got.sha256}, the record says ${record.sha256}`,
        );
      }
    }
  } else if (shot.startsWith("http://") || shot.startsWith("https://")) {
    push(
      "record/screenshot-not-a-pinned-permalink",
      `"${shot}" is a URL but not a ${PERMALINK_PREFIX}<40-char sha>/ permalink into this repository`,
    );
  } else if (shot.startsWith("/") || shot.includes("..")) {
    push(
      "record/screenshot-not-repo-relative",
      `"${shot}" is not a repo-relative path`,
    );
  } else if (!shot.startsWith(CAPTURE_OUTPUT_ROOT)) {
    // A LIVE RECORD MUST NAME A CAPTURE, not merely a file that exists and
    // hashes correctly. Without this arm any tracked path in the repository --
    // `package.json`, a source file -- satisfied the rest of this contract, and
    // the workflow that invokes this tier directly would go green on it.
    push(
      "record/screenshot-outside-capture-root",
      `"${shot}" is not under ${CAPTURE_OUTPUT_ROOT} — a live capture is written into the run ` +
        `output root, and a picture that has left the tree is cited as a pinned permalink instead`,
    );
  } else {
    const abs = join(repoRoot, shot);
    if (!fileExists(abs)) {
      push("record/screenshot-missing", `"${shot}" does not exist in the tree`);
    } else if (!HEX64.test(String(record.sha256 ?? ""))) {
      push("record/sha256-malformed", `"${record.sha256}" is not a sha256 digest`);
    } else {
      const actual = hashFile(abs);
      if (actual !== record.sha256) {
        push(
          "record/sha256-mismatch",
          `"${shot}" hashes to ${actual}, the record says ${record.sha256}`,
        );
      }
    }
  }

  // --- the observations ----------------------------------------------------
  const assertions = Array.isArray(record.assertions) ? record.assertions : [];
  const observed = new Map();
  for (const a of assertions) {
    if (!a || typeof a.selector !== "string") {
      push("record/malformed-assertion", `assertion is not {selector, scope, count}`);
      continue;
    }
    if (!Number.isInteger(a.count) || a.count < 0) {
      push(
        "record/malformed-assertion",
        `"${a.selector}" carries no observed integer count`,
      );
      continue;
    }
    observed.set(`${a.scope ?? "frame"}::${a.selector}`, a.count);
  }
  const { required, forbidden } = requiredAssertionsFor({
    host,
    kind: record.declaredKind ?? claim.kind,
    state: record.declaredState ?? claim.state,
  });
  const satisfied = (sel, scope) => (observed.get(`${scope}::${sel}`) ?? 0) >= 1;
  for (const req of required) {
    // An `any` group is satisfied by any one of its members (Confirm OR Skip).
    if (req.any && req.any.some((s) => satisfied(s, req.scope))) continue;
    if (!observed.has(`${req.scope}::${req.selector}`)) {
      push(
        "record/anchor-never-observed",
        `"${req.selector}" (${req.scope}-scoped) was never looked for -- an unmeasured anchor counts as zero`,
      );
    } else if (!satisfied(req.selector, req.scope)) {
      push(
        "record/anchor-count-zero",
        `"${req.selector}" (${req.scope}-scoped) was observed 0 times on this screen`,
      );
    }
  }
  for (const f of forbidden) {
    if ((observed.get(`${f.scope}::${f.selector}`) ?? 0) > 0) {
      push(
        "record/decided-still-offers-decision",
        `a decided capture still shows "${f.selector}" -- it is not decided`,
      );
    }
  }

  // --- what the record pins, where its kind settles to an absence ----------
  // The one rule both tiers enforce -- see `absenceInstanceViolations`.
  for (const detail of absenceInstanceViolations({
    instance: record.instance ?? null,
    kind: record.declaredKind ?? claim.kind,
    state: record.declaredState ?? claim.state,
  })) {
    push("record/absence-instance", detail);
  }
  return v;
}

/**
 * Validate a whole index: every record on its own terms, plus the two
 * index-level refusals that stop one picture from furnishing everything.
 *
 * @returns {{ byCell: Map<string, object>, violations: Array<{code: string, detail: string, cell?: string}> }}
 */
export function validateCaptureIndex(index, io = {}) {
  const violations = [];
  const byCell = new Map();
  const records = Array.isArray(index?.records) ? index.records : [];
  if (!Array.isArray(index?.records)) {
    violations.push({
      code: "index/malformed",
      detail: "the capture index has no `records` array",
    });
    return { byCell, violations };
  }
  const seenPath = new Map();
  const seenHash = new Map();
  for (const record of records) {
    const cell = record?.cell ?? "(unnamed)";
    for (const v of validateCaptureRecord(record, io)) {
      violations.push({ ...v, cell });
    }
    if (byCell.has(cell)) {
      violations.push({
        code: "index/duplicate-cell",
        detail: `cell "${cell}" is recorded twice`,
        cell,
      });
    } else {
      byCell.set(cell, record);
    }
    if (record?.screenshot) {
      // KEYED ON THE REPOSITORY PATH, not on the citation. Two records pinning
      // the SAME path at DIFFERENT commits are two claims about one picture --
      // and because the bytes may differ between those commits, keying on the
      // whole permalink let the pair through with no duplicate finding at all.
      // The path is the identity; the commit only says which version.
      const shotPath = repoPathOf(record.screenshot);
      const prev = seenPath.get(shotPath);
      if (prev) {
        violations.push({
          code: "index/duplicate-screenshot-path",
          detail:
            `"${shotPath}" already answers cell "${prev.cell}"` +
            (prev.citation !== record.screenshot
              ? " — and the two records pin it at DIFFERENT commits, so they are not even the same bytes"
              : ""),
          cell,
        });
      } else seenPath.set(shotPath, { cell, citation: record.screenshot });
    }
    if (record?.sha256) {
      const prev = seenHash.get(record.sha256);
      if (prev) {
        violations.push({
          code: "index/duplicate-image",
          detail: `the same image already answers cell "${prev}" -- one picture cannot prove two screens`,
          cell,
        });
      } else seenHash.set(record.sha256, cell);
    }
  }
  return { byCell, violations };
}

/**
 * THE BINDING. Every cited cell whose name claims a BOUND host must resolve to
 * a VALID record. An unindexed screenshot counts as zero -- that is the whole
 * point: the filename stops being evidence.
 *
 * WHY chat_thread ALONE, today. cinatra#2821 rules the binding for the cells
 * that name `chat_thread`, because that is where the mislabel happened and
 * where the vocabulary is settled. The contract validates a record for ANY of
 * the four hosts already; what is scoped here is which citations are OBLIGED to
 * have one. A host joins `boundHosts` in the slice that produces its records --
 * widening it before then would only manufacture findings nobody can clear.
 *
 * @param {Array<{cell: string, citedBy: string}>} citedCells
 * @param {{byCell: Map<string, object>, violations: Array}} indexResult
 * @param {{boundHosts?: string[]}} [options]
 * @returns {Array<{code: string, detail: string, cell: string}>}
 */
export function bindEvidenceCells(citedCells, indexResult, options = {}) {
  const boundHosts = options.boundHosts ?? ["chat_thread"];
  const out = [];
  const invalidCells = new Set(
    indexResult.violations.filter((v) => v.cell).map((v) => v.cell),
  );
  for (const cited of citedCells) {
    const claim = parseCellName(cited.cell);
    if (!claim) continue; // reported by the caller's inventory arm
    if (!boundHosts.includes(claim.host)) continue;
    const record = indexResult.byCell.get(claim.cell);
    if (!record) {
      out.push({
        code: "capture/unbound-cell",
        cell: claim.cell,
        detail: `${cited.citedBy} cites a "${claim.host}" capture that no index record answers -- an unindexed screenshot counts as zero`,
      });
      continue;
    }
    if (invalidCells.has(claim.cell)) {
      out.push({
        code: "capture/invalid-record",
        cell: claim.cell,
        detail: `${cited.citedBy} cites a record that does not validate (see the record findings above)`,
      });
    }
  }
  return out;
}
