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
  RECORDER_ID,
  buildCaptureRecord,
  classifyUrl,
  collectAssertions,
  hostTokenInCell,
  validateCaptureIndex,
  validateCaptureRecord,
} from "../lib/chat-hitl-capture-recorder.mjs";
import { CAPTURE_INDEX_PATH, auditCaptureIndex } from "../chat-hitl-acceptance-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-acceptance-gate.mjs");

const PNG = "evidence/2821-fixture/shot.png";
const HASH = createHash("sha256").update("fixture-bytes").digest("hex");
const hashOf = (rel) => {
  if (rel !== PNG) throw new Error(`no such file: ${rel}`);
  return HASH;
};

/** A clean, host-anchored chat_thread record. */
function chatRecord(over = {}) {
  return {
    cell: "S9x-1__chat_thread__recommendation-hold-held",
    declaredHost: "chat_thread",
    finalUrl: "http://localhost:3000/chat?thread=t-1",
    build: "development",
    screenshot: PNG,
    sha256: HASH,
    capturedAt: "2026-08-16T09:00:00.000Z",
    recordedBy: RECORDER_ID,
    assertions: [
      { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1 },
      {
        frame: "main",
        selector: '[data-lifecycle-card-host="chat_thread"]',
        expect: "present",
        count: 1,
      },
    ],
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
    const record = chatRecord({
      assertions: [
        { frame: "main", selector: "[data-conversation-list]", expect: "present", count: 1 },
        {
          frame: "main",
          selector: '[data-lifecycle-card-host="chat_thread"]',
          expect: "present",
          count: 0,
        },
      ],
    });
    expect(validateCaptureRecord(record, { hashOf }).join("\n")).toMatch(
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

  it("the gate CLI reports the capture index on both modes", () => {
    for (const args of [[], ["--strict"]]) {
      const run = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/[Cc]apture index host-anchored/);
    }
  });
});
