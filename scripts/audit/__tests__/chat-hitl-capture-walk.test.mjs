// THE WALK — fixture tests for the recorder path that registers a real-path
// capture round.
//
// The defect these were written after is the S9d round-2 lane: it walked the
// shipped product for real — a schedule stated into the composer, one press of
// Confirm, the run page's schedule step opened by a press, the expired reading
// after a real thirty minutes — shot four cells in two themes, and could
// register NONE of them. Its driver was its own file, so nothing it produced was
// a recorder observation, and an index record's assertions are observations or
// they are inventions. The ten round-1 records stayed in the index describing
// pictures the rework had already replaced.
//
// So the cases below are that gap and its neighbours:
//
//   * a walk is a PATH — contexts that persist, steps that act, cells observed
//     on the screen those actions produced. `driveCapture`'s one-URL-one-cell
//     shape cannot express "the same card before and after one press";
//   * the plan is refused BEFORE the browser opens, because a walk gated on a
//     real TTL is expensive and mostly unrepeatable;
//   * a walk cell that does not come out fails AT THE CELL, judged at the audit
//     tier against the image on disk;
//   * a record's assertions are COUNTED by the recorder, on every host the kind
//     is drawn on — the run-page cell was unrecordable while the observer asked
//     for the kind's anchors in a chat thread only;
//   * a walk MERGES: it replaces what it rewrote, retires what it replaced, and
//     leaves every other record where it stood.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCaptureRecord as validateCanonicalRecord } from "../../ci/lib/capture-record-contract.mjs";
import {
  CAPTURE_FRAMINGS,
  RECORDER_ID,
  WALK_ACTIONS,
  captureRequirementsFor,
  mergeWalkRecords,
  observeWalkCell,
  validateWalkPlan,
  walkCellsOf,
} from "../lib/chat-hitl-capture-recorder.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WALK_PLAN_PATH = join(REPO_ROOT, "evidence", "2788-s9d-rework", "capture-walk.json");
const S9D_WALK = JSON.parse(readFileSync(WALK_PLAN_PATH, "utf8"));

const PNG = "evidence/2821-fixture/walk.png";
const BYTES = Buffer.from("walk-fixture-bytes");
const HASH = createHash("sha256").update(BYTES).digest("hex");
const READ = () => BYTES;
const NOW = () => "2026-08-23T09:00:00.000Z";

/**
 * A page that answers exactly what the requirement set asks for, and says so.
 *
 * `present` requirements count 1 and are painted 1; `absent` ones count 0. That
 * is what an honest capture of a card in that state looks like, and it is the
 * only shape a test may hand the recorder — everything else the record says, the
 * recorder has to read off this fake itself.
 */
function pageAnswering(requirements, { url, overrides = {} } = {}) {
  const counts = {};
  for (const req of requirements) {
    const key = req.within ? `${req.within}>>${req.selector}` : req.selector;
    counts[key] = (req.expect ?? "present") === "present" ? 1 : 0;
    // A root-scoped requirement is counted inside a root that must itself be on
    // the page for the pin to resolve.
    if (req.within) counts[req.within] = counts[req.within] ?? 1;
  }
  Object.assign(counts, overrides);
  const log = [];
  const countOf = (selector, root = null) => {
    if (root !== null) {
      const scoped = counts[`${root}>>${selector}`];
      if (scoped !== undefined) return scoped;
    }
    return counts[selector] ?? 0;
  };
  const page = {
    log,
    shots: [],
    url: async () => url,
    count: async (selector) => countOf(selector),
    countVisible: async (selector) => countOf(selector),
    identifyWithin: async (selector) =>
      Array.from({ length: countOf(selector) }, (_, i) => ({
        "data-lifecycle-card": selector.replace(/^\[data-lifecycle-card="|"\]$/g, ""),
        "data-card-instance": `card-${i}`,
      })),
    pinWithin: async (root, index = 0) => {
      if (countOf(root) <= index) return null;
      return {
        count: async (selector) => countOf(selector, root),
        countVisible: async (selector) => countOf(selector, root),
      };
    },
    frame: async () => null,
    screenshot: async (abs, options = {}) => {
      log.push(`screenshot:${options.framing ?? "(none)"}`);
      page.shots.push(abs);
    },
  };
  return page;
}

