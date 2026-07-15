/**
 * Render→spec guard for the workflow-kind removal on the in-app
 * marketplace/extensions surfaces (cinatra#1035 Slice E).
 *
 * The extensions-package vitest env is `node` (no DOM render), and the client
 * component is a "use client" module wired to next/navigation, so — as with the
 * install-scope-dialog contract test — the marketplace client's tab wiring is
 * pinned by SOURCE-TEXT assertions; the CANONICALIZATION LOGIC itself is
 * exercised behaviourally in `marketplace-tab-model.test.ts` (its resolver is
 * the single decision point the client applies to direct load / client-nav /
 * back-forward). The installed-rows loader is `server-only`, so its
 * kind-collection order is likewise pinned by source-text.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";

const CLIENT = readFileSync(
  path.resolve(__dirname, "../extensions-marketplace-client.tsx"),
  "utf-8",
);
const INSTALLED_ROWS = readFileSync(
  path.resolve(__dirname, "../installed-rows.ts"),
  "utf-8",
);

describe("marketplace client — no 'Workflows' tab, canonicalizes stale ?tab (cinatra#1035)", () => {
  it("renders the shared four-kind tab set (no inline 'Workflows' tab)", () => {
    // The tabs come from the shared MARKETPLACE_TABS model (which the tab-model
    // test proves carries no workflow tab), not an inline array.
    expect(CLIENT).toMatch(/from\s+["']\.\/marketplace-tab-model["']/);
    expect(CLIENT).toContain("MARKETPLACE_TABS.map");
    // No inline workflow tab literal can sneak back in.
    expect(CLIENT).not.toMatch(/value:\s*["']workflow["']/);
    expect(CLIENT).not.toContain("Workflows");
  });

  it("canonicalizes a stale (removed) ?tab value via router.replace (never a 404, never a dead tab)", () => {
    // Resolves the tab through the pure model and strips ONLY a stale (removed
    // marketplace) value with a replace (setParam uses router.replace — no
    // history push); a foreign value the grid never owned is left untouched
    // (tabStale false — see marketplace-tab-model.test.ts). Keyed on the raw
    // searchParams value, so a direct load, a client-side nav, and back/forward
    // all canonicalize identically.
    expect(CLIENT).toMatch(/resolveMarketplaceTab\(rawTab\)/);
    expect(CLIENT).toMatch(/useEffect\(/);
    expect(CLIENT).toMatch(/if\s*\(tabStale\)\s*setParam\("tab",\s*null\)/);
  });

  it("the card filter-metadata kind union drops 'workflow' (unknown-tolerant)", () => {
    // CardMeta.kind is the four kinds + "unknown" + null — a normalized-away
    // workflow entry arrives as "unknown" and shows only under "All".
    expect(CLIENT).toMatch(
      /kind:\s*"agent"\s*\|\s*"skill"\s*\|\s*"connector"\s*\|\s*"artifact"\s*\|\s*"unknown"\s*\|\s*null/,
    );
    expect(CLIENT).not.toMatch(/"artifact"\s*\|\s*"workflow"/);
  });
});

describe("installed-rows — no workflow row is ever collected (post-migration world)", () => {
  it("KIND_ORDER is exactly the four extension kinds, no 'workflow'", () => {
    const match = INSTALLED_ROWS.match(
      /export const KIND_ORDER: ExtensionKind\[\] = \[([\s\S]*?)\];/,
    );
    expect(match, "KIND_ORDER declaration not found").toBeTruthy();
    const body = match![1];
    expect(body).toContain('"agent"');
    expect(body).toContain('"skill"');
    expect(body).toContain('"connector"');
    expect(body).toContain('"artifact"');
    // The removed kind must not be iterated — no workflow descriptors are
    // collapsed into rows, so a persisted workflow install surfaces nowhere.
    expect(body).not.toContain('"workflow"');
  });

  it("collapseKindRows has no workflow branch — an unexpected kind is skipped, never crashes", () => {
    // The former `else { … WorkflowTemplateLike … }` fallthrough is gone; the
    // artifact branch is the last explicit case and any other kind leaves
    // packageName null (skipped).
    expect(INSTALLED_ROWS).not.toContain("WorkflowTemplateLike");
  });
});
