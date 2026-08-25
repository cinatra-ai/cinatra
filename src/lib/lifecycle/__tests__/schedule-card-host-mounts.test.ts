// §VI's card, on all four hosts — the MOUNT inventory (cinatra#2788, epic
// #2784 S9d).
//
// The epic's mount rule: exactly ONE rendered card instance per kind × host at
// runtime; every production callsite enumerated, host-declared, and proven
// mutually exclusive where more than one adapter serves the same host. The
// per-host RENDER is pinned in the card's own suite; this file pins the
// INVENTORY — that the four mounts exist, in the modules the host-ownership
// table names, each under a real host declaration, and that the run page's does
// not draw beside the surface it would duplicate.
//
// It reads source rather than rendering, deliberately: two of the mounts are
// async SERVER components inside route trees with sessions, stores and layout
// chrome, and standing all that up would prove less about the mount than it
// would about the harness. What must not be able to rot silently is the SHAPE —
// a mount that lost its provider, a card mounted from a second module, a
// registry row that quietly went back to the shell — and that is exactly what
// is readable here.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** The card's SOLE owner module — the same one the one-card gate names. */
const OWNER = "packages/agents/src/schedule-proposal-card.tsx";

/**
 * The production mounts, per host, exactly as the epic's host-ownership table
 * records them for §VI after this slice.
 *
 * THE TWO PAGE HOSTS MOVED (cinatra#2788 rework). They used to be the run
 * screen's own body and the review page's GATE REGION. Plan (A) §7.2 step 5
 * rules that out — "the schedule is a **dedicated step in the step rail on the
 * left, above '1 Review'** … The schedule is never drawn as a card among the
 * review cards … so the two can never appear together" — so both are now the
 * ONE rail step component, which declares the host and mounts the card, and the
 * pages pass it a ref and draw no schedule of their own.
 */
const MOUNTS = {
  chat_thread: {
    module: "packages/chat/src/renderable-views/registry.tsx",
    adapter: "registry",
    // The transcript column declares the host once, at its root, and every
    // turn's dispatch happens inside it — so the registry row itself carries no
    // provider and must not be asked for one.
    providerInModule: false,
  },
  site_widget: {
    module: "packages/chat/src/renderable-views/registry.tsx",
    adapter: "registry",
    providerInModule: false,
  },
  run_card: {
    module: "packages/agents/src/schedule-rail-step.tsx",
    adapter: "mount",
    providerInModule: true,
  },
  page_gate_region: {
    module: "packages/agents/src/schedule-rail-step.tsx",
    adapter: "mount",
    providerInModule: true,
  },
} as const;

/**
 * The two PAGES that place the rail step. Neither may mount the card itself.
 *
 * THE REVIEW PAGE PLACES IT ITSELF (cinatra#2788 rework). The step is the two
 * COLUMNS of the run surface, not a row inside the rail — plan (A) §7.2 step 5,
 * "it opens to the right of the steps, never directly under a step" — so it is
 * placed where both columns are composed. On the review page that is the route
 * component, which hands it the rail on one side and the gate region on the
 * other; the rail component itself no longer places anything.
 */
const RAIL_PLACEMENTS = {
  run_card: "packages/agents/src/instance-screens.tsx",
  page_gate_region:
    "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
} as const;

const REVIEW_PAGE =
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx";

