/**
 * §VIII "Dashboards as artifacts" — source-text conformance (cinatra#1895).
 *
 * Pins the build to the RATIFIED design spec
 * `specs/app-artifacts.html` §VIII (design@5daf862, content commit
 * 16efd8d) + `conformance/app-artifacts.json` §VIII surfaces. Owner ruling
 * 2026-07-20: the dashboard surface is a POINTER — NO inline render; the row and
 * the detail Open both navigate to the dashboard's canonical surface.
 *
 * This is the conformance CHECKLIST: every §VIII conformance id maps to an
 * assertion below. Since version 0.13.0 (design@67ecd66d, cinatra#4388) the
 * dashboard's artifact page draws the dashboard extension's own display, so the
 * drawing no longer declares the two surfaces of the core pointer (the pointer
 * detail and its scope chips), and nothing below asserts them. cinatra#4311
 * deletes the core pointer: `src/app/artifacts/[id]/dashboard-pointer-detail.tsx`
 * is gone, no production source under `src` names `DashboardPointerDetail`, and
 * the routing test below holds that the page draws no pointer on any road.
 * The repo runs vitest in node without @testing-library/react,
 * so server-component wiring is pinned via source assertions (the established
 * pattern — see `surface-conformance.test.ts`); the live bidirectional
 * Playwright walk on a production-equivalent build is the proof-at-close.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Strip block + line comments so a "no Download affordance" check tests the
 *  CODE, not the prose that explains why a dashboard has no Download. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ROW = read("src/components/artifacts/dashboard-library-row.tsx");
const LIB = read("src/components/artifacts/library-mode.tsx");
const DETAIL = read("src/app/artifacts/[id]/page.tsx");
const SURFACE = read("src/lib/dashboards/dashboard-artifact-surface.ts");
const RESOLVERS = read("src/lib/dashboards/dashboard-artifact-pointer-resolvers.ts");

// ── artifacts-dashboard-row (conformance/app-artifacts.json) ────────────────
// field name=identity.displayName · action open-dashboard -> dashboard-canonical
// · state kind:artifact · (spec: Open only; NO Download).
describe("§VIII conformance id: artifacts-dashboard-row (the library row)", () => {
  it("carries the conformance id, the name field, and the kind:artifact state", () => {
    expect(ROW).toContain('data-conformance-id="artifacts-dashboard-row"');
    expect(ROW).toContain('data-field="name=identity.displayName"');
    expect(ROW).toContain('data-state="kind:artifact"');
  });

  it("the row's Open action navigates to the dashboard's canonical surface", () => {
    expect(ROW).toContain('data-action="open-dashboard -> dashboard-canonical"');
    expect(ROW).toMatch(/href=\{pointer\.canonicalHref\}/);
    expect(ROW).toMatch(/>\s*Open\s*</);
  });

  it("shows the dashboard glyph + the muted 'Dashboards' defining-extension label", () => {
    expect(ROW).toMatch(/LayoutDashboard/);
    expect(ROW).toContain('DASHBOARD_ARTIFACT_EXTENSION_LABEL = "Dashboards"');
  });

  it("has NO Download affordance — a dashboard is a live view, not a file (render→spec)", () => {
    expect(code(ROW)).not.toMatch(/Download/i);
  });
});

// ── artifacts-axes-state (the shared §IX axes id) ──────────────────────────
// The closed data-state set carried on the §VIII surfaces. Since version 0.13.0
// the state table draws no pointer row, so only the library row is held here.
describe("§IX shared axes id: artifacts-axes-state (state coverage on the new surfaces)", () => {
  it("the row carries kind:artifact", () => {
    expect(ROW).toContain('data-state="kind:artifact"');
  });
});

// ── Routing (spec §VIII): scope surfaces / library rows / detail behaviors ──
describe("§VIII routing — library rows render as dashboard pointers, dual-auth gated", () => {
  it("the library wires the dashboard-typed branch through the dual-auth resolver", () => {
    expect(LIB).toMatch(/isDashboardArtifactType/);
    expect(LIB).toMatch(/resolveLibraryDashboardPointers/);
    expect(LIB).toMatch(/<DashboardLibraryRow/);
  });

  it("facet options come from the dual-auth-gated set — a denied dashboard leaks no facet", () => {
    // The dual-authorization drop must be COMPLETE (not row-only): facets build
    // from `facetSource` (all rows minus §VIII-denied dashboards), never raw
    // `all`, so a list-but-not-read dashboard never discloses its facet.
    expect(LIB).toMatch(/const facetSource = all\.filter\(/);
    expect(LIB).toMatch(/buildFacetOptions\(facetSource\)/);
    expect(LIB).not.toMatch(/buildFacetOptions\(all\)/);
  });

  it("the detail route dispatches every admitted row and draws no pointer on any road", () => {
    // cinatra#3092 acceptance 2: "the page's pre-dispatch interception of the
    // dashboard row is gone". The page carries no branch on the type and no
    // pointer resolver (the type's read gate holds both), so a dashboard row
    // reaches `resolveArtifactDisplayMount(...)` (the CALL, not the import)
    // like every other. cinatra#4311 deletes the pointer: where the dispatch
    // answers a floor, a dashboard row draws the generic floor like every other.
    const code = DETAIL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/isDashboardArtifactType/);
    expect(code).not.toMatch(/resolveDashboardArtifactPointer/);
    expect(code.indexOf("resolveArtifactDisplayMount(")).toBeGreaterThan(-1);
    expect(code).not.toMatch(/dashboard-pointer-detail/);
    expect(code).not.toMatch(/DashboardPointerDetail/);
    expect(code).not.toMatch(/typeGate\.dashboardPointer/);
    expect(code).not.toContain('"dashboard-pointer"');
  });

  it("the core pointer detail is deleted and no production source under src names it (cinatra#4311)", () => {
    expect(existsSync(path.join(ROOT, "src/app/artifacts/[id]/dashboard-pointer-detail.tsx"))).toBe(false);
    const naming: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
        } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name)) {
          if (readFileSync(full, "utf8").includes("DashboardPointerDetail")) naming.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(naming).toEqual([]);
  });
});

// ── Phase-2 SINGLE-GATE cutover (issue #1898 scope) ────────────────────────
describe("§VIII single-gate — object.read is the sole list authorization", () => {
  it("the list selection NO LONGER re-authorizes (the Phase-1 dual gate is gone)", () => {
    // Phase-2 (cinatra#1898): object.read (applied by listArtifacts, reflected in
    // artifactIds) is the SOLE gate. The surface only projects + drops non-surface
    // rows, so the second dashboard-resolver pass is removed.
    expect(SURFACE).not.toMatch(/filterReadableDashboards/);
    expect(SURFACE).toMatch(/filterRenderableDashboards/); // liveness/template gate stays
  });

  it("the detail resolver gates read via the single scope resolver + sanctioned actor", () => {
    // The detail page still gates via requireDashboardAccess — now the flipped
    // scope-only resolver, which AGREES with the object filter row-for-row.
    expect(RESOLVERS).toMatch(/requireDashboardAccess/);
    expect(RESOLVERS).toMatch(/buildDashboardActorFromSession/);
    // denied vs not-found split (spec §III: list-visible-but-read-denied panel).
    expect(RESOLVERS).toMatch(/access: "denied"/);
    expect(RESOLVERS).toMatch(/access: "not-found"/);
  });

  it("the object-type constant is the single §VIII type id", () => {
    // cinatra#4849: the one constant takes the type from the claimant of the
    // `artifact-dashboard-twin` role; the surface spells no quoted type id.
    expect(SURFACE).toContain(
      'DASHBOARD_ARTIFACT_OBJECT_TYPE: string =\n  resolveExtensionRoleArtifactType("artifact-dashboard-twin")',
    );
    expect(SURFACE).not.toMatch(/"@[a-z0-9-]+\/[a-z0-9-]+:[a-z0-9-]+"/);
  });
});
