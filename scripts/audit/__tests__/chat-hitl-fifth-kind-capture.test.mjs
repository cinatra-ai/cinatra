// THE FIFTH KIND IN THE CAPTURE VOCABULARY — `agent_hitl_screen`
// (cinatra#2930, lifecycle-b W3).
//
// The defect this pins is the one the picture leg found: the kind was drawn, it
// was mounted on every host, and the SHIPPED RECORDER refused every truthful
// record of it. `CARD_KINDS` held four kinds, so a plan naming this one was
// refused at parse time and a record declaring it was refused at validation
// time — which meant its pictures could never enter the canonical index at all,
// whatever anybody photographed.
//
// Three rules arrive with the admission, and each is measured here rather than
// asserted in prose:
//
//   1. THE KIND IS IN THE VOCABULARY, with the two canonical states and with the
//      card's own DOM token `asking` normalized to `pending` rather than
//      admitted as a third state;
//   2. ITS SETTLED READING IS AN ABSENCE. Alone among the five kinds, this card
//      draws NO DOM once the question is answered, so a `decided` capture owes
//      the absence of its root and of its fields region rather than a card with
//      an outcome on it;
//   3. TWO OF ITS FOUR HOST CELLS HAVE NO REACHABLE SUBJECT and are recorded as
//      composition-only WITH THE REASON. The mount is real on all four — the
//      host-parity ratchet records four cells and owes none; what two of them
//      have no path to is a photograph, and a validator that let one be claimed
//      would be inviting a staged picture.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  CAPTURE_STATES,
  KIND_REQUIRED_ACTIONS,
  LIFECYCLE_KINDS,
  RECORDER_ID,
  captureHostAdmissibility,
  captureRequirementsFor,
  observeWalkCell,
  settledIsAbsence,
  validateCaptureRecord,
  validateWalkPlan,
} from "../lib/chat-hitl-capture-recorder.mjs";
import {
  CARD_KINDS,
  parseCellName,
  validateCaptureRecord as validateCanonicalRecord,
} from "../../ci/lib/capture-record-contract.mjs";

const KIND = "agent_hitl_screen";
const PNG = "evidence/2821-fixture/shot.png";
const HASH = createHash("sha256").update("fixture-bytes").digest("hex");
const hashOf = (rel) => {
  if (rel !== PNG) throw new Error(`no such file: ${rel}`);
  return HASH;
};

/** Every anchor a capture of this kind owes on `host`, observed honestly. */
function assertionsFor(host, state) {
  return captureRequirementsFor(host, KIND, state).map((r) => ({
    ...r,
    expect: r.expect ?? "present",
    count: (r.expect ?? "present") === "absent" ? 0 : 1,
    visible: (r.expect ?? "present") === "absent" ? 0 : 1,
  }));
}

const URL_FOR = {
  chat_thread: "http://localhost:3000/chat?thread=t-1",
  run_card: "http://localhost:3000/agents/cinatra-ai/pkg/run-1",
  page_gate_region: "http://localhost:3000/agents/cinatra-ai/pkg/run-1/review/task-1",
  site_widget: "http://localhost:3000/embed/assistant?instance=i-1",
};

function recordOn(host, state, over = {}) {
  const base = {
    cell: `HF__hitl-screen__${host}__${state}`,
    declaredHost: host,
    declaredKind: KIND,
    declaredState: state,
    finalUrl: URL_FOR[host],
    build: "development",
    screenshot: PNG,
    sha256: HASH,
    capturedAt: "2026-08-27T09:00:00.000Z",
    recordedBy: RECORDER_ID,
    assertions: assertionsFor(host, state),
  };
  if (state === "pending") {
    base.instance = {
      selector: `[data-lifecycle-card="${KIND}"]`,
      matched: 1,
      index: 0,
      id: null,
      attributes: { "data-lifecycle-card": KIND, "data-lifecycle-card-host": host },
    };
  } else {
    // A DECIDED capture of this kind pins the ABSENCE — see the describe below.
    base.instance = ABSENCE_INSTANCE;
  }
  return { ...base, ...over };
}

/** What a decided capture of a settled-absence kind pins, in full. */
const ABSENCE_INSTANCE = Object.freeze({
  selector: `[data-lifecycle-card="${KIND}"]`,
  matched: 0,
  index: null,
  id: null,
  attributes: {},
  absent: true,
});