const CHAT_PENDING = {
  cell: "S9d-C1__schedule-card__chat_thread__pending",
  declaredHost: "chat_thread",
  kind: "trigger_schedule_proposal",
  state: "pending",
  framing: "window",
  build: "development",
  screenshot: PNG,
};

const RUN_DECIDED = {
  cell: "S9d-C3__schedule-card__run_card__decided",
  declaredHost: "run_card",
  kind: "trigger_schedule_proposal",
  state: "decided",
  framing: "window",
  build: "development",
  screenshot: PNG,
};

const observe = (cell, page) =>
  observeWalkCell({ page, cell, repoRoot: "/anywhere", readImpl: READ, now: NOW });

describe("the walk plan is judged before the browser opens", () => {
  it("accepts the committed S9d plan and reads its ten cells in walk order", () => {
    expect(validateWalkPlan(S9D_WALK)).toEqual([]);
    expect(walkCellsOf(S9D_WALK).map((c) => c.cell)).toEqual([
      "S9d-C1__schedule-card__chat_thread__pending",
      "S9d-C1__schedule-card__chat_thread__pending__dark",
      "S9d-C2__schedule-card__chat_thread__decided",
      "S9d-C2__schedule-card__chat_thread__decided__dark",
      "S9d-C3__schedule-card__run_card__decided",
      "S9d-C3__schedule-card__run_card__decided__dark",
      "S9d-C6__schedule-card__chat_thread__decided__after-fire",
      "S9d-C6__schedule-card__chat_thread__decided__after-fire__dark",
      "S9d-C5__schedule-card__chat_thread__pending__expired",
      "S9d-C5__schedule-card__chat_thread__pending__expired__dark",
    ]);
    // C4 has no step: it needs a lane that may hold a model-provider credential,
    // and a walk that cannot reach a cell must not carry one it would answer
    // with the wrong screen.
    expect(walkCellsOf(S9D_WALK).some((c) => c.cell.includes("C4"))).toBe(false);
  });

  it("drives to the card-less stage and declares NO cell on it", () => {
    // A KNOWN GAP, pinned so it stays visible rather than settling in quietly:
    // the maintainer's proof set is three stages x two hosts, and this plan
    // produces the four card cells of it plus C5. C7 (the run's own scheduling
    // step) and C8 (the run detail after the fire) are the two stages this index
    // cannot hold: every record here
    // asserts `[data-lifecycle-card-host]`, and neither screen draws a card —
    // one is the shipped trigger screen, the other lists the schedule as a rail
    // ROW. Both are photographed as PAGE CONTROLS instead
    // (`evidence/2788-s9d-rework/drivers/page-control.mjs`): measured through the
    // same reader, filed with their hashes, and given no record.
    const cardless = S9D_WALK.steps.filter((s) => s.id === "setup-scheduling-step");
    expect(cardless).toHaveLength(1);
    for (const step of cardless) {
      expect(step.cells).toEqual([]);
      expect(step.why).toContain("NO CELL");
    }
  });

  it("NEVER fires the schedule itself", () => {
    // THE FIRE IS THE SCHEDULER'S. A walk step that pressed `Run now` would make
    // the C6/C8 stage a picture of a button press rather than of a schedule that
    // came due, and the whole point of the "ran" stage is that the one-off went
    // off on its own at the time the person stated. So the plan carries no step
    // that releases the trigger, and the lane waits for `released_at` instead.
    const actions = S9D_WALK.steps.flatMap((s) => s.actions ?? []);
    const selectors = actions.map((a) => a.selector ?? "").join(" ");
    expect(selectors).not.toContain("release-trigger-now");
    expect(selectors).not.toContain("confirm-destructive");
    expect(S9D_WALK.steps.some((s) => s.id === "fire-the-schedule")).toBe(false);

    // AND IT WAITS FOR THE RELEASE RATHER THAN FOR THE SETTLED CARD. Absence of
    // a release control is only half the property: a settled card exists the
    // MOMENT Confirm is pressed, so an `after-fire` step that waits only on
    // `state="settled"` would let a continuous run photograph the "ran" stage
    // before the schedule was ever due — a picture of a card that had not yet
    // been released, filed as the card after it fired.
    for (const id of ["after-fire", "after-fire-dark"]) {
      const step = S9D_WALK.steps.find((s) => s.id === id);
      const waits = (step.actions ?? [])
        .filter((a) => a.action === "waitForSelector")
        .map((a) => a.selector);
      expect(waits).toContain('[data-conformance-id="schedule-released"]');
    }
  });

  it("REFUSES an action outside the closed vocabulary", () => {
    const plan = structuredClone(S9D_WALK);
    plan.steps[1].actions.push({ action: "evaluate", script: "document.body.innerHTML = ''" });
    const violations = validateWalkPlan(plan);
    expect(violations.join("\n")).toContain('"evaluate" is not one of');
    // Named for what it protects: a plan that can write the DOM can arrange what
    // the recorder is about to measure.
    expect(Object.keys(WALK_ACTIONS)).not.toContain("evaluate");
  });

  it("REFUSES a cell whose name contradicts its own declaration", () => {
    const plan = structuredClone(S9D_WALK);
    const runCell = plan.steps.find((s) => s.id === "run-page").cells[0];
    runCell.declaredHost = "chat_thread";
    expect(validateWalkPlan(plan).join("\n")).toContain(
      'the name says host "run_card" and the cell declares "chat_thread"',
    );
  });

  it("REFUSES two cells writing one image, and a screenshot outside evidence/", () => {
    const plan = structuredClone(S9D_WALK);
    const withCells = plan.steps.filter((s) => (s.cells ?? []).length > 0);
    withCells[1].cells[0].screenshot = withCells[0].cells[0].screenshot;
    withCells[2].cells[0].screenshot = "/etc/passwd.png";
    const violations = validateWalkPlan(plan).join("\n");
    expect(violations).toContain("one image cannot be the evidence for two cells");
    expect(violations).toContain("repo-relative path inside the tree");
  });

  it("REFUSES a plan that both retires and produces a cell", () => {
    const plan = structuredClone(S9D_WALK);
    plan.retires.push("S9d-C1__schedule-card__chat_thread__pending");
    expect(validateWalkPlan(plan).join("\n")).toContain("both retires and produces");
  });

  it("names the ten round-1 records the rework replaces, and no others", () => {
    expect(S9D_WALK.retires).toHaveLength(10);
    expect(S9D_WALK.retires.filter((c) => c.includes("standin"))).toHaveLength(2);
  });
});

