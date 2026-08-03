/**
 * The ASSIGNED-SKILL INJECTION TIER (cinatra#2347 S2, epic #2345).
 *
 * This suite owns the tier's own contract: stored order, first-seen dedup, the
 * RESOLUTION-TIME revalidation matrix, and every fail-closed arm.
 *
 * WHAT IS REAL HERE. The revalidation runs the REAL shared S1 predicate
 * (`resolveSkillAssignability`) and the REAL install-status aggregation
 * (`aggregateEffectiveStatusByPackageName`, the pure half of the canonical
 * store's reader). Only the three leaf reads are doubled — catalog rows, the
 * on-disk extension scan, and the raw `installed_extension` status rows. So the
 * matrix below exercises the same decision procedure production runs, including
 * the `locked` → live collapse, rather than a restatement of it.
 *
 * The union PLACEMENT of this tier (and the lifecycle gate above it) is pinned
 * separately in `agents-store-assigned-skill-tier.test.ts`; delivery all the way
 * to the model on the three run shapes is pinned in
 * `agent-assigned-skill-delivery-paths.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { aggregateEffectiveStatusByPackageName } from "../../../packages/extensions/src/canonical-store";
import {
  resolveSkillAssignability,
  type SkillAssignability,
} from "@cinatra-ai/skills/agent-skill-assignability";
import type { SkillExtensionDescriptor } from "../../../packages/skills/src/extension-skill-resolver";
import type { PersistedSkill } from "../../../packages/skills/src/skills-store";
import {
  resolveAssignedSkillTier,
  resolveAssignedSkillTierIds,
} from "../agent-assigned-skills-injection";

const AGENT_PKG = "@cinatra-ai/web-scrape-agent";
const OWNER_PKG = "@cinatra-ai/list-curation-skill";
const SKILL_A = `${OWNER_PKG}:list-curation`;
const OTHER_PKG = "@cinatra-ai/asset-blog";
const SKILL_B = `${OTHER_PKG}:generate-blog-ideas`;

const POPULATION = [
  {
    packageId: AGENT_PKG,
    id: "web-scrape-agent",
    identifier: "web-scrape-agent",
    packageSlug: "web-scrape-agent",
  },
];

function skill(overrides: Partial<PersistedSkill> = {}): PersistedSkill {
  return {
    id: SKILL_A,
    name: "List Curation",
    slug: "list-curation",
    description: "Curate lists.",
    content: "",
    packageId: "pkg",
    packageName: OWNER_PKG,
    packageSlug: "cinatra-ai-list-curation-skill",
    usedBy: [],
    level: "workspace",
    ...overrides,
  } as PersistedSkill;
}

function descriptor(overrides: Partial<SkillExtensionDescriptor> = {}): SkillExtensionDescriptor {
  return {
    pkgDir: "/x",
    pkgName: OWNER_PKG,
    pkgDirName: "list-curation-skill",
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs: ["list-curation"],
    ...overrides,
  } as SkillExtensionDescriptor;
}

// --- the three doubled leaf reads -------------------------------------------
let catalogSkills: PersistedSkill[] = [];
let scanned: SkillExtensionDescriptor[] = [];
/** RAW `installed_extension` rows — the real aggregate collapses them. */
let installRows: Array<{ packageName: string; status: string }> = [];

/** The REAL predicate, with only its leaf reads doubled. */
const realRevalidation = (ids: readonly string[]): Promise<Map<string, SkillAssignability>> =>
  resolveSkillAssignability(ids, {
    readCatalog: async () => ({ skills: catalogSkills }),
    scanExtensions: async () => scanned,
    readInstallStatus: async (names) =>
      aggregateEffectiveStatusByPackageName(
        installRows.filter((r) => names.includes(r.packageName)),
      ),
  });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  catalogSkills = [skill()];
  scanned = [descriptor()];
  installRows = [{ packageName: OWNER_PKG, status: "active" }];
});

