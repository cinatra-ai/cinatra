/**
 * Shared React-hydration wait gate for the e2e suites.
 *
 * Per https://docs.cinatra.ai/references/platform/e2e-headless-hydration/,
 * dev-mode (`pnpm dev` / Turbopack) hydration lands ~20–40s after
 * `domcontentloaded` — any UI interaction issued before `hydrateRoot`
 * commits races React's synthetic event attachment and flakes. React
 * attaches `__reactFiber$…` keys to a DOM node only after the hydration
 * commit, so checking a stable SSR-visible element for that key is the
 * proven element-specific gate (used by the rbac + notifications suites).
 *
 * The default sentinel chain targets the app-shell sidebar — the chat nav
 * link, then any `nav`, then the sidebar slot — which every authenticated
 * surface renders. Suites that interact with a more specific subtree can
 * pass their own `selectors`.
 */
import type { Page } from "@playwright/test";

// CI runs against a prebuilt standalone production server (instant route
// serve + sub-5s hydration); 30s is generous there. The 90s local budget
// absorbs Turbopack cold-compile + Fast Refresh rebuild churn under
// sustained suite load. Mirrors the rbac suite's budget.
export const HYDRATION_TIMEOUT_MS = process.env.CI ? 30_000 : 90_000;

const DEFAULT_SENTINELS = ['a[href="/chat"]', "nav", '[data-slot="sidebar"]'];

export async function waitForHydration(
  page: Page,
  opts: { selectors?: string[]; timeoutMs?: number } = {},
): Promise<void> {
  const selectors = opts.selectors ?? DEFAULT_SENTINELS;
  await page.waitForFunction(
    (sels) => {
      let el: Element | null = null;
      for (const sel of sels) {
        el = document.querySelector(sel);
        if (el) break;
      }
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    },
    selectors,
    { timeout: opts.timeoutMs ?? HYDRATION_TIMEOUT_MS },
  );
}
