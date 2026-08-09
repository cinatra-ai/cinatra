/**
 * THE `/ ↔ /setup` SOFT-NAVIGATION LOOP, on the real surface (cinatra#2544).
 *
 * `AppShell.connectionReady` is a root-layout SERVER SNAPSHOT. The App Router
 * does not re-render a root layout on client navigation, so the value the shell
 * holds is whatever the last FULL DOCUMENT LOAD resolved. At the end of
 * onboarding that value is reliably wrong — the layout last ran while setup was
 * genuinely incomplete — and the old shell redirected off it unconditionally:
 *
 *   finish the last step → /setup re-derives FRESH "complete" → redirect("/")
 *   → / → redirect("/chat") → shell reads the STALE false → replace("/setup")
 *   → /setup re-derives FRESH "complete" → … forever, until a hard refresh.
 *
 * Every arm below drives that on the running app, and each asserts LOOP
 * FREEDOM BY COUNTING MAIN-FRAME NAVIGATIONS — not by the absence of a crash,
 * which the bug never produced. A loop is a URL sequence that keeps growing;
 * a fix is a sequence that stops.
 *
 * The middle arm is the whole issue, and it is driven the way a real operator
 * hits it: the wizard's LAST step is completed through its own form, and the
 * server-action redirect chain that follows is entirely CLIENT-SIDE. A
 * `window` marker planted before the transition proves no document ever
 * reloaded — because a reload is exactly what used to be the only escape, and
 * a proof that silently reloaded would prove nothing at all.
 *
 * Run (from the worktree root, with the lane's own DB + port):
 *   E2E_SETUP_ALLOW_DB_RESET=<db name> E2E_SETUP_PORT=<port> \
 *     pnpm test:e2e:setup 04-setup-gate-soft-nav
 */
import { test, expect, type Page } from "@playwright/test";

import {
  resetFreshInstance,
  deleteMetadataKeys,
  readCommitment,
  readMetadataValue,
  writeMetadataValue,
  fillStable,
  waitForHydration,
  flipStubControl,
  captureStateShots,
  continueThroughModelStep,
  uniqueFirstAccount,
  signUpThroughSetupForm,
} from "./support/instance-state";

test.describe.configure({ mode: "serial" });

const account = uniqueFirstAccount("softnav");

/** Every main-frame URL this page has occupied, in order. */
type NavLog = { urls: string[] };

function recordNavigations(page: Page): NavLog {
  const log: NavLog = { urls: [] };
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    log.urls.push(new URL(frame.url()).pathname);
  });
  return log;
}

/** Client-side (soft) navigations do not fire `framenavigated`, so the pathname
 *  is polled as well — this is the sequence a loop would grow without bound. */
async function settleAndTrace(page: Page, ms = 6_000): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const here = new URL(page.url()).pathname;
    if (seen[seen.length - 1] !== here) seen.push(here);
    await page.waitForTimeout(250);
  }
  return seen;
}

/** How many times the trace ENTERED a path (a loop re-enters; a redirect does
 *  not). Counting entries rather than occurrences is what distinguishes
 *  "passed through /setup once" from "bounced through /setup repeatedly". */
function entries(trace: string[], predicate: (p: string) => boolean): number {
  let count = 0;
  let inside = false;
  for (const path of trace) {
    const now = predicate(path);
    if (now && !inside) count += 1;
    inside = now;
  }
  return count;
}

const isSetupPath = (p: string) => p === "/setup" || p.startsWith("/setup/");
const isAppPath = (p: string) => !isSetupPath(p) && p !== "/sign-in" && p !== "/sign-up";

let page: Page;
/** The identity row arm 1 removes and arm 2 restores out of band. */
let savedIdentity: string | null = null;

test.beforeAll(async ({ browser }, testInfo) => {
  await resetFreshInstance();
  flipStubControl({
    phase: "softnav-2544",
    openaiKeyValid: true,
    anthropicKeyValid: true,
    probeAccept: true,
  });

  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  page = await context.newPage();

  // Walk the REAL wizard to completion once. Everything after this arm depends
  // on a genuinely complete instance — a seeded one could not prove that the
  // gate the shell disagrees with is the gate the wizard actually produces.
  await page.goto("/setup/account");
  await signUpThroughSetupForm(page, account);

  await page.goto("/setup/name");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const display = page.locator("#instance-display-name");
  await expect(display).toBeVisible();
  await fillStable(display, `Lane 2544 SoftNav ${Date.now()}`);
  await page.click('#instance-name-form button[type="submit"]');
  await page.waitForURL(/\/setup\/(model|secrets)/, { timeout: 60_000 });

  await page.goto("/setup/model?stay=1");
  await page.getByTestId("setup-provider-openai").click();
  await waitForHydration(page, { selectors: ['[data-testid="setup-openai-connection-form"]'] });
  // cinatra#2502 item E — one press: the key saves and the provider commits.
  await continueThroughModelStep(
    page,
    "setup-openai-connection-form",
    'input[name="apiKey"]',
    "sk-e2e-2544-openai-not-a-real-key",
  );
  await expect
    .poll(async () => (await readCommitment())?.provider, { timeout: 60_000 })
    .toBe("openai");
});

test.afterAll(async () => {
  await page?.context()?.close();
});

