import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STRUCTURAL locks on concept B's write seam (cinatra#2474 PR5).
 *
 * These guard properties a behavioural test cannot see, because they are about
 * what the code CANNOT be made to do, not what it does:
 *
 *   - the action module obeys the `"use server"` contract (async exports only) —
 *     a non-async export there is a build-time footgun that a unit test running
 *     the module directly would never surface;
 *   - the write has exactly ONE client-reachable entry point, and the surface it
 *     acts on is BOUND server-side rather than accepted from the browser;
 *   - no landing binds its own action or hands the write a ref — the one node
 *     builder does it, from the descriptor it read with;
 *   - the write re-authorizes by CALLING PR4's gates rather than restating them.
 */
const APP = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(APP, rel), "utf8");
/** Strip comments so a "no X" check tests the CODE, not the prose about it. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ACTIONS = read("lib/dashboards/installed-catalog-actions.ts");
const WRITE = read("lib/dashboards/installed-catalog-write.ts");
const NODE = read("components/dashboards/scope-catalog-node.tsx");
const SECTION = read("components/dashboards/scope-catalog-section.tsx");

const LANDINGS = [
  path.resolve(APP, "../packages/dashboards/src/screens/personal-dashboard.tsx"),
  path.resolve(APP, "../packages/dashboards/src/screens/team-detail-dashboard.tsx"),
  path.resolve(
    APP,
    "../packages/dashboards/src/screens/organization-detail-dashboard.tsx",
  ),
  path.resolve(APP, "app/projects/[projectId]/page.tsx"),
].map((p) => [path.basename(p), readFileSync(p, "utf8")] as const);

describe("the `use server` module", () => {
  it("declares the directive and exports ONLY async functions", () => {
    expect(ACTIONS.startsWith('"use server";')).toBe(true);
    const exports = [...strip(ACTIONS).matchAll(/^export\s+(.+?)[\s({]/gm)].map(
      (m) => m[1],
    );
    expect(exports.length).toBeGreaterThan(0);
    for (const e of exports) expect(e).toBe("async");
    // A type re-export would also violate the contract — the result and surface
    // types live in the provider-neutral contract module.
    expect(strip(ACTIONS)).not.toMatch(/^export\s+(type|const|interface)/m);
  });

  it("exposes exactly ONE action", () => {
    const fns = [...strip(ACTIONS).matchAll(/^export async function (\w+)/gm)];
    expect(fns.map((m) => m[1])).toEqual(["addInstalledCatalogDashboardAction"]);
  });

  it("resolves the actor from the LIVE session, never from an argument", () => {
    expect(ACTIONS).toMatch(/const actor = await getActorContext\(\)/);
    expect(strip(ACTIONS)).not.toMatch(/actor\s*[:,]\s*ActorContext/);
  });
});

describe("the surface is bound server-side, and reaches the write only from the node builder", () => {
  it("the ONE node builder binds the action to the SAME descriptor it read with", () => {
    expect(NODE).toMatch(
      /add: addInstalledCatalogDashboardAction\.bind\(null, args\.surface\)/,
    );
    expect(NODE).toMatch(/listInstalledCatalogTemplates\(\{\s*\n?\s*actor: args\.actor,\s*\n?\s*surface: args\.surface,/);
  });

  it("no landing imports the action, binds its own, or hands the write a ref", () => {
    for (const [name, src] of LANDINGS) {
      expect(name && src).toBeTruthy();
      expect(src).not.toContain("installed-catalog-actions");
      expect(src).not.toContain("addInstalledCatalogDashboardAction");
      expect(src).not.toContain("ScopeCatalogSource");
      // Every landing that HAS an add path goes through the one builder. A
      // landing with no Add at all builds no node (cinatra#2807 fix leg 3: the
      // drawing gives the personal scope's Dashboards tab no Add of any kind),
      // which is the same invariant at its strongest — nothing to bind.
      if (src.includes("<ScopeAddSourcesProvider")) {
        expect(src).toContain("buildScopeCatalogNode");
      } else {
        expect(src).not.toContain("buildScopeCatalogNode");
      }
    }
  });

  it("the section takes a bound source and never constructs a destination", () => {
    expect(SECTION).toMatch(/source\s*\.add\(template\.templateId\)/);
    const c = strip(SECTION);
    for (const forbidden of [
      "entityType",
      "ownerLevel",
      "ownerId",
      "orgId",
      "organizationId",
      "scopeId",
    ]) {
      expect(c).not.toContain(forbidden);
    }
  });
});

describe("the write re-authorizes by RUNNING PR4's gates", () => {
  it("calls the read module's own destination + admission functions", () => {
    expect(WRITE).toMatch(/from "\.\/installed-catalog-read"/);
    expect(WRITE).toMatch(/resolveCatalogDestination/);
    expect(WRITE).toMatch(/resolveAdmittedTemplates/);
    expect(WRITE).toMatch(/readDestinationNames/);
  });

  it("computes the persisted name with the WRITER'S own rule, never its own", () => {
    expect(WRITE).toMatch(/prospectiveCopyName/);
    expect(strip(WRITE)).not.toMatch(/\.trim\(\)/);
    expect(strip(WRITE)).not.toMatch(/Overview/);
  });

  it("seeds from the CURRENT declaration, never from the row's cached config", () => {
    // The row is the eligibility record; the pack's manifest is the source of
    // what gets copied (codex convergence r0/HIGH-2).
    expect(WRITE).toMatch(/seedConfig: declaration\.config/);
    expect(strip(WRITE)).not.toContain("configJson");
  });

  it("pins the row's IDENTITY against the declaration, not merely the package", () => {
    expect(WRITE).toMatch(/declaration\.rowName !== target\.row\.name/);
  });

  it("takes the currentness rules off a PURE module, never a writer-bearing barrel", () => {
    // An opaque import of `extension-materialization` reaches every org-write
    // writer it re-exports without naming one — which the boundary gate refuses.
    const CURRENTNESS = read("lib/dashboards/installed-catalog-currentness.ts");
    expect(CURRENTNESS).toMatch(
      /import\("@cinatra-ai\/dashboards\/dashboard-config-v12"\)/,
    );
    expect(strip(CURRENTNESS)).not.toContain("extension-materialization");
    // …and the write never reaches the kernel root either — it asks the seam
    // that owns that edge.
    expect(strip(WRITE)).not.toContain("@cinatra-ai/org-write-kernel");
    expect(WRITE).toMatch(/isOrgWriteRefusal\(e\)/);
  });

  it("re-proves SCOPE REACH — the render's membership proof does not outlive it", () => {
    const READ = read("lib/dashboards/installed-catalog-read.ts");
    expect(READ).toMatch(/if \(!actorMayReachSurface\(actor, surface\)\) return null;/);
    // …and it is inside the step BOTH callers take, so neither can skip it.
    expect(READ).toMatch(
      /export function resolveCatalogDestination[\s\S]{0,600}actorMayReachSurface/,
    );
  });

  it("goes through the platform's entity-dashboard writer, not a table", () => {
    expect(WRITE).toMatch(
      /import\("@cinatra-ai\/dashboards\/entity-dashboard-writer"\)/,
    );
    expect(WRITE).toMatch(/createEntityDashboard\(/);
    const c = strip(WRITE);
    for (const forbidden of ["insert(", "getDashboardsDb", "drizzle", "sql`"]) {
      expect(c).not.toContain(forbidden);
    }
  });

  it("writes NOTHING the issue's constraint forbids — no link row, no provenance, no ownership move", () => {
    // "The created row is an ordinary per-user/per-entity dashboard — no
    // migration, no ownership change, no union read, no `dashboard_entity_links`
    // row, no canonical-home change." The write reaches none of those vocabularies
    // at all, so it cannot express them.
    const c = strip(WRITE);
    for (const forbidden of [
      "dashboard_entity_links",
      "entity-links",
      "extensionId",
      "contributionId",
      "isTemplate",
      "ownerLevel: \"organization\"",
      "ownerLevel: \"team\"",
    ]) {
      expect(c).not.toContain(forbidden);
    }
    // The only owner axis it names is the DERIVED one, and it never re-authors it.
    expect(c).toMatch(/ref: destination\.ref/);
  });
});
