// The paged assignable-skills SEARCH action (cinatra#2348 S3, epic #2345).
//
// The action is thin by design — authorization, the server-derived agent
// target, the already-assigned exclusion, the standard display/vendor
// resolvers, then the pure page model. What is NOT thin is the ORDER those
// steps run in, and that is what this suite pins:
//
//   * a non-admin must be refused BEFORE any population read (a search box is
//     not an acceptable way to enumerate the installed skill catalog);
//   * the exclusion must be computed against the SERVER-derived canonical
//     package, never against whatever the caller typed;
//   * an assistant / non-agent target must be refused, because the assistant
//     injection branch ignores the channel this epic feeds;
//   * narrowing and paging must both happen server-side.
//
// ONE module is doubled: the I/O seam. The real pure model, the real display
// resolvers and the real gate ordering all execute.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdminUserIdMock,
  listCandidatesMock,
  resolveAgentPackageMock,
  assertAgentTargetMock,
  readAssignedSkillIdsMock,
  readInstallRowsMock,
} = vi.hoisted(() => ({
  requireAdminUserIdMock: vi.fn(),
  listCandidatesMock: vi.fn(),
  resolveAgentPackageMock: vi.fn(),
  assertAgentTargetMock: vi.fn(),
  readAssignedSkillIdsMock: vi.fn(),
  readInstallRowsMock: vi.fn(),
}));

vi.mock("../assignable-skills-sources", () => ({
  requireAdminUserIdSource: requireAdminUserIdMock,
  listAssignableSkillCandidatesSource: listCandidatesMock,
  resolveAgentPackageSource: resolveAgentPackageMock,
  assertAgentTargetSource: assertAgentTargetMock,
  readAssignedSkillIdsSource: readAssignedSkillIdsMock,
  readInstallRowsSource: readInstallRowsMock,
}));

import { searchAssignableSkillExtensions } from "../assignable-skills-actions";
import { ASSIGNABLE_SKILL_MAX_PAGE_SIZE } from "../assignable-skills-search-model";

type Candidate = {
  skillId: string;
  skillName: string;
  skillDescription: string;
  ownerPackageName: string;
  ownerPackageCandidates: string[];
  extensionDisplayName: string | null;
  extensionVendorName: string | null;
  extensionAuthor: string | null;
  role: "injectable";
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const ownerPackageName = overrides.ownerPackageName ?? "@acme/widget-skills";
  return {
    skillId: "@acme/widget-skills:do-thing",
    skillName: "Do Thing",
    skillDescription: "Does the thing.",
    ownerPackageName,
    ownerPackageCandidates: [ownerPackageName],
    extensionDisplayName: "Widget Skills",
    extensionVendorName: "Acme Corporation",
    extensionAuthor: "Acme Publishing",
    role: "injectable",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminUserIdMock.mockResolvedValue("user_admin");
  resolveAgentPackageMock.mockResolvedValue({
    ok: true,
    packageName: "@cinatra-ai/web-scrape-agent",
    via: "npm-suffix",
  });
  assertAgentTargetMock.mockResolvedValue({ ok: true });
  listCandidatesMock.mockResolvedValue([candidate()]);
  readAssignedSkillIdsMock.mockResolvedValue([]);
  readInstallRowsMock.mockResolvedValue(new Map());
});

describe("searchAssignableSkillExtensions — authorization", () => {
  it("REFUSES a non-admin and never reads the population", async () => {
    requireAdminUserIdMock.mockRejectedValue(new Error("admin required"));
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out).toEqual({ ok: false, reason: "forbidden" });
    expect(listCandidatesMock).not.toHaveBeenCalled();
    expect(readAssignedSkillIdsMock).not.toHaveBeenCalled();
    expect(resolveAgentPackageMock).not.toHaveBeenCalled();
  });

  it("REFUSES a session with no user id", async () => {
    requireAdminUserIdMock.mockResolvedValue("");
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out).toEqual({ ok: false, reason: "forbidden" });
    expect(listCandidatesMock).not.toHaveBeenCalled();
  });
});