describe("the walk cell is OBSERVED, and refused if it did not come out", () => {
  it("counts every anchor the claim owes and hands back a record both halves accept", async () => {
    const required = captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending");
    const page = pageAnswering(required, { url: "http://localhost:3000/chat/org/agent/t-1" });
    const record = await observe(CHAT_PENDING, page);

    expect(record.recordedBy).toBe(RECORDER_ID);
    expect(record.sha256).toBe(HASH);
    expect(record.declaredKind).toBe("trigger_schedule_proposal");
    expect(record.declaredState).toBe("pending");
    // The decision floor a pending schedule card owes, counted INSIDE the card
    // root rather than anywhere on the screen.
    expect(record.assertions).toContainEqual(
      expect.objectContaining({
        selector: '[data-action="confirm-schedule-proposal"]',
        scope: "root",
        count: 1,
        visible: 1,
      }),
    );
    // And the CANONICAL half — the one the CI gate runs — takes the same record.
    expect(
      validateCanonicalRecord(record, {
        repoRoot: "/anywhere",
        fileExists: () => true,
        hashFile: () => HASH,
      }),
    ).toEqual([]);
  });

  it("records HOW it was framed, and tells the shutter", async () => {
    const required = captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending");
    const page = pageAnswering(required, { url: "/chat/org/agent/t-1" });
    const record = await observe(CHAT_PENDING, page);
    expect(record.framing).toBe("window");
    expect(CAPTURE_FRAMINGS).toContain(record.framing);
    // The maintainer's first rejection of round 1 was the framing, so it is a
    // fact the record carries rather than one the reader has to infer.
    expect(page.log).toContain("screenshot:window");
  });

  it("REFUSES to hand back a record whose card offered no decision", async () => {
    const required = captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending");
    const page = pageAnswering(required, {
      url: "/chat/org/agent/t-1",
      overrides: {
        '[data-lifecycle-card="trigger_schedule_proposal"]>>[data-action="confirm-schedule-proposal"]': 0,
      },
    });
    await expect(observe(CHAT_PENDING, page)).rejects.toThrow(
      /the index would refuse[\s\S]*confirm-schedule-proposal/,
    );
  });

  it("REFUSES a cell photographed on the wrong URL class", async () => {
    const required = captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending");
    const page = pageAnswering(required, { url: "http://localhost:3000/agents/org/agent/run-1" });
    await expect(observe(CHAT_PENDING, page)).rejects.toThrow(/needs a chat URL/);
  });
});

