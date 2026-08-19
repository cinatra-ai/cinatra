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
  chatThreadRequirementsFor,
  classifyUrl,
  collectAssertions,
  hostTokenInCell,
  kindTokenInCell,
  observeCapture,
  stateTokenInCell,
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
import { playwrightPage } from "../lib/chat-hitl-capture-driver.mjs";
import { CHAT_THREAD_CARRIAGE_CONTRACT } from "@/lib/lifecycle/held-turn-card-contract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-acceptance-gate.mjs");

const PNG = "evidence/2821-fixture/shot.png";
const HASH = createHash("sha256").update("fixture-bytes").digest("hex");
const hashOf = (rel) => {
  if (rel !== PNG) throw new Error(`no such file: ${rel}`);
  return HASH;
};

/**
 * Every anchor a chat_thread capture of `kind` owes, observed present AND
 * painted. `visible` tracks `count` here because that is what an honest capture
 * of a rendered card looks like; the fixtures that pull them apart are the
 * attached-but-unrendered cases below.
 */
function chatAssertions(kind = "recommendation_hold", state = "pending") {
  return chatThreadRequirementsFor(kind, state).map((r) => ({
    ...r,
    expect: r.expect ?? "present",
    count: (r.expect ?? "present") === "absent" ? 0 : 1,
    visible: (r.expect ?? "present") === "absent" ? 0 : 1,
  }));
}

/** The card instance a single-card capture pins. */
function chatInstance(kind = "recommendation_hold", over = {}) {
  return {
    selector: `[data-lifecycle-card="${kind}"]`,
    matched: 1,
    index: 0,
    id: null,
    attributes: { "data-lifecycle-card": kind, "data-lifecycle-card-host": "chat_thread" },
    ...over,
  };
}

