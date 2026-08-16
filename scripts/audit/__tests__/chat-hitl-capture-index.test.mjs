// Fixture tests for the HOST-ANCHORED CANONICAL CAPTURE INDEX.
//
// The defect this gate was built after is small and easy to repeat: screenshots
// of the Agents page, filed under chat-cell names, accepted because nothing ever
// compared the claim to the record. So the fixtures below are that defect and
// its neighbours, each stated as a case the validator must refuse:
//
//   * a chat cell whose capture ended on the review page (URL class) and never
//     asserted a chat anchor (missing required host assertion);
//   * a record whose screenshot on disk hashes to something else (the image and
//     the record are not the same capture);
//   * a required anchor recorded with a count of zero (looked for, not found);
//   * a required anchor never asserted at all (the silent omission, which is
//     exactly as bad as the failure);
//   * a site_widget record that skips the frame scoping — the widget transcript
//     also renders `[data-conversation-list]`, so a main-frame assertion proves
//     nothing about which surface was photographed;
//   * a cell name that contradicts the declared host.
//
// And the cases it must ACCEPT: a host-anchored record on every one of the four
// ruled hosts, and a deliberate ABSENT assertion (that is how a placeholder is
// proven to be a placeholder).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_HOSTS,
  CAPTURE_INDEX_SCHEMA_VERSION,
  HOST_ANCHOR_REQUIREMENTS,
  KIND_REQUIRED_ACTIONS,
  RECORDER_ID,
  buildCaptureRecord,
  chatThreadRequirementsFor,
  classifyUrl,
  collectAssertions,
  hostTokenInCell,
  kindTokenInCell,
  observeCapture,
  validateCaptureIndex,
  validateCaptureRecord,
} from "../lib/chat-hitl-capture-recorder.mjs";
import {
  CAPTURE_INDEX_PATH,
  auditCaptureIndex,
  auditManifestIndexBinding,
  chatThreadCellClaims,
  screenshotProofInventory,
} from "../chat-hitl-acceptance-gate.mjs";
import { CHAT_THREAD_CARRIAGE_CONTRACT } from "@/lib/lifecycle/held-turn-card-contract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-acceptance-gate.mjs");

const PNG = "evidence/2821-fixture/shot.png";
const HASH = createHash("sha256").update("fixture-bytes").digest("hex");
const hashOf = (rel) => {
  if (rel !== PNG) throw new Error(`no such file: ${rel}`);
  return HASH;
};

/** Every anchor a chat_thread capture of `kind` owes, observed present. */
function chatAssertions(kind = "recommendation_hold") {
  return chatThreadRequirementsFor(kind).map((r) => ({ ...r, expect: "present", count: 1 }));
}

/** A clean, host-anchored chat_thread record. */
function chatRecord(over = {}) {
  return {
    cell: "S9x-1__chat_thread__recommendation-hold-held",
    declaredHost: "chat_thread",
    kind: "recommendation_hold",
    finalUrl: "http://localhost:3000/chat?thread=t-1",
    build: "development",
    screenshot: PNG,
    sha256: HASH,
    capturedAt: "2026-08-16T09:00:00.000Z",
    recordedBy: RECORDER_ID,
    assertions: chatAssertions(),
    ...over,
  };
}

function indexOf(records) {
  return {
    schemaVersion: CAPTURE_INDEX_SCHEMA_VERSION,
    recorder: RECORDER_ID,
    records,
  };
}

describe("URL classification", () => {
  it("reads the review page as a review page, not merely a run detail", () => {
    expect(classifyUrl("http://x/agents/proof/pkg/run-1/review/task-1")).toBe("review_page");
    expect(classifyUrl("http://x/agents/proof/pkg/run-1")).toBe("run_detail");
    expect(classifyUrl("http://x/agents")).toBe("agents_index");
    expect(classifyUrl("http://x/chat")).toBe("chat");
    expect(classifyUrl("https://blog.example.com/post")).toBe("other");
  });
});

