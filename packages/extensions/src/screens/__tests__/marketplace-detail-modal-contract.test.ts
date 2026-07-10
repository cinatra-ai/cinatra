/**
 * Source-contract pins for `marketplace-detail-modal.tsx` (cinatra#948) —
 * same venue as `extension-install-scope-dialog.test.tsx` (the repo's
 * component-test convention is static markup only; a DOM-interaction test of
 * the client `load()` catch is not expressible here).
 *
 *  - The `load()` catch RE-THROWS the NEXT_REDIRECT sentinel before the
 *    retryable error state: the detail action is admin-gated while the
 *    Installed page is session-gated, so swallowing the sentinel would mask
 *    an authorization redirect as "Couldn't load details" (codex round-0
 *    finding, adopted).
 *  - A pinned `initialLoad` fixture state never fetches (the static
 *    `/design-fixtures` route has no session/DB behind it).
 *  - The trigger override is optional — the browse-card default stays.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../marketplace-detail-modal.tsx"),
  "utf8",
);

describe("marketplace-detail-modal source contract (cinatra#948)", () => {
  it("re-throws the NEXT_REDIRECT sentinel in the load() catch before the error state", () => {
    expect(SOURCE).toMatch(/from\s+["']\.\/is-redirect-error["']/);
    const catchBlock = SOURCE.match(/catch \(error\) \{[\s\S]*?setStatus\("error"\);/)?.[0];
    expect(catchBlock).toBeTruthy();
    expect(catchBlock).toMatch(/isRedirectError\(error\)/);
    expect(catchBlock).toMatch(/throw error;/);
    // The rethrow guards BEFORE the retryable error state.
    expect(catchBlock!.indexOf("throw error;")).toBeLessThan(
      catchBlock!.indexOf('setStatus("error");'),
    );
  });

  it("a pinned initialLoad state never drives the admin-gated fetch", () => {
    expect(SOURCE).toMatch(/const pinned = initialLoad != null;/);
    expect(SOURCE).toMatch(/next && !pinned && status !== "loaded"/);
    // The pinned error state offers no retry (nothing to retry against).
    expect(SOURCE).toMatch(/onRetry=\{pinned \? undefined : \(\) => void load\(\)\}/);
  });

  it("keeps the default browse-card trigger when no override is passed", () => {
    expect(SOURCE).toMatch(/\{trigger \?\? \(/);
    expect(SOURCE).toMatch(/More details/);
  });

  it("centres the hero name + byline against the logo, price pinned top (0.5.0 §II)", () => {
    // The hero row centres its name/byline block vertically against the square
    // logo (items-center, not the former items-start)…
    const hero = SOURCE.match(
      /data-slot="marketplace-modal-hero" className="flex items-\w+ gap-4\.5"/,
    )?.[0];
    expect(hero).toContain("items-center");
    expect(SOURCE).not.toMatch(/marketplace-modal-hero" className="flex items-start/);
    // …while the price stays pinned to the TOP of the centred header (self-start).
    const price = SOURCE.match(/\{detail\.cost && \([\s\S]{0,200}?\)\}/)?.[0];
    expect(price).toContain("self-start");
  });
});
