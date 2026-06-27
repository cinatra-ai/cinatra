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
// sandbox; provide the real-shaped parsePackageId (cinatra#537) so the agent
// vendor/name split under test exercises real first-`/`-only behavior.
vi.mock("@cinatra-ai/registries", () => ({
  parsePackageId: (name: string) => {
    if (typeof name !== "string") return null;
    const t = name.trim();
    if (!t) return null;
    if (!t.startsWith("@")) return { vendor: null, name: t };
    const i = t.indexOf("/");
    if (i <= 1) return null;
    const n = t.slice(i + 1);
    return n.length === 0 ? null : { vendor: t.slice(1, i), name: n };
  },
}));
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
});
