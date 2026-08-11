/**
 * cinatra#2058 — the workspace-wide `/dashboards` directory page is RETIRED with
 * no redirect and no backward-compatibility shim: a GET of `/dashboards` 404s for
 * authenticated AND sessionless requests alike (there is simply no page file at
 * that route, so the router 404s it for everyone — no redirect, nothing
 * revealed), while every per-dashboard detail route is untouched in BOTH of its
 * modes. These source locks keep the retirement — and the preserved detail
 * routing — from silently regressing.
 *
 * cinatra#2474 item 6 (the final slice of the entity-scope dashboards program)
 * is the FOLLOW-THROUGH on that retirement: "ensure the legacy bare
 * `/dashboards` is fully gone — not a route, no residual code left". It closes
 * two gaps this file left open and adds them below:
 *
 *   - the producer lock was an ALLOWLIST of the four files #2058 happened to
 *     touch, so it could only catch a regression in a file already listed. It is
 *     now a literal scan across PRODUCTION source (tests excluded — a test cannot
 *     mint a product URL, and several unrelated suites legitimately feed
 *     `/dashboards` to `guardAppRoute` as an arbitrary protected path). Its
 *     honest scope, stated so nobody over-reads a green run: it is a QUOTED
 *     STRING-LITERAL scan over the source roots below. It catches every form a
 *     producer realistically writes (`"/dashboards"`, `'/dashboards'`,
 *     `` `/dashboards` ``, and the trailing-slash / query / fragment variants
 *     that still address the retired root) and deliberately does NOT match a
 *     `/dashboards/{id}` detail path. It cannot see a URL assembled at runtime
 *     by concatenation or interpolation — that is what the live 404 proof is
 *     for.
 *   - nothing pinned the retired folder against re-accumulating code. The scope
 *     collection's server actions were still parked at
 *     `src/app/dashboards/scope-dashboards-actions.ts` — colocated with a page
 *     that no longer exists, and making `src/components/**` import out of
 *     `src/app/**`. Item 6 moved them next to the components that bind them; the
 *     locks below keep them there.
 *
 * The retirement is DELETION, not a redirect and not a tombstone (#2058's owner
 * ruling verbatim: "retire without redirect / backward compatibility"; #2474's
 * constraint verbatim: "No redirects and no backward-compat shims — remove
 * retired routes/code outright"). What is retired is the workspace-wide
 * DIRECTORY page alone. Every per-dashboard DETAIL route is live product surface
 * and is pinned as preserved at the bottom of this file — `/dashboards/{id}` is
 * still what `canonicalDashboardPath` mints for personal/workspace/project/
 * legacy-unanchored rows.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(p, "utf-8");

/**
 * Strip comments so a "nothing mints this link" check tests the CODE, not the
 * prose explaining the retirement (this repo documents it in comments all over
 * the dashboards surface). A `//` preceded by `:` is left alone so a `https://`
 * URL does not swallow the rest of its line.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Roots that hold PRODUCTION source + machine-consumed config (tests excluded). */
const PRODUCTION_ROOTS = [
  "src",
  ...(existsSync("packages")
    ? readdirSync("packages", { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join("packages", e.name, "src"))
    : []),
  "scripts",
  "config",
  "public",
];

const SCANNED_EXT = /\.(?:tsx?|mjs|cjs|js|jsx|json)$/;
/** A test never ships a product URL — and several suites feed `/dashboards` to
 *  `guardAppRoute` purely as an arbitrary protected-path fixture. */
const IS_TEST = (p: string) =>
  /(?:^|[\\/])__tests__[\\/]/.test(p) ||
  /(?:^|[\\/])tests[\\/]/.test(p) ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p);

function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SCANNED_EXT.test(e.name) && !IS_TEST(p)) out.push(p);
    }
  };
  for (const r of PRODUCTION_ROOTS) if (existsSync(r)) walk(r);
  return out;
}

/** Every quoted string literal in a source text, with its contents. */
const QUOTED_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Does this literal's CONTENT address the retired directory ROOT? `/dashboards`
 * itself, a trailing-slash form, or a query/fragment on the root — all of which
 * a router resolves to the retired route. A `/dashboards/{id}` detail path, and
 * a `/teams/{id}/dashboards/{id}` canonical home, are deliberately NOT matches:
 * they are live product surface.
 */
