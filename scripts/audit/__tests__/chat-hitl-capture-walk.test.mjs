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

import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  CAPTURE_INDEX_PATH,
  validateCaptureRecord as validateCanonicalRecord,
} from "../../ci/lib/capture-record-contract.mjs";
import {
  CAPTURE_FRAMINGS,
  CAPTURE_OUTPUT_ROOT,
  HISTORICAL_OUTPUT_ROOT,
  RECORDER_ID,
  WALK_ACTIONS,
  captureRequirementsFor,
  mergeWalkRecords,
  observeWalkCell,
  readWalkPlan,
  rerootWalkPlanOutputs,
  screenshotPathViolation,
  validateWalkPlan,
  walkCellState,
  walkCellsOf,
} from "../lib/chat-hitl-capture-recorder.mjs";
import { WALK_PLAN_PATH, loadWalkPlan } from "../__fixtures__/capture-walk/load-walk-plan.mjs";

// The committed round-5 plan, byte for byte, with its OUTPUT paths on the
// current capture root — see the loader for why that one rewrite happens.
const S9D_WALK = loadWalkPlan();

const PNG = "test-results/capture-fixture/walk.png";
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
    shotOptions: [],
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
      // What the shutter was ASKED for, so a suite can assert the format was
      // stated rather than left to the file name.
      page.shotOptions.push(options);
      // A REAL SHUTTER LEAVES A FILE. The recorder writes to a temp name in the
      // resolved directory and renames it into place, so a stub that writes
      // nothing is not standing in for a shutter at all.
      writeFileSync(abs, BYTES);
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


// A REAL capture root for the observer. `observeCapture` resolves its
// destination before the shutter — the root, the parent directory and any
// existing target — so a suite that drives it needs a real tree to write into.
// The fake page's "shutter" just drops the fixture bytes at the path it is
// handed, which is what a real one does at the point this suite cares about.
// NOTHING IS PRE-CREATED. Not the run directories and not `test-results/`
// itself — the recorder creates what a run needs, and a suite that made them
// first would not notice when it stopped. That is exactly the regression this
// harness now covers.
const OBSERVE_ROOT = mkdtempSync(join(tmpdir(), "observe-root-"));
afterAll(() => rmSync(OBSERVE_ROOT, { recursive: true, force: true }));