describe("searchAssignableSkillExtensions — the SERVER-DERIVED agent target", () => {
  it("resolves the caller's reference through the shared resolver", async () => {
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(resolveAgentPackageMock).toHaveBeenCalledWith("web-scrape-agent");
    expect(out).toMatchObject({ ok: true, agentPackageName: "@cinatra-ai/web-scrape-agent" });
    // The EXCLUSION is computed against the canonical name, not the raw input.
    expect(readAssignedSkillIdsMock).toHaveBeenCalledWith("@cinatra-ai/web-scrape-agent");
  });

  it("REFUSES an unknown agent and an AMBIGUOUS one, distinctly", async () => {
    resolveAgentPackageMock.mockResolvedValue({ ok: false, reason: "unknown" });
    expect(await searchAssignableSkillExtensions("nope", "")).toEqual({
      ok: false,
      reason: "unknown-agent",
    });
    resolveAgentPackageMock.mockResolvedValue({ ok: false, reason: "ambiguous", matches: ["a", "b"] });
    expect(await searchAssignableSkillExtensions("x", "")).toEqual({
      ok: false,
      reason: "ambiguous-agent",
    });
    resolveAgentPackageMock.mockResolvedValue({ ok: false, reason: "empty" });
    expect(await searchAssignableSkillExtensions("   ", "")).toEqual({
      ok: false,
      reason: "unknown-agent",
    });
    expect(listCandidatesMock).not.toHaveBeenCalled();
  });

  it("REFUSES an assistant, a non-agent kind, and an unreadable eligibility source", async () => {
    for (const reason of ["assistant", "not-an-agent", "eligibility-unreadable"] as const) {
      vi.clearAllMocks();
      requireAdminUserIdMock.mockResolvedValue("user_admin");
      resolveAgentPackageMock.mockResolvedValue({
        ok: true,
        packageName: "@cinatra-ai/some-package",
        via: "exact",
      });
      assertAgentTargetMock.mockResolvedValue({ ok: false, reason });
      const out = await searchAssignableSkillExtensions("some-package", "");
      expect(out).toEqual({ ok: false, reason });
      expect(listCandidatesMock).not.toHaveBeenCalled();
    }
  });
});

