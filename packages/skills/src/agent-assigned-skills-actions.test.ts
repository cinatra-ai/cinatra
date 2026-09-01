// Server actions for direct agent↔skill assignment (cinatra#2346 S1, epic #2345).
//
// Drives the REAL actions through the REAL shared resolver and the REAL shared
// assignability predicate; only the leaf I/O seams (session, catalog, extension
// scan, install status, canonical rows, the DB store) are doubled. The
// lifecycle lock is the REAL `withInstallLock`, so the assign-vs-uninstall
// ordering test proves the actual serialization, not a mock of it.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withInstallLock } from "../../agents/src/materialize-agent-package";

// --- session -----------------------------------------------------------------
let currentSession: { user: { id: string; role: string } } | null = {
  user: { id: "admin_1", role: "admin" },
};

vi.mock("@/lib/auth-session", () => ({
  // Mirrors production semantics: parse the comma-separated role list and
  // refuse anything without `admin`. A crafted request that never rendered the
  // admin page hits exactly this.
  requireAdminSession: async () => {
    if (!currentSession) throw new Error("NEXT_REDIRECT:/login");
    const roles = String(currentSession.user.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!roles.includes("admin")) throw new Error("NEXT_REDIRECT:/not-authorized");
    return currentSession;
  },
}));

// --- installed agents (the resolver's population) ----------------------------
let agentPopulation = [
  {
    packageId: "@cinatra-ai/web-scrape-agent",
    id: "web-scrape-agent",
    identifier: "web-scrape-agent",
    packageSlug: "web-scrape-agent",
    packageName: "Web Scrape",
    humanReadableName: "Web Scrape",
    description: "",
    frontmatter: {},
    content: "",
    sourcePath: "",
    keywords: [],
  },
];
// --- package eligibility (kind + assistant) ---------------------------------
let packageKinds: Record<string, string> = { "@cinatra-ai/web-scrape-agent": "agent" };
let assistantPackages = new Set<string>();

// --- catalog + extension scan + install status ------------------------------
const SKILL_ID = "@cinatra-ai/list-curation-skill:list-curation";
const OWNER_PKG = "@cinatra-ai/list-curation-skill";

let catalogSkills: Array<Record<string, unknown>> = [];
let scanned: Array<Record<string, unknown>> = [];
let installStatus: Record<string, "active" | "archived"> = {};

// ONE seam for every real-world read the slice performs — the whole reason
// `agent-skill-assignment-sources.ts` exists. Doubling it here leaves the
// predicate, the resolver, the write-target gate and the lock ordering REAL.
vi.mock("./agent-skill-assignment-sources", () => ({
  readCatalogSource: async () => ({ skills: catalogSkills }),
  scanExtensionsSource: async () => scanned,
  readInstallStatusSource: async (names: string[]) =>
    new Map(names.filter((n) => n in installStatus).map((n) => [n, installStatus[n]!])),
  readAgentPopulationSource: async () => agentPopulation,
  readPackageKindSource: async (pkg: string) => packageKinds[pkg] ?? null,
  isAssistantPackageSource: async (pkg: string) => assistantPackages.has(pkg),
}));

// --- the REAL lifecycle lock -------------------------------------------------
vi.mock("@cinatra-ai/agents", () => ({ withInstallLock }));

