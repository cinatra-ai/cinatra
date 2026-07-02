/**
 * cinatra#537 — agent vendor/name derivation must use the SINGLE canonical
 * splitter (split on the first `/`, never on `-`).
 *
 * `deriveContextFromLegacy(type:"agent", ...)` previously split the packageSlug
 * on the FIRST DASH, so a hyphenated scope like
 * "@marcushorndt-local/page-summarizer-agent" (which `upsertSkill` reaches
 * here as a `<vendor>/<package>` pair) was mis-split into
 * vendor="marcushorndt" + package="local-...". This test pins the corrected
 * vendor/name decomposition.
 *
 * Only the module-load deps are mocked; `deriveContextFromLegacy` is a pure
 * function and touches no DB/fs.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Mock the registries barrel to avoid dragging pacote/native chains into the
// sandbox; provide the real-shaped parsePackageId + safe-segment guard
// (cinatra#537) so the agent vendor/name split + path-safety under test
// exercise real behavior (first-`/`-only, single-segment, never split on `-`).
// NOTE: vitest HOISTS this `vi.mock` call above all top-level statements, so
// the factory MUST be self-contained — it defines `isSafeSeg` inside its own
// scope (a top-level helper would be referenced before initialization).
vi.mock("@cinatra-ai/registries", () => {
  const isSafeSeg = (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s);
  return {
    parsePackageId: (name: string) => {
      if (typeof name !== "string") return null;
      const t = name.trim();
      if (!t) return null;
      if (!t.startsWith("@")) return isSafeSeg(t) ? { vendor: null, name: t } : null;
      const i = t.indexOf("/");
      if (i <= 1) return null;
      const v = t.slice(1, i);
      const n = t.slice(i + 1);
      if (n.length === 0) return null;
      return isSafeSeg(v) && isSafeSeg(n) ? { vendor: v, name: n } : null;
    },
    isSafePathSegment: isSafeSeg,
    assertSafePathSegment: (s: unknown, label = "path segment"): void => {
      if (!isSafeSeg(s)) throw new Error(`unsafe ${label}: ${JSON.stringify(s)}`);
    },
  };
});
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({ dataPath: "/tmp/x", storePath: "/tmp/y" })),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skillPackages: [], skills: [] })),
  replaceSkillCatalogInDatabase: vi.fn(),
  getPostgresConnectionString: vi.fn(() => ""),
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));

import { deriveContextFromLegacy, __getSkillDiskDirForTest } from "../skills-store";

describe("deriveContextFromLegacy — agent vendor/name (cinatra#537)", () => {
  it("splits a scoped name on the first '/' only, NEVER the hyphen in the scope", () => {
    const ctx = deriveContextFromLegacy(
      "agent",
      "@marcushorndt-local/page-summarizer-agent",
      undefined,
      "do-the-thing",
    );
    expect(ctx.vendor).toBe("marcushorndt-local");
    expect(ctx.package).toBe("page-summarizer-agent");
  });

  it("splits a legacy no-`@` <vendor>/<package> pair on the first '/'", () => {
    const ctx = deriveContextFromLegacy(
      "agent",
      "marcushorndt-local/page-summarizer-agent",
      undefined,
      "do-the-thing",
    );
    expect(ctx.vendor).toBe("marcushorndt-local");
    expect(ctx.package).toBe("page-summarizer-agent");
  });

  it("keeps first-party agents resolving to vendor=cinatra-ai", () => {
    const ctx = deriveContextFromLegacy("agent", "@cinatra-ai/auditor-agent", undefined, "pii-check");
    expect(ctx.vendor).toBe("cinatra-ai");
    expect(ctx.package).toBe("auditor-agent");
  });

  it("leaves vendor null for a flat slug with no vendor (no hyphen mis-split)", () => {
    // Pre-fix this produced vendor="page" + package="summarizer-agent".
    const ctx = deriveContextFromLegacy("agent", "page-summarizer-agent", undefined, "do-the-thing");
    expect(ctx.vendor).toBeNull();
    expect(ctx.package).toBeNull();
  });

  it("fails closed on separator-injection — never persists a multi-segment package (cinatra#537 hardening)", () => {
    // Legacy no-`@` "<vendor>/foo/bar": parsePackageId returns null (multi-seg),
    // the legacy split yields pkg "foo/bar" which is NOT a single safe segment,
    // so the binding drops to the null fallback rather than persisting it.
    const ctx = deriveContextFromLegacy("agent", "acme/foo/bar", undefined, "do-the-thing");
    expect(ctx.vendor).toBeNull();
    expect(ctx.package).toBeNull();
  });

  it("fails closed on a traversal vendor", () => {
    const ctx = deriveContextFromLegacy("agent", "../etc/passwd", undefined, "do-the-thing");
    expect(ctx.vendor).toBeNull();
    expect(ctx.package).toBeNull();
  });

  // cinatra#537 fail-closed bypass: a MALFORMED SCOPED id that parsePackageId
  // rejects must NOT be reinterpreted by the legacy `<vendor>/<package>`
  // splitter (which would mint a literal "@..", "@" or "@~evil" vendor that
  // slips past isSafePathSegment). All of these must drop to the null fallback.
  // Includes the no-slash forms (@.., @., @~evil) and the WHITESPACE-bypass
  // forms (" @../foo", "  @/foo  ") — gating is on the TRIMMED value so leading/
  // surrounding whitespace cannot route a scoped id into the legacy splitter.
  it.each([
    ["@../foo"],
    ["@/foo"],
    ["@~evil/foo"],
    ["@.."],
    ["@."],
    ["@~evil"],
    ["@~/foo"],
    [" @../foo"],
    ["  @/foo  "],
    ["\t@~evil/foo"],
  ])("fails closed on rejected scoped id %j (no literal @-vendor, trim-safe)", (slug) => {
    const ctx = deriveContextFromLegacy("agent", slug, undefined, "do-the-thing");
    expect(ctx.vendor).toBeNull();
    expect(ctx.package).toBeNull();
  });

  it("never emits a vendor/package segment that starts with '@' (belt-and-suspenders)", () => {
    for (const slug of ["@../foo", "@~evil/foo", "@..", "@~evil", " @/foo "]) {
      const ctx = deriveContextFromLegacy("agent", slug, undefined, "do-the-thing");
      expect(ctx.vendor === null || !ctx.vendor.startsWith("@")).toBe(true);
      expect(ctx.package === null || !ctx.package.startsWith("@")).toBe(true);
    }
  });
});

describe("getSkillDiskDir agent-case — fail-closed disk path (cinatra#537)", () => {
  const dir = (slug: string): string => __getSkillDiskDirForTest("agent", slug, "do-the-thing");

  it("builds the canonical ~agents/<vendor>/<package>/<skill> path for valid ids", () => {
    expect(dir("@marcushorndt-local/page-summarizer-agent").replace(/\\/g, "/"))
      .toContain("/workspace/~agents/marcushorndt-local/page-summarizer-agent/do-the-thing");
    expect(dir("@cinatra-ai/foo").replace(/\\/g, "/"))
      .toContain("/workspace/~agents/cinatra-ai/foo/do-the-thing");
    // legacy no-`@` <vendor>/<package> pair
    expect(dir("cinatra/email-agent").replace(/\\/g, "/"))
      .toContain("/workspace/~agents/cinatra/email-agent/do-the-thing");
    // unscoped single name → "unknown" vendor bucket
    expect(dir("page-summarizer-agent").replace(/\\/g, "/"))
      .toContain("/workspace/~agents/unknown/page-summarizer-agent/do-the-thing");
  });

  // A malformed scoped id (after trimming) must NEVER produce a path — not as a
  // vendor and not as a "@.."-under-unknown package. It throws (fail-closed).
  // Covers the no-slash leak (@.., @., @~evil) AND the whitespace bypass.
  it.each([
    ["@../foo"],
    ["@/foo"],
    ["@~evil/foo"],
    ["@.."],
    ["@."],
    ["@~evil"],
    [" @../foo"],
    ["  @/foo  "],
    ["\t@~evil"],
  ])("throws fail-closed for malformed scoped id %j", (slug) => {
    expect(() => dir(slug)).toThrow();
  });

  it("never produces a path containing an '@'- or '..'-prefixed segment", () => {
    for (const slug of ["@../foo", "@~evil/foo", "@..", "@~evil", " @/foo ", "@.", "\t@~evil/x"]) {
      let out: string | null = null;
      try { out = dir(slug); } catch { /* throwing is the desired fail-closed outcome */ }
      if (out !== null) {
        const segs = out.replace(/\\/g, "/").split("/");
        expect(segs.some((s) => s.startsWith("@") || s === "..")).toBe(false);
      }
    }
  });
});