/** A clean, host-anchored chat_thread record. */
function chatRecord(over = {}) {
  return {
    cell: "S9x-1__chat_thread__recommendation-hold-held",
    declaredHost: "chat_thread",
    kind: "recommendation_hold",
    state: "pending",
    finalUrl: "http://localhost:3000/chat?thread=t-1",
    build: "development",
    screenshot: PNG,
    sha256: HASH,
    capturedAt: "2026-08-16T09:00:00.000Z",
    recordedBy: RECORDER_ID,
    assertions: chatAssertions(),
    instance: chatInstance(),
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
        { frame: "main", selector: "main", expect: "present", count: 1, visible: 1 },
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
      a.selector === '[data-lifecycle-card-host="chat_thread"]'
        ? { ...a, count: 0, visible: 0 }
        : a,
    );
    expect(validateCaptureRecord(chatRecord({ assertions }), { hashOf }).join("\n")).toMatch(
      /recorded as present but observed 0 times/,
    );
  });

  it("REFUSES a required anchor that was never asserted at all", () => {
    const record = chatRecord({
      assertions: [
        { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1, visible: 1 },
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
        { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1, visible: 1 },
        {
          frame: "main",
          selector: '[data-lifecycle-card-host="site_widget"]',
          expect: "present",
          count: 1,
          visible: 1,
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
          visible: 1,
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
          visible: 1,
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
          visible: 1,
        },
        { frame: "widget", selector: "[data-conversation-list]", expect: "present", count: 1, visible: 1 },
        {
          frame: "widget",
          selector: '[data-lifecycle-card-host="site_widget"]',
          expect: "present",
          count: 1,
          visible: 1,
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
          visible: 0,
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
          visible: 2,
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

  it("exposes no API that turns supplied assertions into an official record", async () => {
    // API SURFACE, stated exactly. The builder that stamped this module's
    // provenance onto assertions handed to it is gone, so no CODE PATH here
    // manufactures a record from counts it did not take. That is not the same
    // as provenance: a person editing the JSON can still copy the recorder id
    // and invent counts, which the module header says out loud and no check in
    // this repo prevents for any evidence file.
    const mod = await import("../lib/chat-hitl-capture-recorder.mjs");
    expect(Object.keys(mod)).not.toContain("buildCaptureRecord");
    expect(typeof mod.observeCapture).toBe("function");
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
function fakePage({
  url,
  counts = {},
  /**
   * PAINTED counts, keyed exactly like `counts`. Anything unlisted is painted
   * as often as it is attached — the honest default — so only the tests about
   * hidden DOM have to say anything.
   */
  visible = {},
  /**
   * `identifyWithin` answers, keyed by root selector: one attribute map per
   * match. Unlisted roots answer with as many synthetic cards as `counts` says
   * are there, each carrying its own `data-card-instance`, so an ambiguity test
   * only has to raise the count.
   */
  instances = {},
  frame = null,
  frameUrl = "",
  frameCounts = {},
  frameVisible = {},
}) {
  const log = [];
  const scoped = (table, root, selector, fallback) => {
    const hit = table[`${root}>>${selector}`];
    return hit === undefined ? (table[selector] ?? fallback) : hit;
  };
  const paintedOf = (table, counted, key) => (table[key] === undefined ? counted : table[key]);

  const readerFor = (name, countTable, visibleTable, urlOf) => ({
    url: urlOf,
    count: async (selector) => {
      log.push(`${name}.count:${selector}`);
      return countTable[selector] ?? 0;
    },
    countVisible: async (selector) => {
      log.push(`${name}.countVisible:${selector}`);
      return paintedOf(visibleTable, countTable[selector] ?? 0, selector);
    },
    identifyWithin: async (selector) => {
      log.push(`${name}.identifyWithin:${selector}`);
      if (instances[selector] !== undefined) return instances[selector];
      return Array.from({ length: countTable[selector] ?? 0 }, (_, i) => ({
        "data-lifecycle-card": selector.replace(/^\[data-lifecycle-card="|"\]$/g, ""),
        "data-lifecycle-card-host": "chat_thread",
        "data-card-instance": `card-${i}`,
      }));
    },
    // Card-scoped reads. The fake keys them by "root>>selector" so a test can
    // say what lives INSIDE the card and what merely lives on the page. The
    // INDEX is logged too: the recorder pinning a card is the behaviour under
    // test, not an implementation detail.
    countWithin: async (root, selector, index = 0) => {
      log.push(`${name}.countWithin:${root}#${index}>>${selector}`);
      return scoped(countTable, root, selector, 0);
    },
    countWithinVisible: async (root, selector, index = 0) => {
      log.push(`${name}.countWithinVisible:${root}#${index}>>${selector}`);
      const counted = scoped(countTable, root, selector, 0);
      const key = visibleTable[`${root}>>${selector}`] === undefined ? selector : `${root}>>${selector}`;
      return paintedOf(visibleTable, counted, key);
    },
  });

  const page = {
    log,
    written: [],
    ...readerFor("page", counts, visible, async () => {
      log.push("page.url");
      return url;
    }),
    frame: async (selector) => {
      log.push(`page.frame:${selector}`);
      if (!frame) return null;
      return readerFor("frame", frameCounts, frameVisible, async () => {
        log.push("frame.url");
        return frameUrl;
      });
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
        chatThreadRequirementsFor("recommendation_hold").map((r) => [
          r.within ? `${r.within}>>${r.selector}` : r.selector,
          1,
        ]),
      ),
    });
    const record = await observeCapture({
      page,
      cell: "S9x-obs__chat_thread__held",
      declaredHost: "chat_thread",
      kind: "recommendation_hold",
      state: "pending",
      screenshot: PNG,
      build: "development",
      repoRoot: "/anywhere",
      readImpl: OBSERVER_READ,
      now: () => "2026-08-16T09:00:00.000Z",
    });
    expect(record.finalUrl).toBe("http://localhost:3000/chat?thread=t-9");
    expect(record.sha256).toBe(HASH);
    expect(record.recordedBy).toBe(RECORDER_ID);
    // Every required anchor was actually looked for, card-scoped ones INSIDE
    // the card root rather than anywhere on the page.
    for (const req of chatThreadRequirementsFor("recommendation_hold")) {
      expect(page.log).toContain(
        req.within
          ? `page.countWithin:${req.within}#0>>${req.selector}`
          : `page.count:${req.selector}`,
      );
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
      state: "pending",
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

function manifestClaiming(cell, file = "evidence/2821-fixture/README.md") {
  return {
    rows: [
      { criterion: "x", disposition: "BUILT", e2eProofs: [{ file, testName: cell }] },
    ],
  };
}

describe("a SETTLED capture owes the absence of its controls", () => {
  // C2-shaped: the same chat card after the decision. Requiring the controls
  // present would make an honest settled screenshot unindexable; requiring
  // nothing would let a placeholder pass as either state.
  function settledRecord(over = {}) {
    return chatRecord({
      cell: "S9x-8__chat_thread__recommendation-hold-settled",
      state: "settled",
      assertions: chatAssertions("recommendation_hold", "settled"),
      ...over,
    });
  }

  it("ACCEPTS a settled record whose controls are gone and whose summary is there", () => {
    expect(validateCaptureRecord(settledRecord(), { hashOf })).toEqual([]);
  });

  it("REFUSES a settled record that still shows its decision controls", () => {
    const assertions = settledRecord().assertions.map((a) =>
      a.selector === '[data-action="confirm-run-recommendation"]' ? { ...a, count: 1 } : a,
    );
    expect(validateCaptureRecord(settledRecord({ assertions }), { hashOf }).join("\n")).toMatch(
      /recorded as absent but observed 1 times/,
    );
  });

  it("REFUSES a settled record with no decided summary", () => {
    const assertions = settledRecord().assertions.filter(
      (a) => a.selector !== "[data-run-recommendation-decision]",
    );
    expect(validateCaptureRecord(settledRecord({ assertions }), { hashOf }).join("\n")).toMatch(
      /does not assert it at all/,
    );
  });

  it("REFUSES a chat_thread record that declares no state at all", () => {
    expect(validateCaptureRecord(chatRecord({ state: undefined }), { hashOf }).join("\n")).toMatch(
      /must declare the `state` it photographed/,
    );
  });
});

describe("the three bypasses an adversarial round found", () => {
  it("REFUSES a settled marker borrowed from a DIFFERENT card", async () => {
    // The page has the schedule card's root, a stray chat_thread host on some
    // wrapper, and an unrelated card's settled marker. Page-wide counting called
    // that settled; card-scoped counting does not.
    const kind = "trigger_schedule_proposal";
    const reqs = chatThreadRequirementsFor(kind, "settled");
    const counts = { "[data-conversation-list]": 1, [`[data-lifecycle-card="${kind}"]`]: 1 };
    for (const r of reqs) {
      if (!r.within) continue;
      // Present somewhere on the page, absent INSIDE the claimed card.
      counts[r.selector] = 1;
      counts[`${r.within}>>${r.selector}`] = 0;
    }
    const page = fakePage({ url: "http://localhost:3000/chat", counts });
    const record = await observeCapture({
      page,
      cell: "S9x-borrow__chat_thread__settled",
      declaredHost: "chat_thread",
      kind,
      state: "settled",
      screenshot: PNG,
      build: "development",
      repoRoot: "/anywhere",
      readImpl: OBSERVER_READ,
    });
    // The host declaration and the settled marker were counted zero INSIDE the
    // card, so the record is refused however the page looked.
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /data-lifecycle-card-host="chat_thread"/,
    );
  });

  it("REFUSES a capture whose screen changed between the counts and the shutter", async () => {
    // Hydration, a poll, a streamed state change: a record whose numbers
    // describe one screen while its image shows another is worse than none.
    const reqs = chatThreadRequirementsFor("recommendation_hold");
    const counts = Object.fromEntries(
      reqs.map((r) => [r.within ? `${r.within}>>${r.selector}` : r.selector, 1]),
    );
    const page = fakePage({ url: "http://localhost:3000/chat", counts });
    const realScreenshot = page.screenshot;
    page.screenshot = async (abs) => {
      // The decision lands while the shutter is open.
      for (const key of Object.keys(counts)) {
        if (key.includes("confirm-run-recommendation")) counts[key] = 0;
      }
      return realScreenshot(abs);
    };
    await expect(
      observeCapture({
        page,
        cell: "S9x-drift__chat_thread__held",
        declaredHost: "chat_thread",
        kind: "recommendation_hold",
        state: "pending",
        screenshot: PNG,
        build: "development",
        repoRoot: "/anywhere",
        readImpl: OBSERVER_READ,
      }),
    ).rejects.toThrow(/is not stable/);
  });

  it("REFUSES pending evidence for a cell whose name claims a decided state", () => {
    expect(stateTokenInCell("C2__review-card__chat_thread__decided")).toBe("settled");
    expect(stateTokenInCell("C1__review-card__chat_thread__pending")).toBe("pending");
    const violations = auditManifestIndexBinding({
      manifest: manifestClaiming("C2__review-card__chat_thread__decided.png"),
      index: indexOf([
        chatRecord({
          cell: "C2__review-card__chat_thread__decided",
          kind: "artifact_review_gate",
          state: "pending",
        }),
      ]),
    });
    expect(violations.join("\n")).toMatch(/cites .* as settled; its record photographs pending/);
  });
});

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
            { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1, visible: 1 },
          ],
        }),
      ]),
    });
    expect(violations.join("\n")).toMatch(/does not observe \[data-lifecycle-card="recommendation_hold"\]/);
  });

  it("REFUSES a record whose screenshot lives away from the proof that cites it", () => {
    const violations = auditManifestIndexBinding({
      manifest: manifestClaiming("X1__chat_thread__held.png", "evidence/somewhere-else/README.md"),
      index: indexOf([chatRecord({ cell: "X1__chat_thread__held" })]),
    });
    expect(violations.join("\n")).toMatch(/the image must sit with the proof that cites it/);
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

// ---------------------------------------------------------------------------
// WHICH CARD, AND WAS IT ON THE SCREEN
// ---------------------------------------------------------------------------

/**
 * A fake Playwright page over a hand-built tree, so the DRIVER ADAPTER — the
 * code that turns a real browser into the `CapturePage` port — is exercised
 * without a browser and without writing an evidence file.
 *
 * Only the surface `playwrightPage` actually uses is modelled: `locator()` with
 * `count`/`nth`/`first`, per-element `isVisible` and `evaluate`, and nested
 * `locator()` for card-scoped reads.
 */
function fakeElement(attributes, { visible = true, children = {} } = {}) {
  return { attributes, visible, children };
}

function fakeLocator(list) {
  return {
    count: async () => list.length,
    nth: (i) => fakeElementLocator(list[i]),
    // Used ONLY by the pre-fix adapter restated below. The shipped adapter must
    // not reach for it, which is the whole point of this file's mutation check.
    first: () => fakeElementLocator(list[0]),
  };
}

function fakeElementLocator(el) {
  return {
    count: async () => (el ? 1 : 0),
    isVisible: async () => Boolean(el?.visible),
    evaluate: async (fn) =>
      fn({
        attributes: Object.entries(el?.attributes ?? {}).map(([name, value]) => ({ name, value })),
      }),
    locator: (selector) => fakeLocator(el?.children?.[selector] ?? []),
  };
}

function fakeBrowserPage({ url, tree }) {
  return {
    url: () => url,
    locator: (selector) => fakeLocator(tree[selector] ?? []),
    $: async () => null,
    screenshot: async () => {},
  };
}

/**
 * The SHIPPED adapter, with only its image-writing half stubbed out. These tests
 * are about what the adapter MEASURES, and a fixture suite has no business
 * creating an evidence file to prove it.
 */
function drivenPage(page) {
  return { ...playwrightPage(page), screenshot: async () => {} };
}

const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const HOST_ANCHOR = '[data-lifecycle-card-host="chat_thread"]';
const CONFIRM = '[data-action="confirm-run-recommendation"]';
const SKIP = '[data-action="skip-run-recommendation"]';

/** One `recommendation_hold` card, painted or not, with its own controls. */
function heldCard(runId, { visible = true } = {}) {
  const inner = fakeElement({}, { visible });
  return fakeElement(
    { "data-lifecycle-card": "recommendation_hold", "data-run-id": runId },
    {
      visible,
      children: { [HOST_ANCHOR]: [inner], [CONFIRM]: [inner], [SKIP]: [inner] },
    },
  );
}

/**
 * THE PAGE THE FINDING DESCRIBES: a /chat transcript holding TWO cards of the
 * same kind. The first in DOM order is collapsed — attached, with every anchor
 * this gate looks for, and painted nowhere. The second is the one a screenshot
 * of this page actually shows.
 */
function twoCardTranscript() {
  return fakeBrowserPage({
    url: "http://localhost:3000/chat?thread=t-1",
    tree: {
      "[data-conversation-list]": [fakeElement({})],
      [CARD_ROOT]: [heldCard("run-A", { visible: false }), heldCard("run-B")],
    },
  });
}

/**
 * THE ADAPTER AS IT STOOD, restated: card-scoped reads answered from `.first()`,
 * and attachment taken as presence. Nothing here is a straw man — it is the two
 * lines this round changed, expressed through today's port so the SAME recorder
 * and the SAME validator judge both records.
 */
function firstMatchAttachedOnlyPage(page) {
  const countWithin = async (root, selector) => {
    if ((await page.locator(root).count()) === 0) return 0;
    return page.locator(root).first().locator(selector).count();
  };
  return {
    url: async () => page.url(),
    count: async (selector) => page.locator(selector).count(),
    // Attachment WAS presence: the old adapter had no notion of painted.
    countVisible: async (selector) => page.locator(selector).count(),
    // The old adapter recorded no instance at all; the nearest honest
    // translation is "one card, nothing observed about it".
    identifyWithin: async () => [{}],
    countWithin,
    countWithinVisible: countWithin,
    frame: async () => null,
    screenshot: async () => {},
  };
}

const OBSERVE_ARGS = {
  cell: "S9x-mut__chat_thread__recommendation-hold-held",
  declaredHost: "chat_thread",
  kind: "recommendation_hold",
  state: "pending",
  screenshot: PNG,
  build: "development",
  repoRoot: "/anywhere",
  readImpl: OBSERVER_READ,
  now: () => "2026-08-19T09:00:00.000Z",
};

describe("a capture names WHICH card it measured, and whether it was on the screen", () => {
  it("MUTATION: the pre-fix adapter accepts the mislabeled capture the fixed one refuses", async () => {
    // The page: card run-A leads the DOM and is painted nowhere; card run-B is
    // what the screenshot shows. A cell photographing this transcript has to
    // end up describing ONE of them, and saying which.
    const page = twoCardTranscript();

    // BEFORE. Every card-scoped anchor is answered from run-A, the collapsed
    // card, and attachment stands in for presence. The record validates CLEAN:
    // conversation list, card root, host declaration and BOTH decision controls
    // all "observed present" — a fully-anchored pending capture, filed with a
    // screenshot in which none of it appears, and carrying nothing that says
    // which card the numbers came from.
    const before = await observeCapture({
      ...OBSERVE_ARGS,
      page: firstMatchAttachedOnlyPage(page),
    });
    expect(validateCaptureRecord(before, { hashOf })).toEqual([]);
    for (const selector of [HOST_ANCHOR, CONFIRM, SKIP]) {
      const a = before.assertions.find((x) => x.selector === selector);
      expect(a.count).toBe(1);
    }

    // AFTER. The same page, through the shipped adapter, is not measurable at
    // all until the capture says which card it means.
    await expect(
      observeCapture({ ...OBSERVE_ARGS, page: playwrightPage(page) }),
    ).rejects.toThrow(/2 elements matching .* and the cell declares no instance/);
  });

  it("REFUSES the collapsed card even once it is named — attachment is not a photograph", async () => {
    const record = await observeCapture({
      ...OBSERVE_ARGS,
      page: drivenPage(twoCardTranscript()),
      instance: "run-A",
    });
    // It measured the card it was told to measure, and wrote down that nothing
    // in it was painted.
    expect(record.instance).toMatchObject({ selector: CARD_ROOT, matched: 2, index: 0, id: "run-A" });
    for (const selector of [HOST_ANCHOR, CONFIRM, SKIP]) {
      const a = record.assertions.find((x) => x.selector === selector);
      expect({ selector, count: a.count, visible: a.visible }).toEqual({
        selector,
        count: 1,
        visible: 0,
      });
    }
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /attached DOM is not a photograph/,
    );
  });

  it("ACCEPTS the card that is actually on the screen, and records which one it was", async () => {
    const record = await observeCapture({
      ...OBSERVE_ARGS,
      page: drivenPage(twoCardTranscript()),
      instance: "run-B",
    });
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
    // host + kind + state + URL binding is now host + kind + state + URL +
    // INSTANCE binding: the record names the card, off the card's own markup.
    expect(record.instance).toEqual({
      selector: CARD_ROOT,
      matched: 2,
      index: 1,
      id: "run-B",
      attributes: { "data-lifecycle-card": "recommendation_hold", "data-run-id": "run-B" },
    });
  });

  it("REFUSES an instance declaration that selects no card, rather than falling back", async () => {
    await expect(
      observeCapture({
        ...OBSERVE_ARGS,
        page: drivenPage(twoCardTranscript()),
        instance: "run-Z",
      }),
    ).rejects.toThrow(/0 of the 2 matching card\(s\) carry that value/);
  });

  it("needs no declaration when the transcript holds ONE card of the kind", async () => {
    const page = fakeBrowserPage({
      url: "http://localhost:3000/chat?thread=t-1",
      tree: {
        "[data-conversation-list]": [fakeElement({})],
        [CARD_ROOT]: [heldCard("run-only")],
      },
    });
    const record = await observeCapture({ ...OBSERVE_ARGS, page: drivenPage(page) });
    expect(validateCaptureRecord(record, { hashOf })).toEqual([]);
    expect(record.instance).toMatchObject({ matched: 1, index: 0, id: null });
  });

  it("records matched: 0 when the transcript holds no card, and says so twice", async () => {
    // The empty case, which the instance field introduced a branch for: there is
    // nothing to pin, so the capture is not an error — it is a record that
    // observed no card, and both the instance and the required anchors say so.
    const page = fakeBrowserPage({
      url: "http://localhost:3000/chat?thread=t-1",
      tree: { "[data-conversation-list]": [fakeElement({})] },
    });
    const record = await observeCapture({ ...OBSERVE_ARGS, page: drivenPage(page) });
    expect(record.instance).toEqual({
      selector: CARD_ROOT,
      matched: 0,
      index: 0,
      id: null,
      attributes: {},
    });
    const violations = validateCaptureRecord(record, { hashOf }).join("\n");
    expect(violations).toMatch(/the recorded instance matched 0 card\(s\)/);
    expect(violations).toMatch(/requires \[data-lifecycle-card="recommendation_hold"\] PRESENT/);
  });

  it("REFUSES a chat_thread record that names no instance at all", () => {
    const record = chatRecord();
    delete record.instance;
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /must carry the `instance` its card-scoped counts were read from/,
    );
  });

  it("REFUSES a record that measured one of several cards without saying which", () => {
    const record = chatRecord({ instance: chatInstance("recommendation_hold", { matched: 3 }) });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /3 cards matched .* and the record names no instance id/,
    );
  });

  it("REFUSES an instance id no observed attribute carries", () => {
    const record = chatRecord({
      instance: chatInstance("recommendation_hold", { matched: 2, id: "run-ghost" }),
    });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /the id names a card the recorder did not find/,
    );
  });

  it("REFUSES an instance pinned to a root this record does not count inside", () => {
    const record = chatRecord({
      instance: chatInstance("recommendation_hold", { selector: '[data-lifecycle-card="verification_summary"]' }),
    });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
      /the recorded instance pins .* but this record's card-scoped counts are taken inside/,
    );
  });

  it("REFUSES a record whose painted count was never observed", () => {
    const assertions = chatAssertions().map((a) => {
      const withoutPainted = { ...a };
      delete withoutPainted.visible;
      return withoutPainted;
    });
    expect(validateCaptureRecord(chatRecord({ assertions }), { hashOf }).join("\n")).toMatch(
      /visible must be the observed count of PAINTED matches/,
    );
  });

  it("keeps ABSENT answered by ATTACHMENT, so a merely hidden control is not gone", () => {
    // The asymmetry stated as a case. If `absent` were judged on the painted
    // count, a settled capture would pass with its decision controls still in
    // the DOM and merely hidden — which is a card a reader can still be shown.
    const assertions = chatAssertions("recommendation_hold", "settled").map((a) =>
      a.selector === CONFIRM ? { ...a, count: 1, visible: 0 } : a,
    );
    expect(
      validateCaptureRecord(
        chatRecord({ cell: "S9x-mut__chat_thread__recommendation-hold-settled", state: "settled", assertions }),
        { hashOf },
      ).join("\n"),
    ).toMatch(/recorded as absent but observed 1 times/);
  });

  it("the BINDING refuses an attached-but-unpainted anchor too, not only the validator", () => {
    const assertions = chatAssertions().map((a) =>
      a.selector === CONFIRM ? { ...a, visible: 0 } : a,
    );
    expect(
      auditManifestIndexBinding({
        manifest: manifestClaiming("X9__chat_thread__recommendation-hold-held"),
        index: indexOf([chatRecord({ cell: "X9__chat_thread__recommendation-hold-held", assertions })]),
      }).join("\n"),
    ).toMatch(/does not observe \[data-action="confirm-run-recommendation"\] present/);
  });
});