// --- the DB store (in-memory, cap-enforcing) --------------------------------
type Row = {
  // The scope tuple (cinatra#2813 S1). These actions have no scope of
  // their own yet, so they write and read the WORKSPACE tier — which is
  // exactly what package-global assignment always meant.
  scopeKind: "workspace" | "organization" | "team" | "project" | "user";
  scopeId: string;
  source: "manual" | "recommended";
  originRunId: string | null;
  agentPackageName: string;
  skillId: string;
  position: number;
  createdBy: string;
  createdAt: string;
};
let rows: Row[] = [];
// cinatra#2813 S1 (epic #2812): "cap raised 3 to 5 per (package, exact
// scope)". These actions carry no scope of their own yet, so the tier they
// write is the workspace one and the cap they meet is that scope's five.
// The mocked export below repeats the number as a LITERAL rather than reading
// this constant: `vi.mock` factories are hoisted above it, so a reference here
// is a temporal-dead-zone crash at import, not a coupling. The two are kept in
// step by this comment and by the store's own cap fixture.
const CAP = 5;
const insertSpy = vi.fn();
vi.mock("@/lib/agent-assigned-skills-store", () => ({
  AGENT_ASSIGNED_SKILLS_CAP: 5, // keep in step with CAP above
  readAssignedSkillsForAgentPackage: async (pkg: string) =>
    rows.filter((r) => r.agentPackageName === pkg).sort((a, b) => a.position - b.position),
  insertAssignedSkill: async (input: {
    agentPackageName: string;
    skillId: string;
    createdBy: string;
  }) => {
    insertSpy(input);
    const mine = rows.filter((r) => r.agentPackageName === input.agentPackageName);
    const existing = mine.find((r) => r.skillId === input.skillId);
    if (existing) return { outcome: "already_assigned", row: existing };
    if (mine.length >= CAP) return { outcome: "cap_exceeded", count: mine.length };
    const row: Row = {
      scopeKind: "workspace",
      scopeId: "__workspace__",
      source: "manual",
      originRunId: null,
      agentPackageName: input.agentPackageName,
      skillId: input.skillId,
      position: mine.reduce((m, r) => Math.max(m, r.position), 0) + 1,
      createdBy: input.createdBy,
      createdAt: new Date("2026-08-03T00:00:00.000Z").toISOString(),
    };
    rows.push(row);
    return { outcome: "assigned", row };
  },
  deleteAssignedSkill: async (input: { agentPackageName: string; skillId: string }) => {
    const before = rows.length;
    rows = rows.filter(
      (r) => !(r.agentPackageName === input.agentPackageName && r.skillId === input.skillId),
    );
    return { deleted: rows.length < before };
  },
}));

import {
  assignAgentSkill,
  listAssignedAgentSkills,
  removeAgentSkill,
} from "./agent-assigned-skills-actions";

function catalogRow(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name: id.split(":").pop(),
    slug: id.split(":").pop(),
    description: `desc for ${id}`,
    content: "",
    packageId: "pkg",
    packageName: OWNER_PKG,
    packageSlug: "cinatra-ai-list-curation-skill",
    usedBy: [],
    level: "workspace",
    ...patch,
  };
}

function skillExtension(pkgName: string, slugs: string[], patch: Record<string, unknown> = {}) {
  return {
    pkgDir: `/ext/${pkgName}`,
    pkgName,
    pkgDirName: pkgName.split("/").pop(),
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs,
    ...patch,
  };
}

beforeEach(() => {
  currentSession = { user: { id: "admin_1", role: "admin" } };
  agentPopulation = [
    {
      packageId: "@cinatra-ai/web-scrape-agent",
      id: "web-scrape-agent",
      identifier: "web-scrape-agent",
      packageSlug: "web-scrape-agent",
      packageName: "Web Scrape",
      humanReadableName: "Web Scrape",
      description: "",
      frontmatter: {},
      content: "",
      sourcePath: "",
      keywords: [],
    },
  ];
  packageKinds = { "@cinatra-ai/web-scrape-agent": "agent" };
  assistantPackages = new Set<string>();
  catalogSkills = [catalogRow(SKILL_ID)];
  scanned = [skillExtension(OWNER_PKG, ["list-curation"])];
  installStatus = { [OWNER_PKG]: "active" };
  rows = [];
  insertSpy.mockClear();
});

// ---------------------------------------------------------------------------

