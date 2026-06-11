// /connectors index readiness containment (cinatra#110).
//
// The index resolves every visible connector's readiness probe inside one
// Promise.all — before the fail-soft wrapper, a SINGLE probe that threw
// (extension not bundled, host deps not registered at boot, status read
// error) rejected the whole render and 500'd the page. These tests pin the
// containment contract: a failing probe degrades to "not connected" and is
// logged; healthy probes pass through untouched.

import { describe, expect, it, vi } from "vitest";

import { resolveReadinessFailSoft } from "../../../packages/connectors/src/readiness-fail-soft";

describe("resolveReadinessFailSoft", () => {
  it("passes a healthy probe result through untouched", async () => {
    const result = await resolveReadinessFailSoft("gmail-connector", async () => ({
      connected: true,
      connectedLabel: "3",
    }));
    expect(result).toEqual({ connected: true, connectedLabel: "3" });
  });

  it("degrades a synchronously-throwing probe to not connected and logs the slug", async () => {
    const log = vi.fn();
    const result = await resolveReadinessFailSoft(
      "gemini-connector",
      () => {
        // The exact #110 failure shape: the connector module loads but its
        // host runtime deps were never registered, so the status read throws.
        throw new Error("@cinatra-ai/gemini-connector: host runtime deps not registered.");
      },
      log,
    );
    expect(result).toEqual({ connected: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("gemini-connector");
  });

  it("degrades a rejecting async probe to not connected", async () => {
    const result = await resolveReadinessFailSoft(
      "apify-connector",
      async () => {
        throw new Error("module load failed");
      },
      () => {},
    );
    expect(result).toEqual({ connected: false });
  });

  it("keeps Promise.all over mixed probes resolving (the index render shape)", async () => {
    const probes = [
      () => Promise.resolve({ connected: true }),
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve({ connected: false }),
    ];
    const results = await Promise.all(
      probes.map((probe, i) => resolveReadinessFailSoft(`connector-${i}`, probe, () => {})),
    );
    expect(results.map((r) => r.connected)).toEqual([true, false, false]);
  });
});