describe("stored order, dedup and the empty cases", () => {
  it("emits the assignment rows in the STORED order, not sorted by id", async () => {
    // `position` is what an admin arranged; the store hands rows over ordered.
    // A sort here would silently re-rank the human's choice under the cap.
    catalogSkills = [skill(), skill({ id: SKILL_B, packageName: OTHER_PKG, slug: "generate-blog-ideas" })];
    scanned = [descriptor(), descriptor({ pkgName: OTHER_PKG, pkgDirName: "asset-blog", slugs: ["generate-blog-ideas"] })];
    installRows = [
      { packageName: OWNER_PKG, status: "active" },
      { packageName: OTHER_PKG, status: "active" },
    ];
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      // B first (position 1), A second (position 2) — the reverse of id order.
      readAssignments: async () => [{ skillId: SKILL_B }, { skillId: SKILL_A }],
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([SKILL_B, SKILL_A]);
    expect(out.agentPackageName).toBe(AGENT_PKG);
    expect(out.degraded).toBeNull();
  });

  it("dedupes a repeated id to its FIRST-seen position", async () => {
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [{ skillId: SKILL_A }, { skillId: SKILL_A }],
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([SKILL_A]);
  });

  it("drops blank ids without asking the predicate about them", async () => {
    const asked: string[][] = [];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [{ skillId: "  " }, { skillId: SKILL_A }],
      resolveAssignability: async (ids) => {
        asked.push([...ids]);
        return realRevalidation(ids);
      },
    });
    expect(out.skillIds).toEqual([SKILL_A]);
    expect(asked).toEqual([[SKILL_A]]);
  });

  it("NO rows is a completed run, not a degradation — and never calls the predicate", async () => {
    const revalidate = vi.fn(realRevalidation);
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [],
      resolveAssignability: revalidate,
    });
    expect(out).toEqual({
      skillIds: [],
      agentPackageName: AGENT_PKG,
      withheld: [],
      degraded: null,
    });
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe("agent resolution consumes the SHARED S1 resolver", () => {
  it("resolves a raw bridge SLUG to the canonical package the store is keyed by", async () => {
    const keys: string[] = [];
    await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async (pkg) => {
        keys.push(pkg);
        return [];
      },
      resolveAssignability: realRevalidation,
    });
    expect(keys).toEqual([AGENT_PKG]);
  });

  it("REFUSES an ambiguous reference instead of guessing an agent", async () => {
    const read = vi.fn(async () => [{ skillId: SKILL_A }]);
    const out = await resolveAssignedSkillTier(
      "twin",
      [
        { packageId: "@vendor-a/twin", id: "a-twin" },
        { packageId: "@vendor-b/twin", id: "b-twin" },
      ],
      { readAssignments: read, resolveAssignability: realRevalidation },
    );
    expect(out).toMatchObject({ skillIds: [], degraded: "agent-unresolved" });
    expect(read).not.toHaveBeenCalled();
  });

  it("an UNKNOWN agent reference reads nothing and delivers nothing", async () => {
    const read = vi.fn(async () => [{ skillId: SKILL_A }]);
    const out = await resolveAssignedSkillTier("not-installed", POPULATION, {
      readAssignments: read,
      resolveAssignability: realRevalidation,
    });
    expect(out).toMatchObject({ skillIds: [], degraded: "agent-unresolved" });
    expect(read).not.toHaveBeenCalled();
  });

  it("an EMPTY reference is refused before any I/O", async () => {
    const read = vi.fn(async () => [{ skillId: SKILL_A }]);
    expect(
      await resolveAssignedSkillTierIds("   ", POPULATION, { readAssignments: read }),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("with NO population it resolves through the I/O resolver (the degraded path)", async () => {
    const keys: string[] = [];
    const out = await resolveAssignedSkillTier("web-scrape-agent", null, {
      resolveAgentPackage: async (raw) => {
        expect(raw).toBe("web-scrape-agent");
        return { ok: true, packageName: AGENT_PKG, via: "exact" };
      },
      readAssignments: async (pkg) => {
        keys.push(pkg);
        return [{ skillId: SKILL_A }];
      },
      resolveAssignability: realRevalidation,
    });
    expect(keys).toEqual([AGENT_PKG]);
    expect(out.skillIds).toEqual([SKILL_A]);
  });

  it("a MALFORMED population fails closed instead of propagating out of the resolver", async () => {
    // The caller (`getAssignedSkillIdsForAgent`) was total on this input before
    // the tier existed; a null candidate row must not turn it into a rejecting
    // function. Guards the "never rejects" contract on the PURE arm too.
    const read = vi.fn(async () => [{ skillId: SKILL_A }]);
    const out = await resolveAssignedSkillTier(
      "web-scrape-agent",
      [null as unknown as (typeof POPULATION)[number]],
      { readAssignments: read, resolveAssignability: realRevalidation },
    );
    expect(out).toMatchObject({ skillIds: [], degraded: "agent-unresolved" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a THROWING I/O resolver fails closed instead of propagating", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", null, {
      resolveAgentPackage: async () => {
        throw new Error("population read exploded");
      },
      readAssignments: async () => [{ skillId: SKILL_A }],
      resolveAssignability: realRevalidation,
    });
    expect(out).toMatchObject({ skillIds: [], degraded: "agent-unresolved" });
  });
});

describe("resolution-time revalidation matrix (issue AC 4)", () => {
  const assigned = { readAssignments: async () => [{ skillId: SKILL_A }] };

  it("an ACTIVE install is delivered", async () => {
    installRows = [{ packageName: OWNER_PKG, status: "active" }];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([SKILL_A]);
    expect(out.withheld).toEqual([]);
  });

  it("a LOCKED install stays deliverable — locked is a LIVE state", async () => {
    // Driven through the REAL aggregate, which is where `locked` collapses to
    // live. A locked extension is pinned, not retired: withholding it would
    // silently strip an admin's assignment from every run of a pinned agent.
    installRows = [{ packageName: OWNER_PKG, status: "locked" }];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([SKILL_A]);
    expect(out.withheld).toEqual([]);
  });

  it("an ARCHIVED extension is WITHHELD — even though the catalog row survives", async () => {
    // Archiving a skill extension is a catalog NO-OP, and a derived skill's
    // lifecycle_state is NULL (which the delivery gate passes through). Only
    // this revalidation notices.
    installRows = [{ packageName: OWNER_PKG, status: "archived" }];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([]);
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "archived" }]);
    expect(out.degraded).toBeNull();
  });

  it("an UNINSTALLED package (no canonical row at all) is WITHHELD", async () => {
    installRows = [];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([]);
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "not-installed" }]);
  });

  it("a package that vanished from the extension SCAN is WITHHELD", async () => {
    scanned = [];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "no-owning-extension" }]);
  });

  it("LOSS OF GLOBAL VISIBILITY is WITHHELD — every owner-scoping shape", async () => {
    for (const patch of [
      { level: "personal" },
      { level: "team", scope: "team_9" },
      { level: "project", scope: "proj_1" },
      { level: "organization", scope: "org_2" },
      { ownerUserId: "user_42" },
      { isCustomSkill: true },
      {
        level: "workspace",
        accessPolicy: {
          runListVisibility: ["team:team_7"],
          runDataVisibility: ["team:team_7"],
          runExecuteVisibility: ["team:team_7"],
          allowRunSharing: false,
        },
      },
    ] as Array<Partial<PersistedSkill>>) {
      catalogSkills = [skill(patch)];
      const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
        ...assigned,
        resolveAssignability: realRevalidation,
      });
      expect(out.skillIds, JSON.stringify(patch)).toEqual([]);
      expect(out.withheld, JSON.stringify(patch)).toEqual([
        { skillId: SKILL_A, reason: "not-globally-visible" },
      ]);
    }
  });

  it("a ROLE CHANGE to matcher or internal is WITHHELD", async () => {
    for (const role of ["matcher", "internal"]) {
      scanned = [descriptor({ skillRole: role } as Partial<SkillExtensionDescriptor>)];
      const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
        ...assigned,
        resolveAssignability: realRevalidation,
      });
      expect(out.skillIds, role).toEqual([]);
      expect(out.withheld, role).toEqual([{ skillId: SKILL_A, reason: "not-injectable" }]);
    }
  });

  it("a role change declared by a CONSUMER's dependency edge is WITHHELD too", async () => {
    // No `cinatra.skillRole` on the package itself — the role is inferred from a
    // consumer that declares it as a `matcher` edge. Same authoritative source
    // S1 uses; no name suffix, no directory heuristic.
    scanned = [
      descriptor(),
      descriptor({
        pkgName: "@cinatra-ai/some-consumer",
        pkgDirName: "some-consumer",
        kind: "agent",
        slugs: [],
        dependencies: [
          {
            packageName: OWNER_PKG,
            edgeType: "dependencies",
            requirement: "^1.0.0",
            kind: "skill",
            role: "matcher",
          },
        ],
      } as Partial<SkillExtensionDescriptor>),
    ];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "not-injectable" }]);
  });

  it("an id with NO catalog row is WITHHELD", async () => {
    catalogSkills = [];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: realRevalidation,
    });
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "unknown-skill" }]);
  });

  it("keeps the still-assignable rows and withholds only the refused one", async () => {
    catalogSkills = [
      skill(),
      skill({ id: SKILL_B, packageName: OTHER_PKG, slug: "generate-blog-ideas" }),
    ];
    scanned = [
      descriptor(),
      descriptor({ pkgName: OTHER_PKG, pkgDirName: "asset-blog", slugs: ["generate-blog-ideas"] }),
    ];
    // Only the FIRST package is still installed.
    installRows = [{ packageName: OWNER_PKG, status: "active" }];
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [{ skillId: SKILL_A }, { skillId: SKILL_B }],
      resolveAssignability: realRevalidation,
    });
    expect(out.skillIds).toEqual([SKILL_A]);
    expect(out.withheld).toEqual([{ skillId: SKILL_B, reason: "not-installed" }]);
  });

  it("a predicate that returns NO verdict for an id withholds it (never approves by omission)", async () => {
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      ...assigned,
      resolveAssignability: async () => new Map(),
    });
    expect(out.skillIds).toEqual([]);
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "no-verdict" }]);
  });
});

