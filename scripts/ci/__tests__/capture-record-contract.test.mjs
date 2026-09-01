// Fixture tests for the CAPTURE-RECORD CONTRACT (cinatra#2821, epic #2784 S9h).
//
// The failure this contract exists to stop is a screenshot filed under a host it
// does not show, so the fixtures are that exact shape: a picture of the Agents
// page recorded under a chat-cell name, a record whose anchors were never
// measured, a hash that has drifted, and one image doing duty for two screens.
// Each has an honest twin that must pass, because a gate nobody can satisfy gets
// switched off.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstatSync as lstatSyncForTest } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CANONICAL_CAPTURE_STATES,
  CAPTURE_HOSTS,
  CAPTURE_INDEX_PATH,
  CARD_KINDS,
  KIND_CAPTURE_STATES,
  RECORDER_ID,
  URL_CLASSES,
  bindEvidenceCells,
  captureStatesFor,
  parseCellName,
  requiredAssertionsFor,
  validateCaptureIndex,
  validateCaptureRecord,
  CAPTURE_OUTPUT_ROOT,
  captureImageFormat,
  createCaptureTempFile,
  prepareCaptureTarget,
  recheckCaptureParent,
  resolveCaptureTarget,
  resolveLiveCapture,
  isHistoricalPermalink,
  parsePermalink,
  readPinnedArtifact,
  repoPathOf,
  sha256Pinned,
} from "../lib/capture-record-contract.mjs";
// The recorder's re-export, so the suite proves the two tiers share ONE string
// rather than two copies that happen to match today.
import { CAPTURE_OUTPUT_ROOT as recorderCaptureOutputRoot } from "../../audit/lib/chat-hitl-capture-recorder.mjs";

/** The tree the committed index's screenshots are resolved against. */
const REPO_ROOT = join(dirname(CAPTURE_INDEX_PATH), "..", "..");

let repoRoot;
const IMAGE_A = "test-results/capture-fixture/C1__review-card__chat_thread__pending.png";
const IMAGE_B = "test-results/capture-fixture/C2__review-card__chat_thread__decided.png";
let hashA;
let hashB;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "s9h-capture-"));
  mkdirSync(join(repoRoot, "test-results", "capture-fixture"), { recursive: true });
  writeFileSync(join(repoRoot, IMAGE_A), "PNG-A");
  writeFileSync(join(repoRoot, IMAGE_B), "PNG-B");
  hashA = createHash("sha256").update("PNG-A").digest("hex");
  hashB = createHash("sha256").update("PNG-B").digest("hex");
});

afterAll(() => {
  // Only ever the directory this suite made itself.
  rmSync(repoRoot, { recursive: true, force: true });
});

/** An honest chat_thread capture: the host anchors were actually counted. */
function honestChatPending(overrides = {}) {
  return {
    cell: "C1__review-card__chat_thread__pending",
    recorder: RECORDER_ID,
    declaredHost: "chat_thread",
    declaredKind: "artifact_review_gate",
    declaredState: "pending",
    finalUrl: "http://localhost:3000/chat/1f0c",
    screenshot: IMAGE_A,
    sha256: hashA,
    assertions: [
      { selector: "[data-conversation-list]", scope: "frame", count: 1 },
      {
        selector: '[data-lifecycle-card-host="chat_thread"]',
        scope: "frame",
        count: 1,
      },
      {
        selector: '[data-lifecycle-card="artifact_review_gate"]',
        scope: "frame",
        count: 1,
      },
      {
        selector: '[data-conformance-id="review-decision-bar"]',
        scope: "root",
        count: 1,
      },
    ],
    ...overrides,
  };
}

/**
 * An honest page_gate_region capture, on the SHIPPED gate-region deep link.
 *
 * The URL is the real shape a lane records — vendor / package / run UUID /
 * `review` / a URL-ENCODED review task id (the shipped ids carry a colon, so
 * `%3A` is what actually lands in `finalUrl`). This fixture exists because the
 * `review_page` class used to read `^/agents/reviews`, the open-review QUEUE,
 * which no truthful record of this host could ever satisfy.
 */
function honestGateRegionPending(overrides = {}) {
  return {
    cell: "C3__review-card__page_gate_region__pending",
    recorder: RECORDER_ID,
    declaredHost: "page_gate_region",
    declaredKind: "artifact_review_gate",
    declaredState: "pending",
    finalUrl:
      "/agents/cinatra-ai/blog-draft-writer-agent/fd104b43-19fd-4404-9d74-0896bba371f5/review/lifecycle-review%3A28c4a63d1b6068e89bdd57f6c24f35ca3c2c47d928531997d2c2b6355b94a8ac",
    screenshot: IMAGE_B,
    sha256: hashB,
    assertions: [
      {
        selector: '[data-lifecycle-card-host="page_gate_region"]',
        scope: "frame",
        count: 1,
      },
      {
        selector: '[data-lifecycle-card="artifact_review_gate"]',
        scope: "frame",
        count: 1,
      },
      {
        selector: '[data-conformance-id="review-decision-bar"]',
        scope: "root",
        count: 1,
      },
    ],
    ...overrides,
  };
}

const codes = (violations) => violations.map((v) => v.code);

describe("parseCellName", () => {
  it("reads the host, kind and state off a committed cell name", () => {
    expect(parseCellName("C1__review-card__chat_thread__pending.png")).toMatchObject({
      host: "chat_thread",
      kind: "artifact_review_gate",
      state: "pending",
    });
    expect(
      parseCellName("recommendation-hold__run_card__held__lane-dev.png"),
    ).toMatchObject({
      host: "run_card",
      kind: "recommendation_hold",
      state: "pending",
    });
  });

  it("returns null for a name that claims no host", () => {
    expect(parseCellName("B1__chat__composer-binding-row.png")).toBeNull();
  });
});

describe("requiredAssertionsFor", () => {
  it("does not accept the conversation list as proof of chat_thread on its own", () => {
    const { required } = requiredAssertionsFor({
      host: "chat_thread",
      kind: "artifact_review_gate",
      state: "pending",
    });
    const selectors = required.map((r) => r.selector);
    expect(selectors).toContain("[data-conversation-list]");
    expect(selectors).toContain('[data-lifecycle-card-host="chat_thread"]');
  });

  it("makes the widget prove the frame chain", () => {
    const selectors = requiredAssertionsFor({
      host: "site_widget",
      kind: "artifact_review_gate",
      state: "pending",
    }).required.map((r) => r.selector);
    expect(selectors).toContain(".cw-frame");
    expect(selectors).toContain('[data-embed-assistant][data-phase="active"]');
  });

  it("makes a decided capture owe the ABSENCE of its decision controls", () => {
    const { forbidden } = requiredAssertionsFor({
      host: "chat_thread",
      kind: "recommendation_hold",
      state: "decided",
    });
    expect(forbidden.map((f) => f.selector)).toContain(
      '[data-skill-action="confirm"]',
    );
    // …and the other two the §V redraw put on every chip (cinatra#2841).
    expect(forbidden.map((f) => f.selector)).toContain('[data-skill-action="adjust"]');
    expect(forbidden.map((f) => f.selector)).toContain('[data-skill-action="skip"]');
  });
});

