// Canonical agent-package resolver (cinatra#2346 S1, epic #2345).
//
// AC: "Resolver tests: raw bridge slug, scoped package name, template-free
// provider-declared agent, multi-template package; ambiguous suffix refused;
// assistant/non-agent target refused."
//
// The resolver is the ONLY thing standing between four different identifier
// shapes and one storage key. Every arm below is a shape that actually reaches
// it in production, plus the two refusals that must never be guessed past.
import { describe, expect, it, vi } from "vitest";

import {
  assertAgentWriteTarget,
  evaluateAgentWriteTarget,
  npmSuffix,
  resolveCanonicalAgentPackage,
  resolveCanonicalAgentPackageFrom,
} from "./agent-package-resolver";

/** The shape `readAgentsForSkillMatching` produces for a DB-installed template. */
function installed(packageId: string) {
  const slug = packageId.replace(/^@[^/]+\//, "");
  return { packageId, id: slug, identifier: slug, packageSlug: slug };
}

describe("resolveCanonicalAgentPackageFrom — identifier shapes", () => {
  const population = [
    installed("@cinatra-ai/web-scrape-agent"),
    installed("@cinatra-ai/security-reviewer-agent"),
  ];

  it("resolves the SCOPED package name exactly (the settings-page shape)", () => {
    expect(resolveCanonicalAgentPackageFrom("@cinatra-ai/web-scrape-agent", population)).toEqual({
      ok: true,
      packageName: "@cinatra-ai/web-scrape-agent",
      via: "exact",
    });
  });

  it("REFUSES a fully-qualified name that is not installed, even when a SUFFIX twin is", () => {
    // Codex round-1 finding: falling back to the suffix for a scoped needle
    // would silently land an admin's assignment on a DIFFERENT vendor's agent.
    // A qualified name that does not match exactly is UNKNOWN, never a guess.
    const out = resolveCanonicalAgentPackageFrom("@vendor-a/web-scrape-agent", population);
    expect(out).toEqual({ ok: false, reason: "unknown" });
  });

  it("REFUSES an unscoped-but-qualified needle whose suffix twin is installed", () => {
    expect(resolveCanonicalAgentPackageFrom("vendor-a/web-scrape-agent", population)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("keeps EVERY alias matchable across candidates of the same package", () => {
    // Codex round-1 finding: deduping candidates BEFORE matching discarded a
    // second template row's aliases, so a needle naming one of them missed.
    const multiAlias = [
      { packageId: "@cinatra-ai/multi-agent", id: "tmpl-a", identifier: "alias-a" },
      { packageId: "@cinatra-ai/multi-agent", id: "tmpl-b", identifier: "alias-b" },
    ];
    for (const needle of ["tmpl-a", "alias-a", "tmpl-b", "alias-b"]) {
      expect(resolveCanonicalAgentPackageFrom(needle, multiAlias), needle).toEqual({
        ok: true,
        packageName: "@cinatra-ai/multi-agent",
        via: "exact",
      });
    }
  });

  it("detects ambiguity carried by a LATER candidate of a different package", () => {
    const shadowed = [
      { packageId: "@vendor-a/x-agent", id: "first", identifier: "shared" },
      { packageId: "@vendor-a/x-agent", id: "second", identifier: "other" },
      { packageId: "@vendor-b/y-agent", id: "third", identifier: "shared" },
    ];
    expect(resolveCanonicalAgentPackageFrom("shared", shadowed)).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: ["@vendor-a/x-agent", "@vendor-b/y-agent"],
    });
  });

  it("resolves a RAW BRIDGE SLUG through the npm-suffix fallback", () => {
    // `getAssignedSkillIdsForAgent` receives this shape; it must land on the
    // same rows the settings page wrote under the scoped name.
    expect(resolveCanonicalAgentPackageFrom("web-scrape-agent", population)).toEqual({
      ok: true,
      packageName: "@cinatra-ai/web-scrape-agent",
      via: "exact", // id/identifier/packageSlug carry the slug — exact wins first
    });
  });

  it("resolves a raw slug that matches NO identity field but IS the npm suffix", () => {
    // A provider-declared agent whose reader row carries only packageId.
    const bare = [{ packageId: "@vendor/report-agent" }];
    expect(resolveCanonicalAgentPackageFrom("report-agent", bare)).toEqual({
      ok: true,
      packageName: "@vendor/report-agent",
      via: "npm-suffix",
    });
  });

  it("resolves a TEMPLATE-FREE provider-declared agent (no agent_templates row)", () => {
    // The whole reason this action must not copy the execution action's
    // DB-template lookup: this agent has no template row at all, only an
    // on-disk manifest, and the installed-agents reader unions it in.
    const population2 = [
      installed("@cinatra-ai/web-scrape-agent"),
      { packageId: "@partner/on-disk-only-agent", packageSlug: "on-disk-only-agent" },
    ];
    expect(resolveCanonicalAgentPackageFrom("on-disk-only-agent", population2)).toEqual({
      ok: true,
      packageName: "@partner/on-disk-only-agent",
      via: "exact",
    });
    expect(
      resolveCanonicalAgentPackageFrom("@partner/on-disk-only-agent", population2),
    ).toEqual({ ok: true, packageName: "@partner/on-disk-only-agent", via: "exact" });
  });

  it("resolves a MULTI-TEMPLATE package to ONE key (templates dedupe by packageId)", () => {
    // Some readers contribute one candidate per template. Two candidates that
    // are the same package must not read as an ambiguity with themselves — the
    // assignment applies to every template in the package.
    const multi = [
      { packageId: "@cinatra-ai/multi-agent", id: "multi-agent", identifier: "multi-agent" },
      { packageId: "@cinatra-ai/multi-agent", id: "multi-agent", identifier: "multi-agent" },
    ];
    expect(resolveCanonicalAgentPackageFrom("multi-agent", multi)).toEqual({
      ok: true,
      packageName: "@cinatra-ai/multi-agent",
      via: "exact",
    });
  });

  it("REFUSES an ambiguous npm suffix instead of guessing", () => {
    const ambiguous = [
      { packageId: "@vendor-a/research-agent" },
      { packageId: "@vendor-b/research-agent" },
    ];
    expect(resolveCanonicalAgentPackageFrom("research-agent", ambiguous)).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: ["@vendor-a/research-agent", "@vendor-b/research-agent"],
    });
  });

  it("REFUSES an ambiguous EXACT match (two packages claiming one slug identity)", () => {
    const ambiguous = [
      { packageId: "@vendor-a/x-agent", identifier: "shared-identity" },
      { packageId: "@vendor-b/y-agent", identifier: "shared-identity" },
    ];
    const out = resolveCanonicalAgentPackageFrom("shared-identity", ambiguous);
    expect(out).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: ["@vendor-a/x-agent", "@vendor-b/y-agent"],
    });
  });

  it("refuses an unknown id and an empty id distinctly", () => {
    expect(resolveCanonicalAgentPackageFrom("nope", population)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(resolveCanonicalAgentPackageFrom("   ", population)).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("never falls back to the raw input (the storage-key hazard)", () => {
    // The pre-existing inline lookup in agents-store returns `agentId` verbatim
    // when nothing matches. As a STORAGE KEY that writes rows nothing can read
    // back, so the resolver must refuse instead.
    const out = resolveCanonicalAgentPackageFrom("@evil/not-installed", population);
    expect(out.ok).toBe(false);
  });

  it("npmSuffix handles scoped, unscoped and nested forms", () => {
    expect(npmSuffix("@cinatra-ai/web-scrape-agent")).toBe("web-scrape-agent");
    expect(npmSuffix("web-scrape-agent")).toBe("web-scrape-agent");
    expect(npmSuffix("a/b/c")).toBe("c");
  });
});

describe("resolveCanonicalAgentPackage — I/O composition", () => {
  it("fails CLOSED when the installed-agent population cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await resolveCanonicalAgentPackage("@cinatra-ai/web-scrape-agent", {
      readAgents: async () => {
        throw new Error("db down");
      },
    });
    expect(out).toEqual({ ok: false, reason: "unknown" });
    warn.mockRestore();
  });

  it("resolves through the injected population", async () => {
    const out = await resolveCanonicalAgentPackage("web-scrape-agent", {
      readAgents: async () => [installed("@cinatra-ai/web-scrape-agent")],
    });
    expect(out).toEqual({
      ok: true,
      packageName: "@cinatra-ai/web-scrape-agent",
      via: "exact",
    });
  });
});

