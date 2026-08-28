// Fixture tests for the CAPTURE-RECORD CONTRACT (cinatra#2821, epic #2784 S9h).
//
// The failure this contract exists to stop is a screenshot filed under a host it
// does not show, so the fixtures are that exact shape: a picture of the Agents
// page recorded under a chat-cell name, a record whose anchors were never
// measured, a hash that has drifted, and one image doing duty for two screens.
// Each has an honest twin that must pass, because a gate nobody can satisfy gets
// switched off.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      { repoRoot: "/repo", readPinned: () => ({ ok: false, reason: "not read in this case" }) },
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
        { repoRoot: "/repo", readPinned: () => ({ ok: true, bytes: BYTES }) },
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
        { repoRoot: "/repo", readPinned: () => ({ ok: true, bytes: BYTES }) },
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