describe("the mislabeled capture — the defect this index was built after", () => {
  it("REFUSES an Agents-page screenshot filed under a chat-cell name", () => {
    // The exact round it was built after: the cell says chat_thread, the record
    // says the page was the review page, and no chat anchor was ever asserted.
    const record = chatRecord({
      finalUrl: "http://localhost:3000/agents/proof/pkg/run-1/review/task-1",
      assertions: [
        { frame: "main", selector: "main", expect: "present", count: 1 },
      ],
    });
    const violations = validateCaptureRecord(record, { hashOf });
    expect(violations.join("\n")).toMatch(/needs a chat URL/);
    expect(violations.join("\n")).toMatch(/\[data-conversation-list\]/);
    expect(violations.join("\n")).toMatch(/data-lifecycle-card-host="chat_thread"/);
  });

  it("REFUSES a cell name that contradicts the declared host", () => {
    const record = chatRecord({
      cell: "S9x-2__run_card__recommendation-hold-held",
    });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /the cell name says host "run_card" and the record declares "chat_thread"/,
    );
  });

  it("REFUSES a record whose screenshot hashes to something else", () => {
    const record = chatRecord({ sha256: "0".repeat(64) });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /the image and the record are not the same capture/,
    );
  });

  it("REFUSES a record whose screenshot is not on disk", () => {
    const record = chatRecord({ screenshot: "evidence/2821-fixture/missing.png" });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(/screenshot not found/);
  });

  it("REFUSES a required anchor that was looked for and not found", () => {
    const assertions = chatAssertions().map((a) =>
      a.selector === '[data-lifecycle-card-host="chat_thread"]' ? { ...a, count: 0 } : a,
    );
    expect(validateCaptureRecord(chatRecord({ assertions }), { hashOf }).join("\n")).toMatch(
      /recorded as present but observed 0 times/,
    );
  });

  it("REFUSES a required anchor that was never asserted at all", () => {
    const record = chatRecord({
      assertions: [
        { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1 },
      ],
    });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /does not assert it at all/,
    );
  });

  it("REFUSES a chat_thread record that names no lifecycle kind", () => {
    // A transcript was on screen proves nothing about a card being in it.
    const record = chatRecord({ kind: undefined });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /must declare the lifecycle `kind` it photographed/,
    );
  });

  it("REFUSES a chat capture whose card has no decision controls", () => {
    // The placeholder case: the transcript, the card root and the host are all
    // there, and the card cannot be acted on.
    const assertions = chatAssertions().filter(
      (a) => !a.selector.startsWith('[data-action="'),
    );
    const violations = validateCaptureRecord(chatRecord({ assertions }), { hashOf }).join("\n");
    expect(violations).toMatch(/confirm-run-recommendation/);
    expect(violations).toMatch(/skip-run-recommendation/);
  });

  it("REFUSES a site_widget record asserted in the main frame instead of the embed frame", () => {
    // `[data-conversation-list]` is shared with the widget transcript, so a
    // main-frame assertion proves nothing about which surface was photographed.
    const record = {
      cell: "S9x-3__site_widget__recommendation-hold-held",
      declaredHost: "site_widget",
      finalUrl: "https://blog.example.com/post",
      build: "development",
      screenshot: PNG,
      sha256: HASH,
      capturedAt: "2026-08-16T09:00:00.000Z",
      recordedBy: RECORDER_ID,
      assertions: [
        { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1 },
        {
          frame: "main",
          selector: '[data-lifecycle-card-host="site_widget"]',
          expect: "present",
          count: 1,
        },
      ],
    };
    const violations = validateCaptureRecord(record, { hashOf }).join("\n");
    expect(violations).toMatch(/must declare the "widget" frame reached by \.cw-frame/);
    expect(violations).toMatch(/does not assert it at all/);
  });

  it("REFUSES a record not written by the one shared recorder", () => {
    const record = chatRecord({ recordedBy: "evidence/2821/my-own-capture.mjs" });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /every record is written by the ONE shared recorder/,
    );
  });

  it("REFUSES a screenshot outside evidence/ and a path that escapes the tree", () => {
    expect(validateCaptureRecord(chatRecord({ screenshot: "tmp/shot.png" }), { hashOf }).join("\n")).toMatch(
      /must live under evidence\//,
    );
    expect(
      validateCaptureRecord(chatRecord({ screenshot: "evidence/../../etc/x.png" }), { hashOf }).join("\n"),
    ).toMatch(/repo-relative path inside the tree/);
  });
});

