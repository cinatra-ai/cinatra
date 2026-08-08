/**
 * Source-contract pins for `marketplace-detail-modal.tsx` (cinatra#948) —
 * same venue as `marketplace-install-wiring.test.ts` (the repo's
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

describe("details-only: the modal carries no INSTALL affordance (cinatra#2406 ruling, pinned by #2374)", () => {
  // The UPDATE side of the details-only ruling is already locked in
  // update-plan-flow-contract.test.ts ("the modal footer … is gone"). This is
  // its INSTALL-side twin.
  //
  // Design contract — specs/app-extensions.html, version 0.13.2, §II: "The modal is
  // details-only — it carries no footer and no install/update/restore action
  // of its own (owner ruling, 2026-08-04); install/update/restore run from the
  // §I ListingCard and the §III installed card, never from this dialog."
  //
  // cinatra#2374 was originally specified as lifting the in-card install panel
  // into this modal's FOOTER. The owner removed that footer first, so there is
  // no region to lift into; #2374 deleted the orphaned popup instead and pins
  // the absence here — for the deleted popup AND for the in-card panel, so a
  // future slice cannot reintroduce installation on this surface by mounting
  // the panel that legitimately exists on the card.
  it("mounts neither the deleted popup nor the in-card install panel", () => {
    expect(SOURCE).not.toMatch(/<ExtensionInstallScopeDialog/);
    expect(SOURCE).not.toMatch(/<ExtensionInstallScopePanel/);
    expect(SOURCE).not.toMatch(
      /from\s+["']\.\/extension-install-scope-dialog["']/,
    );
    expect(SOURCE).not.toMatch(
      /from\s+["']\.\/extension-install-scope-panel["']/,
    );
  });

  it("threads no install action, access target or install-scope context", () => {
    expect(SOURCE).not.toMatch(/installExtensionPackageFormAction/);
    expect(SOURCE).not.toMatch(/installScope/);
    expect(SOURCE).not.toMatch(/accessTarget/);
  });

  it("renders no install/update/restore CTA", () => {
    // JSX-shaped: the module comment may still quote the removed CTA copy while
    // explaining WHY it is gone, but no element may render it.
    expect(SOURCE).not.toMatch(/>\s*Install now\s*</);
    expect(SOURCE).not.toMatch(/>\s*Update now\s*</);
    expect(SOURCE).not.toMatch(/>\s*Restore\s*</);
  });

  it("mounts none of the known lifecycle-action components, nor a dialog footer", () => {
    // The CTA-copy assertions above are exact-text and could be sidestepped by
    // routing through a component instead of literal copy. Name the components
    // that actually perform an install/update, plus the footer region the owner
    // removed, so an indirect reintroduction is caught too.
    for (const mount of [
      "MarketplaceInstallForm",
      "InstallPanelOpenButton",
      "CardFaceSwitcher",
      "ModalUpdatePlanFlow",
      "DialogFooter",
    ]) {
      expect(SOURCE).not.toMatch(new RegExp(`<${mount}\\b`));
    }
  });
});