describe("admin re-assertion + server-derived target (crafted-request test)", () => {
  it("REJECTS a non-admin write and never touches the store", async () => {
    currentSession = { user: { id: "mallory", role: "user" } };
    await expect(
      assignAgentSkill({ agentRef: "@cinatra-ai/web-scrape-agent", skillId: SKILL_ID }),
    ).rejects.toThrow(/not-authorized/);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("REJECTS an unauthenticated write", async () => {
    currentSession = null;
    await expect(
      removeAgentSkill({ agentRef: "@cinatra-ai/web-scrape-agent", skillId: SKILL_ID }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(rows).toHaveLength(0);
  });

  it("REJECTS a non-admin read", async () => {
    currentSession = { user: { id: "mallory", role: "user,editor" } };
    await expect(listAssignedAgentSkills("@cinatra-ai/web-scrape-agent")).rejects.toThrow(
      /not-authorized/,
    );
  });

  it("IGNORES crafted target/creator/position fields — all are server-derived", async () => {
    const crafted = {
      agentRef: "web-scrape-agent",
      skillId: SKILL_ID,
      // Everything below is attacker-supplied noise the action must not read.
      agentPackageName: "@evil/other-agent",
      templateId: "tmpl_evil",
      createdBy: "root",
      position: 99,
      cap: 999,
    } as unknown as { agentRef: string; skillId: string };

    const out = await assignAgentSkill(crafted);
    expect(out).toMatchObject({ ok: true, agentPackageName: "@cinatra-ai/web-scrape-agent" });
    expect(insertSpy).toHaveBeenCalledWith({
      // Derived from the authorized settings context, not from the payload.
      agentPackageName: "@cinatra-ai/web-scrape-agent",
      skillId: SKILL_ID,
      // The SESSION principal, not the payload's `createdBy`.
      createdBy: "admin_1",
    });
    expect(rows[0]).toMatchObject({ position: 1, createdBy: "admin_1" });
  });

  it("REFUSES an unresolvable agent reference rather than writing under a raw key", async () => {
    await expect(
      assignAgentSkill({ agentRef: "@ghost/not-installed", skillId: SKILL_ID }),
    ).resolves.toEqual({ ok: false, reason: "unknown-agent" });
    expect(rows).toHaveLength(0);
  });

  it("REFUSES an AMBIGUOUS agent reference", async () => {
    agentPopulation = [
      { ...agentPopulation[0]!, packageId: "@vendor-a/research-agent", id: "a", identifier: "a", packageSlug: "a" },
      { ...agentPopulation[0]!, packageId: "@vendor-b/research-agent", id: "b", identifier: "b", packageSlug: "b" },
    ];
    await expect(assignAgentSkill({ agentRef: "research-agent", skillId: SKILL_ID })).resolves.toEqual(
      { ok: false, reason: "ambiguous-agent" },
    );
  });

  it("ADMITS an assistant target (cinatra#2813 S1, epic #2812)", async () => {
    // The write gate no longer refuses assistants — the epic makes them
    // first-class assignment targets. The row lands; whether an assistant's
    // assigned skills are DELIVERED at run time is a separate seam.
    assistantPackages.add("@cinatra-ai/web-scrape-agent");
    const out = await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    expect(out.ok).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("REFUSES a non-agent target (a connector settings page)", async () => {
    packageKinds = { "@cinatra-ai/web-scrape-agent": "connector" };
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toEqual({ ok: false, reason: "not-an-agent" });
    expect(rows).toHaveLength(0);
  });
});

describe("assignability enforcement on assign (the picker filter is NOT the enforcement)", () => {
  it("REFUSES an unknown skill id", async () => {
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: "@nope/nope:nope" }),
    ).resolves.toMatchObject({ ok: false, reason: "unknown-skill" });
    expect(rows).toHaveLength(0);
  });

  it("REFUSES an empty skill id", async () => {
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: "   " }),
    ).resolves.toEqual({ ok: false, reason: "unknown-skill" });
  });

  it("REFUSES a NON-globally-visible skill (personal / owner-scoped)", async () => {
    catalogSkills = [catalogRow(SKILL_ID, { level: "personal", ownerUserId: "user_9" })];
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: false, reason: "not-assignable", detail: "not-globally-visible" });
    expect(rows).toHaveLength(0);
  });

  it("REFUSES a NON-injectable (matcher-role) skill", async () => {
    scanned = [
      skillExtension(OWNER_PKG, ["list-curation"]),
      {
        ...skillExtension("@cinatra-ai/some-artifact", [], { kind: "artifact" }),
        dependencies: [
          {
            packageName: OWNER_PKG,
            kind: "skill",
            role: "matcher",
            edgeType: "runtime",
            requirement: "required",
          },
        ],
      },
    ];
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: false, reason: "not-assignable", detail: "not-injectable" });
    expect(rows).toHaveLength(0);
  });

  it("REFUSES a skill whose owning extension has NO canonical install row", async () => {
    installStatus = {};
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: false, reason: "not-assignable", detail: "not-installed" });
  });

  it("REFUSES a skill whose owning extension is archived", async () => {
    installStatus = { [OWNER_PKG]: "archived" };
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: false, reason: "not-assignable", detail: "archived" });
  });
});

