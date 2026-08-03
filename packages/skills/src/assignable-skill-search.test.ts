// The ASSIGNABLE-SKILL POPULATION (cinatra#2348 S3, epic #2345).
//
// This is the picker's answer to "which skills may an admin pin right now".
// Every assertion below exists because getting it wrong is invisible in the UI
// until it is wrong in production:
//
//   * a `matcher` / `internal` skill offered here is a skill an admin can
//     select and then fails to save (the write path re-validates);
//   * a virtual-namespace successor skill derived as `<pkg>:<slug>` names a
//     catalog row that does not exist, so five first-party skills vanish;
//   * a `locked` install dropped from the population makes every
//     system/required skill unassignable;
//   * a syncing catalog read turns one keystroke into one full rebuild.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { listAssignableSkillCandidates } from "./assignable-skill-search";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";
import type { PersistedSkill } from "./skills-store";

function skill(overrides: Partial<PersistedSkill> = {}): PersistedSkill {
  return {
    id: "@acme/widget-skills:do-thing",
    name: "Do Thing",
    slug: "do-thing",
    description: "Does the thing.",
    content: "",
    packageId: "pkg",
    packageName: "@acme/widget-skills",
    packageSlug: "acme-widget-skills",
    usedBy: [],
    level: "workspace",
    ...overrides,
  } as PersistedSkill;
}

function descriptor(overrides: Partial<SkillExtensionDescriptor> = {}): SkillExtensionDescriptor {
  return {
    pkgDir: "/x",
    pkgName: "@acme/widget-skills",
    pkgDirName: "widget-skills",
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs: ["do-thing"],
    ...overrides,
  };
}

/** Every package live unless named otherwise. */
function statuses(map: Record<string, "active" | "archived"> = {}) {
  return async (names: string[]) => {
    const out = new Map<string, "active" | "archived">();
    for (const n of names) {
      const explicit = map[n];
      if (explicit) out.set(n, explicit);
      else if (!(n in map)) out.set(n, "active");
    }
    return out;
  };
}

/** Nothing installed at all — the "no canonical row" shape. */
const noInstalls = async () => new Map<string, "active" | "archived">();