describe("write-target eligibility — assistant / non-agent refused", () => {
  it("admits an agent-kind, non-assistant package", () => {
    expect(evaluateAgentWriteTarget({ kind: "agent", isAssistant: false })).toEqual({ ok: true });
  });

  it("REFUSES an assistant even when its kind reads 'agent'", () => {
    // Authoritative assistant data wins: the assistant injection branch ignores
    // the recommendation channel this epic feeds, so an assignment there could
    // never be delivered.
    expect(evaluateAgentWriteTarget({ kind: "agent", isAssistant: true })).toEqual({
      ok: false,
      reason: "assistant",
    });
  });

  it("REFUSES a non-agent kind (connector / artifact / skill settings pages)", () => {
    for (const kind of ["connector", "artifact", "skill", "workflow"]) {
      expect(evaluateAgentWriteTarget({ kind, isAssistant: false })).toEqual({
        ok: false,
        reason: "not-an-agent",
      });
    }
  });

  it("fails CLOSED on an unresolvable kind", () => {
    expect(evaluateAgentWriteTarget({ kind: null, isAssistant: false })).toEqual({
      ok: false,
      reason: "eligibility-unreadable",
    });
  });

  it("assertAgentWriteTarget refuses when an eligibility source throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await assertAgentWriteTarget("@cinatra-ai/web-scrape-agent", {
      readPackageKind: async () => {
        throw new Error("canonical store unreachable");
      },
      isAssistantPackage: async () => false,
    });
    expect(out).toEqual({ ok: false, reason: "eligibility-unreadable" });
    warn.mockRestore();
  });

  it("assertAgentWriteTarget composes the injected sources", async () => {
    await expect(
      assertAgentWriteTarget("@cinatra-ai/assistant-pkg", {
        readPackageKind: async () => "agent",
        isAssistantPackage: async () => true,
      }),
    ).resolves.toEqual({ ok: false, reason: "assistant" });
    await expect(
      assertAgentWriteTarget("@cinatra-ai/web-scrape-agent", {
        readPackageKind: async () => "agent",
        isAssistantPackage: async () => false,
      }),
    ).resolves.toEqual({ ok: true });
  });
});