describe(`the ${CAP}-cap`, () => {
  function addSkill(n: number) {
    const id = `@cinatra-ai/pack-${n}-skill:s${n}`;
    catalogSkills.push(catalogRow(id, { packageName: `@cinatra-ai/pack-${n}-skill` }));
    scanned.push(skillExtension(`@cinatra-ai/pack-${n}-skill`, [`s${n}`]));
    installStatus[`@cinatra-ai/pack-${n}-skill`] = "active";
    return id;
  }

  // Counted off CAP rather than spelled out, so the number lives in exactly one
  // place in this file and the next time the cap moves this case moves with it.
  it(`accepts ${CAP} and REJECTS the one after it server-side`, async () => {
    const ids = [SKILL_ID, ...Array.from({ length: CAP - 1 }, (_, i) => addSkill(i + 2))];
    for (const id of ids) {
      await expect(assignAgentSkill({ agentRef: "web-scrape-agent", skillId: id })).resolves.toMatchObject(
        { ok: true },
      );
    }
    expect(rows.map((r) => r.position)).toEqual(
      Array.from({ length: CAP }, (_, i) => i + 1),
    );

    const overflow = addSkill(CAP + 1);
    await expect(
      assignAgentSkill({ agentRef: "web-scrape-agent", skillId: overflow }),
    ).resolves.toMatchObject({ ok: false, reason: "cap-exceeded" });
    expect(rows).toHaveLength(CAP);
  });

  it("a duplicate assign is idempotent and does NOT consume a cap slot", async () => {
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    const again = await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    expect(again).toMatchObject({ ok: true, alreadyAssigned: true, position: 1 });
    expect(rows).toHaveLength(1);
  });

  it("the cap is PER AGENT PACKAGE, not global", async () => {
    agentPopulation.push({
      ...agentPopulation[0]!,
      packageId: "@cinatra-ai/other-agent",
      id: "other-agent",
      identifier: "other-agent",
      packageSlug: "other-agent",
    });
    packageKinds["@cinatra-ai/other-agent"] = "agent";
    const ids = [SKILL_ID, addSkill(2), addSkill(3)];
    for (const id of ids) await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: id });
    await expect(
      assignAgentSkill({ agentRef: "other-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: true, agentPackageName: "@cinatra-ai/other-agent" });
  });
});

describe("removal — down to zero", () => {
  it("removes every assignment, one at a time, with NO last-row floor", async () => {
    const second = "@cinatra-ai/pack-2-skill:s2";
    catalogSkills.push(catalogRow(second, { packageName: "@cinatra-ai/pack-2-skill" }));
    scanned.push(skillExtension("@cinatra-ai/pack-2-skill", ["s2"]));
    installStatus["@cinatra-ai/pack-2-skill"] = "active";

    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: second });
    expect(rows).toHaveLength(2);

    await expect(
      removeAgentSkill({ agentRef: "web-scrape-agent", skillId: second }),
    ).resolves.toMatchObject({ ok: true, removed: true });
    await expect(
      removeAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: true, removed: true });
    expect(rows).toHaveLength(0);

    const listed = await listAssignedAgentSkills("web-scrape-agent");
    expect(listed).toMatchObject({ ok: true, skills: [] });
  });

  it("removes an ARCHIVED assignment (removal never consults assignability)", async () => {
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    installStatus = { [OWNER_PKG]: "archived" };
    await expect(
      removeAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: true, removed: true });
    expect(rows).toHaveLength(0);
  });

  it("removing what is already gone is idempotent", async () => {
    await expect(
      removeAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }),
    ).resolves.toMatchObject({ ok: true, removed: false });
  });
});

