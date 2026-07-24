/**
 * cinatra#2058 — the workspace-wide `/dashboards` directory page is RETIRED with
 * no redirect and no backward-compatibility shim: a GET of `/dashboards` 404s for
 * authenticated AND sessionless requests alike (there is simply no page file at
 * that route, so the router 404s it for everyone — no redirect, nothing
 * revealed), while every per-dashboard detail route is untouched in BOTH of its
 * modes. These source locks keep the retirement — and the preserved detail
 * routing — from silently regressing.
 *
 * The runtime halves are proven elsewhere:
 *   - the retired route 404s for BOTH authenticated and sessionless requests —
 *     exercised end-to-end by the #2058 live-boot proof
 *     (`tests/e2e/dashboards/directory-retired-2058.spec.ts`). (Earlier review
 *     assumed a sessionless `/dashboards` would 307 to `/sign-in`; the live
 *     prod-standalone stack showed it 404s for everyone once the page is gone.)
 *   - the auth GUARD is untouched by #2058: that a sessionless request to a real
 *     protected path still 307s to `/sign-in` is unit-proven in
 *     `src/lib/__tests__/auth-route-guard-public-paths.test.ts` (guardAppRoute has
 *     no knowledge of route existence — redirecting protected paths is its job;
 *     whether the router then serves a page or a 404 is a separate layer). That
 *     unit layer, not the standalone e2e, is the home for the redirect assertion.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(p, "utf-8");

describe("dashboards directory-page retirement (#2058)", () => {
  it("the workspace-wide `/dashboards` directory route file is removed (authenticated GET → 404)", () => {
    expect(existsSync("src/app/dashboards/page.tsx")).toBe(false);
  });

  it("no producer mints the retired bare `/dashboards` directory link", () => {
    // The producers that used to emit or target the directory root now point at
    // `/artifacts` (or a preserved `/dashboards/{id}` detail route). We flag only
    // a *code* string literal `"/dashboards"` — a returned URL, a
    // `safeRevalidatePath(...)` argument, or a JSON `surface` value — where the
    // closing double-quote sits immediately after `dashboards`. That deliberately
    // matches neither a `/dashboards/{id}` detail path nor a backtick prose
    // reference to the retired route in a comment.
    const bareDirectoryLiteral = /"\/dashboards"/;
    for (const path of [
      "src/lib/blog/dashboard-url.ts",
      "src/lib/blog/generation.ts",
      "src/lib/blog/store.ts",
      "scripts/fixtures/manifest.json",
    ]) {
      expect(read(path), `${path} must not mint the retired /dashboards directory root`).not.toMatch(
        bareDirectoryLiteral,
      );
    }
  });

  it("the flat `/dashboards/[id]` detail route is preserved and renders the shared screen", () => {
    expect(existsSync("src/app/dashboards/[id]/page.tsx")).toBe(true);
    const flat = read("src/app/dashboards/[id]/page.tsx");
    expect(flat).toMatch(/DashboardDetailScreen/);
    // Flat mode is served at `/dashboards/{id}` — the canonical path for
    // personal/workspace/project/legacy-unanchored rows (they render in place).
    expect(flat).toMatch(/currentPath=\{`\/dashboards\/\$\{encodeURIComponent\(id\)\}`\}/);
  });

  it("the shared detail screen keeps its post-gate canonical redirect (team/org-anchored mode)", () => {
    const screen = read("src/app/dashboards/[id]/dashboard-detail-screen.tsx");
    // Team/organization-anchored rows redirect to their nested canonical URL
    // AFTER every access gate; personal/project rows fall through and render.
    expect(screen).toMatch(/if \(canonical !== currentPath\) redirect\(canonical\)/);
  });

  it("the nested canonical detail routes are preserved", () => {
    expect(existsSync("src/app/teams/[teamId]/dashboards/[dashboardId]/page.tsx")).toBe(true);
    expect(existsSync("src/app/organizations/[id]/dashboards/[dashboardId]/page.tsx")).toBe(true);
  });
});