// NO INJECTED READER: the stub shutter writes the fixture bytes, and the
// recorder hashes them back off real disk — which is what a real walk does.
const observe = (cell, page) => observeWalkCell({ page, cell, repoRoot: OBSERVE_ROOT, now: NOW });

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
    // (`https://github.com/cinatra-ai/cinatra/blob/35e369ed68a6446b0125cfecaee6aa993742a961/evidence/2788-s9d-rework/drivers/page-control.mjs`): measured through the
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

    // AND `after-fire` IS GATED ON MORE THAN "settled". Absence of a release
    // control is only half the property: a settled card exists the MOMENT
    // Confirm is pressed, so an `after-fire` step gated only on
    // `state="settled"` would let a continuous run photograph the "ran" stage
    // before the schedule was ever due — a picture of a card that had not yet
    // been released, filed as the card after it fired.
    //
    // THIS ASSERTION CHANGED WITH THE CARD, and what it can honestly claim
    // changed with it. The step used to wait on `schedule-released`, the line
    // that explained the withheld controls. A FIRED one-off no longer draws it:
    // §7.2 — "once a one-off has fired it cannot be changed" — so the card
    // withdraws Save changes, Cancel schedule and Run now TOGETHER WITH the
    // status line that used to explain them (`body.released && !fired` in
    // packages/agents/src/schedule-proposal-card.tsx). There is no longer ANY
    // rendered anchor that means "fired" and nothing else: the read-only rows
    // the fired card draws also stand on an arming card and on a past-due card
    // whose gate has not opened.
    //
    // So this test no longer pretends a selector proves firing, and it is
    // explicit about the limit of what a PLAN-SHAPE test can enforce at all.
    //
    // WHAT IT ENFORCES:
    //   (1) the step is gated on something BEYOND the settled state, so
    //       "settled alone" can never be what releases the shutter; and
    //   (2) that something is EXACTLY one of an ALLOW-LIST of selectors that
    //       belong to the fired reading — an equality check, not a substring
    //       one. "Some second selector" would be satisfied by any always-present
    //       anchor, and a substring check would be satisfied by a comma-union
    //       like `<settled>, <fired>`, which resolves on the settled branch
    //       alone. Both bypasses are mutation-checked; and
    //   (3) the plan's own note carries the DATABASE gate the lane must apply
    //       before this step is driven — `agent_run_triggers.released_at`.
    //
    // WHAT IT CANNOT ENFORCE, said plainly rather than implied: the timing
    // itself. Every selector on the allow-list is also true of an arming card
    // and of a past-due card whose gate has not opened, because the card no
    // longer draws anything that means "fired" and nothing else. Only
    // `released_at` separates those, a plan cannot poll a database, and this
    // test judges the plan. So the mechanical guard here is "not settled-alone,
    // and from the fired vocabulary"; the timing guard is the lane's, and (3)
    // is what keeps it written down where the next operator will read it.
    // If the card regains a fired-specific rendered anchor, tighten (2) onto it
    // and this comment can go.
    // The EXACT selectors that count as the fired reading. Equality, not
    // substring: a comma-union like `<settled>, <fired>` resolves on the settled
    // branch alone, and a substring check would wave it through.
    const FIRED_READING_SELECTORS = [
      '[data-lifecycle-card="trigger_schedule_proposal"] [data-field="schedule-run-at"][disabled]',
      '[data-lifecycle-card="trigger_schedule_proposal"] [data-field="schedule-timezone"][disabled]',
      '[data-field="schedule-run-at"][disabled]',
      '[data-field="schedule-timezone"][disabled]',
    ];
    const SETTLED_ONLY =
      '[data-lifecycle-card="trigger_schedule_proposal"][data-lifecycle-card-state="settled"]';
    for (const id of ["after-fire", "after-fire-dark"]) {
      const step = S9D_WALK.steps.find((s) => s.id === id);
      const waits = (step.actions ?? [])
        .filter((a) => a.action === "waitForSelector")
        .map((a) => a.selector);
      expect(waits).toContain(SETTLED_ONLY);
      const beyondSettled = waits.filter((w) => w !== SETTLED_ONLY);
      expect(beyondSettled.length).toBeGreaterThan(0);
      expect(
        beyondSettled.some((w) => FIRED_READING_SELECTORS.includes(w.trim())),
      ).toBe(true);
    }
    const note = (S9D_WALK.note ?? []).join(" ");
    expect(note).toContain("agent_run_triggers`.`released_at".replace(/`/g, ""));
    expect(note).toMatch(/the LANE polls/);
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

  it("REFUSES two cells writing one image, and a screenshot outside the capture output root", () => {
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
        virtualFilesystem: true,
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
        virtualFilesystem: true,
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

describe("the preflight and the walk derive ONE state", () => {
  // The audit card resolves `advisory` and nothing else, so a cell of that kind
  // named `__advisory` is the case where a preflight that reads the name and a
  // walk that does not come apart: the plan was admitted and the record was
  // then stamped `pending`, which the per-kind vocabulary refuses.
  const ADVISORY_CELL = {
    cell: "G7__audit-card__run_card__advisory",
    declaredHost: "run_card",
    kind: "verification_summary",
    framing: "window",
    build: "development",
    screenshot: PNG,
  };

  it("derives the state from the NAME when the cell declares none", () => {
    expect(walkCellState(ADVISORY_CELL)).toBe("advisory");
    expect(walkCellState({ ...ADVISORY_CELL, state: "advisory" })).toBe("advisory");
    // A cell claiming nothing either way keeps observeCapture's own default.
    expect(walkCellState({ cell: "Z__audit-card__run_card__zoomed" })).toBeUndefined();
  });

  it("STAMPS that state on the record, so the walk produces what the preflight admitted", async () => {
    const requirements = captureRequirementsFor("run_card", "verification_summary", "advisory");
    const page = pageAnswering(requirements, {
      url: "http://localhost:3000/agents/v/p/fd104b43-19fd-4404-9d74-0896bba371f5",
    });
    // `observeWalkCell` THROWS on a record the index would refuse, so reaching
    // the assertions below is itself the audit tier accepting it.
    const record = await observe(ADVISORY_CELL, page);
    expect(record.declaredState).toBe("advisory");
    expect(validateCanonicalRecord(record, { virtualFilesystem: true,
        fileExists: () => true, hashFile: () => HASH })).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// THE DOCUMENTED COMMAND HAS TO RUN. `scripts/ci/chat-hitl-capture-index.json`
// tells a reader to drive this exact fixture with
// `chat-hitl-capture-driver.mjs --walk <it>`. The driver used to read the file
// raw while only the suites re-rooted its outputs, so that command died in
// preflight with ten output-root violations and the suites graded a plan the
// real CLI never saw. These cases load through the DRIVER'S OWN call.
// ---------------------------------------------------------------------------
describe("the committed fixture is executable exactly as documented", () => {
  it("the capture index documents this fixture path, and no path that is gone", () => {
    const prose = JSON.parse(readFileSync(CAPTURE_INDEX_PATH, "utf8")).$comment.join("\n");
    const relative = WALK_PLAN_PATH.slice(WALK_PLAN_PATH.indexOf("scripts/"));
    expect(prose).toContain(`--walk ${relative}`);
    // The path it USED to document no longer exists in any tree this repo has.
    expect(prose).not.toContain("evidence/2788-s9d-rework/capture-walk.json");
  });

  it("the driver's own loader preflights the fixture with ZERO violations", () => {
    // readWalkPlan is what `--walk` calls; nothing here re-implements it.
    const plan = readWalkPlan(WALK_PLAN_PATH);
    expect(validateWalkPlan(plan)).toEqual([]);
  });

  it("loads TEN cells, every output re-rooted onto the live capture root", () => {
    const shots = walkCellsOf(readWalkPlan(WALK_PLAN_PATH)).map((c) => c.screenshot);
    expect(shots).toHaveLength(10);
    for (const shot of shots) {
      expect(shot.startsWith(CAPTURE_OUTPUT_ROOT), shot).toBe(true);
      expect(screenshotPathViolation(shot)).toBe(null);
    }
    expect(shots).toEqual([
      "test-results/2788-s9d-rework/captures/C1__chat-first-shown__light.png",
      "test-results/2788-s9d-rework/captures/C1__chat-first-shown__dark.png",
      "test-results/2788-s9d-rework/captures/C2__chat-configured__light.png",
      "test-results/2788-s9d-rework/captures/C2__chat-configured__dark.png",
      "test-results/2788-s9d-rework/captures/C3__run-page-configured__light.png",
      "test-results/2788-s9d-rework/captures/C3__run-page-configured__dark.png",
      "test-results/2788-s9d-rework/captures/C6__chat-ran__light.png",
      "test-results/2788-s9d-rework/captures/C6__chat-ran__dark.png",
      "test-results/2788-s9d-rework/captures/C5__chat-expired__light.png",
      "test-results/2788-s9d-rework/captures/C5__chat-expired__dark.png",
    ]);
  });

  it("the FIXTURE BYTES are untouched — only the loaded copy is re-rooted", () => {
    const raw = readFileSync(WALK_PLAN_PATH, "utf8");
    expect(raw).toContain("evidence/2788-s9d-rework/captures/C1__chat-first-shown__light.png");
    expect(raw).not.toContain("test-results/");
    // ...and the loader hands back a COPY, so a mutating suite cannot poison it.
    const a = readWalkPlan(WALK_PLAN_PATH);
    a.steps[0].cells = [];
    expect(walkCellsOf(readWalkPlan(WALK_PLAN_PATH))).toHaveLength(10);
  });

  it("re-rooting touches ONLY the output paths — every graded field is as committed", () => {
    const committed = JSON.parse(readFileSync(WALK_PLAN_PATH, "utf8"));
    const loaded = readWalkPlan(WALK_PLAN_PATH);
    const strip = (plan) =>
      JSON.stringify(plan, (key, value) => (key === "screenshot" ? undefined : value));
    expect(strip(loaded)).toBe(strip(committed));
    // ...and each output differs by its ROOT alone.
    const outs = (plan) => walkCellsOf(plan).map((c) => c.screenshot);
    expect(outs(loaded)).toEqual(
      outs(committed).map((s) => CAPTURE_OUTPUT_ROOT + s.slice(HISTORICAL_OUTPUT_ROOT.length)),
    );
  });

  it("a plan ALREADY on the live root is passed through unchanged", () => {
    // The re-rooting is a rescue for committed plans, not a transform every
    // plan is subject to: anything authored since the cleanup is untouched.
    const modern = {
      slice: "modern",
      steps: [{ id: "s", cells: [{ ...walkCellsOf(readWalkPlan(WALK_PLAN_PATH))[0] }] }],
    };
    expect(rerootWalkPlanOutputs(modern)).toEqual(modern);
  });
});


// ---------------------------------------------------------------------------
// THE SHUTTER IS A WRITE. These drive the real observer against real temp trees
// and assert it refuses BEFORE anything is written — the file the redirect
// aimed at is still untouched afterwards, which is what "refused" has to mean.
// ---------------------------------------------------------------------------
describe("the observer refuses a redirected write before the shutter", () => {
  const shot = (root, rel) =>
    observeWalkCell({
      page: pageAnswering(captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending"), {
        url: "http://localhost:3000/chat/org/agent/t-1",
      }),
      cell: { ...CHAT_PENDING, screenshot: rel },
      repoRoot: root,
      now: NOW,
    });

  it("a SYMLINKED CAPTURE ROOT is refused, and nothing is written through it", async () => {
    const root = mkdtempSync(join(tmpdir(), "shutter-root-"));
    try {
      writeFileSync(join(root, "victim.txt"), "OLD");
      symlinkSync(".", join(root, "test-results"), "dir");
      await expect(shot(root, "test-results/victim.txt")).rejects.toThrow(/capture root must be a real directory/);
      expect(readFileSync(join(root, "victim.txt"), "utf8")).toBe("OLD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a SYMLINKED INTERMEDIATE DIRECTORY is refused, and its target is untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "shutter-parent-"));
    try {
      mkdirSync(join(root, "test-results"), { recursive: true });
      mkdirSync(join(root, "outside"), { recursive: true });
      writeFileSync(join(root, "outside", "victim.png"), "OLD");
      symlinkSync(join(root, "outside"), join(root, "test-results", "sneaky"), "dir");
      await expect(shot(root, "test-results/sneaky/victim.png")).rejects.toThrow(/is a symlink/);
      expect(readFileSync(join(root, "outside", "victim.png"), "utf8")).toBe("OLD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an EXISTING SYMLINKED TARGET is refused, and the file it points at is untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "shutter-target-"));
    try {
      mkdirSync(join(root, "test-results", "c"), { recursive: true });
      mkdirSync(join(root, "outside"), { recursive: true });
      writeFileSync(join(root, "outside", "victim.png"), "OLD");
      symlinkSync(join(root, "outside", "victim.png"), join(root, "test-results", "c", "x.png"));
      await expect(shot(root, "test-results/c/x.png")).rejects.toThrow(/already exists as a symlink/);
      expect(readFileSync(join(root, "outside", "victim.png"), "utf8")).toBe("OLD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the honest destination IS written, and atomically — no temp file left behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "shutter-ok-"));
    try {
      mkdirSync(join(root, "test-results", "c"), { recursive: true });
      const record = await shot(root, "test-results/c/ok.png");
      expect(record.screenshot).toBe("test-results/c/ok.png");
      expect(readFileSync(join(root, "test-results", "c", "ok.png"))).toEqual(BYTES);
      const left = readdirSync(join(root, "test-results", "c"));
      expect(left).toEqual(["ok.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// THE MID-CAPTURE SWAP. The destination is resolved, then real DOM work runs,
// then the shutter fires and the file is renamed. An ancestor swapped for a
// symlink in that window redirects both. Node has no `openat`, so the gap
// cannot be closed — it is re-checked immediately before each step and fails
// closed. The stub shutter below performs the swap at exactly that moment.
// ---------------------------------------------------------------------------
describe("a parent swapped DURING the capture fails closed", () => {
  const cellFor = (rel) => ({ ...CHAT_PENDING, screenshot: rel });
  const req = captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending");

  it("REFUSES the rename when the shutter's own directory is swapped mid-capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "swap-mid-"));
    try {
      mkdirSync(join(root, "outside"), { recursive: true });
      writeFileSync(join(root, "outside", "victim.png"), "OLD");
      const page = pageAnswering(req, { url: "http://localhost:3000/chat/org/agent/t-1" });
      // THE SWAP HAPPENS INSIDE THE SHUTTER — after the pre-shutter re-check
      // and before the pre-rename one, which is the window being tested.
      page.screenshot = async (abs) => {
        writeFileSync(abs, BYTES);
        const parent = join(root, "test-results", "run");
        rmSync(parent, { recursive: true, force: true });
        symlinkSync(join(root, "outside"), parent, "dir");
      };
      await expect(
        observeWalkCell({ page, cell: cellFor("test-results/run/x.png"), repoRoot: root, now: NOW }),
      ).rejects.toThrow(/mid-capture/);
      // The directory the swap pointed at is untouched: nothing was renamed in.
      expect(readdirSync(join(root, "outside"))).toEqual(["victim.png"]);
      expect(readFileSync(join(root, "outside", "victim.png"), "utf8")).toBe("OLD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the honest run through the same path still lands", async () => {
    const root = mkdtempSync(join(tmpdir(), "swap-none-"));
    try {
      const page = pageAnswering(req, { url: "http://localhost:3000/chat/org/agent/t-1" });
      const record = await observeWalkCell({
        page,
        cell: cellFor("test-results/run/x.png"),
        repoRoot: root,
        now: NOW,
      });
      expect(record.screenshot).toBe("test-results/run/x.png");
      expect(readdirSync(join(root, "test-results", "run"))).toEqual(["x.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// THE SHUTTER IS AN IMAGE WRITER. It infers its format from the file name, so
// the exclusive random temp file must still LOOK like an image — an
// extensionless temp path made the real producer fail outright with
// `unsupported mime type "null"`. Belt and braces: the name keeps the
// extension AND the format is stated explicitly.
// ---------------------------------------------------------------------------
describe("the temp file is still an image, by name and by declaration", () => {
  it("the shutter is handed a .png temp path and an explicit type", async () => {
    const root = mkdtempSync(join(tmpdir(), "shutter-type-"));
    try {
      const page = pageAnswering(
        captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending"),
        { url: "http://localhost:3000/chat/org/agent/t-1" },
      );
      await observeWalkCell({
        page,
        cell: { ...CHAT_PENDING, screenshot: "test-results/run/shot.png" },
        repoRoot: root,
        now: NOW,
      });
      expect(page.shots).toHaveLength(1);
      const handed = page.shots[0];
      // It is the TEMP name — random, hidden, and still a .png.
      expect(handed.endsWith(".png")).toBe(true);
      expect(basename(handed)).toMatch(/^\.capture-[0-9a-f]{24}\.tmp\.png$/);
      expect(page.shotOptions[0].type).toBe("png");
      // ...and the file that survives is the real name, with nothing beside it.
      expect(readdirSync(join(root, "test-results", "run"))).toEqual(["shot.png"]);
      expect(readFileSync(join(root, "test-results", "run", "shot.png"))).toEqual(BYTES);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