describe("searchAssignableSkillExtensions — result rows", () => {
  it("carries the catalog id, extension title + vendor, skill name and status", async () => {
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out).toMatchObject({ ok: true, hasMore: false });
    expect(out.ok && out.results).toEqual([
      {
        skillId: "@acme/widget-skills:do-thing",
        skillName: "Do Thing",
        skillDescription: "Does the thing.",
        packageName: "@acme/widget-skills",
        displayName: "Widget Skills",
        vendorName: "Acme Corporation",
        status: "active",
      },
    ]);
  });

  it("falls back through the STANDARD display-name and vendor chains", async () => {
    listCandidatesMock.mockResolvedValue([
      // Nothing declared at all → the raw package name is the display last
      // resort (never ""), and there is no byline.
      candidate({
        extensionDisplayName: null,
        extensionVendorName: null,
        extensionAuthor: null,
      }),
      // No declared vendor identity → the npm author is the second tier.
      candidate({
        skillId: "@acme/other-skills:x",
        ownerPackageName: "@acme/other-skills",
        extensionDisplayName: "Other Skills",
        extensionVendorName: null,
        extensionAuthor: "Other Publishing",
      }),
      // Neither → no byline at all. The npm SCOPE is never a vendor name.
      candidate({
        skillId: "@acme/third-skills:x",
        ownerPackageName: "@acme/third-skills",
        extensionDisplayName: "Third Skills",
        extensionVendorName: null,
        extensionAuthor: null,
      }),
    ]);
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results.map((r) => [r.displayName, r.vendorName])).toEqual([
      ["@acme/widget-skills", null],
      ["Other Skills", "Other Publishing"],
      ["Third Skills", null],
    ]);
  });

  // ---------------------------------------------------------------------------
  // AC: LOCKED-install skills are listed; uninstalled ones are not.
  // ---------------------------------------------------------------------------

  it("LISTS a locked-install skill and labels it `locked`", async () => {
    readInstallRowsMock.mockResolvedValue(
      new Map([["@acme/widget-skills", [{ status: "locked" }]]]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results).toHaveLength(1);
    expect(out.ok && out.results[0]!.status).toBe("locked");
  });

  it("labels a package with BOTH an active and a locked row `locked` (any locked wins)", async () => {
    // The platform's ONE badge rule (`pickLifecycleBadgeStatus`): a locked row
    // wins over an active one, so the picker and the Installed card can never
    // show the same package with two different badges.
    readInstallRowsMock.mockResolvedValue(
      new Map([["@acme/widget-skills", [{ status: "active" }, { status: "locked" }]]]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results[0]!.status).toBe("locked");
  });

  it("labels `locked` when the row is stored under a legacy SLUG key", async () => {
    // `installed_extension.package_name` is not always the npm form. Reading
    // only the exact name would see "no rows" and fail-live to `active`,
    // silently un-badging every legacy-keyed system extension.
    listCandidatesMock.mockResolvedValue([
      candidate({ ownerPackageCandidates: ["@acme/widget-skills", "acme-widget-skills"] }),
    ]);
    readInstallRowsMock.mockResolvedValue(
      new Map([["acme-widget-skills", [{ status: "locked" }]]]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(readInstallRowsMock).toHaveBeenCalledWith([
      "@acme/widget-skills",
      "acme-widget-skills",
    ]);
    expect(out.ok && out.results[0]!.status).toBe("locked");
  });

  it("lets the EXACT name outvote a drift alias when it has rows of its own", async () => {
    // `slugify` is lossy, so a drift key can collide with an unrelated package.
    // When the canonical name has rows, the aliases must not be consulted.
    listCandidatesMock.mockResolvedValue([
      candidate({ ownerPackageCandidates: ["@acme/widget-skills", "acme-widget-skills"] }),
    ]);
    readInstallRowsMock.mockResolvedValue(
      new Map([
        ["@acme/widget-skills", [{ status: "active" }]],
        ["acme-widget-skills", [{ status: "locked" }]],
      ]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results[0]!.status).toBe("active");
  });

  it("DROPS a skill whose extension turned out to be archived (a TOCTOU guard)", async () => {
    // The population read said live; by the time the rows are read the
    // extension is archived. Relabelling would offer a skill the write path
    // refuses, so the row is dropped instead.
    readInstallRowsMock.mockResolvedValue(
      new Map([["@acme/widget-skills", [{ status: "archived" }]]]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out).toMatchObject({ ok: true, results: [], hasMore: false });
  });

  it("keeps a package whose LIVE row survives alongside an archived one", async () => {
    readInstallRowsMock.mockResolvedValue(
      new Map([["@acme/widget-skills", [{ status: "archived" }, { status: "locked" }]]]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results[0]!.status).toBe("locked");
  });

  it("does NOT list an uninstalled skill — the POPULATION already excluded it", async () => {
    // Uninstalled means the predicate refused it upstream, so it never reaches
    // the action. The action must not resurrect it from an install-row read.
    listCandidatesMock.mockResolvedValue([]);
    readInstallRowsMock.mockResolvedValue(
      new Map([["@acme/widget-skills", [{ status: "active" }]]]),
    );
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out).toEqual({
      ok: true,
      agentPackageName: "@cinatra-ai/web-scrape-agent",
      results: [],
      hasMore: false,
    });
  });

  it("keeps listing when the LABEL read fails (a label outage is not a liveness verdict)", async () => {
    readInstallRowsMock.mockRejectedValue(new Error("db down"));
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results).toHaveLength(1);
    expect(out.ok && out.results[0]!.status).toBe("active");
  });
});

describe("searchAssignableSkillExtensions — the already-assigned exclusion", () => {
  it("EXCLUDES a skill this agent already carries, server-side", async () => {
    listCandidatesMock.mockResolvedValue([
      candidate({ skillId: "@acme/a:one", ownerPackageName: "@acme/a", extensionDisplayName: "A" }),
      candidate({ skillId: "@acme/b:two", ownerPackageName: "@acme/b", extensionDisplayName: "B" }),
      candidate({ skillId: "@acme/c:three", ownerPackageName: "@acme/c", extensionDisplayName: "C" }),
    ]);
    readAssignedSkillIdsMock.mockResolvedValue(["@acme/b:two"]);
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out.ok && out.results.map((r) => r.skillId)).toEqual(["@acme/a:one", "@acme/c:three"]);
  });

  it("excludes BEFORE paging, so an excluded row never consumes a page slot", async () => {
    listCandidatesMock.mockResolvedValue([
      candidate({ skillId: "@acme/a:one", ownerPackageName: "@acme/a", extensionDisplayName: "A" }),
      candidate({ skillId: "@acme/b:two", ownerPackageName: "@acme/b", extensionDisplayName: "B" }),
      candidate({ skillId: "@acme/c:three", ownerPackageName: "@acme/c", extensionDisplayName: "C" }),
    ]);
    readAssignedSkillIdsMock.mockResolvedValue(["@acme/a:one"]);
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "", { limit: 2 });
    expect(out.ok && out.results.map((r) => r.skillId)).toEqual(["@acme/b:two", "@acme/c:three"]);
    expect(out.ok && out.hasMore).toBe(false);
  });

  it("returns an EMPTY page when every candidate is already assigned", async () => {
    readAssignedSkillIdsMock.mockResolvedValue(["@acme/widget-skills:do-thing"]);
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(out).toMatchObject({ ok: true, results: [], hasMore: false });
  });
});

describe("searchAssignableSkillExtensions — server-side narrowing and paging", () => {
  function population(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const key = String(i).padStart(3, "0");
      return candidate({
        skillId: `@acme/pack-${key}:s`,
        ownerPackageName: `@acme/pack-${key}`,
        extensionDisplayName: `Pack ${key}`,
        skillName: `Skill ${key}`,
      });
    });
  }

  it("NARROWS server-side — the response carries only matching rows", async () => {
    listCandidatesMock.mockResolvedValue([
      candidate({ skillId: "@acme/a:one", ownerPackageName: "@acme/a", extensionDisplayName: "Alpha Pack" }),
      candidate({ skillId: "@acme/b:two", ownerPackageName: "@acme/b", extensionDisplayName: "Beta Pack" }),
      candidate({ skillId: "@acme/g:three", ownerPackageName: "@acme/g", extensionDisplayName: "Gamma Pack" }),
    ]);
    const all = await searchAssignableSkillExtensions("web-scrape-agent", "");
    expect(all.ok && all.results).toHaveLength(3);
    const narrowed = await searchAssignableSkillExtensions("web-scrape-agent", "gamma");
    expect(narrowed.ok && narrowed.results.map((r) => r.skillId)).toEqual(["@acme/g:three"]);
  });

  it("narrows on the SKILL name too, not only the extension title", async () => {
    listCandidatesMock.mockResolvedValue([
      candidate({ skillId: "@acme/a:one", ownerPackageName: "@acme/a", extensionDisplayName: "Alpha", skillName: "Summarize" }),
      candidate({ skillId: "@acme/b:two", ownerPackageName: "@acme/b", extensionDisplayName: "Beta", skillName: "Translate" }),
    ]);
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "transl");
    expect(out.ok && out.results.map((r) => r.skillId)).toEqual(["@acme/b:two"]);
  });

  it("pages with limit+1 hasMore and a stable order across windows", async () => {
    listCandidatesMock.mockResolvedValue(population(25));
    const first = await searchAssignableSkillExtensions("web-scrape-agent", "", { limit: 20 });
    expect(first.ok && first.results).toHaveLength(20);
    expect(first.ok && first.hasMore).toBe(true);
    const second = await searchAssignableSkillExtensions("web-scrape-agent", "", {
      offset: 20,
      limit: 20,
    });
    expect(second.ok && second.results).toHaveLength(5);
    expect(second.ok && second.hasMore).toBe(false);
    const seen = [
      ...(first.ok ? first.results : []),
      ...(second.ok ? second.results : []),
    ].map((r) => r.skillId);
    expect(new Set(seen).size).toBe(25);
  });

  it("CLAMPS an oversized page request", async () => {
    listCandidatesMock.mockResolvedValue(population(120));
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "", { limit: 5_000 });
    expect(out.ok && out.results).toHaveLength(ASSIGNABLE_SKILL_MAX_PAGE_SIZE);
    expect(out.ok && out.hasMore).toBe(true);
  });

  it("treats a wildcard needle as literal (no pattern can widen the page)", async () => {
    listCandidatesMock.mockResolvedValue(population(5));
    const out = await searchAssignableSkillExtensions("web-scrape-agent", "%");
    expect(out.ok && out.results).toEqual([]);
  });
});
