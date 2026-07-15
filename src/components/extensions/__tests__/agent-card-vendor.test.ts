/**
 * resolveAgentCardVendor — the /agents §IV card vendor derivation (cinatra#1528).
 *
 * A Cinatra-hosted ("local") agent resolves to the genuine "Cinatra" display
 * name; an external A2A agent's connector `host` is a SLUG (a machine
 * identifier) and must resolve to the explicit missing-vendor state — NEVER the
 * raw slug.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import { resolveAgentCardVendor } from "../agent-card-vendor";

afterEach(() => vi.restoreAllMocks());

describe("resolveAgentCardVendor", () => {
  it("resolves a Cinatra-hosted (local) agent to the known 'Cinatra' vendor", () => {
    expect(resolveAgentCardVendor({ host: "local", ref: "@cinatra-ai/planner-agent" })).toEqual({
      kind: "known",
      displayName: "Cinatra",
      storeUrl: null,
    });
  });

  it("resolves an external A2A agent (connector host slug) to missing — NEVER the slug", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveAgentCardVendor({ host: "machine-slug-sentinel", ref: "external-agent-key" });
    expect(result).toEqual({ kind: "missing" });
    // Structurally cannot carry the slug as a label.
    expect(JSON.stringify(result)).not.toContain("machine-slug-sentinel");
  });

  it("emits the structured missing-vendor diagnostic for an A2A host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveAgentCardVendor({ host: "another-connector-slug", ref: "diag-ref-unique" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      event: "vendor.display_name.missing",
      surface: "agent-all-card",
      ref: "diag-ref-unique",
    });
  });
});