describe("listAssignedAgentSkills — hydration incl. degraded rows", () => {
  it("returns ORDERED rows with display metadata and status", async () => {
    const second = "@cinatra-ai/pack-2-skill:s2";
    catalogSkills.push(catalogRow(second, { packageName: "@cinatra-ai/pack-2-skill" }));
    scanned.push(skillExtension("@cinatra-ai/pack-2-skill", ["s2"]));
    installStatus["@cinatra-ai/pack-2-skill"] = "active";

    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: second });
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });

    const out = await listAssignedAgentSkills("web-scrape-agent");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.agentPackageName).toBe("@cinatra-ai/web-scrape-agent");
    expect(out.skills.map((s) => s.skillId)).toEqual([second, SKILL_ID]);
    expect(out.skills.map((s) => s.position)).toEqual([1, 2]);
    expect(out.skills[0]).toMatchObject({
      name: "s2",
      description: `desc for ${second}`,
      ownerPackageName: "@cinatra-ai/pack-2-skill",
      status: "ok",
      assignable: true,
      createdBy: "admin_1",
    });
  });

  it("KEEPS an ARCHIVED assigned skill visible, with status 'archived'", async () => {
    // The S4 list cannot hydrate this from the S3 search — the search
    // deliberately excludes it — so the hydration read has to carry it.
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    installStatus = { [OWNER_PKG]: "archived" };

    const out = await listAssignedAgentSkills("web-scrape-agent");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0]).toMatchObject({
      skillId: SKILL_ID,
      status: "archived",
      assignable: false,
      // Still hydrated: the catalog row survives an archive, so the admin sees
      // a NAME to remove, not an opaque id.
      name: "list-curation",
    });
  });

  it("KEEPS a ROLE-CHANGED assigned skill visible, with status 'role-changed'", async () => {
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    scanned = [
      skillExtension(OWNER_PKG, ["list-curation"], { skillRole: "internal" }),
    ];

    const out = await listAssignedAgentSkills("web-scrape-agent");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.skills[0]).toMatchObject({ status: "role-changed", assignable: false });
  });

  it("falls back to the raw id when the catalog row is gone", async () => {
    await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    catalogSkills = [];
    const out = await listAssignedAgentSkills("web-scrape-agent");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.skills[0]).toMatchObject({ skillId: SKILL_ID, name: SKILL_ID, status: "missing" });
  });

  it("resolves the same rows from a RAW BRIDGE SLUG and the SCOPED name", async () => {
    await assignAgentSkill({ agentRef: "@cinatra-ai/web-scrape-agent", skillId: SKILL_ID });
    const bySlug = await listAssignedAgentSkills("web-scrape-agent");
    const byScoped = await listAssignedAgentSkills("@cinatra-ai/web-scrape-agent");
    expect(bySlug).toEqual(byScoped);
    expect(bySlug.ok && bySlug.skills).toHaveLength(1);
  });
});

