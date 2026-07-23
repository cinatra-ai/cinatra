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
 * assertion below. The repo runs vitest in node without @testing-library/react,
 * so server-component wiring is pinned via source assertions (the established
 * pattern — see `surface-conformance.test.ts`); the live bidirectional
 * Playwright walk on a production-equivalent build is the proof-at-close.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Strip block + line comments so a "no Download affordance" check tests the
 *  CODE, not the prose that explains why a dashboard has no Download. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ROW = read("src/components/artifacts/dashboard-library-row.tsx");
const POINTER = read("src/app/artifacts/[id]/dashboard-pointer-detail.tsx");
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

// ── artifact-dashboard-pointer (conformance/app-artifacts.json) ─────────────
// field name=identity.displayName · action open-dashboard -> dashboard-canonical
// · states loading, error · (spec: NO inline render, NO grid, NO portlet).
describe("§VIII conformance id: artifact-dashboard-pointer (the /artifacts/[id] detail)", () => {
  it("carries the conformance id + the name field", () => {
    expect(POINTER).toContain('data-conformance-id="artifact-dashboard-pointer"');
    expect(POINTER).toContain('data-field="name=identity.displayName"');
  });

  it("the primary affordance opens the dashboard's canonical surface", () => {
    expect(POINTER).toContain('data-action="open-dashboard -> dashboard-canonical"');
    expect(POINTER).toMatch(/href=\{pointer\.canonicalHref\}/);
    expect(POINTER).toMatch(/Open dashboard/);
  });

  it("covers the closed data-state set for the pointer surface (ready/loading/error)", () => {
    expect(POINTER).toContain('data-state="ready"');
    expect(POINTER).toContain('data-state="loading"');
    expect(POINTER).toContain('data-state="error"');
  });

  it("is a POINTER, never a renderer: no inline dashboard render is wired in", () => {
    // render→spec: no read-only grid, no embedded portlet, no renderer dispatch.
    expect(POINTER).not.toMatch(/PortletHost/);
    expect(POINTER).not.toMatch(/ExtensionRendererMount/);
    expect(POINTER).not.toMatch(/pickArtifactRenderer/);
    expect(POINTER).not.toMatch(/renderer-dispatch/);
    expect(code(POINTER)).not.toMatch(/Download/i);
  });
});

// ── artifact-dashboard-scope-chips (conformance/app-artifacts.json) ─────────
// action open-scope -> scope-view.
describe("§VIII conformance id: artifact-dashboard-scope-chips (D9 listings)", () => {
  it("renders the scope-chips group whose chips open the scope's view", () => {
    expect(POINTER).toContain('data-conformance-id="artifact-dashboard-scope-chips"');
    expect(POINTER).toContain('data-action="open-scope -> scope-view"');
  });
});

// ── artifacts-axes-state (the shared §IX axes id) ──────────────────────────
// The closed data-state set carried on the §VIII surfaces.
describe("§IX shared axes id: artifacts-axes-state (state coverage on the new surfaces)", () => {
  it("the pointer surface carries loading + error; the row carries kind:artifact", () => {
    expect(POINTER).toContain('data-state="loading"');
    expect(POINTER).toContain('data-state="error"');
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

  it("the detail route opens a dashboard artifact as a POINTER, not the renderer", () => {
    expect(DETAIL).toMatch(/isDashboardArtifactType\(artifact\.objectType\)/);
    expect(DETAIL).toMatch(/resolveDashboardArtifactPointer/);
    expect(DETAIL).toMatch(/<DashboardPointerDetail/);
    // The dashboard branch returns BEFORE the renderer-dispatch body runs — so
    // a dashboard artifact never reaches `pickArtifactRenderer(...)` (the CALL,
    // not the import).
    const branchIdx = DETAIL.indexOf("isDashboardArtifactType(artifact.objectType)");
    const dispatchCallIdx = DETAIL.indexOf("pickArtifactRenderer(");
    expect(branchIdx).toBeGreaterThan(-1);
    expect(dispatchCallIdx).toBeGreaterThan(branchIdx);
  });
});

// ── Phase-1 DUAL AUTHORIZATION (issue #1895 scope) ─────────────────────────
describe("§VIII dual authorization — resolveDashboardAccess gates list + detail", () => {
  it("the list selection layers the dashboard owner+project gate on object.read", () => {
    // filterReadableDashboards → resolveDashboardAccess (the second gate).
    expect(SURFACE).toMatch(/filterReadableDashboards/);
    expect(SURFACE).toMatch(/filterRenderableDashboards/); // liveness gate too
  });

  it("the detail resolver requires dashboard read access via the sanctioned actor", () => {
    expect(RESOLVERS).toMatch(/requireDashboardAccess/);
    expect(RESOLVERS).toMatch(/buildDashboardActorFromSession/);
    // denied vs not-found split (spec §III: list-visible-but-read-denied panel).
    expect(RESOLVERS).toMatch(/access: "denied"/);
    expect(RESOLVERS).toMatch(/access: "not-found"/);
  });

  it("the object-type constant is the single §VIII type id", () => {
    expect(SURFACE).toContain(
      'DASHBOARD_ARTIFACT_OBJECT_TYPE =\n  "@cinatra-ai/dashboard-artifact:dashboard"',
    );
  });
});