describe("listAssignableSkillCandidates — the population", () => {
  it("returns an assignable skill with its catalog id, name and manifest metadata", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [
        descriptor({
          displayName: "Widget Skills",
          vendorName: "Acme Corporation",
          author: "Acme Publishing",
        }),
      ],
      readInstallStatus: statuses(),
    });
    expect(rows).toEqual([
      {
        skillId: "@acme/widget-skills:do-thing",
        skillName: "Do Thing",
        skillDescription: "Does the thing.",
        ownerPackageName: "@acme/widget-skills",
        ownerPackageCandidates: ["@acme/widget-skills", "acme-widget-skills"],
        extensionDisplayName: "Widget Skills",
        extensionVendorName: "Acme Corporation",
        extensionAuthor: "Acme Publishing",
        role: "injectable",
      },
    ]);
  });

  it("puts the CANONICAL name first in the candidate keys", async () => {
    // A consumer reading canonical install rows for the badge applies
    // exact-first; the ordering is part of the contract, not incidental.
    const [row] = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses(),
    });
    expect(row!.ownerPackageCandidates[0]).toBe("@acme/widget-skills");
  });

  it("DROPS a drift key that is another scanned package's canonical name", async () => {
    // `slugify` is lossy: `@acme/widget-skills` and a package literally named
    // `acme-widget-skills` share a candidate key. The unrelated package's
    // install rows must never be able to vouch for this one, so the collided
    // key is dropped — the same rule the shared predicate applies.
    const [row] = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [
        descriptor(),
        descriptor({
          pkgName: "acme-widget-skills",
          pkgDirName: "acme-widget-skills",
          slugs: [],
        }),
      ],
      readInstallStatus: statuses(),
    });
    expect(row!.ownerPackageCandidates).toEqual(["@acme/widget-skills"]);
  });

  it("carries NULL (not undefined) for metadata the manifest never declared", async () => {
    const [row] = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses(),
    });
    expect(row).toMatchObject({
      extensionDisplayName: null,
      extensionVendorName: null,
      extensionAuthor: null,
    });
  });

  // -------------------------------------------------------------------------
  // AC: `matcher`/`internal` never returned; undeclared-role skills ARE.
  // -------------------------------------------------------------------------

  it("NEVER returns a matcher-role or internal-role skill", async () => {
    for (const role of ["matcher", "internal"] as const) {
      const rows = await listAssignableSkillCandidates({
        readCatalogSnapshot: async () => ({ skills: [skill()] }),
        scanExtensions: async () => [descriptor({ skillRole: role })],
        readInstallStatus: statuses(),
      });
      expect(rows, `role=${role} must not be offered`).toEqual([]);
    }
  });

  it("NEVER returns a skill a CONSUMER's dependency edge marks pipeline-consumed", async () => {
    // The demotion can come from another extension's declared edge, not only
    // from the skill package's own manifest — the picker must honour both.
    for (const edgeRole of ["matcher", "authoring"] as const) {
      const rows = await listAssignableSkillCandidates({
        readCatalogSnapshot: async () => ({ skills: [skill()] }),
        scanExtensions: async () => [
          descriptor(),
          descriptor({
            pkgName: "@acme/consumer-agent",
            pkgDirName: "consumer-agent",
            kind: "agent",
            slugs: [],
            dependencies: [
              {
                packageName: "@acme/widget-skills",
                edgeType: "runtime",
                requirement: "required",
                kind: "skill",
                role: edgeRole,
              },
            ],
          }),
        ],
        readInstallStatus: statuses(),
      });
      expect(rows, `edge role=${edgeRole} must not be offered`).toEqual([]);
    }
  });

  it("RETURNS a skill whose package declares NO role (the injectable default)", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor({ skillRole: undefined })],
      readInstallStatus: statuses(),
    });
    expect(rows.map((r) => r.skillId)).toEqual(["@acme/widget-skills:do-thing"]);
    expect(rows[0]!.role).toBe("injectable");
  });

  it("RETURNS a skill reached by a dependency edge that declares no role", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [
        descriptor(),
        descriptor({
          pkgName: "@acme/consumer-agent",
          pkgDirName: "consumer-agent",
          kind: "agent",
          slugs: [],
          dependencies: [
            {
              packageName: "@acme/widget-skills",
              edgeType: "runtime",
              requirement: "required",
              kind: "skill",
            },
          ],
        }),
      ],
      readInstallStatus: statuses(),
    });
    expect(rows.map((r) => r.skillId)).toEqual(["@acme/widget-skills:do-thing"]);
  });

  // -------------------------------------------------------------------------
  // AC: virtual-namespace successor skills return their CORRECT catalog ids.
  // -------------------------------------------------------------------------

  it("derives the VIRTUAL chat-namespace id for a successor package, not <pkg>:<slug>", async () => {
    const chatSkill = skill({
      id: "@cinatra-ai/chat:blog-content",
      name: "Blog Content",
      slug: "blog-content",
      packageName: "@cinatra-ai/chat",
    });
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [chatSkill] }),
      scanExtensions: async () => [
        descriptor({
          pkgName: "@cinatra-ai/blog-content-skill",
          pkgDirName: "blog-content-skill",
          slugs: ["blog-content"],
          displayName: "Blog Content",
        }),
      ],
      // The lifecycle row belongs to the REAL package, never the virtual one.
      readInstallStatus: statuses({ "@cinatra-ai/blog-content-skill": "active" }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skillId).toBe("@cinatra-ai/chat:blog-content");
    // The naive derivation would have been this — and it names no catalog row.
    expect(rows[0]!.skillId).not.toBe("@cinatra-ai/blog-content-skill:blog-content");
    // The OWNER stays the real package: that is what carries the install row
    // and the lifecycle lock the write path takes.
    expect(rows[0]!.ownerPackageName).toBe("@cinatra-ai/blog-content-skill");
  });

  it("covers all FIVE chat successor packages", async () => {
    const successors: Array<[string, string]> = [
      ["chat-assistant-core-skill", "chat-assistant-core"],
      ["extension-authoring-skill", "extension-authoring"],
      ["automation-authoring-skill", "automation-authoring"],
      ["company-research-skill", "company-research"],
      ["blog-content-skill", "blog-content"],
    ];
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({
        skills: successors.map(([, slug]) =>
          skill({ id: `@cinatra-ai/chat:${slug}`, slug, packageName: "@cinatra-ai/chat" }),
        ),
      }),
      scanExtensions: async () =>
        successors.map(([dir, slug]) =>
          descriptor({
            pkgName: `@cinatra-ai/${dir}`,
            pkgDirName: dir,
            slugs: [slug],
          }),
        ),
      readInstallStatus: statuses(),
    });
    expect(rows.map((r) => r.skillId).sort()).toEqual(
      successors.map(([, slug]) => `@cinatra-ai/chat:${slug}`).sort(),
    );
  });

  // -------------------------------------------------------------------------
  // AC: LOCKED installs are listed; UNINSTALLED ones are not.
  // -------------------------------------------------------------------------

  it("LISTS a locked-install skill (locked is live, per the installed-rows rule)", async () => {
    // The canonical status reader collapses active|locked to "active" — that
    // collapse IS the locked-counts-as-live rule, and the population inherits
    // it rather than re-deriving liveness.
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses({ "@acme/widget-skills": "active" }),
    });
    expect(rows.map((r) => r.skillId)).toEqual(["@acme/widget-skills:do-thing"]);
  });

  it("does NOT list a skill whose extension has NO canonical install row", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: noInstalls,
    });
    expect(rows).toEqual([]);
  });

  it("does NOT list a skill whose extension is ARCHIVED", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses({ "@acme/widget-skills": "archived" }),
    });
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Population boundaries.
  // -------------------------------------------------------------------------

  it("does NOT list an owner-scoped or user-authored catalog skill", async () => {
    const scoped: Array<Partial<PersistedSkill>> = [
      { level: "personal" },
      { level: "team", scope: "team_1" },
      { level: "agent", agentId: "@acme/some-agent" },
      { isCustomSkill: true },
      { ownerUserId: "user_1" },
    ];
    for (const patch of scoped) {
      const rows = await listAssignableSkillCandidates({
        readCatalogSnapshot: async () => ({ skills: [skill(patch)] }),
        scanExtensions: async () => [descriptor()],
        readInstallStatus: statuses(),
      });
      expect(rows, JSON.stringify(patch)).toEqual([]);
    }
  });

  it("does NOT list a catalog skill NO scanned extension owns", async () => {
    // A hand-authored custom skill has a catalog row and no owning package;
    // starting the candidate set from the SCAN keeps it out structurally.
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({
        skills: [skill({ id: "custom:hand-written", packageName: "custom" })],
      }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses(),
    });
    expect(rows).toEqual([]);
  });

  it("does NOT list a scanned skill dir that has no catalog row yet", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses(),
    });
    expect(rows).toEqual([]);
  });

  it("ignores NON-skill-kind extensions when building the candidate set", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor({ kind: "agent" })],
      readInstallStatus: statuses(),
    });
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Fail-closed.
  // -------------------------------------------------------------------------

  it("offers NOTHING when the catalog snapshot read fails", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => {
        throw new Error("catalog down");
      },
      scanExtensions: async () => [descriptor()],
      readInstallStatus: statuses(),
    });
    expect(rows).toEqual([]);
  });

  it("offers NOTHING when the extension scan fails", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => {
        throw new Error("scan down");
      },
      readInstallStatus: statuses(),
    });
    expect(rows).toEqual([]);
  });

  it("offers NOTHING when the install-status read fails (never assumes live)", async () => {
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [skill()] }),
      scanExtensions: async () => [descriptor()],
      readInstallStatus: async () => {
        throw new Error("lifecycle down");
      },
    });
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ONE read of each source — the typeahead cost contract.
  // -------------------------------------------------------------------------

  it("reads the catalog ONCE and the scan ONCE for a whole population pass", async () => {
    // The predicate accepts injected sources; passing the already-read values
    // through them is what keeps a keystroke from firing two catalog reads AND
    // guarantees both halves decide on the same snapshot.
    const readCatalogSnapshot = vi.fn(async () => ({
      skills: [skill(), skill({ id: "@acme/widget-skills:other", slug: "other", name: "Other" })],
    }));
    const scanExtensions = vi.fn(async () => [descriptor({ slugs: ["do-thing", "other"] })]);
    const readInstallStatus = vi.fn(statuses());
    const rows = await listAssignableSkillCandidates({
      readCatalogSnapshot,
      scanExtensions,
      readInstallStatus,
    });
    expect(rows).toHaveLength(2);
    expect(readCatalogSnapshot).toHaveBeenCalledTimes(1);
    expect(scanExtensions).toHaveBeenCalledTimes(1);
    expect(readInstallStatus).toHaveBeenCalledTimes(1);
  });

  it("defaults its catalog read to the PURE snapshot, never the syncing read", async () => {
    // Guards the cost contract at the SEAM: the default source must resolve to
    // `readSkillsCatalogSnapshot` (no scan/write/enqueue), not to
    // `readSkillsCatalog`, which is `syncInstalledSkillsToDatabase()`.
    const sources = await import("./agent-skill-assignment-sources");
    const snapshotSource = String(sources.readCatalogSnapshotSource);
    expect(snapshotSource).toContain("readSkillsCatalogSnapshot");
    expect(snapshotSource).not.toContain("readSkillsCatalog(");
  });
});
