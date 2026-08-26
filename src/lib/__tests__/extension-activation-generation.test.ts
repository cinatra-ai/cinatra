import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getActivationGeneration,
  bumpActivationGeneration,
  getActivationControlPlaneSnapshot,
  admissionReviewIsAfter,
  nextAdmissionReviewMoment,
  __resetActivationGenerationForTests,
  __resetAdmissionReviewClockForTests,
} from "@/lib/extension-activation-generation";

beforeEach(() => __resetActivationGenerationForTests());

describe("extension activation (control-plane) generation", () => {
  it("starts at 0 with an empty transition history", () => {
    expect(getActivationGeneration()).toBe(0);
    expect(getActivationControlPlaneSnapshot()).toEqual({ generation: 0, lastTransitions: [] });
  });

  it("bumps monotonically and returns the new value", () => {
    expect(bumpActivationGeneration("activate")).toBe(1);
    expect(bumpActivationGeneration("hot-update")).toBe(2);
    expect(bumpActivationGeneration("teardown")).toBe(3);
    expect(getActivationGeneration()).toBe(3);
  });

  it("records each transition with its reason + packageName + a timestamp", () => {
    const before = Date.now();
    bumpActivationGeneration("activate", "@cinatra-ai/foo");
    bumpActivationGeneration("teardown", "@cinatra-ai/foo");
    const after = Date.now();

    const { generation, lastTransitions } = getActivationControlPlaneSnapshot();
    expect(generation).toBe(2);
    expect(lastTransitions).toHaveLength(2);
    expect(lastTransitions[0]).toMatchObject({
      generation: 1,
      reason: "activate",
      packageName: "@cinatra-ai/foo",
    });
    expect(lastTransitions[1]).toMatchObject({
      generation: 2,
      reason: "teardown",
      packageName: "@cinatra-ai/foo",
    });
    for (const t of lastTransitions) {
      expect(t.at).toBeGreaterThanOrEqual(before);
      expect(t.at).toBeLessThanOrEqual(after);
    }
  });

  it("omits packageName when a transition is not package-scoped (boot)", () => {
    bumpActivationGeneration("boot-static");
    bumpActivationGeneration("boot-runtime");
    const { lastTransitions } = getActivationControlPlaneSnapshot();
    expect(lastTransitions.map((t) => t.reason)).toEqual(["boot-static", "boot-runtime"]);
    expect(lastTransitions.every((t) => t.packageName === undefined)).toBe(true);
  });

  it("bounds the transition history ring to the last 100 transitions (generation keeps climbing)", () => {
    for (let i = 0; i < 150; i++) bumpActivationGeneration("activate", `@cinatra-ai/p${i}`);
    const { generation, lastTransitions } = getActivationControlPlaneSnapshot();
    expect(generation).toBe(150);
    expect(lastTransitions).toHaveLength(100);
    // The ring keeps the NEWEST 100 (generations 51..150), oldest first.
    expect(lastTransitions[0].generation).toBe(51);
    expect(lastTransitions[lastTransitions.length - 1].generation).toBe(150);
  });

  it("snapshot is a copy — a caller cannot mutate the internal ring", () => {
    bumpActivationGeneration("activate", "@cinatra-ai/foo");
    const snap = getActivationControlPlaneSnapshot();
    (snap.lastTransitions as unknown as { reason: string }[])[0].reason = "TAMPERED";
    // A fresh snapshot is unaffected.
    expect(getActivationControlPlaneSnapshot().lastTransitions[0].reason).toBe("activate");
  });
});

describe("the admission review moment", () => {
  beforeEach(() => __resetAdmissionReviewClockForTests());

  it("reports the TRUE wall clock and never runs ahead of it", () => {
    // The whole point of splitting instant from sequence: a clock that invented
    // a later time to break a tie would let a stamp outlive a teardown that
    // genuinely followed it, because another process reads the honest clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
      for (let i = 0; i < 5; i += 1) {
        expect(nextAdmissionReviewMoment().at).toBe("2026-05-01T12:00:00.000Z");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders two moments from THIS process even inside one millisecond", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
      const earlier = nextAdmissionReviewMoment();
      const later = nextAdmissionReviewMoment();
      expect(later.at).toBe(earlier.at);
      expect(admissionReviewIsAfter(later, earlier)).toBe(true);
      expect(admissionReviewIsAfter(earlier, later)).toBe(false);
      // And a moment is not after itself.
      expect(admissionReviewIsAfter(earlier, earlier)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REFUSES to order a same-millisecond tie across processes", () => {
    // Two epochs cannot be compared, and the caller revokes on `false`. This is
    // the case the sequence deliberately does NOT paper over.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
      const ours = nextAdmissionReviewMoment();
      const theirs = { at: ours.at, mint: "some-other-process.999" };
      expect(admissionReviewIsAfter(theirs, ours)).toBe(false);
      expect(admissionReviewIsAfter(ours, theirs)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the wall clock decide whenever it can", () => {
    const cutoff = { at: "2026-05-01T12:00:00.000Z", mint: "e.5" };
    expect(admissionReviewIsAfter({ at: "2026-05-01T12:00:00.001Z", mint: "e.1" }, cutoff)).toBe(true);
    expect(admissionReviewIsAfter({ at: "2026-05-01T11:59:59.999Z", mint: "e.9" }, cutoff)).toBe(false);
  });

  it("answers `false` for everything it cannot prove", () => {
    const cutoff = { at: "2026-05-01T12:00:00.000Z", mint: "e.5" };
    expect(admissionReviewIsAfter(undefined, cutoff)).toBe(false);
    expect(admissionReviewIsAfter({}, cutoff)).toBe(false);
    // Same instant, no mint / an unparseable mint / a lower sequence.
    expect(admissionReviewIsAfter({ at: cutoff.at }, cutoff)).toBe(false);
    expect(admissionReviewIsAfter({ at: cutoff.at, mint: "e." }, cutoff)).toBe(false);
    expect(admissionReviewIsAfter({ at: cutoff.at, mint: "nodot" }, cutoff)).toBe(false);
    expect(admissionReviewIsAfter({ at: cutoff.at, mint: "e.notanumber" }, cutoff)).toBe(false);
    expect(admissionReviewIsAfter({ at: cutoff.at, mint: "e.4" }, cutoff)).toBe(false);
    // ...and `true` for the one case it can.
    expect(admissionReviewIsAfter({ at: cutoff.at, mint: "e.6" }, cutoff)).toBe(true);
  });

  it("mints the CANONICAL instant spelling the record normalizer accepts", () => {
    expect(nextAdmissionReviewMoment().at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});