describe("fail-closed arms — the run always proceeds (issue AC 5)", () => {
  it("an assignment-store read ERROR yields the EMPTY set and does NOT reject", async () => {
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => {
        throw new Error("agent_assigned_skills unreadable");
      },
      resolveAssignability: realRevalidation,
    });
    expect(out).toEqual({
      skillIds: [],
      agentPackageName: AGENT_PKG,
      withheld: [],
      degraded: "assignment-read-failed",
    });
  });

  it("a revalidation THROW yields the EMPTY set and does NOT reject", async () => {
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [{ skillId: SKILL_A }],
      resolveAssignability: async () => {
        throw new Error("predicate seam exploded");
      },
    });
    expect(out).toMatchObject({ skillIds: [], degraded: "revalidation-failed" });
  });

  it("the REAL predicate's own read failures refuse every id rather than approving", async () => {
    // Not a restatement of S1's fail-closed tests: this proves the TIER honors
    // the refusal verdicts instead of treating "no approval" as "no opinion".
    const out = await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [{ skillId: SKILL_A }],
      resolveAssignability: (ids) =>
        resolveSkillAssignability(ids, {
          readCatalog: async () => ({ skills: catalogSkills }),
          scanExtensions: async () => scanned,
          readInstallStatus: async () => {
            throw new Error("install status unreadable");
          },
        }),
    });
    expect(out.skillIds).toEqual([]);
    expect(out.withheld).toEqual([{ skillId: SKILL_A, reason: "lifecycle-read-failed" }]);
  });

  it("logs a withheld assignment WITHOUT splicing the id into the log format", async () => {
    // A skill id originates off the wire; a `%s` or newline in it must not be
    // able to forge a log record. Mirrors S1's `forLog` discipline.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    catalogSkills = [];
    await resolveAssignedSkillTier(AGENT_PKG, POPULATION, {
      readAssignments: async () => [{ skillId: "%s\nFORGED evil:id" }],
      resolveAssignability: realRevalidation,
    });
    const call = warn.mock.calls.find((c) => String(c[0]).includes("withheld assignment"));
    expect(call).toBeDefined();
    expect(String(call?.[0])).not.toContain("%s");
    expect(String(call?.[0])).not.toContain("FORGED");
    expect(JSON.stringify(call?.[2])).not.toContain("\\n");
  });
});