describe("assign-vs-uninstall race — the lifecycle lock is the ordering", () => {
  it("an assign issued while an UNINSTALL holds the skill's lifecycle lock never lands after cleanup", async () => {
    const order: string[] = [];
    let releaseUninstall!: () => void;
    const uninstallGate = new Promise<void>((res) => {
      releaseUninstall = res;
    });

    // The uninstall path runs under the SAME per-package lifecycle lock.
    const uninstall = withInstallLock(OWNER_PKG, async () => {
      order.push("uninstall:start");
      await uninstallGate;
      // Teardown: the package's rows go away and its extension leaves the scan.
      installStatus = {};
      scanned = [];
      catalogSkills = [];
      order.push("uninstall:end");
    });

    // Issued while the uninstall holds the lock.
    const assign = assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }).then(
      (r) => {
        order.push("assign:done");
        return r;
      },
    );

    // Give the assign a chance to reach the lock and block on it.
    await new Promise((r) => setTimeout(r, 25));
    releaseUninstall();
    const [, result] = await Promise.all([uninstall, assign]);

    // The assign WAITED for the lifecycle lock and then refused, because the
    // revalidation under the lock saw the uninstalled state.
    expect(order).toEqual(["uninstall:start", "uninstall:end", "assign:done"]);
    expect(result).toMatchObject({ ok: false });
    // Crucially: NO row landed after the teardown.
    expect(rows).toHaveLength(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("COMPENSATES a row whose skill became unassignable between revalidation and commit", async () => {
    // Codex round-1 finding: the lifecycle lock is PROCESS-LOCAL, so a sibling
    // worker's uninstall can complete inside the assign's transaction window.
    // The post-commit re-check under the still-held lock deletes the row it
    // just wrote, instead of leaving one the teardown already swept past.
    let inserts = 0;
    const deps = await import("@/lib/agent-assigned-skills-store");
    const spy = vi.spyOn(deps, "insertAssignedSkill").mockImplementation(async (input) => {
      inserts += 1;
      const r: Row = {
        scopeKind: "workspace",
        scopeId: "__workspace__",
        source: "manual",
        originRunId: null,
        agentPackageName: input.agentPackageName,
        skillId: input.skillId,
        position: 1,
        createdBy: input.createdBy,
        createdAt: "2026-08-03T00:00:00.000Z",
      };
      rows.push(r);
      // The sibling process's teardown lands right here.
      installStatus = {};
      scanned = [];
      return { outcome: "assigned", row: r };
    });

    const out = await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    expect(inserts).toBe(1);
    expect(out).toMatchObject({ ok: false, reason: "not-assignable" });
    // The row it wrote is GONE — never left behind for the runtime to read.
    expect(rows).toHaveLength(0);
    spy.mockRestore();
  });

  it("a THROWN post-commit re-check is treated as a regression (fail-closed)", async () => {
    const storeDeps = await import("@/lib/agent-assigned-skills-store");
    const spy = vi.spyOn(storeDeps, "insertAssignedSkill").mockImplementation(async (input) => {
      const r: Row = {
        scopeKind: "workspace",
        scopeId: "__workspace__",
        source: "manual",
        originRunId: null,
        agentPackageName: input.agentPackageName,
        skillId: input.skillId,
        position: 1,
        createdBy: input.createdBy,
        createdAt: "2026-08-03T00:00:00.000Z",
      };
      rows.push(r);
      // The re-check's catalog read now blows up.
      catalogSkills = null as never;
      return { outcome: "assigned", row: r };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID });
    expect(out).toMatchObject({ ok: false, reason: "not-assignable" });
    expect(rows).toHaveLength(0);
    spy.mockRestore();
    warn.mockRestore();
  });

  it("an assign that WINS the lock completes BEFORE the uninstall's teardown runs", async () => {
    const order: string[] = [];
    // The assign acquires first; the uninstall queues behind it.
    const assign = assignAgentSkill({ agentRef: "web-scrape-agent", skillId: SKILL_ID }).then(
      (r) => {
        order.push("assign:done");
        return r;
      },
    );
    // Let the assign get past its pre-lock work (admin, target derivation,
    // owner resolution) and actually hold the lifecycle lock.
    await new Promise((r) => setTimeout(r, 25));
    const uninstall = withInstallLock(OWNER_PKG, async () => {
      order.push("uninstall:start");
      installStatus = {};
      scanned = [];
    });

    const [result] = await Promise.all([assign, uninstall]);
    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(["assign:done", "uninstall:start"]);
    expect(rows).toHaveLength(1);
  });
});