describe("the four mounts exist and are host-declared", () => {
  it("the transcript hosts are served by the ONE registry row — not by a second table", () => {
    const registry = read(MOUNTS.chat_thread.module);
    expect(registry).toContain(
      'import { ScheduleProposalCard } from "@cinatra-ai/agents/schedule-proposal-card"',
    );
    expect(registry).toMatch(/trigger_schedule_proposal:\s*ScheduleProposalCard/);
    // THE S1 SHELL IS RETIRED FOR THIS KIND — the whole point of the swap.
    expect(registry).not.toMatch(/trigger_schedule_proposal:\s*LifecycleCard/);
    // AND THE OTHER KIND'S SWAP SURVIVES THIS ONE. This line read
    // `verification_summary: LifecycleCard` while §VII was still owed; S9e
    // (cinatra#2789) drew that card, so the assertion is re-aimed rather than
    // dropped. Its job never was to record which kinds are undrawn — it is that
    // THIS slice swaps ONE row and leaves its neighbour's alone, which a
    // registry-wide edit would break silently.
    expect(registry).toMatch(/verification_summary:\s*VerificationSummaryCard/);
    expect(registry).not.toMatch(/verification_summary:\s*LifecycleCard/);
    // ONE row, not two: `chat_thread` and `site_widget` are the same dispatch.
    expect(registry.match(/trigger_schedule_proposal:/g)).toHaveLength(1);
  });

  it("the rail step mounts the card ONCE and declares BOTH page hosts itself", () => {
    const source = read(MOUNTS.run_card.module);
    expect(source).toMatch(/<\s*ScheduleProposalCard\b/);
    // TWO callsites, and exactly two: one per named host, inside the branch that
    // declares that host. They are mutually exclusive by construction — a
    // ternary on `host` — so one rendered instance per host still holds.
    expect(source.match(/<\s*ScheduleProposalCard\b/g)).toHaveLength(2);
    // The host is the CALLER's, and it is declared BY NAME here — a literal, so
    // the one-card gate's R3 check and the host-parity ratchet's composition
    // scan can both see it. One component, two named hosts, no page of its own.
    expect(source).toContain('<LifecycleCardSurfaceProvider host="run_card">');
    expect(source).toContain('<LifecycleCardSurfaceProvider host="page_gate_region">');
    expect(source).toMatch(/host:\s*"run_card"\s*\|\s*"page_gate_region"/);
  });

  // PLAN §7.2 step 5, read off the two pages: the schedule is a STEP, and the review
  // page's gate region holds the review card alone.
  it("both pages place the rail STEP and neither mounts the card — the gate region is the review card's alone", () => {
    for (const [host, rel] of Object.entries(RAIL_PLACEMENTS)) {
      const source = read(rel);
      expect(source, `${host}: ${rel} places the rail step`).toMatch(
        /<\s*ScheduleRailStep\b/,
      );
      expect(
        source.match(/<\s*ScheduleRailStep\b/g),
        `${host}: ${rel} places it ONCE`,
      ).toHaveLength(1);
      expect(source).toContain(`host="${host}"`);
      // THE TWO COLUMNS TRAVEL WITH IT. A placement that passed no rail and no
      // detail would be drawing the step somewhere it does not own the frame —
      // which is how the configuration ended up under the row it opens from.
      expect(source, `${host}: ${rel} hands the step both columns`).toMatch(
        /rail=\{[A-Za-z]+\}/,
      );
      expect(source, `${host}: ${rel} hands the step both columns`).toMatch(
        /detail=\{[A-Za-z]+\}/,
      );
      // The page never mounts the card itself any more.
      expect(source, `${host}: ${rel} mounts no card of its own`).not.toMatch(
        /<\s*ScheduleProposalCard\b/,
      );
    }
    // THE GATE REGION. The review page's `page_gate_region` provider now wraps
    // the review card and nothing else — the composition the plan requires. The
    // schedule step opens IN that region, in place of the card, which is what
    // makes "the two can never appear together" structural.
    const reviewPage = read(REVIEW_PAGE);
    expect(reviewPage).not.toMatch(/<\s*ScheduleProposalCard\b/);
    expect(reviewPage).toMatch(/<LifecycleCardSurfaceProvider host="page_gate_region">/);
    const region = reviewPage.slice(
      reviewPage.indexOf('<LifecycleCardSurfaceProvider host="page_gate_region">'),
      reviewPage.indexOf("</LifecycleCardSurfaceProvider>"),
    );
    expect(region).toContain("<ReviewGateCard");
    expect(region).not.toContain("Schedule");
  });

  it("both pages mint a SERVER-side ref and draw no step when they cannot", () => {
    const screens = read(RAIL_PLACEMENTS.run_card);
    const reviewPage = read(REVIEW_PAGE);
    for (const source of [screens, reviewPage]) {
      expect(source).toContain("encodeScheduleRunRef");
    }
    // The client is never handed a run id to name; the ref is the whole binding.
    expect(screens).toMatch(/cardRef=\{scheduleRailRef\}/);
    expect(reviewPage).toMatch(/cardRef=\{scheduleCardRef\}/);
    // A run with no schedule row mints no ref, and neither page draws a step:
    // each falls back to the two columns it composed before the step existed.
    expect(screens).toMatch(/run && trigger \? encodeScheduleRunRef/);
    expect(reviewPage).toMatch(/readRunTriggerByRunId\(runId\)/);
    expect(reviewPage).toMatch(/if \(scheduleCardRef\) \{/);
    expect(screens).toMatch(/if \(scheduleRailRef\) \{/);
  });

  it("the card is defined in exactly ONE module in the whole first-party tree", () => {
    const owner = read(OWNER);
    expect(owner).toMatch(/export function ScheduleProposalCard\b/);
    // Every other module that names it does so as an IMPORT, never a definition.
    for (const rel of [
      ...new Set([...Object.values(MOUNTS).map((m) => m.module), ...Object.values(RAIL_PLACEMENTS), REVIEW_PAGE]),
    ]) {
      const source = read(rel);
      expect(source).not.toMatch(
        /\b(?:function|const|class)\s+(?:[A-Z][A-Za-z0-9]*)?ScheduleProposalCard\b/,
      );
    }
  });
});

describe("the owner's contract, read off its own source", () => {
  const owner = read(OWNER);

  it("the root carries the identity, the host and the state a capture needs", () => {
    expect(owner).toContain('data-lifecycle-card="trigger_schedule_proposal"');
    expect(owner).toContain("data-lifecycle-card-host");
    expect(owner).toContain("data-lifecycle-card-state");
    expect(owner).toContain('data-conformance-id="schedule-proposal-card"');
  });

  it("every ratified §VI anchor is emitted", () => {
    for (const anchor of [
      "schedule-option-rows",
      "schedule-proposal-floor",
    ]) {
      expect(owner, anchor).toContain(`data-conformance-id="${anchor}"`);
    }
    for (const action of [
      "save-schedule-changes",
      "cancel-trigger-schedule",
      "release-trigger-now",
    ]) {
      expect(owner, action).toContain(`data-action="${action}"`);
    }
    // PLAN §7.2, as an absence in the source itself: the retired control cannot
    // come back through a stray callsite.
    expect(owner).not.toContain('data-action="adjust-schedule-proposal"');
  });

  it("it consumes its AUTHORIZED body through the one resolve seam, and reads every phase", () => {
    expect(owner).toContain("useLifecycleCardResolve");
    expect(owner).toContain("resolved?.body");
    for (const phase of ['"proposal"', '"expired"']) {
      expect(owner).toContain(`body.phase === ${phase}`);
    }
    // THE LIST IS THE GATE'S, FIELD FOR FIELD. `body.fields` in
    // `scripts/audit/chat-hitl-one-card-gate.mjs` is the AUTHORIZED body for
    // this kind, read off `triggerScheduleProposalViewBodySchema` rather than
    // paraphrased, and this pin exists to say the card consumes it. Two lists
    // that mean the same thing are two lists that drift, and this one had:
    // it still named `.gatedSteps` and `.runId` after the chrome removal took
    // away the drawings that read them — the held-steps tree and the "Open the
    // run" link. The gate dropped both (plan (A) §7.2 removes the drawings);
    // the card draws neither; so a pin demanding them was demanding the chrome
    // back through a test. `.restrictedReason` joins for the same reason in
    // reverse — the gate authorizes it and the card reads it.
    //
    // `.scheduleCopy` AND `.superseded` LEAVE, and `.triggerType` COMES BACK.
    // The S9d capture round graded the supersede warning above the settled rows
    // a conformance FAIL against §7.2 — "the same card, with the same option
    // rows, shows the schedule as it stands — no label, no summary box" — so
    // the renderer stopped drawing it, and the two fields it read went with it.
    // `.triggerType` returns because §7.2's other sentence gave it a reader
    // again: "once a one-off has fired it cannot be changed", and the card
    // tells a fired one-off from a released or still-arming schedule by reading
    // `triggerType` beside `canSave`.
    //
    // THE CARD IS NOT CHANGED TO SATISFY THIS. The direction of the fix is the
    // one the seam has always had: the gate says what the server sends, the
    // card draws it, and this file records that the card reads what it draws.
    for (const field of [
      ".state",
      ".phase",
      ".schedule",
      ".durationCopy",
      ".canConfirm",
      ".restrictedReason",
      ".triggerType",
      ".timezone",
      ".released",
      ".arming",
      ".canSave",
      ".canCancel",
      ".canRelease",
    ]) {
      expect(owner, field).toContain(field);
    }
  });

  it("no raw cron field can be drawn or posted from the card", () => {
    expect(owner).not.toMatch(/cronExpression/);
  });
});
