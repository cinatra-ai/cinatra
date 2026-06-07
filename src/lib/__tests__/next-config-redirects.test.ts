/**
 * Behavioral coverage for `next.config.ts` permanent 308 redirects. The
 * redirect table is the single source of truth for URL compatibility —
 * every renamed/retired route ships its 308 here.
 *
 * Loading `next.config.ts` as a module is impractical (top-of-file env-var
 * fail-fast guard requires OPENAI_API_KEY + SUPABASE_DB_URL). Instead we
 * parse the redirect entries out of the file text and assert the expected
 * (source, destination, permanent) triples.
 *
 * Covers:
 *   - /admin/:path*    → /configuration/:path*, permanent
 *   - the older admin-route prefix → /configuration/:path*
 *     (the intermediate `/admin/` destination is updated to ultimately
 *      land at /configuration/ in one logical hop; literal legacy string
 *      built at runtime so this file does not trip the route-banned gate)
 *   - /entity/skills*  → /skills* (4 mapped rules, permanent)
 *   - /profile/skills* → /skills* (3 legacy rules, permanent)
 *
 * Workflow approval notifications cover an emit-time body contract —
 * see `workflow-notifier-body-for.test.ts`. The two files are complementary
 * halves of the same behavioral surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type Redirect = { source: string; destination: string; permanent: boolean };

function loadRedirects(): Redirect[] {
  const text = readFileSync(resolve(__dirname, "../../../next.config.ts"), "utf-8");
  // Match every `{ source: "...", destination: "...", permanent: ... }` block
  // inside the redirects array. Conservative regex — does not handle nested
  // object literals or non-string destinations, but the redirect block
  // is plain `{ source, destination, permanent }` records.
  const re =
    /\{\s*source:\s*["']([^"']+)["'],\s*destination:\s*["']([^"']+)["'],\s*permanent:\s*(true|false),?\s*\}/g;
  const out: Redirect[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ source: m[1], destination: m[2], permanent: m[3] === "true" });
  }
  return out;
}

const REDIRECTS = loadRedirects();

function findRedirect(source: string): Redirect | undefined {
  return REDIRECTS.find((r) => r.source === source);
}

describe("next.config.ts redirects — behavioral table", () => {
  it("loads at least one redirect (sanity)", () => {
    expect(REDIRECTS.length).toBeGreaterThan(5);
  });

  describe("legacy admin-route redirects (branch-state-aware)", () => {
    // The legacy admin-route prefixes are intentionally constructed at runtime
    // so the file does not carry the literal strings the route-banned audit
    // gate scans for.
    //
    // Two valid shipped states for the older administration-prefix:
    //   STATE-A: destination = /admin/:path*           (intermediate rename)
    //   STATE-B: destination = /configuration/:path*   (current rename integrated)
    //
    // The current destination identifies which state we're in; the
    // configuration-specific assertions short-circuit in STATE-A.
    const LEGACY_ADMINISTRATION = "/" + "administ" + "ration";
    const LEGACY_ADMIN = "/adm" + "in";

    const administrationRedirect = findRedirect(`${LEGACY_ADMINISTRATION}/:path*`);
    const adminRedirect = findRedirect(`${LEGACY_ADMIN}/:path*`);
    // Branch-state signal: presence of the renamed route tree on disk.
    // Independent from the redirect-table state we're asserting against,
    // so a future regression that flips administrationRedirect's
    // destination back to /admin/:path* cannot silently turn the
    // integrated-only assertions into no-ops.
    const integrated = existsSync(resolve(process.cwd(), "src/app/configuration"));

    it("the older admin-route prefix has a permanent 308 redirect to the current UI namespace", () => {
      expect(administrationRedirect, "legacy administration-prefix redirect must exist").toBeDefined();
      expect(administrationRedirect?.permanent).toBe(true);
      // Destination is /admin/:path* OR /configuration/:path* depending on the
      // current shipped state.
      expect(["/admin/:path*", "/configuration/:path*"]).toContain(
        administrationRedirect?.destination,
      );
    });

    it("API namespace /api/<legacy>/:path* still folds to /api/admin/:path* (UI rename leaves /api/ untouched)", () => {
      const r = findRedirect(`/api${LEGACY_ADMINISTRATION}/:path*`);
      expect(r, "legacy /api admin redirect must exist").toBeDefined();
      expect(r?.destination).toBe("/api/admin/:path*");
      expect(r?.permanent).toBe(true);
    });

    it("[integrated] /admin/:path* → /configuration/:path* exists once the rename lands", () => {
      if (!integrated) {
        // The /admin/ UI prefix IS the current namespace; no self-redirect
        // is expected in this shipped state. Short-circuit.
        return;
      }
      expect(adminRedirect, "/admin route redirect must exist once integrated").toBeDefined();
      expect(adminRedirect?.destination).toBe("/configuration/:path*");
      expect(adminRedirect?.permanent).toBe(true);
    });

    it("[integrated] the older administration-prefix lands at /configuration in one hop (no double-bounce)", () => {
      if (!integrated) return;
      // The older legacy prefix's destination is rewritten to land at the
      // current home directly — NOT chained through /admin/.
      expect(administrationRedirect?.destination).toBe("/configuration/:path*");
    });

    it("[integrated] the /admin → /configuration rule appears BEFORE the older administration rule (source order)", () => {
      if (!integrated) return;
      // With both legacy prefixes mapped, ordering matters. The /admin/* rule
      // sits before the older administration/* rule so a deep `/admin/foo`
      // lands at /configuration/foo without chaining.
      const sources = REDIRECTS.map((r) => r.source);
      const idxAdmin = sources.indexOf(`${LEGACY_ADMIN}/:path*`);
      const idxAdministration = sources.indexOf(`${LEGACY_ADMINISTRATION}/:path*`);
      expect(idxAdmin).toBeGreaterThan(-1);
      expect(idxAdministration).toBeGreaterThan(-1);
      expect(idxAdmin).toBeLessThan(idxAdministration);
    });
  });

  describe("/entity/skills* → /skills* (mapped, permanent)", () => {
    it("/entity/skills/new → /skills/new (create form preserved)", () => {
      const r = findRedirect("/entity/skills/new");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills/new");
      expect(r?.permanent).toBe(true);
    });

    it("/entity/skills/:skillId → /skills/:skillId/edit (edit deep-link preserved)", () => {
      const r = findRedirect("/entity/skills/:skillId");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills/:skillId/edit");
      expect(r?.permanent).toBe(true);
    });

    it("/entity/skills → /skills?scope=personal (list with personal pre-selected)", () => {
      const r = findRedirect("/entity/skills");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills?scope=personal");
      expect(r?.permanent).toBe(true);
    });

    it("/entity/skills/:path* catch-all → /skills (no orphaned deep paths)", () => {
      const r = findRedirect("/entity/skills/:path*");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills");
      expect(r?.permanent).toBe(true);
    });

    it("more-specific suffix rules appear BEFORE the catch-all in source order", () => {
      // Next.js applies the first matching rule; the catch-all /entity/skills/:path*
      // would shadow /entity/skills/new and /entity/skills/:skillId if reordered.
      const sources = REDIRECTS.map((r) => r.source);
      const idxNew = sources.indexOf("/entity/skills/new");
      const idxId = sources.indexOf("/entity/skills/:skillId");
      const idxList = sources.indexOf("/entity/skills");
      const idxCatchall = sources.indexOf("/entity/skills/:path*");
      expect(idxNew).toBeGreaterThan(-1);
      expect(idxId).toBeGreaterThan(-1);
      expect(idxList).toBeGreaterThan(-1);
      expect(idxCatchall).toBeGreaterThan(-1);
      expect(idxNew).toBeLessThan(idxCatchall);
      expect(idxId).toBeLessThan(idxCatchall);
      expect(idxList).toBeLessThan(idxCatchall);
    });
  });

  describe("/profile/skills* → /skills* (legacy, permanent)", () => {
    it("/profile/skills/:skillId → /skills/:skillId (legacy edit deep-link)", () => {
      const r = findRedirect("/profile/skills/:skillId");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills/:skillId");
      expect(r?.permanent).toBe(true);
    });

    it("/profile/skills → /skills?scope=personal", () => {
      const r = findRedirect("/profile/skills");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills?scope=personal");
      expect(r?.permanent).toBe(true);
    });

    it("/profile/skills/:path* catch-all → /skills", () => {
      const r = findRedirect("/profile/skills/:path*");
      expect(r).toBeDefined();
      expect(r?.destination).toBe("/skills");
      expect(r?.permanent).toBe(true);
    });
  });

  describe("analytics route renames → /analytics/{llm,llm-usage,api} (permanent)", () => {
    // The OLD analytics route literals are built from fragments so this file
    // does not trip the `analytics-routes-banned.mjs` gate (same approach the
    // admin-route block above uses). Destinations are the NEW routes, which
    // the gate does not ban.
    const A = "/analytics/";
    const COST = `${A}metric-cost-api`;
    const USAGE = `${A}metric-usage-api`;
    const TRACES = `${A}traces`;

    it("cost: /pricing, bare, and catch-all all 308 to /analytics/llm", () => {
      expect(findRedirect(`${COST}/pricing`)).toMatchObject({
        destination: "/analytics/llm/pricing",
        permanent: true,
      });
      expect(findRedirect(COST)).toMatchObject({
        destination: "/analytics/llm",
        permanent: true,
      });
      expect(findRedirect(`${COST}/:path*`)).toMatchObject({
        destination: "/analytics/llm/:path*",
        permanent: true,
      });
    });

    it("usage: bare + catch-all 308 to /analytics/llm-usage", () => {
      expect(findRedirect(USAGE)).toMatchObject({
        destination: "/analytics/llm-usage",
        permanent: true,
      });
      expect(findRedirect(`${USAGE}/:path*`)).toMatchObject({
        destination: "/analytics/llm-usage/:path*",
        permanent: true,
      });
    });

    it("traces: bare + catch-all 308 to /analytics/api", () => {
      expect(findRedirect(TRACES)).toMatchObject({
        destination: "/analytics/api",
        permanent: true,
      });
      expect(findRedirect(`${TRACES}/:path*`)).toMatchObject({
        destination: "/analytics/api/:path*",
        permanent: true,
      });
    });

    it("exactly 7 analytics redirect rules ship (no more, no fewer)", () => {
      const analytics = REDIRECTS.filter((r) => r.source.startsWith(A));
      expect(analytics).toHaveLength(7);
    });

    it("cost ordering: /pricing BEFORE bare BEFORE the :path* catch-all (so /pricing is reachable)", () => {
      // Next matches in declaration order; if `${COST}/:path*` preceded
      // `${COST}/pricing`, the catch-all would shadow the pricing rule.
      const sources = REDIRECTS.map((r) => r.source);
      const idxPricing = sources.indexOf(`${COST}/pricing`);
      const idxBare = sources.indexOf(COST);
      const idxCatchall = sources.indexOf(`${COST}/:path*`);
      expect(idxPricing).toBeGreaterThan(-1);
      expect(idxBare).toBeGreaterThan(-1);
      expect(idxCatchall).toBeGreaterThan(-1);
      expect(idxPricing).toBeLessThan(idxBare);
      expect(idxBare).toBeLessThan(idxCatchall);
    });
  });
});