describe("the kind is measured wherever it is drawn — the run-page cell", () => {
  it("asks the run page for the card's own anchors, not the host's alone", async () => {
    const required = captureRequirementsFor("run_card", "trigger_schedule_proposal", "decided");
    const page = pageAnswering(required, {
      url: "http://localhost:3000/agents/cinatra-ai/planner-agent/5def4d62-70a6-497f-baf9-838b6185cfc0",
    });
    const record = await observe(RUN_DECIDED, page);

    const asserted = record.assertions.map((a) => `${a.scope}::${a.selector}`);
    // The card root, on the run page.
    expect(asserted).toContain('frame::[data-lifecycle-card="trigger_schedule_proposal"]');
    // The settled card says what was decided, inside its own root...
    expect(asserted).toContain("root::[data-lifecycle-card-state]");
    // ...and offers no decision any more, MEASURED absent rather than omitted.
    expect(record.assertions).toContainEqual(
      expect.objectContaining({
        selector: '[data-action="confirm-schedule-proposal"]',
        scope: "root",
        expect: "absent",
        count: 0,
      }),
    );
    // The regression this closes: while the observer derived the kind's anchors
    // for chat_thread ALONE, this record carried none of the three above, and
    // the canonical half — which derives them on every host — refused it. So the
    // run-page cell could not be recorded at all.
    expect(
      validateCanonicalRecord(record, {
        repoRoot: "/anywhere",
        fileExists: () => true,
        hashFile: () => HASH,
      }),
    ).toEqual([]);
  });
});

describe("a walk MERGES into the index it did not write", () => {
  const index = {
    schemaVersion: 1,
    recorder: RECORDER_ID,
    records: [
      { cell: "keep-1__chat_thread__pending" },
      { cell: "A1__schedule-card__chat_thread__pending" },
      { cell: "keep-2__run_card__decided" },
      { cell: "E1__schedule-card__chat_thread__pending__expired-face__standin" },
    ],
  };

  it("retires what it replaces, appends what it wrote, and moves nothing else", () => {
    const merged = mergeWalkRecords({
      index,
      records: [{ cell: "S9d-C1__schedule-card__chat_thread__pending" }],
      retires: [
        "A1__schedule-card__chat_thread__pending",
        "E1__schedule-card__chat_thread__pending__expired-face__standin",
      ],
    });
    expect(merged.records.map((r) => r.cell)).toEqual([
      "keep-1__chat_thread__pending",
      "keep-2__run_card__decided",
      "S9d-C1__schedule-card__chat_thread__pending",
    ]);
    // The index this walk read is not the index it wrote, and nothing about the
    // records it never touched changed — including their order.
    expect(index.records).toHaveLength(4);
  });

  it("replaces a re-walked cell WHERE IT STOOD rather than at the end", () => {
    const merged = mergeWalkRecords({
      index,
      records: [{ cell: "keep-2__run_card__decided", walked: true }],
    });
    expect(merged.records.map((r) => r.cell)).toEqual(index.records.map((r) => r.cell));
    expect(merged.records[2].walked).toBe(true);
  });
});