function planWith(cell) {
  return {
    plan: "chat-hitl-capture",
    contexts: { app: { role: "app" } },
    steps: [{ id: "s1", context: "app", actions: [], cells: [cell] }],
  };
}

// ---------------------------------------------------------------------------
// 1. The kind is in the vocabulary
// ---------------------------------------------------------------------------

describe("the fifth kind is admitted everywhere the four were enumerated", () => {
  it("is one of the card kinds the contract knows", () => {
    expect(Object.keys(CARD_KINDS)).toContain(KIND);
    expect(LIFECYCLE_KINDS).toContain(KIND);
  });

  it("owes ONE control on a pending capture — the fields region, not the Continue", () => {
    // A setup-loop gate submits on change and draws no Continue, so requiring
    // it would refuse an honest capture of that screen.
    expect(KIND_REQUIRED_ACTIONS[KIND]).toEqual(['[data-conformance-id="hitl-screen-fields"]']);
  });

  it("carries the two canonical states and no third one", () => {
    expect([...CAPTURE_STATES]).toEqual(["pending", "decided"]);
  });

  it("normalizes the card's own `asking` token to `pending`", () => {
    const claim = parseCellName(`HF__hitl-screen__chat_thread__asking`);
    expect(claim.kind).toBe(KIND);
    expect(claim.state).toBe("pending");
  });

  it("accepts a truthful chat_thread record of it — the refusal that made its pictures unindexable", () => {
    expect(validateCaptureRecord(recordOn("chat_thread", "pending"), { hashOf })).toEqual([]);
    expect(
      validateCanonicalRecord(recordOn("chat_thread", "pending"), {
        fileExists: () => true,
        hashFile: () => HASH,
      }),
    ).toEqual([]);
  });

  it("accepts a truthful run_card record of it", () => {
    expect(validateCaptureRecord(recordOn("run_card", "pending"), { hashOf })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The settled reading is an absence
// ---------------------------------------------------------------------------

describe("the settled reading of this kind is an absence, and only of this kind", () => {
  it("declares it, and no other kind does", () => {
    expect(settledIsAbsence(KIND)).toBe(true);
    for (const other of LIFECYCLE_KINDS.filter((k) => k !== KIND)) {
      expect(settledIsAbsence(other), other).toBe(false);
    }
  });

  it("asks a decided capture for the ABSENCE of the root and the fields region", () => {
    const decided = captureRequirementsFor("chat_thread", KIND, "decided");
    const absent = decided.filter((r) => r.expect === "absent").map((r) => r.selector);
    expect(absent).toContain(`[data-lifecycle-card="${KIND}"]`);
    expect(absent).toContain('[data-conformance-id="hitl-screen-fields"]');
    // …and asks for no presence inside a root that is not there.
    expect(decided.filter((r) => r.expect === "present" && r.scope === "root")).toEqual([]);
  });

  it("accepts a decided record that photographed the card gone", () => {
    expect(validateCaptureRecord(recordOn("chat_thread", "decided"), { hashOf })).toEqual([]);
  });

  it("refuses a decided record that still shows the card", () => {
    const record = recordOn("chat_thread", "decided");
    const violations = validateCaptureRecord(
      {
        ...record,
        assertions: record.assertions.map((a) =>
          a.selector === `[data-lifecycle-card="${KIND}"]` ? { ...a, count: 1, visible: 1 } : a,
        ),
      },
      { hashOf },
    );
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2b. A DECIDED RECORD OF THIS KIND PINS THE ABSENCE
// ---------------------------------------------------------------------------
//
// THE DEFECT, measured twice on two real runs at the moment each answer landed:
// the SHIPPED recorder refused every `decided` record of this kind and quoted
// its own rules doing it —
//
//   walk cell "HC-decided__hitl-card__chat_thread__decided" produced a record
//   the index would refuse: a chat_thread record must carry the `instance` its
//   card-scoped counts were read from — without it the counts describe
//   whichever card led the DOM
//
// — because `settledIsAbsence` emits no root-scoped requirement, so nothing
// resolved a root, so `observeCapture` wrote no `instance`, while the audit tier
// requires one of any record whose kind has a card root. Each rule was right;
// together they made the one kind that settles to no DOM unindexable in its
// settled state. What was missing was a definition of what such a record pins
// INSTEAD of a card, and it is the absence itself.

const PNG_BYTES = Buffer.from("hitl-decided-fixture");
const PNG_HASH = createHash("sha256").update(PNG_BYTES).digest("hex");
const WALK_PNG = "evidence/2930-fixture/decided.png";

/** A screen with the transcript intact and no card of this kind on it. */
function decidedChatPage({ rootCount = 0 } = {}) {
  const counts = {
    "[data-conversation-list]": 1,
    [`[data-lifecycle-card="${KIND}"]`]: rootCount,
    '[data-conformance-id="hitl-screen-fields"]': 0,
    '[data-lifecycle-card-host="chat_thread"]': rootCount,
  };
  const countOf = (selector) => counts[selector] ?? 0;
  return {
    url: async () => URL_FOR.chat_thread,
    count: async (selector) => countOf(selector),
    countVisible: async (selector) => countOf(selector),
    identifyWithin: async (selector) =>
      Array.from({ length: countOf(selector) }, () => ({ "data-lifecycle-card": KIND })),
    pinWithin: async (root, index = 0) =>
      countOf(root) > index
        ? { count: async (sel) => countOf(sel), countVisible: async (sel) => countOf(sel) }
        : null,
    frame: async () => null,
    screenshot: async () => {},
  };
}

const walkCell = (over = {}) => ({
  cell: `HC-decided__hitl-card__chat_thread__decided`,
  declaredHost: "chat_thread",
  kind: KIND,
  state: "decided",
  framing: "window",
  build: "development",
  screenshot: WALK_PNG,
  ...over,
});

describe("a decided record of a kind that settles to an absence pins THE ABSENCE", () => {
  it("the shipped recorder writes one, and the walk it used to refuse now lands", async () => {
    const record = await observeWalkCell({
      page: decidedChatPage(),
      cell: walkCell(),
      repoRoot: "/anywhere",
      readImpl: () => PNG_BYTES,
      now: () => "2026-08-27T09:23:53.927Z",
    });
    // The pin is the ROOT that was owed absent, the count that was READ for it
    // — the frame-scoped number this capture already took twice around the
    // shutter — and the claim itself. There is no card to be the nth of and
    // none to read an identity off.
    expect(record.instance).toEqual({
      selector: `[data-lifecycle-card="${KIND}"]`,
      matched: 0,
      index: null,
      id: null,
      attributes: {},
      absent: true,
    });
    expect(record.declaredState).toBe("decided");
    // And BOTH halves take it — the refusal was the two disagreeing.
    expect(validateCaptureRecord(record, { hashOf: () => PNG_HASH, tier: "audit" })).toEqual([]);
    expect(
      validateCanonicalRecord(record, { fileExists: () => true, hashFile: () => PNG_HASH }),
    ).toEqual([]);
  });

  it("refuses one whose root is still on the screen", async () => {
    // The picture would show the question still being asked. The absence is
    // MEASURED, so the record says 1 and both halves refuse it rather than
    // writing "decided" over a card that is still there.
    await expect(
      observeWalkCell({
        page: decidedChatPage({ rootCount: 1 }),
        cell: walkCell(),
        repoRoot: "/anywhere",
        readImpl: () => PNG_BYTES,
        now: () => "2026-08-27T09:23:53.927Z",
      }),
    ).rejects.toThrow(/still on the screen|not decided/);

    const claimed = { ...recordOn("chat_thread", "decided"), instance: { ...ABSENCE_INSTANCE, matched: 1 } };
    expect(validateCaptureRecord(claimed, { hashOf }).join("\n")).toMatch(/still on the screen/);
    expect(
      validateCanonicalRecord(claimed, { fileExists: () => true, hashFile: () => HASH })
        .map((x) => x.detail)
        .join("\n"),
    ).toMatch(/still on the screen/);
  });

  it("refuses a decided record of this kind that pins a CARD instead of the absence", () => {
    const pinsACard = {
      ...recordOn("chat_thread", "decided"),
      instance: {
        selector: `[data-lifecycle-card="${KIND}"]`,
        matched: 1,
        index: 0,
        id: null,
        attributes: { "data-lifecycle-card": KIND },
      },
    };
    expect(validateCaptureRecord(pinsACard, { hashOf }).join("\n")).toMatch(/absent: true/);
    expect(
      validateCanonicalRecord(pinsACard, { fileExists: () => true, hashFile: () => HASH })
        .map((x) => x.detail)
        .join("\n"),
    ).toMatch(/absent: true/);
  });

  it("refuses an ABSENCE claimed by a kind whose settled reading is a drawn card", () => {
    // The narrowness is the point: a review card is still drawn once it is
    // decided — its floor is replaced by its outcome — so a record of one that
    // says the card was not there is not a settled reading, it is a missed one.
    const drawnKind = "artifact_review_gate";
    const record = {
      cell: `HF__review-card__chat_thread__decided`,
      declaredHost: "chat_thread",
      declaredKind: drawnKind,
      declaredState: "decided",
      finalUrl: URL_FOR.chat_thread,
      build: "development",
      screenshot: PNG,
      sha256: HASH,
      capturedAt: "2026-08-27T09:00:00.000Z",
      recordedBy: RECORDER_ID,
      assertions: captureRequirementsFor("chat_thread", drawnKind, "decided").map((r) => ({
        ...r,
        expect: r.expect ?? "present",
        count: (r.expect ?? "present") === "absent" ? 0 : 1,
        visible: (r.expect ?? "present") === "absent" ? 0 : 1,
      })),
      instance: {
        selector: CARD_KINDS[drawnKind].root,
        matched: 1,
        index: 0,
        id: null,
        attributes: { "data-lifecycle-card": drawnKind },
        absent: true,
      },
    };
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(/has no absence to pin/);
    expect(
      validateCanonicalRecord(record, { fileExists: () => true, hashFile: () => HASH })
        .map((x) => x.detail)
        .join("\n"),
    ).toMatch(/has no absence to pin/);
  });

  it("refuses an absence that still names WHICH card, or what was read off it", () => {
    // Half-checking the shape is how a forged pin gets in: an absence that
    // carries an index, an id or attributes is claiming a measurement of
    // something that was not on the screen.
    const symbolKeyed = {};
    symbolKeyed[Symbol("data-lifecycle-card")] = KIND;
    const hiddenKeyed = {};
    Object.defineProperty(hiddenKeyed, "data-lifecycle-card", {
      value: KIND,
      enumerable: false,
    });
    const forged = [
      ["an index", { index: 7 }, /pins index/],
      ["an id", { id: "forged" }, /names instance/],
      ["an array where the attribute set belongs", { attributes: [] }, /attributes` OBJECT/],
      // `typeof` calls all three of these an object, which is why the check is
      // on the PROTOTYPE rather than on the word.
      ["a Date", { attributes: new Date() }, /attributes` OBJECT/],
      ["a Map", { attributes: new Map() }, /attributes` OBJECT/],
      [
        "an instance of something of its own",
        { attributes: Object.create({ inherited: true }) },
        /attributes` OBJECT/,
      ],
      [
        "attributes read off nothing",
        { attributes: { "data-lifecycle-card": KIND } },
        /cannot have been read/,
      ],
      // Both of these are invisible to `Object.keys`, which is why the check is
      // on EVERY own key.
      ["a symbol-keyed attribute", { attributes: symbolKeyed }, /cannot have been read/],
      ["a non-enumerable attribute", { attributes: hiddenKeyed }, /cannot have been read/],
    ];
    for (const [what, over, matcher] of forged) {
      const record = {
        ...recordOn("chat_thread", "decided"),
        instance: { ...ABSENCE_INSTANCE, ...over },
      };
      expect(validateCaptureRecord(record, { hashOf }).join("\n"), what).toMatch(matcher);
      expect(
        validateCanonicalRecord(record, { fileExists: () => true, hashFile: () => HASH })
          .map((x) => x.detail)
          .join("\n"),
        what,
      ).toMatch(matcher);
    }
  });

  it("leaves the four other kinds' decided records exactly as they were", () => {
    for (const other of LIFECYCLE_KINDS.filter((k) => k !== KIND)) {
      const record = {
        cell: `HF__${CARD_KINDS[other].cellTokens[0]}__chat_thread__decided`,
        declaredHost: "chat_thread",
        declaredKind: other,
        declaredState: "decided",
        finalUrl: URL_FOR.chat_thread,
        build: "development",
        screenshot: PNG,
        sha256: HASH,
        capturedAt: "2026-08-27T09:00:00.000Z",
        recordedBy: RECORDER_ID,
        assertions: captureRequirementsFor("chat_thread", other, "decided").map((r) => ({
          ...r,
          expect: r.expect ?? "present",
          count: (r.expect ?? "present") === "absent" ? 0 : 1,
          visible: (r.expect ?? "present") === "absent" ? 0 : 1,
        })),
        instance: {
          selector: CARD_KINDS[other].root,
          matched: 1,
          index: 0,
          id: null,
          attributes: { "data-lifecycle-card": other },
        },
      };
      expect(validateCaptureRecord(record, { hashOf, tier: "audit" }), other).toEqual([]);
      expect(
        validateCanonicalRecord(record, { fileExists: () => true, hashFile: () => HASH }),
        other,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. A cell with no reachable subject
// ---------------------------------------------------------------------------

describe("the two host cells with no reachable subject are recorded, with the reason", () => {
  it("names the two, and leaves the other three kinds capturable everywhere", () => {
    expect(captureHostAdmissibility(KIND, "chat_thread").capturable).toBe(true);
    expect(captureHostAdmissibility(KIND, "run_card").capturable).toBe(true);
    expect(captureHostAdmissibility(KIND, "site_widget").capturable).toBe(false);
    expect(captureHostAdmissibility(KIND, "page_gate_region").capturable).toBe(false);
    for (const other of LIFECYCLE_KINDS.filter((k) => k !== KIND)) {
      for (const host of ["chat_thread", "run_card", "site_widget", "page_gate_region"]) {
        expect(captureHostAdmissibility(other, host).capturable, `${other}/${host}`).toBe(true);
      }
    }
  });

  it("carries the code fact rather than a bare refusal", () => {
    expect(captureHostAdmissibility(KIND, "site_widget").reason).toMatch(/pending_approval/);
    expect(captureHostAdmissibility(KIND, "page_gate_region").reason).toMatch(/review/);
  });

  it("refuses a RECORD claiming one of them, and says why", () => {
    const violations = validateCaptureRecord(recordOn("site_widget", "pending"), { hashOf });
    expect(violations.join("\n")).toMatch(/composition-only/);
  });

  it("refuses a record that leaves the kind OFF and lets the cell name say it", () => {
    // The bypass a declaration-only rule leaves open: `declaredKind` is
    // optional on every host but chat_thread, so a cell with no reachable
    // subject could walk past by saying nothing while its NAME still named the
    // kind. Both validators read the EFFECTIVE kind.
    const { declaredKind: _dropped, ...undeclared } = recordOn("site_widget", "pending");
    expect(validateCaptureRecord(undeclared, { hashOf }).join("\n")).toMatch(/composition-only/);
    expect(
      validateCanonicalRecord(undeclared, { fileExists: () => true, hashFile: () => HASH }).map(
        (x) => x.detail,
      ).join("\n"),
    ).toMatch(/composition-only/);
  });

  it("refuses a PLAN cell that leaves the kind off, for the same reason", () => {
    const refused = validateWalkPlan(
      planWith({
        cell: `HF__hitl-screen__site_widget__pending`,
        declaredHost: "site_widget",
        screenshot: PNG,
      }),
    );
    expect(refused.join("\n")).toMatch(/composition-only/);
  });

  it("refuses a PLAN naming one of them before anybody walks it", () => {
    const refused = validateWalkPlan(
      planWith({
        cell: `HF__hitl-screen__page_gate_region__pending`,
        declaredHost: "page_gate_region",
        kind: KIND,
        state: "pending",
        screenshot: PNG,
      }),
    );
    expect(refused.join("\n")).toMatch(/composition-only/);
  });

  it("admits a PLAN naming a cell that CAN be photographed", () => {
    const accepted = validateWalkPlan(
      planWith({
        cell: `HF__hitl-screen__chat_thread__pending`,
        declaredHost: "chat_thread",
        kind: KIND,
        state: "pending",
        screenshot: PNG,
      }),
    );
    expect(accepted.filter((x) => /agent_hitl_screen|composition-only/.test(x))).toEqual([]);
  });
});
