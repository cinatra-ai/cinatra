import { describe, expect, it, vi } from "vitest";
import {
  selectConnectorSetupRoutes,
  SMOKE_WALK_BUDGET_MS,
  walkSmokeSurfaces,
  type SmokeVisit,
} from "../dev-hmr-smoke/smoke-walk";

describe("the bounded warm-session smoke", () => {
  it("takes two distinct setup routes in stable path order without privileging a connector", () => {
    const descriptor = (slug: string) => ({ packageId: `@example/${slug}`, slug, setupSubroute: "setup" });
    const descriptors = [descriptor("d"), descriptor("a"), descriptor("c"), descriptor("b"), descriptor("a")];
    expect(selectConnectorSetupRoutes(descriptors)).toEqual([
      "/connectors/example/a/setup", "/connectors/example/b/setup",
    ]);
    expect(selectConnectorSetupRoutes([...descriptors].reverse())).toEqual(selectConnectorSetupRoutes(descriptors));
    expect(selectConnectorSetupRoutes([])).toEqual([]);
  });

  it("grants the cold allowance only to the first /connectors visit", async () => {
    const check = vi.fn(async () => null);
    const options = { routes: ["/connectors", "/agents", "/connectors/example/a/setup"], deadline: SMOKE_WALK_BUDGET_MS, now: () => 0, check, report: () => undefined };
    await walkSmokeSurfaces({ ...options, phase: "warm" });
    await walkSmokeSurfaces({ ...options, phase: "post-recompile" });
    expect(check.mock.calls).toEqual([
      ["/connectors", 120_000], ["/agents", 90_000], ["/connectors/example/a/setup", 90_000],
      ["/connectors", 90_000], ["/agents", 90_000], ["/connectors/example/a/setup", 90_000],
    ]);
  });

  it("uses the remaining total budget and stops before starting another route", async () => {
    let now = SMOKE_WALK_BUDGET_MS - 25_000;
    const check = vi.fn(async () => { now += 25_000; return null; });
    const failures = await walkSmokeSurfaces({ phase: "post-recompile", routes: ["/agents", "/connectors"], deadline: SMOKE_WALK_BUDGET_MS, now: () => now, check, report: () => undefined });
    expect(check.mock.calls).toEqual([["/agents", 25_000]]);
    expect(failures).toEqual([expect.stringContaining("[post-recompile] /connectors: total smoke budget exhausted")]);
    expect(SMOKE_WALK_BUDGET_MS).toBeLessThan(600_000);
  });

  it.each(["HTTP 500", "rendered error surface: Build Error"])("stops on %s and keeps its elapsed timing", async (problem) => {
    let now = 0;
    const visits: SmokeVisit[] = [];
    const check = vi.fn(async () => { now += 740; return problem; });
    const failures = await walkSmokeSurfaces({ phase: "post-recompile", routes: ["/connectors/example/a/setup", "/agents"], deadline: SMOKE_WALK_BUDGET_MS, now: () => now, check, report: (visit) => visits.push(visit) });
    expect(check).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([`[post-recompile] /connectors/example/a/setup after 740ms: ${problem}`]);
    expect(visits).toEqual([
      { phase: "post-recompile", route: "/connectors/example/a/setup", state: "start", budgetMs: 90_000 },
      { phase: "post-recompile", route: "/connectors/example/a/setup", state: "failed", budgetMs: 90_000, elapsedMs: 740, failure: problem },
    ]);
  });

  it("preserves a thrown recompile navigation error instead of trying the next surface", async () => {
    const check = vi.fn(async () => { throw new Error("navigation timed out"); });
    const failures = await walkSmokeSurfaces({ phase: "post-recompile", routes: ["/connectors/example/a/setup", "/agents"], deadline: SMOKE_WALK_BUDGET_MS, now: () => 0, check, report: () => undefined });
    expect(check).toHaveBeenCalledTimes(1);
    expect(failures).toEqual(["[post-recompile] /connectors/example/a/setup after 0ms: navigation timed out"]);
  });

  it("reports successful elapsed time for every visited surface", async () => {
    let now = 0;
    const visits: SmokeVisit[] = [];
    const failures = await walkSmokeSurfaces({ phase: "warm", routes: ["/connectors", "/agents"], deadline: SMOKE_WALK_BUDGET_MS, now: () => now, check: async () => { now += 30; return null; }, report: (visit) => visits.push(visit) });
    expect(failures).toEqual([]);
    expect(visits.filter((visit) => visit.state === "passed").map((visit) => [visit.route, visit.elapsedMs])).toEqual([["/connectors", 30], ["/agents", 30]]);
  });
});