const addressesRetiredRoot = (literal: string) =>
  /^\/dashboards\/?(?:[?#].*)?$/.test(literal);

function mintsRetiredRoot(source: string): boolean {
  for (const m of source.matchAll(QUOTED_LITERAL)) {
    if (addressesRetiredRoot(m[2])) return true;
  }
  return false;
}

describe("dashboards directory-page retirement (#2058)", () => {
  it("the workspace-wide `/dashboards` directory route file is removed (authenticated GET → 404)", () => {
    expect(existsSync("src/app/dashboards/page.tsx")).toBe(false);
  });

  it("no Next route convention re-creates the bare `/dashboards` route", () => {
    // `page.tsx` is the one that would serve it, but the retirement is about the
    // ROUTE, not one filename: a `route.ts` or a `default.tsx` at the same level
    // would resurrect it just as well. (`[id]/` beneath is a different route and
    // is preserved — pinned below.)
    for (const file of [
      "page.tsx",
      "page.ts",
      "page.jsx",
      "page.js",
      "route.ts",
      "route.tsx",
      "route.js",
      "default.tsx",
      "default.ts",
    ]) {
      expect(
        existsSync(path.join("src/app/dashboards", file)),
        `src/app/dashboards/${file} would re-create the retired bare /dashboards route`,
      ).toBe(false);
    }
  });

  it("no PRODUCTION source mints the retired bare `/dashboards` directory link", () => {
    // Across the roots, not an allowlist (#2474 item 6): the producers that used
    // to emit or target the directory root now point at `/artifacts`, the entity
    // landings, or a preserved `/dashboards/{id}` detail route — and NO new file
    // may start minting it again.
    const offenders = productionSourceFiles().filter((f) =>
      mintsRetiredRoot(f.endsWith(".json") ? read(f) : stripComments(read(f))),
    );
    expect(offenders).toEqual([]);
  });
});

describe("no code is left parked in the retired directory's folder (#2474 item 6)", () => {
  it("the scope-collection server actions no longer live under `src/app/dashboards/`", () => {
    // They were written there while the directory page still occupied the
    // folder; #2058 retired the page and #2474 PR2 folded the collection onto
    // the entity landings, leaving the module orphaned beside a dead route.
    expect(existsSync("src/app/dashboards/scope-dashboards-actions.ts")).toBe(false);
  });

  it("they live beside the components that bind them, and nothing imports the old path", () => {
    expect(
      existsSync("src/components/dashboards/scope-dashboards-actions.ts"),
    ).toBe(true);
    const offenders = productionSourceFiles().filter((f) =>
      /@\/app\/dashboards\/scope-dashboards-actions/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("the two binders import the module from its component-local home", () => {
    for (const file of [
      "src/components/dashboards/scope-dashboards-section.tsx",
      "src/components/dashboards/scope-reference-binding.ts",
    ]) {
      expect(read(file), file).toContain(
        'from "@/components/dashboards/scope-dashboards-actions"',
      );
    }
  });

  it("the relocated module keeps its server-action exports and authorization anchors", () => {
    // The one thing a relocation must not quietly change: the file is still a
    // server-action module, still exports the same four actions, and each still
    // re-resolves the live actor and TENANT-FENCES the scope (the render gate
    // cannot protect a later invocation after an org switch). Comments are
    // stripped first so prose cannot satisfy any of these.
    const raw = read("src/components/dashboards/scope-dashboards-actions.ts");
    // The directive must be the first STATEMENT; a leading doc comment is fine.
    expect(stripComments(raw).trimStart()).toMatch(/^["']use server["'];?/);

    const src = stripComments(raw);
    expect(src).toContain("await getActorContext()");
    // The tenant fence itself, not merely its platform-admin exception.
    expect(src).toContain("actor.organizationId !== scope.orgId");
    expect(src).toContain('actor.platformRole !== "platform_admin"');
    for (const action of [
      "scopeListCandidatesAction",
      "scopeAddListingAction",
      "scopeRemoveListingAction",
      "scopeRequestPromotionAction",
    ]) {
      expect(src, action).toMatch(
        new RegExp(String.raw`export async function ${action}\s*\(`),
      );
    }
  });
});

describe("the per-dashboard DETAIL routes are preserved (#2058 + #2474 item 6)", () => {
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