// ---------------------------------------------------------------------------
// THE RECOMMENDATION CARD'S DECISION CONTROLS ARE PER HOST (cinatra#3062)
// ---------------------------------------------------------------------------
//
// The ratified drawing gives this card ONE decision act on the three checklist
// hosts — "The reader sets the boxes and presses Continue beneath the list …
// and the whole row is answered at once" — and "a pill carries nothing to press
// — no Confirm, no Adjust, no Skip." The review page's gate region is the one
// host that still draws the per-chip trio, so the trio is ITS vocabulary and
// not the kind's.
//
// The debt this closes, in one line: the shipped recorder refused every honest
// capture of the branch's own card, because it demanded three controls the card
// no longer draws on the host it was drawing them for.
describe("recommendation_hold decision controls, per host", () => {
  const skillsCheckHosts = ["run_card", "chat_thread", "site_widget"];
  const RETIRED = [
    '[data-skill-action="confirm"]',
    '[data-skill-action="adjust"]',
    '[data-skill-action="skip"]',
  ];

  it.each(skillsCheckHosts)("makes a pending capture on %s owe the Continue", (host) => {
    const { required } = requiredAssertionsFor({
      host,
      kind: "recommendation_hold",
      state: "pending",
    });
    const rooted = required.filter((r) => r.scope === "root").map((r) => r.selector);
    expect(rooted).toContain("[data-skills-step-continue]");
    // …and NOT the trio the card retired on this host.
    for (const sel of RETIRED) expect(rooted).not.toContain(sel);
  });

  it.each(skillsCheckHosts)("forbids the retired trio on %s, pending and decided", (host) => {
    for (const state of ["pending", "decided"]) {
      const { forbidden } = requiredAssertionsFor({
        host,
        kind: "recommendation_hold",
        state,
      });
      const banned = forbidden.map((f) => f.selector);
      for (const sel of RETIRED) expect(banned).toContain(sel);
    }
  });

  it("does NOT forbid the Continue on a decided capture of a checklist host", () => {
    // §V draws a Continue on a SETTLED reading whose run has not started —
    // "Continue does not close the row… Continue still beneath them" — and that
    // reading declares itself `decided`. Banning the control there would refuse
    // a truthful picture of a reading the drawing prescribes.
    const { forbidden } = requiredAssertionsFor({
      host: "chat_thread",
      kind: "recommendation_hold",
      state: "decided",
    });
    expect(forbidden.map((f) => f.selector)).not.toContain("[data-skills-step-continue]");
  });

  it("leaves the review page's gate region on the per-chip trio", () => {
    const { required } = requiredAssertionsFor({
      host: "page_gate_region",
      kind: "recommendation_hold",
      state: "pending",
    });
    const rooted = required.filter((r) => r.scope === "root").map((r) => r.selector);
    for (const sel of RETIRED) expect(rooted).toContain(sel);
    expect(rooted).not.toContain("[data-skills-step-continue]");
  });

  it("admits an honest capture of the shipped card, and refuses one that shows the retired trio", () => {
    // The dry run of the shipped recorder against the branch's own card is
    // exactly this record, and the contract refused it.
    const honest = {
      cell: "F1__recommendation-card__chat_thread__pending__light",
      recorder: RECORDER_ID,
      declaredHost: "chat_thread",
      declaredKind: "recommendation_hold",
      declaredState: "pending",
      finalUrl: "http://localhost:3000/chat/1f0c",
      screenshot: IMAGE_A,
      sha256: hashA,
      assertions: [
        { selector: "[data-conversation-list]", scope: "frame", count: 1 },
        { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame", count: 1 },
        { selector: '[data-lifecycle-card="recommendation_hold"]', scope: "frame", count: 1 },
        { selector: "[data-skills-step-continue]", scope: "root", count: 1 },
        ...RETIRED.map((selector) => ({ selector, scope: "root", count: 0 })),
      ],
    };
    expect(validateCaptureRecord(honest, { repoRoot })).toEqual([]);

    // A record of the SAME cell showing the retired controls is refused: the
    // card does not draw them on this host any more, so a picture that shows
    // them is a picture of a regression.
    const regressed = {
      ...honest,
      assertions: honest.assertions.map((a) =>
        RETIRED.includes(a.selector) ? { ...a, count: 3 } : a,
      ),
    };
    expect(codes(validateCaptureRecord(regressed, { repoRoot }))).toContain(
      "record/decided-still-offers-decision",
    );
  });

  it("holds the pictures ON FILE to the reading they were taken of, and only those", () => {
    // THE 26 RECORDS THIS CANNOT RE-MEASURE. Every pending picture of this card
    // on the three checklist hosts was shot before §V's checklist reached that
    // host, against the per-chip trio, and no one can re-measure them without
    // re-taking the photographs. They are named — a CLOSED list, frozen — and
    // held to the vocabulary they were actually taken against.
    //
    // The naming is not an escape hatch, and this arm is what makes it so: a
    // named cell OWES the retired trio — required, not merely admitted — so a
    // re-shoot under an old name is refused, because the shipped card draws none
    // of the three. It must take the cell off the list, or take a new name.
    const named = CARD_KINDS.recommendation_hold.preChecklistPendingCells;
    expect(Array.isArray(named)).toBe(true);
    expect(named).toHaveLength(26);
    expect(named).toContain("A1__recommendation-card__chat_thread__pending__light");

    const cell = "A1__recommendation-card__chat_thread__pending__light";
    const { required } = requiredAssertionsFor({
      host: "chat_thread",
      kind: "recommendation_hold",
      state: "pending",
      cell,
    });
    const rooted = required.filter((r) => r.scope === "root").map((r) => r.selector);
    for (const sel of RETIRED) expect(rooted).toContain(sel);
    expect(rooted).not.toContain("[data-skills-step-continue]");

    // …and a picture of the SHIPPED card, taken under that name, is refused —
    // it shows none of the three the name claims.
    const reshotUnderAnOldName = {
      cell,
      recorder: RECORDER_ID,
      declaredHost: "chat_thread",
      declaredKind: "recommendation_hold",
      declaredState: "pending",
      finalUrl: "http://localhost:3000/chat/1f0c",
      screenshot: IMAGE_A,
      sha256: hashA,
      assertions: [
        { selector: "[data-conversation-list]", scope: "frame", count: 1 },
        { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame", count: 1 },
        { selector: '[data-lifecycle-card="recommendation_hold"]', scope: "frame", count: 1 },
        { selector: "[data-skills-step-continue]", scope: "root", count: 1 },
        ...RETIRED.map((selector) => ({ selector, scope: "root", count: 0 })),
      ],
    };
    expect(codes(validateCaptureRecord(reshotUnderAnOldName, { repoRoot }))).toContain(
      "record/anchor-count-zero",
    );
  });
});

describe("validateCaptureRecord", () => {
  it("accepts an honest host-anchored record", () => {
    expect(validateCaptureRecord(honestChatPending(), { repoRoot })).toEqual([]);
  });

  it("refuses an Agents-page screenshot filed under a chat cell", () => {
    // The #2794 shape: the picture is real, the name says chat, the URL says the
    // capture was taken somewhere else entirely.
    const record = honestChatPending({
      finalUrl: "http://localhost:3000/agents/cinatra-ai/blog-draft-writer-agent",
    });
    expect(codes(validateCaptureRecord(record, { repoRoot }))).toContain(
      "record/url-class-mismatch",
    );
  });

  it("refuses a chat record whose conversation list was never looked for", () => {
    const record = honestChatPending();
    record.assertions = record.assertions.filter(
      (a) => a.selector !== "[data-conversation-list]",
    );
    expect(codes(validateCaptureRecord(record, { repoRoot }))).toContain(
      "record/anchor-never-observed",
    );
  });

  it("refuses an anchor that was measured and found absent", () => {
    const record = honestChatPending();
    record.assertions = record.assertions.map((a) =>
      a.selector === '[data-lifecycle-card-host="chat_thread"]'
        ? { ...a, count: 0 }
        : a,
    );
    expect(codes(validateCaptureRecord(record, { repoRoot }))).toContain(
      "record/anchor-count-zero",
    );
  });

  it("refuses a record whose declared host contradicts its cell name", () => {
    expect(
      codes(validateCaptureRecord(honestChatPending({ declaredHost: "run_card" }), {
        repoRoot,
      })),
    ).toContain("record/host-claim-mismatch");
  });

  it("refuses a hash that has drifted from the image on disk", () => {
    expect(
      codes(validateCaptureRecord(honestChatPending({ sha256: "0".repeat(64) }), {
        repoRoot,
      })),
    ).toContain("record/sha256-mismatch");
  });

  it("refuses a screenshot that is not there, and one that escapes the tree", () => {
    expect(
      codes(
        validateCaptureRecord(honestChatPending({ screenshot: "test-results/nope.png" }), {
          repoRoot,
        }),
      ),
    ).toContain("record/screenshot-missing");
    expect(
      codes(
        validateCaptureRecord(
          honestChatPending({ screenshot: "../../etc/hosts.png" }),
          { repoRoot },
        ),
      ),
    ).toContain("record/screenshot-not-repo-relative");
  });

  it("refuses a decided capture that still offers the decision", () => {
    const record = honestChatPending({
      cell: "C2__review-card__chat_thread__decided",
      declaredState: "decided",
      screenshot: IMAGE_B,
      sha256: hashB,
    });
    record.assertions = [
      ...record.assertions,
      { selector: "[data-lifecycle-card-state]", scope: "root", count: 1 },
    ];
    expect(codes(validateCaptureRecord(record, { repoRoot }))).toContain(
      "record/decided-still-offers-decision",
    );
  });

  it("accepts an honest decided capture", () => {
    const record = honestChatPending({
      cell: "C2__review-card__chat_thread__decided",
      declaredState: "decided",
      screenshot: IMAGE_B,
      sha256: hashB,
    });
    record.assertions = record.assertions
      .filter((a) => a.selector !== '[data-conformance-id="review-decision-bar"]')
      .concat({ selector: "[data-lifecycle-card-state]", scope: "root", count: 1 });
    expect(validateCaptureRecord(record, { repoRoot })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE review_page CLASS, against the SHIPPED route (cinatra#2791).
//
// The class used to read `^/agents/reviews`. That path is the org's open-review
// QUEUE — a navigation/volume screen that mounts no lifecycle card — while the
// surface that declares `host="page_gate_region"` is
// `/agents/<vendor>/<package>/<runId>/review/<reviewTaskId>`. So the class
// refused every truthful record of the host it governs and would have accepted
// a picture of a screen with no card on it. These rows pin the shipped shape in
// BOTH directions, because a class that only ever says yes is not a class.
// ---------------------------------------------------------------------------
describe("the review_page URL class", () => {
  const SHIPPED =
    "/agents/cinatra-ai/blog-draft-writer-agent/fd104b43-19fd-4404-9d74-0896bba371f5/review/lifecycle-review%3A28c4a63d1b6068e89bdd57f6c24f35ca3c2c47d928531997d2c2b6355b94a8ac";

  it("matches the shipped gate-region deep link, encoded task id and all", () => {
    expect(URL_CLASSES.review_page.test(SHIPPED)).toBe(true);
  });

  it("matches it with a query string and with a trailing slash", () => {
    expect(URL_CLASSES.review_page.test(`${SHIPPED}?view=verification`)).toBe(true);
    expect(
      URL_CLASSES.review_page.test(
        "/agents/cinatra-ai/blog-draft-writer-agent/6a4f9c78-a6d5-4da6-a09b-f8c947c48026/review/lifecycle-review%3Aa9ad/",
      ),
    ).toBe(true);
  });

  it("does NOT match the open-review queue, which mounts no card", () => {
    // The exact path the class used to be written as. A picture of this screen
    // must never answer a page_gate_region claim.
    expect(URL_CLASSES.review_page.test("/agents/reviews")).toBe(false);
    expect(URL_CLASSES.review_page.test("/agents/reviews?open=1")).toBe(false);
  });

  it("does NOT match a bare run-detail path, nor a truncated review path", () => {
    expect(
      URL_CLASSES.review_page.test(
        "/agents/cinatra-ai/blog-draft-writer-agent/fd104b43-19fd-4404-9d74-0896bba371f5",
      ),
    ).toBe(false);
    // `/review` with no task id is not the gate-region route.
    expect(
      URL_CLASSES.review_page.test(
        "/agents/cinatra-ai/blog-draft-writer-agent/fd104b43-19fd-4404-9d74-0896bba371f5/review",
      ),
    ).toBe(false);
  });

  it("accepts an honest page_gate_region record taken on that route", () => {
    expect(validateCaptureRecord(honestGateRegionPending(), { repoRoot })).toEqual([]);
  });

  it("refuses a page_gate_region record taken on the queue instead", () => {
    const record = honestGateRegionPending({ finalUrl: "/agents/reviews" });
    expect(codes(validateCaptureRecord(record, { repoRoot }))).toContain(
      "record/url-class-mismatch",
    );
  });
});

describe("validateCaptureIndex", () => {
  it("refuses one picture doing duty for two cells", () => {
    const twin = honestChatPending({
      cell: "C2__review-card__chat_thread__decided",
      declaredState: "decided",
    });
    twin.assertions = twin.assertions
      .filter((a) => a.selector !== '[data-conformance-id="review-decision-bar"]')
      .concat({ selector: "[data-lifecycle-card-state]", scope: "root", count: 1 });
    const { violations } = validateCaptureIndex(
      { records: [honestChatPending(), twin] },
      { repoRoot },
    );
    expect(codes(violations)).toEqual(
      expect.arrayContaining([
        "index/duplicate-screenshot-path",
        "index/duplicate-image",
      ]),
    );
  });

  it("reports an index with no records array rather than passing it", () => {
    expect(codes(validateCaptureIndex({}, { repoRoot }).violations)).toEqual([
      "index/malformed",
    ]);
  });
});

describe("bindEvidenceCells", () => {
  const cited = [
    {
      cell: "C1__review-card__chat_thread__pending",
      citedBy: "the acceptance manifest row AC-15",
    },
  ];

  it("treats an unindexed screenshot as zero", () => {
    const result = validateCaptureIndex({ records: [] }, { repoRoot });
    expect(codes(bindEvidenceCells(cited, result))).toEqual([
      "capture/unbound-cell",
    ]);
  });

  it("binds a cell that has an honest record", () => {
    const result = validateCaptureIndex(
      { records: [honestChatPending()] },
      { repoRoot },
    );
    expect(bindEvidenceCells(cited, result)).toEqual([]);
  });

  it("refuses a cell bound to a record that does not validate", () => {
    const result = validateCaptureIndex(
      { records: [honestChatPending({ sha256: "0".repeat(64) })] },
      { repoRoot },
    );
    expect(codes(bindEvidenceCells(cited, result))).toEqual([
      "capture/invalid-record",
    ]);
  });
});

describe("the advisory state — one kind's vocabulary, not every kind's", () => {
  // §VII's audit card resolves `advisory` and nothing else that DRAWS:
  // "TWO STATES DRAW, AND ONLY TWO … `advisory` — the reading — or `absent`,
  // which draws NO DOM AT ALL" (packages/agents/src/verification-summary-card.tsx).
  // Two advisory records of it already stand in the committed index, on
  // `run_card` and on `page_gate_region`; the third was driven on `chat_thread`
  // and refused by the audit tier's state list rather than by the screen
  // (https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2791-s9g-conformance/capture-results.json).
  function advisoryAudit(over = {}) {
    return {
      cell: "G7__audit-card__chat_thread__advisory",
      recorder: RECORDER_ID,
      declaredHost: "chat_thread",
      declaredKind: "verification_summary",
      declaredState: "advisory",
      finalUrl: "http://localhost:3000/chat/1f0c",
      screenshot: IMAGE_A,
      sha256: hashA,
      assertions: [
        { selector: "[data-conversation-list]", scope: "frame", count: 1 },
        {
          selector: '[data-lifecycle-card-host="chat_thread"]',
          scope: "frame",
          count: 1,
        },
        {
          selector: '[data-lifecycle-card="verification_summary"]',
          scope: "frame",
          count: 1,
        },
      ],
      ...over,
    };
  }

  it("reads `advisory` off the name the driven capture already carried", () => {
    expect(parseCellName("G7__audit-card__chat_thread__advisory.png")).toMatchObject({
      host: "chat_thread",
      kind: "verification_summary",
      state: "advisory",
    });
  });

  it("ACCEPTS the audit card's advisory record on chat_thread", () => {
    expect(validateCaptureRecord(advisoryAudit(), { repoRoot })).toEqual([]);
  });

  it("REFUSES `advisory` on a kind that never resolves it", () => {
    const v = validateCaptureRecord(
      honestChatPending({
        cell: "X1__review-card__chat_thread__advisory",
        declaredState: "advisory",
      }),
      { repoRoot },
    );
    expect(codes(v)).toContain("record/state-not-in-kind-vocabulary");
  });

  it("is EXACT per kind: the audit card resolves advisory and nothing else", () => {
    // Not "the two, plus advisory". A `pending` audit card would be a reading
    // asking for a decision it has no floor to take, and a `decided` one a
    // verdict the resolver never issues; the card draws neither.
    expect(captureStatesFor("verification_summary")).toEqual(["advisory"]);
    for (const kind of [
      "artifact_review_gate",
      "recommendation_hold",
      "trigger_schedule_proposal",
      "agent_hitl_screen",
    ]) {
      expect(captureStatesFor(kind)).toEqual(CANONICAL_CAPTURE_STATES);
    }
  });

  it("names EVERY card kind, so a new one cannot inherit a vocabulary silently", () => {
    expect(Object.keys(KIND_CAPTURE_STATES).sort()).toEqual(Object.keys(CARD_KINDS).sort());
  });

  it("REFUSES the audit card declaring a state its card never draws", () => {
    for (const state of ["pending", "decided"]) {
      const v = validateCaptureRecord(advisoryAudit({ declaredState: state }), { repoRoot });
      expect(codes(v)).toContain("record/state-not-in-kind-vocabulary");
    }
  });

  it("REFUSES an empty declaration rather than reading it as no claim", () => {
    // `""` is not nullish, so it survived `?? claim.state` and then skipped
    // every truthiness-guarded arm — a blank field that switched off the checks
    // the claim owes.
    expect(
      codes(
        validateCaptureRecord(
          honestChatPending({
            cell: "X2__review-card__run_card__advisory",
            declaredHost: "run_card",
            declaredState: "",
            finalUrl:
              "/agents/cinatra-ai/blog-draft-writer-agent/fd104b43-19fd-4404-9d74-0896bba371f5",
            assertions: [
              {
                selector: '[data-lifecycle-card-host="run_card"]',
                scope: "frame",
                count: 1,
              },
              {
                selector: '[data-lifecycle-card="artifact_review_gate"]',
                scope: "frame",
                count: 1,
              },
            ],
          }),
          { repoRoot },
        ),
      ),
    ).toContain("record/empty-declaration");
    expect(
      codes(validateCaptureRecord(advisoryAudit({ declaredKind: "" }), { repoRoot })),
    ).toContain("record/empty-declaration");
  });

  it("adds NO ANCHOR — the advisory set is the one both ratified sets are built from", () => {
    // This is what lets the vocabulary widen without the anchor digest moving:
    // every selector an advisory capture owes is already a ratified input under
    // this kind's `pending` and `decided` entries.
    const key = (r) => `${r.scope}::${r.selector}`;
    for (const host of CAPTURE_HOSTS) {
      const kind = "verification_summary";
      const advisory = requiredAssertionsFor({ host, kind, state: "advisory" });
      const pending = requiredAssertionsFor({ host, kind, state: "pending" });
      const decided = requiredAssertionsFor({ host, kind, state: "decided" });
      expect(advisory.forbidden).toEqual([]);
      for (const r of advisory.required) {
        expect(pending.required.map(key)).toContain(key(r));
        expect(decided.required.map(key)).toContain(key(r));
      }
    }
  });

  it("the committed index still validates, record for record", () => {
    const index = JSON.parse(readFileSync(CAPTURE_INDEX_PATH, "utf8"));
    const { byCell, violations } = validateCaptureIndex(index, { repoRoot: REPO_ROOT });
    expect(violations).toEqual([]);
    expect(byCell.size).toBe(index.records.length);
  });

  it("RATCHET: the committed index's kind × host × state census", () => {
    // The census, not merely the count: a vocabulary that started admitting
    // something new would move a cell from one bucket to another without
    // changing the total, and this is where that shows.
    const index = JSON.parse(readFileSync(CAPTURE_INDEX_PATH, "utf8"));
    const census = {};
    for (const r of index.records) {
      const k = `${r.declaredKind} | ${r.declaredHost} | ${r.declaredState}`;
      census[k] = (census[k] ?? 0) + 1;
    }
    expect(census).toEqual({
      "agent_hitl_screen | chat_thread | decided": 4,
      "agent_hitl_screen | chat_thread | pending": 4,
      "agent_hitl_screen | run_card | pending": 4,
      "artifact_review_gate | chat_thread | decided": 3,
      "artifact_review_gate | chat_thread | pending": 10,
      "artifact_review_gate | page_gate_region | decided": 4,
      // MOVED AGAIN 2026-08-28 by cinatra#2936 W6 part 2b batch 2 (+4) — the
      // REVIEW moment, which batch 1 could not reach because its run package had
      // never been published to the instance's own registry. This round publishes
      // it first (with a registry readback) and both of its runs open their
      // review. `https://github.com/cinatra-ai/cinatra/blob/f275dcb2d31a243ccf5a1dda155186fbb8f1dc7f/evidence/2936-w6-captures-batch-2/` carries the run ids, the DB
      // timeline and the grading.
      //
      //   artifact_review_gate | page_gate_region | pending   5 -> 6
      //     the dark sibling of the review page with the gate still open.
      //   artifact_review_gate | run_card | decided           0 -> 3
      //     the settled card after Approve was pressed on the run page's OWN
      //     decision bar: light and dark on the run page, and the DARK sibling of
      //     the same card as the CONVERSATION draws it. That third one is on a
      //     /chat path and declares `run_card` on purpose — the settled review the
      //     conversation draws is the inline run card, which `HOST_URL_CLASS`
      //     already admits on two classes for exactly this reason. The
      //     `chat_thread`-declared sibling was DRIVEN and the shipped recorder
      //     REFUSED it ("host \"chat_thread\" requires
      //     [data-lifecycle-card-host=\"chat_thread\"] PRESENT (root-scoped); the
      //     record observed 0"), so that cell stays where it was rather than being
      //     answered by a picture of a differently-hosted card.
      "artifact_review_gate | page_gate_region | pending": 6,
      "artifact_review_gate | run_card | decided": 3,
      "artifact_review_gate | run_card | pending": 4,
      "artifact_review_gate | site_widget | pending": 5,
      // MOVED by cinatra#2936 W6 part 2b batch 1 (+8): one real run's
      // recommendation hold, photographed pending and settled, in the
      // conversation and on the run page, in BOTH themes — two records per
      // bucket. Nothing moved between buckets; the four cells this round wrote
      // to each gained its light/dark pair, which is what a census ratchet is
      // for.
      "recommendation_hold | chat_thread | decided": 6,
      "recommendation_hold | chat_thread | pending": 7,
      "recommendation_hold | page_gate_region | decided": 4,
      "recommendation_hold | run_card | decided": 10,
      "recommendation_hold | run_card | pending": 12,
      // MOVED 2026-08-28 by cinatra#2936 W6 part 2b batch 3 (+6) — the FIRST
      // cells taken inside a THIRD-PARTY APPLICATION since the widget's own
      // named-agent start landed. One real run of the blog-draft-writer agent,
      // started by a sentence typed into the widget's OWN composer on a page
      // served by another site, with four organization-owned skills assigned:
      //
      //   recommendation_hold | site_widget | pending   5 -> 7
      //     the held chip row, light and dark, in the palette the reader chose
      //     on the app's own control (the widget follows the app origin's
      //     class; the OPERATING SYSTEM preference is `false` on every frame).
      //   recommendation_hold | site_widget | decided   2 -> 6
      //     the settled row — four chips, one SKIPPED — light and dark, and the
      //     SAME row again in both palettes after the third-party page was
      //     reloaded and the widget signed in again, which is plan (B) §6's
      //     reload clause on this host.
      //
      // NOTHING ELSE MOVED, AND THE REST OF THIS HOST'S CELLS ARE OWED TO
      // FIXES rather than to a batch. `artifact_review_gate | site_widget` did
      // NOT move: a real widget-started run opened its review gate and the
      // widget drew no review card at all, live or after a reload —
      // `widgetHostedPanel` closes both readings of the run card's review slot
      // (packages/agents/src/agentic-run-panel.tsx:1620/:1625/:1633) while the
      // outbox withholds the injected part from the same turn on the ground
      // that the run card would show it. `trigger_schedule_proposal |
      // site_widget` did not move either: the widget's own conversation
      // answered the schedule request with the shipped fixed refusal.
      // `https://github.com/cinatra-ai/cinatra/blob/c2e708cb4466623c3a4c4ef7cb2113c319def399/evidence/2936-w6-captures-batch-3-widget/` carries the run ids, the
      // measurements and the code facts.
      "recommendation_hold | site_widget | decided": 6,
      "recommendation_hold | site_widget | pending": 7,
      "trigger_schedule_proposal | chat_thread | decided": 4,
      "trigger_schedule_proposal | chat_thread | pending": 4,
      "trigger_schedule_proposal | run_card | decided": 2,
      "verification_summary | page_gate_region | advisory": 1,
      "verification_summary | run_card | advisory": 1,
    });
    expect(index.records.length).toBe(111);
  });
});


// ---------------------------------------------------------------------------
// THE PINNED READER — the thing that lets a picture leave the tree without the
// gate losing its grip on it. Every branch is driven with an INJECTED `run`,
// `fetched` and `cache`, so nothing here spawns git and nothing touches a
// network: what is under test is the decision-making, not git itself.
// ---------------------------------------------------------------------------
describe("readPinnedArtifact — reading a proof out of history", () => {
  const SHA = "a".repeat(40);
  const URL = `https://github.com/cinatra-ai/cinatra/blob/${SHA}/evidence/round/shot.png`;
  const BYTES = Buffer.from("PINNED-PNG-BYTES");
  const PIN_HASH = createHash("sha256").update(BYTES).digest("hex");

  /**
   * A `spawnSync` stand-in that starts SHALLOW: `cat-file` misses until a
   * `fetch` has succeeded. `calls` records argv so the suite can assert both
   * WHAT was run and HOW MANY times.
   */
  function gitStub({ fetchMakesItLocal = true, fetchOk = true } = {}) {
    const calls = [];
    let local = false;
    return {
      calls,
      run(cmd, args, opts) {
        calls.push({ cmd, args, opts });
        if (args[0] === "cat-file") {
          return local
            ? { status: 0, stdout: BYTES, stderr: Buffer.alloc(0) }
            : { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: Not a valid object name") };
        }
        if (args[0] === "fetch") {
          if (fetchOk && fetchMakesItLocal) local = true;
          return fetchOk
            ? { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
            : { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: could not read from remote") };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      },
    };
  }
  /** Fresh DI state per case — the caches are module-level in production. */
  const io = (run) => ({ repoRoot: "/repo", run, fetched: new Set(), cache: new Map() });

  it("a MISS is followed by exactly one shallow fetch and one retry", () => {
    const git = gitStub();
    const got = readPinnedArtifact(URL, io(git.run));
    expect(got.ok).toBe(true);
    expect(got.bytes.toString()).toBe("PINNED-PNG-BYTES");
    expect(git.calls.map((c) => c.args)).toEqual([
      ["cat-file", "blob", `${SHA}:evidence/round/shot.png`],
      ["fetch", "--depth=1", "origin", SHA],
      ["cat-file", "blob", `${SHA}:evidence/round/shot.png`],
    ]);
  });

  it("argv is an ARRAY and no shell is involved", () => {
    const git = gitStub();
    readPinnedArtifact(URL, io(git.run));
    for (const call of git.calls) {
      expect(call.cmd).toBe("git");
      expect(Array.isArray(call.args)).toBe(true);
      // A shell would make the sha:path pair splittable on whitespace and would
      // make `opts.shell` truthy; neither may ever be the case here.
      expect(call.opts?.shell).toBeFalsy();
      expect(call.args.every((a) => typeof a === "string")).toBe(true);
    }
    expect(git.calls[0].opts.cwd).toBe("/repo");
  });

  it("ONE fetch per commit, not per record — a second path at that sha adds none", () => {
    const git = gitStub();
    const shared = io(git.run);
    readPinnedArtifact(URL, shared);
    readPinnedArtifact(`https://github.com/cinatra-ai/cinatra/blob/${SHA}/evidence/round/other.png`, shared);
    expect(git.calls.filter((c) => c.args[0] === "fetch")).toHaveLength(1);
  });

  it("a cache hit spawns NOTHING", () => {
    const git = gitStub();
    const shared = io(git.run);
    readPinnedArtifact(URL, shared);
    const spawned = git.calls.length;
    const again = readPinnedArtifact(URL, shared);
    expect(again.ok).toBe(true);
    expect(git.calls).toHaveLength(spawned);
  });

  it("STILL MISSING after the fetch is a failure, never a pass", () => {
    const git = gitStub({ fetchMakesItLocal: false });
    const got = readPinnedArtifact(URL, io(git.run));
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/could not produce/);
  });

  it("a FAILING fetch is a failure, and says so", () => {
    const git = gitStub({ fetchOk: false });
    const got = readPinnedArtifact(URL, io(git.run));
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/fetch of a{40} failed/);
  });

  it("sha256Pinned derives the digest from the bytes it read", () => {
    const git = gitStub();
    expect(sha256Pinned(URL, io(git.run))).toEqual({ ok: true, sha256: PIN_HASH });
  });

  it("parsePermalink splits the pin, and a branch ref is not one", () => {
    expect(parsePermalink(URL)).toEqual({ sha: SHA, path: "evidence/round/shot.png" });
    expect(parsePermalink("https://github.com/cinatra-ai/cinatra/blob/main/evidence/x.png")).toBe(null);
    expect(isHistoricalPermalink(URL)).toBe(true);
    expect(repoPathOf(URL)).toBe("evidence/round/shot.png");
  });

  describe("what the RECORD does with it", () => {
    const pinnedRecord = (overrides = {}) => ({
      ...honestChatPending(),
      screenshot: URL,
      sha256: PIN_HASH,
      ...overrides,
    });
    const withGit = (git) => ({
      repoRoot: "/repo",
      // EXPLICIT: the pinned reader is gated by the same flag as the working
      // tree, so a suite that brings its own git says so. Without it these
      // cases would fall through to the real reader and attempt a real fetch.
      virtualFilesystem: true,
      readPinned: (u, extra) => readPinnedArtifact(u, { ...extra, ...io(git.run) }),
    });

    it("an unreachable object yields capture/pinned-object-unreachable", () => {
      const git = gitStub({ fetchMakesItLocal: false });
      const found = codes(validateCaptureRecord(pinnedRecord(), withGit(git)));
      expect(found).toContain("capture/pinned-object-unreachable");
      expect(found).not.toContain("record/sha256-mismatch");
    });

    it("a WRONG digest is caught after re-derivation, and names the real hash", () => {
      const git = gitStub();
      const found = validateCaptureRecord(pinnedRecord({ sha256: "d".repeat(64) }), withGit(git));
      const mismatch = found.find((v) => v.code === "record/sha256-mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch.detail).toContain(PIN_HASH);
      expect(codes(found)).not.toContain("capture/pinned-object-unreachable");
    });

    it("the honest digest passes through the same path", () => {
      const git = gitStub();
      const found = codes(validateCaptureRecord(pinnedRecord(), withGit(git)));
      expect(found).not.toContain("record/sha256-mismatch");
      expect(found).not.toContain("capture/pinned-object-unreachable");
    });

    it("a pin OUTSIDE the proof-artifact root is refused, hash or no hash", () => {
      const git = gitStub();
      const elsewhere = `https://github.com/cinatra-ai/cinatra/blob/${SHA}/src/app/icon.png`;
      const found = codes(
        validateCaptureRecord(pinnedRecord({ screenshot: elsewhere }), withGit(git)),
      );
      expect(found).toContain("record/pinned-screenshot-outside-proof-root");
    });
  });

  it("TWO records pinning ONE path at DIFFERENT commits is a duplicate", () => {
    // Keying the duplicate map on the whole citation missed this entirely: the
    // two URLs differ, so nothing compared them — while they name one picture,
    // whose bytes may well differ between the two commits.
    const at = (sha, cell) => ({
      ...honestChatPending(),
      cell,
      screenshot: `https://github.com/cinatra-ai/cinatra/blob/${sha}/evidence/round/shot.png`,
      sha256: PIN_HASH,
    });
    const result = validateCaptureIndex(
      {
        records: [
          at("a".repeat(40), "C1__review-card__chat_thread__pending"),
          at("b".repeat(40), "C2__review-card__chat_thread__decided"),
        ],
      },
      {
        repoRoot: "/repo",
        virtualFilesystem: true,
        readPinned: () => ({ ok: false, reason: "not read in this case" }),
      },
    );
    const dup = result.violations.filter((v) => v.code === "index/duplicate-screenshot-path");
    expect(dup).toHaveLength(1);
    expect(dup[0].detail).toMatch(/DIFFERENT commits/);
  });
});


// ---------------------------------------------------------------------------
// THE CAPTURE ROOT, ON THE CANONICAL TIER. This is the tier the required
// workflow invokes on its own, so a rule the audit tier alone enforces is a
// rule this gate does not have. A record naming any tracked file with that
// file's real hash used to satisfy every canonical rule there was.
// ---------------------------------------------------------------------------
describe("a live screenshot must be written into the capture output root", () => {
  it("REFUSES an arbitrary tracked file even when the hash is genuinely right", () => {
    // `package.json` exists and the digest below is really its digest — the
    // only thing wrong with this record is that it is not a capture.
    const real = readFileSync(join(REPO_ROOT, "package.json"));
    const found = codes(
      validateCaptureRecord(
        honestChatPending({
          screenshot: "package.json",
          sha256: createHash("sha256").update(real).digest("hex"),
        }),
        { repoRoot: REPO_ROOT },
      ),
    );
    expect(found).toContain("record/screenshot-outside-capture-root");
    // ...and it is refused for THAT reason, not for a hash it does satisfy.
    expect(found).not.toContain("record/sha256-mismatch");
    expect(found).not.toContain("record/screenshot-missing");
  });

  it("ACCEPTS the run scratch path a real held-turn run mints into", () => {
    const shot = "test-results/chat-hitl-held-turn-captures/C1__review-card__chat_thread__pending.png";
    const found = codes(
      validateCaptureRecord(honestChatPending({ screenshot: shot, sha256: hashA }), {
        repoRoot,
        virtualFilesystem: true,
        fileExists: () => true,
        hashFile: () => hashA,
      }),
    );
    expect(found).not.toContain("record/screenshot-outside-capture-root");
    expect(found).toEqual([]);
  });

  it("the root is the SHARED constant, so both tiers refuse the same paths", () => {
    expect(CAPTURE_OUTPUT_ROOT).toBe("test-results/");
    expect(recorderCaptureOutputRoot).toBe(CAPTURE_OUTPUT_ROOT);
  });

  it("ACCEPTS a pinned permalink under the historical proof root", () => {
    const BYTES = Buffer.from("PINNED");
    const hash = createHash("sha256").update(BYTES).digest("hex");
    const found = codes(
      validateCaptureRecord(
        honestChatPending({
          screenshot: `https://github.com/cinatra-ai/cinatra/blob/${"a".repeat(40)}/evidence/round/shot.png`,
          sha256: hash,
        }),
        { repoRoot: "/repo", virtualFilesystem: true, readPinned: () => ({ ok: true, bytes: BYTES }) },
      ),
    );
    expect(found).not.toContain("record/screenshot-outside-capture-root");
    expect(found).not.toContain("record/pinned-screenshot-outside-proof-root");
    expect(found).toEqual([]);
  });

  it("REFUSES a pinned permalink OUTSIDE the historical proof root", () => {
    const BYTES = Buffer.from("PINNED");
    const found = codes(
      validateCaptureRecord(
        honestChatPending({
          screenshot: `https://github.com/cinatra-ai/cinatra/blob/${"a".repeat(40)}/src/app/icon.png`,
          sha256: createHash("sha256").update(BYTES).digest("hex"),
        }),
        { repoRoot: "/repo", virtualFilesystem: true, readPinned: () => ({ ok: true, bytes: BYTES }) },
      ),
    );
    expect(found).toContain("record/pinned-screenshot-outside-proof-root");
  });
});


// ---------------------------------------------------------------------------
// ROOT CONTAINMENT IS RESOLVED, NOT SPELLED. Every case here builds a REAL
// temp tree with REAL symlinks, because the hole this closes is a filesystem
// fact that no string test can see: `test-results -> .` makes
// `test-results/package.json` start with the capture root, exist, and hash to
// whatever that file hashes to.
// ---------------------------------------------------------------------------
describe("a live screenshot is resolved on disk, not just spelled", () => {
  let root;
  const PNG = Buffer.from("PNG-BYTES");
  const PNG_HASH = createHash("sha256").update(PNG).digest("hex");
  const REL = "test-results/chat-hitl-held-turn-captures/C1__review-card__chat_thread__pending.png";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "capture-root-"));
    mkdirSync(join(root, "test-results", "chat-hitl-held-turn-captures"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, REL), PNG);
    writeFileSync(join(root, "src", "secret.png"), PNG);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const record = (overrides = {}) =>
    honestChatPending({ screenshot: REL, sha256: PNG_HASH, ...overrides });

  it("the honest case still passes — a regular file inside a real root", () => {
    expect(validateCaptureRecord(record(), { repoRoot: root })).toEqual([]);
    const resolved = resolveLiveCapture(REL, { repoRoot: root });
    expect(resolved.ok).toBe(true);
    expect(resolved.realPath).toBe(realpathSync(join(root, REL)));
  });

  it("a SYMLINKED ROOT is refused before anything under it is considered", () => {
    // `test-results -> .` — the exact escape: the path spells the capture root
    // and lands on the repository root, so any file in the repo is reachable.
    const linked = mkdtempSync(join(tmpdir(), "capture-linkroot-"));
    try {
      writeFileSync(join(linked, "package.json"), PNG);
      symlinkSync(".", join(linked, "test-results"), "dir");
      const found = codes(
        validateCaptureRecord(
          honestChatPending({ screenshot: "test-results/package.json", sha256: PNG_HASH }),
          { repoRoot: linked },
        ),
      );
      expect(found).toContain("record/capture-root-is-symlink");
      // ...and it is NOT waved through on a hash that genuinely matches.
      expect(found).not.toContain("record/sha256-mismatch");
      expect(found).not.toEqual([]);
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("a symlinked FILE inside the root pointing OUTSIDE is refused", () => {
    const rel = "test-results/chat-hitl-held-turn-captures/escape.png";
    symlinkSync(join(root, "src", "secret.png"), join(root, rel));
    try {
      const found = codes(validateCaptureRecord(record({ screenshot: rel }), { repoRoot: root }));
      expect(found).toContain("record/screenshot-symlink");
      expect(found).not.toContain("record/sha256-mismatch");
    } finally {
      rmSync(join(root, rel), { force: true });
    }
  });

  it("a symlinked file pointing INSIDE the root is ALSO refused — a capture is a regular file", () => {
    // DOCUMENTED DECISION. The link lands in a legitimate place, so a
    // containment-only rule would admit it. It is still refused: a capture is a
    // file a run wrote, and admitting the "harmless" inward link would mean the
    // check has to reason about where each link lands — the reasoning that
    // failed in the first place. One rule, no exceptions, nothing to get wrong.
    const rel = "test-results/chat-hitl-held-turn-captures/alias.png";
    symlinkSync(join(root, REL), join(root, rel));
    try {
      const found = codes(validateCaptureRecord(record({ screenshot: rel }), { repoRoot: root }));
      expect(found).toContain("record/screenshot-symlink");
    } finally {
      rmSync(join(root, rel), { force: true });
    }
  });

  it("a directory named like a capture is refused", () => {
    const rel = "test-results/chat-hitl-held-turn-captures/adir.png";
    mkdirSync(join(root, rel), { recursive: true });
    try {
      expect(codes(validateCaptureRecord(record({ screenshot: rel }), { repoRoot: root })))
        .toContain("record/screenshot-not-a-regular-file");
    } finally {
      rmSync(join(root, rel), { recursive: true, force: true });
    }
  });

  it("a missing file is still reported as missing", () => {
    const found = codes(
      validateCaptureRecord(record({ screenshot: "test-results/gone.png" }), { repoRoot: root }),
    );
    expect(found).toContain("record/screenshot-missing");
  });

  it("no capture root at all reads as a missing screenshot, not as a pass", () => {
    const bare = mkdtempSync(join(tmpdir(), "capture-noroot-"));
    try {
      expect(codes(validateCaptureRecord(record(), { repoRoot: bare })))
        .toContain("record/screenshot-missing");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("the hash is taken at the RESOLVED path", () => {
    const wrong = codes(validateCaptureRecord(record({ sha256: "d".repeat(64) }), { repoRoot: root }));
    expect(wrong).toContain("record/sha256-mismatch");
  });
});


// ---------------------------------------------------------------------------
// A HARD LINK IS A SECOND NAME FOR THE SAME INODE, and neither `lstat` nor
// `realpath` can see the other one: both answer INSIDE the root for
// `ln <outside file> test-results/.../shot.png`. Link count is the only local
// evidence that the bytes are reachable by another name.
// ---------------------------------------------------------------------------
describe("a live screenshot may not be hard-linked", () => {
  let root;
  const PNG = Buffer.from("PNG-BYTES");
  const PNG_HASH = createHash("sha256").update(PNG).digest("hex");
  const REL = "test-results/chat-hitl-held-turn-captures/linked.png";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "capture-hardlink-"));
    mkdirSync(join(root, "test-results", "chat-hitl-held-turn-captures"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "outside.png"), PNG);
    linkSync(join(root, "src", "outside.png"), join(root, REL));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("REFUSES it, even though lstat and realpath both answer inside the root", () => {
    const st = lstatSyncForTest(join(root, REL));
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    expect(realpathSync(join(root, REL)).startsWith(realpathSync(join(root, "test-results")))).toBe(true);
    const found = codes(
      validateCaptureRecord(honestChatPending({ screenshot: REL, sha256: PNG_HASH }), {
        repoRoot: root,
      }),
    );
    expect(found).toContain("record/screenshot-hard-linked");
    expect(found).not.toContain("record/sha256-mismatch");
  });

  it("a singly-linked capture beside it is still fine", () => {
    const rel = "test-results/chat-hitl-held-turn-captures/plain.png";
    writeFileSync(join(root, rel), PNG);
    expect(
      validateCaptureRecord(honestChatPending({ screenshot: rel, sha256: PNG_HASH }), {
        repoRoot: root,
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SEAM IS AN OPTION, NOT AN INFERENCE. It used to be "the caller injected a
// reader", which quietly turned every real-disk caller that also wanted a
// hasher into one that skipped resolution.
// ---------------------------------------------------------------------------
describe("an injected hasher does not buy an exemption", () => {
  it("a hasher ALONE still gets the resolved containment check", () => {
    const linked = mkdtempSync(join(tmpdir(), "capture-seam-"));
    try {
      writeFileSync(join(linked, "package.json"), "X");
      symlinkSync(".", join(linked, "test-results"), "dir");
      const record = honestChatPending({
        screenshot: "test-results/package.json",
        sha256: createHash("sha256").update("X").digest("hex"),
      });
      // A hasher, and nothing else: this must NOT skip resolution.
      const withHasher = codes(
        validateCaptureRecord(record, { repoRoot: linked, hashFile: () => record.sha256 }),
      );
      expect(withHasher).toContain("record/capture-root-is-symlink");
      // The explicit opt-in is the ONLY thing that replaces the filesystem.
      const virtual = codes(
        validateCaptureRecord(record, {
          repoRoot: linked,
          virtualFilesystem: true,
          fileExists: () => true,
          hashFile: () => record.sha256,
        }),
      );
      expect(virtual).toEqual([]);
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BEFORE THE SHUTTER. A capture is a WRITE, and refusing the record afterwards
// does not un-write the bytes — which may have landed on top of something.
// ---------------------------------------------------------------------------
describe("resolveCaptureTarget refuses a redirected write", () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "capture-target-"));
    mkdirSync(join(root, "test-results", "captures"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("admits an honest destination, resolved", () => {
    const got = resolveCaptureTarget("test-results/captures/new.png", { repoRoot: root });
    expect(got.ok).toBe(true);
    expect(got.parentReal).toBe(realpathSync(join(root, "test-results", "captures")));
    expect(got.absReal).toBe(join(got.parentReal, "new.png"));
  });

  it("refuses a SYMLINKED ROOT", () => {
    const linked = mkdtempSync(join(tmpdir(), "capture-target-root-"));
    try {
      symlinkSync(".", join(linked, "test-results"), "dir");
      const got = resolveCaptureTarget("test-results/x.png", { repoRoot: linked });
      expect(got.ok).toBe(false);
      expect(got.code).toBe("capture/root-is-symlink");
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("refuses a SYMLINKED INTERMEDIATE DIRECTORY — the case a final-component check cannot see", () => {
    symlinkSync(join(root, "outside"), join(root, "test-results", "sneaky"), "dir");
    try {
      const got = resolveCaptureTarget("test-results/sneaky/x.png", { repoRoot: root });
      expect(got.ok).toBe(false);
      expect(got.code).toBe("capture/parent-is-symlink");
    } finally {
      rmSync(join(root, "test-results", "sneaky"), { force: true });
    }
  });

  it("refuses an EXISTING SYMLINKED TARGET — writing it would follow the link out", () => {
    writeFileSync(join(root, "outside", "victim.png"), "OLD");
    symlinkSync(join(root, "outside", "victim.png"), join(root, "test-results", "captures", "t.png"));
    try {
      const got = resolveCaptureTarget("test-results/captures/t.png", { repoRoot: root });
      expect(got.ok).toBe(false);
      expect(got.code).toBe("capture/target-is-symlink");
      // ...and the file it points at is untouched, which is the whole point.
      expect(readFileSync(join(root, "outside", "victim.png"), "utf8")).toBe("OLD");
    } finally {
      rmSync(join(root, "test-results", "captures", "t.png"), { force: true });
    }
  });

  it("refuses an EXISTING HARD-LINKED TARGET — writing through a second name", () => {
    writeFileSync(join(root, "outside", "shared.png"), "OLD");
    linkSync(join(root, "outside", "shared.png"), join(root, "test-results", "captures", "h.png"));
    try {
      const got = resolveCaptureTarget("test-results/captures/h.png", { repoRoot: root });
      expect(got.ok).toBe(false);
      expect(got.code).toBe("capture/target-hard-linked");
    } finally {
      rmSync(join(root, "test-results", "captures", "h.png"), { force: true });
    }
  });

  it("refuses a parent that does not exist, and one outside the root", () => {
    expect(resolveCaptureTarget("test-results/nope/x.png", { repoRoot: root }).code)
      .toBe("capture/parent-missing");
  });
});


// ---------------------------------------------------------------------------
// CREATION IS PART OF THE CONTRACT. A run's FIRST capture names a directory
// that does not exist yet, and in a fresh checkout the capture root does not
// either — it is gitignored. Playwright used to create both on its way past;
// resolving before the shutter took that away and broke every run's first
// capture. These cases are the ones CI caught.
// ---------------------------------------------------------------------------
describe("prepareCaptureTarget creates what a run needs and refuses the rest", () => {
  it("a FRESH root with no capture root at all succeeds, and creates it", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-fresh-"));
    try {
      expect(existsSync(join(root, "test-results"))).toBe(false);
      const got = prepareCaptureTarget("test-results/x.png", { repoRoot: root });
      expect(got.ok).toBe(true);
      expect(existsSync(join(root, "test-results"))).toBe(true);
      expect(got.absReal).toBe(join(realpathSync(join(root, "test-results")), "x.png"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the FIRST capture into a run directory that does not exist creates it", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-first-"));
    try {
      const rel = "test-results/chat-hitl-held-turn-captures/S9k-1__recommendation-hold__chat_thread__held.png";
      expect(prepareCaptureTarget(rel, { repoRoot: root }).ok).toBe(true);
      expect(existsSync(join(root, "test-results", "chat-hitl-held-turn-captures"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nested run directories are created all the way down", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-deep-"));
    try {
      expect(prepareCaptureTarget("test-results/a/b/c/d.png", { repoRoot: root }).ok).toBe(true);
      expect(existsSync(join(root, "test-results", "a", "b", "c"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a SYMLINKED ROOT is still refused — mkdir does not replace an existing entry", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-symroot-"));
    try {
      symlinkSync(".", join(root, "test-results"), "dir");
      expect(prepareCaptureTarget("test-results/x.png", { repoRoot: root }).code)
        .toBe("capture/root-is-symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a PRE-EXISTING symlinked intermediate is still refused, and is not replaced", () => {
    // `mkdir -p` is satisfied by an existing symlinked directory and creates
    // nothing, so the re-resolution after it is the step that sees this.
    const root = mkdtempSync(join(tmpdir(), "prep-symint-"));
    try {
      mkdirSync(join(root, "test-results"), { recursive: true });
      mkdirSync(join(root, "outside"), { recursive: true });
      writeFileSync(join(root, "outside", "victim.png"), "OLD");
      symlinkSync(join(root, "outside"), join(root, "test-results", "sneaky"), "dir");
      expect(prepareCaptureTarget("test-results/sneaky/x.png", { repoRoot: root }).code)
        .toBe("capture/parent-is-symlink");
      expect(readFileSync(join(root, "outside", "victim.png"), "utf8")).toBe("OLD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CANONICAL validator never creates anything — it only judges", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-nowrite-"));
    try {
      validateCaptureRecord(honestChatPending({ screenshot: "test-results/a/b.png" }), {
        repoRoot: root,
      });
      expect(existsSync(join(root, "test-results"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// THE LAST-MOMENT RE-CHECK and the exclusive temp file. Node has no `openat`,
// so a path resolved once and used later is a time-of-check/time-of-use gap.
// It cannot be closed from here; it can be shrunk, and it must fail closed.
// ---------------------------------------------------------------------------
describe("the destination is re-verified at the last moment", () => {
  it("passes while nothing moved", () => {
    const root = mkdtempSync(join(tmpdir(), "recheck-ok-"));
    try {
      const t = prepareCaptureTarget("test-results/c/x.png", { repoRoot: root });
      expect(recheckCaptureParent(t)).toBe(null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED when the parent is swapped for a symlink mid-capture", () => {
    const root = mkdtempSync(join(tmpdir(), "recheck-swap-"));
    try {
      const t = prepareCaptureTarget("test-results/c/x.png", { repoRoot: root });
      mkdirSync(join(root, "outside"), { recursive: true });
      rmSync(join(root, "test-results", "c"), { recursive: true, force: true });
      symlinkSync(join(root, "outside"), join(root, "test-results", "c"), "dir");
      const got = recheckCaptureParent(t);
      expect(got).not.toBe(null);
      expect(got.code).toBe("capture/parent-replaced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED when the parent vanishes mid-capture", () => {
    const root = mkdtempSync(join(tmpdir(), "recheck-gone-"));
    try {
      const t = prepareCaptureTarget("test-results/c/x.png", { repoRoot: root });
      rmSync(join(root, "test-results", "c"), { recursive: true, force: true });
      expect(recheckCaptureParent(t).code).toBe("capture/parent-vanished");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the temp file is UNGUESSABLE and created exclusively", () => {
    const root = mkdtempSync(join(tmpdir(), "temp-excl-"));
    try {
      const t = prepareCaptureTarget("test-results/c/x.png", { repoRoot: root });
      const a = createCaptureTempFile(t.parentReal);
      const b = createCaptureTempFile(t.parentReal);
      expect(a.ok && b.ok).toBe(true);
      expect(a.path).not.toBe(b.path);
      // 96 bits of randomness in the name, and nothing predictable in it.
      expect(a.path).toMatch(/\.capture-[0-9a-f]{24}\.tmp$/);
      expect(a.path).not.toContain(String(process.pid));
      // ...and creating it again is refused rather than silently reused.
      expect(createCaptureTempFile(t.parentReal, { open: () => { throw new Error("EEXIST"); } }).code)
        .toBe("capture/temp-not-exclusive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// REAL DISK MEANS REAL `fs`. Injected filesystem functions were still honoured
// outside virtual mode, so a caller could fabricate the resolution or hand back
// the RECORDED digest for bytes that are something else — the implicit bypass
// one layer down from the flag that was supposed to end it.
// ---------------------------------------------------------------------------
describe("injected filesystem functions are ignored outside virtual mode", () => {
  let root;
  const REL = "test-results/c/s.png";
  const CLAIMED = createHash("sha256").update("CLAIMED").digest("hex");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "real-fs-only-"));
    mkdirSync(join(root, "test-results", "c"), { recursive: true });
    writeFileSync(join(root, REL), "WRONG-BYTES");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const record = () => honestChatPending({ screenshot: REL, sha256: CLAIMED });

  it("an injected hasher returning the RECORDED digest still fails on the real bytes", () => {
    const found = codes(validateCaptureRecord(record(), { repoRoot: root, hashFile: () => CLAIMED }));
    expect(found).toContain("record/sha256-mismatch");
  });

  it("injected lstat/realpath cannot fabricate the resolution", () => {
    const found = codes(
      validateCaptureRecord(record(), {
        repoRoot: root,
        hashFile: () => CLAIMED,
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
        realpath: (p) => p,
      }),
    );
    expect(found).toContain("record/sha256-mismatch");
  });

  it("an injected fileExists cannot vouch for a file that is not there", () => {
    const found = codes(
      validateCaptureRecord(honestChatPending({ screenshot: "test-results/c/gone.png" }), {
        repoRoot: root,
        fileExists: () => true,
        hashFile: () => hashA,
      }),
    );
    expect(found).toContain("record/screenshot-missing");
  });

  it("...and WITH the explicit flag the suite's filesystem is honoured, as designed", () => {
    expect(
      codes(
        validateCaptureRecord(record(), {
          repoRoot: root,
          virtualFilesystem: true,
          fileExists: () => true,
          hashFile: () => CLAIMED,
        }),
      ),
    ).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// THE PINNED READER IS GATED TOO. It reaches git history rather than the
// working tree, but that is a different STORE, not a different kind of trust:
// an injected reader can hand back bytes that hash to exactly the recorded
// digest for a blob that is something else entirely.
//
// The permalink below points into a REAL temp git repository this suite makes,
// so the reader runs `git cat-file` for real and nothing touches the network.
// ---------------------------------------------------------------------------
describe("an injected pinned reader is honoured only under the flag", () => {
  let root;
  let url;
  const REAL_BYTES = Buffer.from("THE-REAL-BLOB");
  const REAL_HASH = createHash("sha256").update(REAL_BYTES).digest("hex");
  const FORGED_BYTES = Buffer.from("FORGED-BYTES");
  const FORGED_HASH = createHash("sha256").update(FORGED_BYTES).digest("hex");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pinned-gate-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    // This throwaway repository is a FIXTURE, not the product tree: a
    // machine-wide hooks path (the very hygiene hooks this branch is about)
    // would otherwise refuse the proof-shaped fixture commit below.
    git("config", "core.hooksPath", join(root, ".no-hooks"));
    mkdirSync(join(root, "evidence", "round"), { recursive: true });
    writeFileSync(join(root, "evidence", "round", "shot.png"), REAL_BYTES);
    // `-f`: a machine-wide ignore rule for proof directories is exactly the
    // hygiene this branch installs, and it would otherwise leave the fixture
    // commit empty.
    git("add", "-f", "evidence/round/shot.png");
    git("commit", "-qm", "the real blob");
    const sha = git("rev-parse", "HEAD").trim();
    url = `https://github.com/cinatra-ai/cinatra/blob/${sha}/evidence/round/shot.png`;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A record that CLAIMS the forged digest, with a reader that vouches for it. */
  const forged = () => honestChatPending({ screenshot: url, sha256: FORGED_HASH });
  const vouchingReader = () => ({ ok: true, bytes: FORGED_BYTES });

  it("WITHOUT the flag the injected reader is ignored and the forgery is caught", () => {
    const found = codes(
      validateCaptureRecord(forged(), { repoRoot: root, readPinned: vouchingReader }),
    );
    // The real blob was read from history and hashes to something else.
    expect(found).toContain("record/sha256-mismatch");
    expect(found).not.toContain("capture/pinned-object-unreachable");
  });

  it("...and an injected `run` cannot fake the git call either", () => {
    const found = codes(
      validateCaptureRecord(forged(), {
        repoRoot: root,
        run: () => ({ status: 0, stdout: FORGED_BYTES, stderr: Buffer.alloc(0) }),
      }),
    );
    expect(found).toContain("record/sha256-mismatch");
  });

  it("an HONEST record still passes through the real reader", () => {
    expect(
      validateCaptureRecord(honestChatPending({ screenshot: url, sha256: REAL_HASH }), {
        repoRoot: root,
      }),
    ).toEqual([]);
  });

  it("WITH the flag the suite's reader is honoured, as designed", () => {
    expect(
      codes(
        validateCaptureRecord(forged(), {
          repoRoot: root,
          virtualFilesystem: true,
          readPinned: vouchingReader,
        }),
      ),
    ).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// A REJECTED WRITE MUST NOT HAVE BUILT ANYTHING. `mkdir -p` walks the path
// itself and walks straight THROUGH a symlinked intermediate, so the recursive
// form created `/outside/new` and the check afterwards then — correctly, and
// too late — refused the capture. The refusal was never the problem; the
// directory this function had already made outside the root was.
// ---------------------------------------------------------------------------
describe("preparing a target creates nothing outside the capture root", () => {
  it("a pre-existing symlinked intermediate is refused with NOTHING created through it", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-nomkdir-"));
    try {
      mkdirSync(join(root, "test-results"), { recursive: true });
      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, "test-results", "sneaky"), "dir");

      const got = prepareCaptureTarget("test-results/sneaky/new/shot.png", { repoRoot: root });
      expect(got.ok).toBe(false);
      expect(got.code).toBe("capture/parent-is-symlink");
      // THE ASSERTION THAT MATTERS: the outside directory is untouched.
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(outside, "new"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a FILE where a directory component belongs is refused, and not clobbered", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-file-seg-"));
    try {
      mkdirSync(join(root, "test-results"), { recursive: true });
      writeFileSync(join(root, "test-results", "notadir"), "I AM A FILE");
      const got = prepareCaptureTarget("test-results/notadir/deeper/shot.png", { repoRoot: root });
      expect(got.ok).toBe(false);
      expect(got.code).toBe("capture/parent-not-a-directory");
      expect(readFileSync(join(root, "test-results", "notadir"), "utf8")).toBe("I AM A FILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a deep honest path is built one component at a time", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-deep-walk-"));
    try {
      const got = prepareCaptureTarget("test-results/a/b/c/shot.png", { repoRoot: root });
      expect(got.ok).toBe(true);
      for (const d of ["a", join("a", "b"), join("a", "b", "c")]) {
        expect(lstatSyncForTest(join(root, "test-results", d)).isDirectory()).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recursive mkdir is never used — a single component is created per step", () => {
    // Proven by observation rather than by reading the source: every `mkdir`
    // call is recorded, and none of them asks for `recursive`.
    const root = mkdtempSync(join(tmpdir(), "prep-nonrecursive-"));
    try {
      const calls = [];
      const got = prepareCaptureTarget("test-results/a/b/shot.png", {
        repoRoot: root,
        mkdir: (p, opts) => {
          calls.push({ p, opts });
          return mkdirSync(p, opts);
        },
      });
      expect(got.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.opts?.recursive).toBeFalsy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the temp file keeps the final extension so an image writer can place it", () => {
    const root = mkdtempSync(join(tmpdir(), "prep-tmpext-"));
    try {
      const t = prepareCaptureTarget("test-results/c/shot.png", { repoRoot: root });
      const temp = createCaptureTempFile(t.parentReal, { extension: ".png" });
      expect(temp.ok).toBe(true);
      expect(temp.path.endsWith(".png")).toBe(true);
      expect(captureImageFormat(temp.path).type).toBe("png");
      expect(captureImageFormat("/x/y/shot.jpeg").type).toBe("jpeg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// ONE MAPPING, A CLOSED SET. Answering "png" for everything that is not a JPEG
// meant `shot.webp` reached the shutter as a `.webp` temp file DECLARED a PNG:
// the suffix and the type were derived twice and could disagree.
// ---------------------------------------------------------------------------
describe("a capture's image format is looked up, not guessed", () => {
  it("accepts the closed set, and returns the CANONICAL extension", () => {
    expect(captureImageFormat("a/b/shot.png")).toEqual({ ok: true, extension: ".png", type: "png" });
    expect(captureImageFormat("a/b/shot.jpg")).toEqual({ ok: true, extension: ".jpg", type: "jpeg" });
    expect(captureImageFormat("a/b/shot.jpeg")).toEqual({ ok: true, extension: ".jpeg", type: "jpeg" });
  });

  it("is case-insensitive, and normalises what it hands back", () => {
    // `.PNG` is a png — and the temp file it produces is spelled `.png`.
    expect(captureImageFormat("a/b/shot.PNG")).toEqual({ ok: true, extension: ".png", type: "png" });
    expect(captureImageFormat("a/b/shot.JPEG")).toEqual({ ok: true, extension: ".jpeg", type: "jpeg" });
  });

  it("REFUSES anything else rather than defaulting it to png", () => {
    for (const name of ["shot.webp", "shot.gif", "shot.svg", "shot", "shot.png.txt"]) {
      const got = captureImageFormat(name);
      expect(got.ok, name).toBe(false);
      expect(got.code, name).toBe("capture/unsupported-image-extension");
    }
  });

  it("the temp suffix and the declared type come from the SAME lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "fmt-pair-"));
    try {
      const t = prepareCaptureTarget("test-results/c/shot.jpeg", { repoRoot: root });
      const fmt = captureImageFormat("test-results/c/shot.jpeg");
      const temp = createCaptureTempFile(t.parentReal, { extension: fmt.extension });
      expect(temp.path.endsWith(".jpeg")).toBe(true);
      expect(fmt.type).toBe("jpeg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