describe("the host-anchored capture — what the index ACCEPTS", () => {
  it("accepts a chat_thread record with its frame-scoped anchors", () => {
    expect(validateCaptureRecord(chatRecord(), { hashOf })).toEqual([]);
  });

  it("accepts a run_card and a page_gate_region record on their own URL classes", () => {
    const runCard = chatRecord({
      cell: "S9x-4__run_card__recommendation-hold-held",
      declaredHost: "run_card",
      finalUrl: "http://localhost:3000/agents/proof/pkg/run-1",
      assertions: [
        {
          frame: "main",
          selector: '[data-lifecycle-card-host="run_card"]',
          expect: "present",
          count: 1,
        },
      ],
    });
    expect(validateCaptureRecord(runCard, { hashOf })).toEqual([]);

    const pageGate = chatRecord({
      cell: "S9x-5__page_gate_region__review-pending",
      declaredHost: "page_gate_region",
      finalUrl: "http://localhost:3000/agents/proof/pkg/run-1/review/task-1",
      assertions: [
        {
          frame: "main",
          selector: '[data-lifecycle-card-host="page_gate_region"]',
          expect: "present",
          count: 1,
        },
      ],
    });
    expect(validateCaptureRecord(pageGate, { hashOf })).toEqual([]);
  });

  it("accepts a site_widget record scoped through the declared embed frame", () => {
    const record = {
      cell: "S9x-6__site_widget__recommendation-hold-held",
      declaredHost: "site_widget",
      finalUrl: "https://blog.example.com/post",
      build: "development",
      screenshot: PNG,
      sha256: HASH,
      capturedAt: "2026-08-16T09:00:00.000Z",
      recordedBy: RECORDER_ID,
      frames: {
        widget: {
          selector: ".cw-frame",
          url: "http://localhost:3000/embed/assistant?site=blog",
        },
      },
      assertions: [
        {
          frame: "widget",
          selector: '[data-embed-assistant][data-phase="active"]',
          expect: "present",
          count: 1,
        },
        { frame: "widget", selector: "[data-conversation-list]", expect: "present", count: 1 },
        {
          frame: "widget",
          selector: '[data-lifecycle-card-host="site_widget"]',
          expect: "present",
          count: 1,
        },
      ],
    };
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
  });

  it("accepts a deliberate ABSENT assertion — how a placeholder is proven to be one", () => {
    const record = chatRecord({
      assertions: [
        ...chatRecord().assertions,
        {
          frame: "main",
          selector: '[data-action="cancel-trigger-schedule"]',
          expect: "absent",
          count: 0,
        },
      ],
    });
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
  });

  it("REFUSES an ABSENT assertion whose selector was in fact observed", () => {
    const record = chatRecord({
      assertions: [
        ...chatRecord().assertions,
        {
          frame: "main",
          selector: '[data-action="cancel-trigger-schedule"]',
          expect: "absent",
          count: 2,
        },
      ],
    });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /recorded as absent but observed 2 times/,
    );
  });
});

describe("the index as a whole", () => {
  it("refuses a wrong schema version, a foreign recorder and duplicate cells", () => {
    const bad = { schemaVersion: 99, recorder: "somewhere-else", records: [chatRecord(), chatRecord()] };
    const violations = validateCaptureIndex({ index: bad, hashOf }).join("\n");
    expect(violations).toMatch(/schemaVersion 99/);
    expect(violations).toMatch(/the index names the ONE shared recorder/);
    expect(violations).toMatch(/duplicate cell name/);
  });

  it("accepts a well-formed index", () => {
    expect(validateCaptureIndex({ index: indexOf([chatRecord()]), hashOf })).toEqual([]);
  });

  it("covers every ruled host with a required anchor set", () => {
    for (const host of CAPTURE_HOSTS) {
      expect(HOST_ANCHOR_REQUIREMENTS[host].length).toBeGreaterThan(0);
    }
  });

  it("reads a host token out of a cell name without giving it authority", () => {
    expect(hostTokenInCell("S9x-1__chat_thread__held")).toBe("chat_thread");
    expect(hostTokenInCell("S9x-1__no-host-here")).toBeNull();
  });
});

