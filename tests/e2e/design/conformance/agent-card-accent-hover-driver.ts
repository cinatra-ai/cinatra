/**
 * Driver for the extensions drawing's coloured-panel hover of an agent card
 * (surface: agent-card-accent-hover). The harness mounts ONE shipped
 * AgentAllCard with a scoped listing row
 * (src/app/design-fixtures/conformance/agent-card-accent-hover-fixture.tsx).
 * The driver asserts what the manifest declares - the interactive coloured
 * panel with its hover layer, the one action (open-details -> the detail modal
 * open in place) and the one state (kind:agent) - and nothing of the wash's
 * colour, opacity or timing.
 */
import { expect } from "@playwright/test";
import type { SurfaceDriver } from "./contract";

const ROOT = '[data-surface-id="agent-card-accent-hover"]';
const BANNER = '[data-slot="extension-card-banner"][data-accent-detail]';
const HOVER = '[data-slot="extension-card-accent-hover"]';
const MODAL = '[data-slot="dialog-content"]';
const HERO = '[data-slot="marketplace-modal-hero"]';

export const AGENT_CARD_ACCENT_HOVER_DRIVER: SurfaceDriver = {
  path: "/design-fixtures/conformance",
  root: (page) => page.locator(ROOT),
  present: async (_page, root) => {
    await expect(root).toBeVisible();
    const banner = root.locator(BANNER);
    await expect(banner).toHaveCount(1);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveCSS("cursor", "pointer");
    await expect(banner).toHaveAttribute("aria-haspopup", "dialog");
    await expect(banner.locator(HOVER)).toHaveCount(1);
  },
  fields: {},
  actions: {
    "open-details": {
      outcome: "detail-modal-open",
      run: async (page, root) => {
        const banner = root.locator(BANNER);
        const modal = page.locator(MODAL);
        // A press that lands before React hydration is swallowed, so it is
        // retried until the modal answers (openViaHydrated of
        // tests/e2e/design/agents-card-accent.spec.ts).
        await expect(async () => {
          await banner.click();
          await expect(modal).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await expect(modal.locator(HERO)).toBeVisible();
        // Opened IN PLACE: the press did not follow the panel's fallback href.
        expect(new URL(page.url()).hash).toBe("");
        await page.keyboard.press("Escape");
        await expect(modal).toHaveCount(0);
      },
    },
  },
  states: {
    "kind:agent": async (_page, root) => {
      await expect(root.locator('[data-slot="installed-extension-kind-label"]')).toHaveText("Agent");
    },
  },
};