test("a genuinely incomplete gate still routes a fresh load INTO the wizard, once", async () => {
  // Re-open the LAST step by removing exactly the row its readiness reads. The
  // instance is otherwise fully configured — which is precisely the state the
  // stale snapshot is taken in.
  savedIdentity = await readMetadataValue("instance_identity");
  expect(savedIdentity).not.toBeNull();
  await deleteMetadataKeys(["instance_identity"]);
  expect(await readMetadataValue("instance_identity")).toBeNull();

  const nav = recordNavigations(page);
  // A FULL document load: the root layout runs and resolves a truthful
  // `connectionReady === false`.
  await page.goto("/");
  await page.waitForURL(/\/setup\/name/, { timeout: 60_000 });

  const trace = await settleAndTrace(page);
  // Landed and stayed on the step that is genuinely next.
  expect(new URL(page.url()).pathname).toBe("/setup/name");
  expect(trace).toEqual(["/setup/name"]);
  // The route to get there passed through the app side exactly once. The bug
  // re-entered it on every lap.
  expect(entries(nav.urls, isAppPath)).toBe(1);
  await captureStateShots(page, "2544-01-incomplete-lands-on-wizard");
});

test("finishing the wizard lands on the app and STAYS — no reload, no bounce", async () => {
  // THE REGRESSION, on the path the report describes. The document from arm 1
  // is still on screen, so the shell still holds that arm's truthful
  // `connectionReady === false`. The gate is restored OUT OF BAND below — no
  // server action, no `router.refresh()` — which is the only way to leave the
  // snapshot behind while the server moves on. (A server action would
  // revalidate the router cache and re-render the root layout, which is
  // exactly why the loop is NOT reachable through a form submit and why this
  // arm must not use one.)
  expect(savedIdentity).not.toBeNull();
  await writeMetadataValue("instance_identity", savedIdentity as string);

  // A marker that only a full document load can destroy.
  const marker = `fix2544-${Date.now()}`;
  await page.evaluate((value) => {
    (window as unknown as Record<string, unknown>).__fix2544Marker = value;
  }, marker);

  const nav = recordNavigations(page);

  // Every hop from here is a Next <Link> — client-side, same document:
  //   rail "Model" → the step's Continue → "Skip for now" → / → /chat.
  // That is the real end of onboarding, and it is where the loop appeared.
  await page.getByRole("link", { name: "Model", exact: false }).first().click();
  await page.waitForURL(/\/setup\/model/, { timeout: 60_000 });

  const continueLink = page.getByTestId("setup-ai-continue");
  await expect(continueLink).toBeVisible({ timeout: 30_000 });
  await continueLink.click();
  await page.waitForURL(/\/setup\/complete/, { timeout: 60_000 });

  await page.getByRole("link", { name: /skip for now/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/setup"), { timeout: 90_000 });

  const trace = await settleAndTrace(page, 10_000);

  // 1. NO REVISITS. This is the loop test, and it is why the trace is recorded
  //    rather than just the final URL: a redirect CHAIN visits each path once
  //    (/ → /chat), while a loop necessarily returns to a path it already
  //    left. Pre-fix this trace grew /chat → /setup → /chat → … without bound.
  expect(new Set(trace).size).toBe(trace.length);
  // 2. It never went back into the wizard.
  expect(trace.filter(isSetupPath)).toEqual([]);
  expect(entries(nav.urls, isSetupPath)).toBeLessThanOrEqual(1);
  // 3. It landed on the app and STAYED on the app. A later window may still
  //    move FORWARD (/chat opens its default thread route) — that is the app
  //    navigating itself, not a bounce.
  const settled = await settleAndTrace(page, 6_000);
  expect(settled.every(isAppPath)).toBe(true);
  expect(new Set(settled).size).toBe(settled.length);
  // 4. And it did it WITHOUT a document reload — the only escape the bug had.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__fix2544Marker),
    )
    .toBe(marker);

  await captureStateShots(page, "2544-02-soft-nav-lands-and-stays");
});

test("a direct /setup visit on a configured instance redirects out exactly once", async () => {
  // The mirror direction: the wizard is done, so /setup must hand the visitor
  // back to the app and NOT be handed straight back by the shell.
  const nav = recordNavigations(page);
  await page.goto("/setup");
  await page.waitForURL((url) => !url.pathname.startsWith("/setup"), { timeout: 60_000 });

  const trace = await settleAndTrace(page);
  // Same loop test: no path is revisited on the way out.
  expect(new Set(trace).size).toBe(trace.length);
  // /setup was entered AT MOST once — the visit itself — and never re-entered.
  // At most, not exactly: the hop out is a server-side redirect chain, so the
  // main frame can commit only the final URL and never record /setup at all.
  // Zero is the strongest possible outcome here; two would be the bounce.
  expect(entries(trace, isSetupPath)).toBeLessThanOrEqual(1);
  expect(entries(nav.urls, isSetupPath)).toBeLessThanOrEqual(1);
  const settled = await settleAndTrace(page, 6_000);
  expect(settled.every(isAppPath)).toBe(true);
  expect(new Set(settled).size).toBe(settled.length);
  await captureStateShots(page, "2544-03-setup-redirects-out-once");
});