describe("the shared recorder", () => {
  it("records the counts it observed, never a count it assumed", () => {
    const seen = [];
    const assertions = collectAssertions(
      [
        { frame: "main", selector: "[data-conversation-list]" },
        { frame: "main", selector: '[data-lifecycle-card-host="chat_thread"]', expect: "present" },
        { frame: "main", selector: "[data-nope]", expect: "absent" },
      ],
      (frame, selector) => {
        seen.push(`${frame}|${selector}`);
        return selector === "[data-nope]" ? 0 : 1;
      },
    );
    expect(seen).toHaveLength(3);
    expect(assertions.map((a) => a.count)).toEqual([1, 1, 0]);
    expect(assertions[0].expect).toBe("present");
  });

  it("hashes the screenshot from disk, so a record cannot carry a hash it invented", () => {
    const record = buildCaptureRecord({
      cell: "S9x-7__chat_thread__held",
      declaredHost: "chat_thread",
      kind: "recommendation_hold",
      finalUrl: "http://localhost:3000/chat",
      build: "development",
      screenshot: PNG,
      assertions: chatRecord().assertions,
      repoRoot: "/anywhere",
      readImpl: () => Buffer.from("fixture-bytes"),
    });
    expect(record.sha256).toBe(HASH);
    expect(record.recordedBy).toBe(RECORDER_ID);
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The RECORDER as an OBSERVER
// ---------------------------------------------------------------------------

/**
 * A fake browser that records what was asked of it. The point of these tests is
 * the ORDER and the SOURCE of the facts: the recorder must resolve the outer
 * frame, count it, enter it, read the frame's own URL, and count the inner
 * anchors there — never take any of it from the caller.
 */
function fakePage({ url, counts = {}, frame = null, frameUrl = "", frameCounts = {} }) {
  const log = [];
  const page = {
    log,
    written: [],
    url: async () => {
      log.push("page.url");
      return url;
    },
    count: async (selector) => {
      log.push(`page.count:${selector}`);
      return counts[selector] ?? 0;
    },
    frame: async (selector) => {
      log.push(`page.frame:${selector}`);
      if (!frame) return null;
      return {
        url: async () => {
          log.push("frame.url");
          return frameUrl;
        },
        count: async (sel) => {
          log.push(`frame.count:${sel}`);
          return frameCounts[sel] ?? 0;
        },
      };
    },
    screenshot: async (abs) => {
      log.push("page.screenshot");
      page.written.push(abs);
    },
  };
  return page;
}

const OBSERVER_READ = () => Buffer.from("fixture-bytes");

describe("the recorder OBSERVES rather than taking dictation", () => {
  it("reads the final URL and every required anchor off the page itself", async () => {
    const page = fakePage({
      url: "http://localhost:3000/chat?thread=t-9",
      counts: Object.fromEntries(
        chatThreadRequirementsFor("recommendation_hold").map((r) => [r.selector, 1]),
      ),
    });
    const record = await observeCapture({
      page,
      cell: "S9x-obs__chat_thread__held",
      declaredHost: "chat_thread",
      kind: "recommendation_hold",
      screenshot: PNG,
      build: "development",
      repoRoot: "/anywhere",
      readImpl: OBSERVER_READ,
      now: () => "2026-08-16T09:00:00.000Z",
    });
    expect(record.finalUrl).toBe("http://localhost:3000/chat?thread=t-9");
    expect(record.sha256).toBe(HASH);
    expect(record.recordedBy).toBe(RECORDER_ID);
    // Every required anchor was actually looked for.
    for (const req of chatThreadRequirementsFor("recommendation_hold")) {
      expect(page.log).toContain(`page.count:${req.selector}`);
    }
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
  });

  it("resolves the outer frame, ENTERS it, and reads the inner URL and anchors there", async () => {
    const inner = HOST_ANCHOR_REQUIREMENTS.site_widget.map((r) => r.selector);
    const page = fakePage({
      url: "https://blog.example.com/post",
      counts: { ".cw-frame": 1 },
      frame: true,
      frameUrl: "http://localhost:3000/embed/assistant?site=blog",
      frameCounts: Object.fromEntries(inner.map((s) => [s, 1])),
    });
    const record = await observeCapture({
      page,
      cell: "S9x-obs__site_widget__held",
      declaredHost: "site_widget",
      screenshot: PNG,
      build: "development",
      repoRoot: "/anywhere",
      readImpl: OBSERVER_READ,
    });

    // The order IS the claim: count the outer frame, enter it, read its URL,
    // then count inside it.
    expect(page.log.indexOf("page.count:.cw-frame")).toBeLessThan(
      page.log.indexOf("page.frame:.cw-frame"),
    );
    expect(page.log.indexOf("page.frame:.cw-frame")).toBeLessThan(page.log.indexOf("frame.url"));
    for (const selector of inner) expect(page.log).toContain(`frame.count:${selector}`);
    expect(record.frames.widget).toEqual({
      selector: ".cw-frame",
      url: "http://localhost:3000/embed/assistant?site=blog",
    });
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
  });

  it("writes ZERO counts for a frame that did not resolve, so the failure is visible", async () => {
    const page = fakePage({ url: "https://blog.example.com/post", counts: { ".cw-frame": 0 } });
    const record = await observeCapture({
      page,
      cell: "S9x-obs__site_widget__missing-frame",
      declaredHost: "site_widget",
      screenshot: PNG,
      build: "development",
      repoRoot: "/anywhere",
      readImpl: OBSERVER_READ,
    });
    expect(record.assertions.every((a) => a.count === 0)).toBe(true);
    // …and the record it produced is REFUSED, rather than silently thin.
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(/embed_assistant/);
  });

  it("writes the screenshot before hashing it, so the hash is of the image on disk", async () => {
    const page = fakePage({ url: "http://localhost:3000/chat" });
    const record = await observeCapture({
      page,
      cell: "S9x-obs__chat_thread__zero",
      declaredHost: "chat_thread",
      kind: "recommendation_hold",
      screenshot: PNG,
      build: "production",
      repoRoot: "/anywhere",
      readImpl: OBSERVER_READ,
    });
    expect(page.written).toEqual([`/anywhere/${PNG}`]);
    expect(page.log.indexOf("page.screenshot")).toBeGreaterThan(page.log.indexOf("page.url"));
    // Nothing was observed, so nothing is claimed — and the record fails.
    expect(record.assertions.every((a) => a.count === 0)).toBe(true);
    expect(validateCaptureRecord(record, { hashOf }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The BINDING: an unindexed screenshot counts as zero
// ---------------------------------------------------------------------------

function manifestClaiming(cell) {
  return {
    rows: [
      {
        criterion: "x",
        disposition: "BUILT",
        e2eProofs: [{ file: "evidence/whatever/README.md", testName: cell }],
      },
    ],
  };
}

describe("the manifest to capture-index binding", () => {
  it("finds the manifest cells that CLAIM a chat_thread capture", () => {
    const claims = chatThreadCellClaims(
      manifestClaiming("C1__review-card__chat_thread__pending.png"),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].cell).toBe("C1__review-card__chat_thread__pending");
  });

  it("REFUSES a claimed chat cell with no record in the index", () => {
    const violations = auditManifestIndexBinding({
      manifest: manifestClaiming("X1__chat_thread__held.png"),
      index: indexOf([]),
    });
    expect(violations.join("\n")).toMatch(/an unindexed screenshot counts as zero/);
  });

  it("REFUSES a claimed chat cell whose record declares a different host", () => {
    const violations = auditManifestIndexBinding({
      manifest: manifestClaiming("X1__chat_thread__held"),
      index: indexOf([
        chatRecord({ cell: "X1__chat_thread__held", declaredHost: "run_card" }),
      ]),
    });
    expect(violations.join("\n")).toMatch(/its record declares "run_card"/);
  });

  it("REFUSES a claimed chat cell whose record never observed the card", () => {
    const violations = auditManifestIndexBinding({
      manifest: manifestClaiming("X1__chat_thread__held"),
      index: indexOf([
        chatRecord({
          cell: "X1__chat_thread__held",
          assertions: [
            { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1 },
          ],
        }),
      ]),
    });
    expect(violations.join("\n")).toMatch(/does not observe \[data-lifecycle-card="recommendation_hold"\]/);
  });

  it("ACCEPTS a claimed chat cell bound to a fully observed record", () => {
    expect(
      auditManifestIndexBinding({
        manifest: manifestClaiming("X1__chat_thread__held.png"),
        index: indexOf([chatRecord({ cell: "X1__chat_thread__held" })]),
      }),
    ).toEqual([]);
  });

  it("REFUSES a record whose kind disagrees with the kind the row cites", () => {
    // The row's claim wins. Otherwise a proof cited for the review card binds
    // to a record photographing the hold card, and the record decides what the
    // row proved.
    const violations = auditManifestIndexBinding({
      manifest: manifestClaiming("Z1__review-card__chat_thread__pending.png"),
      index: indexOf([
        chatRecord({ cell: "Z1__review-card__chat_thread__pending" }), // kind: recommendation_hold
      ]),
    });
    expect(violations.join("\n")).toMatch(
      /cites .* for artifact_review_gate; its record photographs recommendation_hold/,
    );
  });

  it("reads the kind a cell name claims, through the closed label map", () => {
    expect(kindTokenInCell("C1__review-card__chat_thread__pending")).toBe("artifact_review_gate");
    expect(kindTokenInCell("S9x__recommendation-hold__chat_thread__held")).toBe(
      "recommendation_hold",
    );
    expect(kindTokenInCell("A1__chat_thread__something")).toBeNull();
  });

  it("keeps the capture requirements in step with the held-turn contract", () => {
    // One authority for what an operable hold card looks like. The contract's
    // owner anchors drive the transcript gate; these drive the capture gate.
    const row = CHAT_THREAD_CARRIAGE_CONTRACT.find((r) => r.kind === "recommendation_hold");
    for (const action of KIND_REQUIRED_ACTIONS.recommendation_hold) {
      expect(row.ownerAnchors).toContain(action);
    }
  });
});

describe("the committed index and the gate CLI", () => {
  it("the committed capture index is valid", () => {
    expect(auditCaptureIndex()).toEqual([]);
  });

  it("the committed index names the shared recorder and the current schema", () => {
    const index = JSON.parse(readFileSync(CAPTURE_INDEX_PATH, "utf8"));
    expect(index.recorder).toBe(RECORDER_ID);
    expect(index.schemaVersion).toBe(CAPTURE_INDEX_SCHEMA_VERSION);
    expect(Array.isArray(index.records)).toBe(true);
  });

  it("RATCHET: exactly these screenshot proofs exist, with these declared hosts", () => {
    // The binding is keyed off a host token in the cell name, which makes it
    // opt-in: renaming `__chat_thread__` to `__chat__` would drop the claim and
    // the evidence requirement with it. This inventory closes that door. A
    // rename, an addition or a deletion changes this list and fails HERE, so a
    // capture cannot be un-claimed by relabelling it.
    expect(screenshotProofInventory().map((p) => `${p.cell} :: ${p.host ?? "-"}`)).toEqual([
      "A1__run-detail__held-at-recommendation-checkpoint :: -",
      "A1__run-detail__held-at-recommendation-checkpoint :: -",
      "A1__run-detail__held-at-recommendation-checkpoint :: -",
      "A2__run-detail__decided-summary-exactly-once :: -",
      "A2__run-detail__decided-summary-exactly-once :: -",
      "A2__run-detail__decided-summary-exactly-once :: -",
      "B2__chat__comment-typed-while-bound-lands-on-the-gate :: -",
      "B3__chat__two-open-gates-no-focus-the-pick-a-card-refusal :: -",
      "B3b__chat__the-ambiguous-send-is-refused-and-goes-nowhere :: -",
      "B4a__chat__explicit-focus-binds-that-card-only :: -",
      "B4b__chat__moving-the-focus-moves-where-the-comment-lands :: -",
      "C1__review-card__chat_thread__pending :: chat_thread",
      "C1__review-card__chat_thread__pending :: chat_thread",
      "C2__review-card__chat_thread__decided :: chat_thread",
      "C2__review-card__chat_thread__decided :: chat_thread",
      "island__first_party__server_rendered :: -",
      "island__forged_ref__empty :: -",
      "review-card__page_gate_region__pending :: page_gate_region",
      "s2-06-settled-no-longer-open :: -",
      "V2r-widget-review-card-island-painting :: -",
      "V4-widget-review-card :: -",
      "V6-widget-card-decided :: -",
      "V7-db-readback :: -",
    ]);
    // Five `__chat__` cells carry NO recognized host token. That is the rename
    // bypass sitting in the tree already, visible instead of silent: relabelling
    // a chat_thread cell to `__chat__` would land it in this list, not out of
    // sight. Binding them is the capture round's work, not a rename away.
  });

  it("RATCHET: exactly these chat_thread cells are unbound today", () => {
    // The honest state of the tree. A later round that adds another unindexed
    // chat screenshot changes this set and fails HERE, in the required job,
    // whatever the CLI's exit code is. Binding a cell to a real record also
    // changes it — which is the direction this list is meant to move.
    const unbound = [
      ...new Set(
        auditManifestIndexBinding()
          .map((v) => /chat_thread cell "([^"]+)"/.exec(v)?.[1])
          .filter(Boolean),
      ),
    ].sort();
    expect(unbound).toEqual([
      "C1__review-card__chat_thread__pending",
      "C2__review-card__chat_thread__decided",
    ]);
  });

  it("the gate CLI REFUSES both modes while a claimed chat cell is unbound", () => {
    for (const args of [[], ["--strict"]]) {
      const run = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
      expect(run.status, `mode ${args.join(" ") || "audit"}`).toBe(1);
      expect(run.stderr).toMatch(/an unindexed screenshot counts as zero/);
    }
  });
});
