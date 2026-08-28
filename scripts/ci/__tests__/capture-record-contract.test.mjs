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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
} from "../lib/capture-record-contract.mjs";

/** The tree the committed index's screenshots are resolved against. */
const REPO_ROOT = join(dirname(CAPTURE_INDEX_PATH), "..", "..");

let repoRoot;
const IMAGE_A = "evidence/fixture/C1__review-card__chat_thread__pending.png";
const IMAGE_B = "evidence/fixture/C2__review-card__chat_thread__decided.png";
let hashA;
let hashB;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "s9h-capture-"));
  mkdirSync(join(repoRoot, "evidence", "fixture"), { recursive: true });
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
        validateCaptureRecord(honestChatPending({ screenshot: "evidence/nope.png" }), {
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
      "evidence/unbound-cell",
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
      "evidence/invalid-record",
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
  // (evidence/2791-s9g-conformance/capture-results.json).
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
      "artifact_review_gate | page_gate_region | pending": 5,
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
      "recommendation_hold | site_widget | decided": 2,
      "recommendation_hold | site_widget | pending": 5,
      "trigger_schedule_proposal | chat_thread | decided": 4,
      "trigger_schedule_proposal | chat_thread | pending": 4,
      "trigger_schedule_proposal | run_card | decided": 2,
      "verification_summary | page_gate_region | advisory": 1,
      "verification_summary | run_card | advisory": 1,
    });
    expect(index.records.length).toBe(101);
  });
});
