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
    module: "packages/agents/src/instance-screens.tsx",
    adapter: "mount",
    providerInModule: true,
  },
  page_gate_region: {
    module:
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
    adapter: "mount",
    providerInModule: true,
  },
} as const;

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

  it("each JSX mount sits under a lifecycle host declaration in its own module", () => {
    for (const [host, spec] of Object.entries(MOUNTS)) {
      if (!spec.providerInModule) continue;
      const source = read(spec.module);
      expect(source, `${host}: ${spec.module} mounts the card`).toMatch(
        /<\s*ScheduleProposalCard\b/,
      );
      expect(source, `${host}: ${spec.module} declares the host`).toContain(
        `<LifecycleCardSurfaceProvider host="${host}">`,
      );
      // ONE mount per module — a second JSX callsite is a second instance.
      expect(source.match(/<\s*ScheduleProposalCard\b/g)).toHaveLength(1);
    }
  });

  it("the run page's mount is EXCLUSIVE with the persistent Trigger tab, by the screen's own selector", () => {
    const screens = read(MOUNTS.run_card.module);
    // The card's ref is minted only where the tab does not draw. The selector is
    // the screen's own exported branch, pinned by its own test — read here, not
    // re-derived, so the two cannot drift into drawing the same trigger twice.
    expect(screens).toMatch(
      /const scheduleCardRef\s*=\s*\n?\s*run && !showPersistentTab \? encodeScheduleRunRef/,
    );
    expect(screens).toContain("const showPersistentTab = shouldShowPersistentTab(trigger)");
    // And the card is only drawn when that ref exists.
    expect(screens).toMatch(/\{scheduleCardRef \? \(/);
  });

  it("both page mounts mint a SERVER-side ref and draw nothing when they cannot", () => {
    const screens = read(MOUNTS.run_card.module);
    const reviewPage = read(MOUNTS.page_gate_region.module);
    for (const source of [screens, reviewPage]) {
      expect(source).toContain("encodeScheduleRunRef");
      // The client is never handed a run id to name; the ref is the whole binding.
      expect(source).toMatch(/ref: scheduleCardRef/);
    }
    // A ref that cannot be minted draws no card rather than a second composition.
    expect(reviewPage).toMatch(/\{scheduleCardRef \? \(/);
  });

  it("the card is defined in exactly ONE module in the whole first-party tree", () => {
    const owner = read(OWNER);
    expect(owner).toMatch(/export function ScheduleProposalCard\b/);
    // Every other module that names it does so as an IMPORT, never a definition.
    for (const spec of Object.values(MOUNTS)) {
      const source = read(spec.module);
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
      "scheduled-run-chrome",
    ]) {
      expect(owner, anchor).toContain(`data-conformance-id="${anchor}"`);
    }
    for (const action of ["cancel-trigger-schedule", "release-trigger-now"]) {
      expect(owner, action).toContain(`data-action="${action}"`);
    }
  });

  it("it consumes its AUTHORIZED body through the one resolve seam, and reads every phase", () => {
    expect(owner).toContain("useLifecycleCardResolve");
    expect(owner).toContain("resolved?.body");
    for (const phase of ['"proposal"', '"expired"']) {
      expect(owner).toContain(`body.phase === ${phase}`);
    }
    for (const field of [
      ".schedule",
      ".durationCopy",
      ".canConfirm",
      ".scheduleCopy",
      ".triggerType",
      ".timezone",
      ".gatedSteps",
      ".released",
      ".arming",
      ".canCancel",
      ".canRelease",
      ".runId",
    ]) {
      expect(owner, field).toContain(field);
    }
  });

  it("no raw cron field can be drawn or posted from the card", () => {
    expect(owner).not.toMatch(/cronExpression/);
  });
});
