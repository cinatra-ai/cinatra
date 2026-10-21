/**
 * THE FIRED-ONE-OFF FREEZE, FROM ITS OWN MODULE (cinatra#3189, clause R7).
 *
 * The predicate moved out of `instance-screens.tsx` into a module with no
 * directive, so the review page's SERVER component can ask it of the run's
 * trigger row exactly as the run page does. This pins two things about the new
 * home: the module path answers the same truth table cinatra#2980 pinned (an
 * allow-list: only `recurring` stays changeable after a fire, and a kind nobody
 * named freezes), and the module carries no client or server-only directive —
 * either one would close it to one of its two hosts.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/schedule-freeze.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { shouldFreezeFiredOneOffSchedule } from "../schedule-freeze";
import { shouldFreezeFiredOneOffSchedule as fromScreens } from "../instance-screens";

const FIRED = new Date("2026-07-14T07:00:00Z");

describe("shouldFreezeFiredOneOffSchedule, from @cinatra-ai/agents/schedule-freeze", () => {
  it("is false with no trigger row", () => {
    expect(shouldFreezeFiredOneOffSchedule(null)).toBe(false);
  });

  it("is false for a released recurring row — it stays changeable", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "recurring", releasedAt: FIRED }),
    ).toBe(false);
  });

  it("is TRUE for a released one-off, scheduled or immediate", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "scheduled", releasedAt: FIRED }),
    ).toBe(true);
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "immediate", releasedAt: FIRED }),
    ).toBe(true);
  });

  it("is false for a one-off that has not fired", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "scheduled", releasedAt: null }),
    ).toBe(false);
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "immediate", releasedAt: null }),
    ).toBe(false);
  });

  it("is TRUE for an unknown fired kind — the rule fails closed", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "webhook", releasedAt: FIRED }),
    ).toBe(true);
  });

  it("is the same function the run page's module re-exports", () => {
    expect(fromScreens).toBe(shouldFreezeFiredOneOffSchedule);
  });
});

describe("the module can be reached from both page hosts", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "..", "schedule-freeze.ts"), "utf-8");

  it("carries no \"use client\" and no \"server-only\" line", () => {
    expect(SRC).not.toMatch(/^\s*["']use client["']/m);
    expect(SRC).not.toMatch(/^\s*import\s+["']server-only["']/m);
  });

  it("imports nothing", () => {
    expect(SRC).not.toMatch(/^\s*import\s/m);
  });

  it("is a declared subpath of the package", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"),
    ) as { exports: Record<string, string> };
    expect(pkg.exports["./schedule-freeze"]).toBe("./src/schedule-freeze.ts");
  });
});
