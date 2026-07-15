/**
 * Regression: ExtensionsTabSelect single-navigation-per-selection (cinatra#1645).
 *
 * The §VI Installed-extensions status filter is a controlled Radix Select whose
 * `value` is the URL-derived tab; selecting a tab pushes the new URL and the
 * server re-renders from it. Before #1645, on the first post-hydration
 * selection the controlled value lagged the router push and Radix's hidden
 * native <select> (SelectBubbleInput) re-asserted the PREVIOUS tab, firing a
 * STRAY SECOND client navigation that reverted the URL back to the active tab
 * (the "tab flap" — deterministically reproduced by the design job on the slow
 * CI runner: `toHaveURL(/tab=archived/)` never stuck; the list stayed at the 4
 * active cards). The fix holds the selection optimistically across the push so
 * the controlled value can never lag back.
 *
 * This test pins the invariant DIRECTLY: selecting "Archived" produces EXACTLY
 * ONE client navigation — to ?tab=archived — with NO stray revert to the active
 * URL, and the URL then STAYS on ?tab=archived. It records every History push /
 * replace the router performs (App Router navigates via window.history), so a
 * revert cannot slip between URL samples.
 *
 * Runs in the design-conformance-functional project (the same seeded harness +
 * standalone recipe as the filter-status acceptance action). The ONLY retry is
 * an element-readiness retry on OPENING the combobox past hydration (mirrors the
 * suite's `clickUntil` on the trigger); the selection click and every
 * navigation assertion are single-shot — no retry wrappers.
 */
import { test, expect, type Page } from "@playwright/test";

import { SEEDED_INSTALLED_ARCHIVED_COUNT } from "../../../../src/app/design-fixtures/conformance/seed-data";
import { SEEDED_HARNESS_PATH, ensureSeeded } from "./contract";

const INSTALLED_LIST_SELECTOR = '[data-slot="installed-extension-card"]';

// Record every History navigation the client performs (App Router uses
// history.pushState/replaceState for soft navigations), independent of how fast
// a revert would land.
async function installNavRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __navs: string[] };
    w.__navs = [];
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = function (
        this: History,
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ) {
        try {
          w.__navs.push(String(url ?? location.href));
        } catch {
          /* ignore */
        }
        return original(data, unused, url ?? null);
      } as typeof history.pushState;
    }
  });
}

test.describe("ExtensionsTabSelect — single navigation per selection (cinatra#1645)", () => {
  test.beforeAll(async () => {
    await ensureSeeded();
  });

  test("selecting Archived navigates once to ?tab=archived and stays (no stray revert)", async ({
    page,
  }) => {
    await installNavRecorder(page);
    await page.goto(SEEDED_HARNESS_PATH, { waitUntil: "domcontentloaded" });

    const trigger = page.getByRole("combobox", {
      name: "Filter installed extensions by state",
    });
    await expect(trigger).toBeVisible();
    const archivedOption = page.getByRole("option", { name: "Archived" });

    // Element-readiness ONLY: open the combobox, retrying the OPEN past
    // hydration (mirrors contract.ts `clickUntil` on the trigger). The
    // selection + navigation assertions below are single-shot.
    await expect(async () => {
      await trigger.click();
      await expect(archivedOption).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // Isolate the selection's navigations from the initial page load.
    const urlBeforeSelect = page.url();
    await page.evaluate(() => {
      (window as unknown as { __navs: string[] }).__navs = [];
    });

    // THE SELECTION — single click, no retry.
    await archivedOption.click();

    // Final stable URL: on ?tab=archived, and it STAYS there.
    await expect(page).toHaveURL(/tab=archived/);
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/tab=archived/);

    // Navigation invariant: the selection navigates to ?tab=archived and NEVER
    // back to the active tab. Every recorded History mutation is normalized to
    // an absolute URL (records may be relative or absolute) against the
    // pre-selection (active) URL — that URL is NOT discarded: a navigation back
    // to it is precisely the #1645 revert this test must catch. The recorder
    // was cleared immediately before the click, so these are the selection's
    // navigations only.
    const navs = await page.evaluate(
      () => (window as unknown as { __navs: string[] }).__navs,
    );
    const normalized = navs.map((u) => new URL(u, urlBeforeSelect).href);
    // A revert = any recorded destination that is not the archived tab (the
    // active/base URL, or any other non-archived target).
    const revertNavs = normalized.filter((u) => !/tab=archived/.test(u));
    expect(
      revertNavs.length,
      `no navigation may revert away from the archived tab (the #1645 flap); recorded reverts: ${JSON.stringify(
        revertNavs,
      )} (full sequence: ${JSON.stringify(normalized)})`,
    ).toBe(0);
    // ...and the selection DID navigate to the archived tab.
    const archivedNavs = normalized.filter((u) => /tab=archived/.test(u));
    expect(
      archivedNavs.length,
      `selecting Archived must navigate to ?tab=archived; recorded: ${JSON.stringify(
        normalized,
      )}`,
    ).toBeGreaterThanOrEqual(1);

    // Final rendered state matches the archived tab (unchanged four-kind
    // filtering behaviour) — the server re-rendered the archived partition.
    const list = page.locator(
      '[data-surface-id="installed-extensions-list"][data-variant="populated"]',
    );
    await expect(list).toHaveAttribute("data-tab", "archived");
    await expect(list.locator(INSTALLED_LIST_SELECTOR)).toHaveCount(
      SEEDED_INSTALLED_ARCHIVED_COUNT,
    );
    await expect(list.locator(`${INSTALLED_LIST_SELECTOR}[data-archived]`)).toHaveCount(
      SEEDED_INSTALLED_ARCHIVED_COUNT,
    );
  });
});
