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
    typeof s === "string" && s.length > 0 && s !== "." && s !== ".." &&
    !s.includes("/") && !s.includes("\\") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(s) && !s.startsWith("~") && !/^[a-zA-Z]:/.test(s);
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

import { deriveContextFromLegacy } from "../skills-store";

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
});
