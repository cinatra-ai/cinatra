/**
 * ITEM-BY-ITEM CONFORMANCE of the setup wizard's step rail against its design
 * spec, driven on the REAL running wizard (cinatra#2502).
 *
 * THE PINNED SPEC — `specs/app-setup.html` revision 0.3.0 at design
 * commit 052bfb5f5ec7545124e50d2adf656d9adc80eca1. Every assertion below cites
 * the section it comes from, and each numbered item is one sentence of that
 * spec turned into a measurement. Requirement NAMES are quoted here; spec prose is not.
 *
 * BIDIRECTIONAL: the spec→render direction asserts every rule functions; the
 * render→spec direction asserts nothing renders that the spec does not specify
 * (no card chrome around a step body, no fourth pill state, no second Secrets
 * pill, no check on a pill that is not done).
 *
 * The suite runs with `CINATRA_E2E_SETUP_BYPASS` unset — the wizard is the
 * surface under proof, so bypassing it would prove nothing — and drives the
 * states in wizard order so each is reached the way an operator reaches it.
 */
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";

import {
  captureStateShots,
  deleteMetadataKeys,
  expectNoCardChrome,
  readMetadataValue,
  writeMetadataValue,
  expectUniversalStepRail,
  fillStable,
  signUpThroughSetupForm,
  resetFreshInstance,
  suiteBaseUrl,
  uniqueFirstAccount,
  waitForHydration,
  UNIVERSAL_STEP_TITLES,
  SETUP_SECRETS_PATH,
} from "./support/instance-state";

test.describe.configure({ mode: "serial" });

// SHORT label on purpose: `uniqueFirstAccount` builds the username as
// `setupacc<label><13-digit stamp>`, and Better Auth's username plugin caps a
// username at 30 characters — a longer label 400s the real sign-up POST with
// an error the form surfaces only as "the wizard did not advance".
const account = uniqueFirstAccount("rail");

// ONE browser context for the whole serial walk. The default `page` fixture
// gives each test a FRESH context, which drops the session the sign-up test
// earns — every later step then 307s to /sign-in and the wizard states this
// suite exists to inspect are unreachable. Same shape as the 01/02 walks.
let context: BrowserContext;
let page: Page;

/** The connection service's stored settings — cleared for this walk, restored
 *  afterwards (see afterAll). */
const NANGO_CONFIG_KEY = "connector_config:nango";
let savedNangoConfig: string | null = null;

/** The wizard column bound, §I: max-w-2xl · 42rem · 672px. */
const COLUMN_BOUND_PX = 672;

function railOf(page: Page): Locator {
  return page.getByRole("navigation", { name: "Setup progress" });
}

/** One pill's geometry + treatment, read off the LIVE element. */
async function readPills(page: Page) {
  return railOf(page).evaluate((nav) => {
    const items = Array.from(nav.querySelectorAll("li"));
    return items.map((li) => {
      const pill = li.lastElementChild as HTMLElement;
      const connector = li.children.length > 1 ? (li.firstElementChild as HTMLElement) : null;
      const cs = getComputedStyle(pill);
      const glyph = pill.querySelector("svg");
      const glyphBox = glyph?.getBoundingClientRect();
      return {
        // UPPERCASED here, not read as rendered: the pill's `uppercase` class
        // is presentation, and `textContent` reports the SOURCE casing. Every
        // label comparison below is therefore case-normalised, never a claim
        // about how the glyphs happen to be cased in the markup.
        label: (pill.textContent ?? "").trim().toUpperCase(),
        tag: pill.tagName.toLowerCase(),
        isLink: pill.tagName.toLowerCase() === "a",
        href: pill.getAttribute("href"),
        ariaCurrent: pill.getAttribute("aria-current"),
        className: pill.getAttribute("class") ?? "",
        height: pill.getBoundingClientRect().height,
        borderRadius: cs.borderTopLeftRadius,
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
        gap: cs.columnGap,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        textTransform: cs.textTransform,
        letterSpacing: cs.letterSpacing,
        whiteSpace: cs.whiteSpace,
        flexShrink: cs.flexShrink,
        color: cs.color,
        background: cs.backgroundColor,
        borderColor: cs.borderTopColor,
        borderWidth: cs.borderTopWidth,
        hasCheck: Boolean(glyph),
        checkW: glyphBox?.width ?? null,
        checkH: glyphBox?.height ?? null,
        // The check must LEAD the label (§II) — first element child of the pill.
        checkLeads: glyph ? pill.firstElementChild === glyph : null,
        // The glyph's OWN resolved colour. `fill="currentColor"` means this
        // must equal the pill's `color`; a glyph given a colour of its own
        // would differ, which is the thing §II forbids.
        checkFill: glyph ? getComputedStyle(glyph).fill : null,
        checkColor: glyph ? getComputedStyle(glyph).color : null,
        // The PAINTED element, not just its <svg> host: a `fill` set on the
        // <path> overrides the svg's and would otherwise escape the check.
        checkPathFill: glyph?.querySelector("path")
          ? getComputedStyle(glyph.querySelector("path")!).fill
          : null,
        connector: connector
          ? {
              width: connector.getBoundingClientRect().width,
              height: connector.getBoundingClientRect().height,
              background: getComputedStyle(connector).backgroundColor,
              ariaHidden: connector.getAttribute("aria-hidden"),
              textContent: (connector.textContent ?? "").trim(),
            }
          : null,
        // Gap either side of the connector comes from the li's own column-gap.
        liGap: getComputedStyle(li).columnGap,
      };
    });
  });
}

/** The three treatments, resolved from the live computed colours. */
type PillState = "done" | "current" | "upcoming" | "UNKNOWN";
function classifyPill(p: { className: string; hasCheck: boolean }): PillState {
  if (/(^|\s)bg-success\/10(\s|$)/.test(p.className)) return "done";
  if (/(^|\s)bg-primary\/10(\s|$)/.test(p.className)) return "current";
  if (/(^|\s)bg-surface-strong(\s|$)/.test(p.className)) return "upcoming";
  return "UNKNOWN";
}

test.beforeAll(async ({ browser }) => {
  await resetFreshInstance();
  // The SECRETS step has to start UNPASSED for this walk to reach its own
  // surface. `resetFreshInstance()` predates cinatra#2502 and does not clear
  // the connection service's stored settings — before this issue the step
  // simply disappeared once connected, so nothing needed it back. Cleared here
  // rather than in the shared reset: the 01/02 walks depend on a configured
  // connection service to save a provider key at all, and widening the reset
  // would pull that out from under them.
  //
  // An ENV-supplied secret key still reports connected and this clear cannot
  // change that; the arms below detect it and say so rather than assert into
  // thin air.
  savedNangoConfig = await readMetadataValue(NANGO_CONFIG_KEY);
  await deleteMetadataKeys([NANGO_CONFIG_KEY]);
  context = await browser.newContext({ baseURL: suiteBaseUrl() });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  // PUT THE STACK BACK. This spec is the only one that clears the connection
  // service, and the 01/02 walks need it configured to save a provider key at
  // all. Leaving it cleared (or holding this suite's throwaway key) would make
  // a selective or reordered run poison whatever ran after it — a failure that
  // would read as a defect in the OTHER spec.
  if (savedNangoConfig !== null) {
    await writeMetadataValue(NANGO_CONFIG_KEY, savedNangoConfig);
  } else {
    await deleteMetadataKeys([NANGO_CONFIG_KEY]);
  }
});

// ---------------------------------------------------------------------------
// §VI — the rail before sign-up: a forecast, not a status
// ---------------------------------------------------------------------------
test("§VI/§VII — the PRE-SIGN-UP rail is a five-step forecast that carries Secrets, with nothing done and nothing clickable", async () => {
  await page.goto("/");
  await page.waitForURL(/\/setup\/account/, { timeout: 60_000 });

  // 1 (§I) — the rail appears on this step, like every other.
  await expect(railOf(page)).toBeVisible();
  // 2 (§II/§VII) — the ordered list of the wizard's steps, in order, with the
  //     Secrets entry among them.
  await expectUniversalStepRail(page);
  const pills = await readPills(page);
  expect(pills.map((p) => p.label)).toEqual([...UNIVERSAL_STEP_TITLES].map((t) => t.toUpperCase()));

  // 3 (§II) — a labelled navigation landmark wrapping an ORDERED list.
  expect(await railOf(page).evaluate((n) => n.tagName.toLowerCase())).toBe("nav");
  expect(await railOf(page).evaluate((n) => Boolean(n.querySelector("ol")))).toBe(true);

  // 4 (§VI) — NO step is done: no check glyph anywhere, no green connector.
  expect(pills.filter((p) => p.hasCheck)).toHaveLength(0);
  expect(pills.filter((p) => classifyPill(p) === "done")).toHaveLength(0);
  // 5 (§VI/§III) — the step on screen is current; every step after it upcoming.
  expect(pills.map(classifyPill)).toEqual([
    "current",
    "upcoming",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);
  // 6 (§VI) — nothing is a link. §IV's return link has nothing to offer when
  //     no step is done.
  expect(pills.filter((p) => p.isLink)).toHaveLength(0);
  // 7 (§VII) — EXACTLY ONE Secrets pill. The spec's own test, on the one screen
  //     where the step used to be absent entirely.
  expect(pills.filter((p) => p.label === "SECRETS")).toHaveLength(1);

  await captureStateShots(page, "2502-01-presignup-rail-forecast");
});

// ---------------------------------------------------------------------------
// §II — anatomy & geometry, §V — density
// ---------------------------------------------------------------------------
test("§II/§V — pill geometry, the check glyph, the connector, and the halving at five steps, measured live", async () => {
  await page.goto("/setup/account");
  const pills = await readPills(page);

  for (const p of pills) {
    // 8  — 32px tall.
    expect(p.height).toBeCloseTo(32, 0);
    // 9  — fully rounded.
    expect(Number.parseFloat(p.borderRadius)).toBeGreaterThanOrEqual(9999 - 1);
    // 10 — 12px horizontal padding.
    expect(p.paddingLeft).toBe("12px");
    expect(p.paddingRight).toBe("12px");
    // 11 — 8px gap between glyph and label.
    expect(p.gap).toBe("8px");
    // 12 — 1px border.
    expect(p.borderWidth).toBe("1px");
    // 13 — 12px sans, weight 600, uppercase, tracking 0.025em, nowrap.
    expect(p.fontSize).toBe("12px");
    expect(p.fontWeight).toBe("600");
    expect(p.textTransform).toBe("uppercase");
    expect(Number.parseFloat(p.letterSpacing)).toBeCloseTo(12 * 0.025, 1);
    expect(p.whiteSpace).toBe("nowrap");
    // 14 — a pill NEVER shrinks.
    expect(p.flexShrink).toBe("0");
    // 15 — 8px either side of each connector (the list item's own gap).
    expect(p.liGap).toBe("8px");
  }

  // 16 (§V) — five steps ⇒ the connector rule HALVES from 40px to 20px.
  const connectors = pills.map((p) => p.connector).filter((c) => c !== null);
  expect(connectors).toHaveLength(4);
  for (const c of connectors!) {
    expect(c!.width).toBeCloseTo(20, 0);
    // 17 (§II) — 2px tall.
    expect(c!.height).toBeCloseTo(2, 0);
    // 18 (§II) — decorative: hidden from assistive tech, and never labelled.
    expect(c!.ariaHidden).toBe("true");
    expect(c!.textContent).toBe("");
  }

  // 19 (§II) — consecutive pills sit 36px apart on a dense rail (8 + 20 + 8).
  const spacing = await railOf(page).evaluate((nav) => {
    const items = Array.from(nav.querySelectorAll("li"));
    const boxes = items.map((li) => (li.lastElementChild as HTMLElement).getBoundingClientRect());
    return boxes.slice(1).map((b, i) => b.left - boxes[i].right);
  });
  for (const gap of spacing) expect(gap).toBeCloseTo(36, 0);

  // 20 (§I/§II) — the rail lives inside the 672px column and does not overflow
  //     it; the wizard column is bounded at 672px.
  const columnWidth = await page
    .locator("main > div")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(columnWidth).toBeLessThanOrEqual(COLUMN_BOUND_PX + 0.5);
  const overflow = await railOf(page).evaluate((n) => n.scrollWidth - n.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // 21 (§II) — a max-content row, CENTRED while it fits.
  const centred = await railOf(page).evaluate((nav) => {
    const ol = nav.querySelector("ol")!;
    const navBox = nav.getBoundingClientRect();
    const olBox = ol.getBoundingClientRect();
    return Math.abs(olBox.left - navBox.left - (navBox.right - olBox.right));
  });
  expect(centred).toBeLessThanOrEqual(1.5);

  // 22 (§I) — 32px between the rail and the step body.
  const railGap = await railOf(page).evaluate((n) => getComputedStyle(n).marginBottom);
  expect(railGap).toBe("32px");

  // 23 (§II) — step NUMBERS are not drawn; the order of the pills is the order
  //     of the steps.
  for (const p of pills) expect(p.label).not.toMatch(/^\s*\d/);
});

// ---------------------------------------------------------------------------
// §III — the three states, walked in wizard order
// ---------------------------------------------------------------------------
test("§III — after sign-up the passed steps read DONE (green + check) and the connector into them is green", async () => {
  await page.goto("/setup/account");
  await signUpThroughSetupForm(page, account);
  await expect(page).not.toHaveURL(/\/setup\/account/);

  await page.goto("/setup/name");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const pills = await readPills(page);

  // 24 — Account and Key are passed: green tint, green hairline, green text,
  //      and the LEADING check glyph.
  const done = pills.filter((p) => classifyPill(p) === "done");
  expect(done.length).toBeGreaterThanOrEqual(2);
  for (const p of done) {
    expect(p.hasCheck).toBe(true);
    expect(p.checkLeads).toBe(true);
    // 25 (§II) — the check is a 14px square…
    expect(p.checkW).toBeCloseTo(14, 0);
    expect(p.checkH).toBeCloseTo(14, 0);
    // 26 (§II) — …drawn in `currentColor`: it takes the PILL's own state
    //      colour and never one of its own. Compared against the pill's
    //      resolved `color`, so a glyph hardcoded to some other value fails
    //      even while it still looks green.
    expect(p.checkColor).toBe(p.color);
    expect(p.checkFill).toBe(p.color);
    expect(p.checkPathFill).toBe(p.color);
    // …and that colour is the done state's sea-green at FULL opacity, not
    // merely "the same as whatever the pill happens to be". Anchored, so a
    // transparent `rgba(63, 110, 107, 0)` — which is invisible and would
    // satisfy an unanchored match — fails.
    expect(p.color).toMatch(/^rgb\(\s*63,\s*110,\s*107\s*\)$/);
  }

  // 27 (§III) — the connector leading INTO a done step is solid green; the
  //      connector into a non-done step is the hairline.
  for (const p of pills) {
    if (!p.connector) continue;
    const isDone = classifyPill(p) === "done";
    const green = /(63,\s*110,\s*107)|rgb\(63, 110, 107\)/.test(p.connector.background);
    expect(
      green,
      `connector into ${p.label} should ${isDone ? "" : "NOT "}be green (got ${p.connector.background})`,
    ).toBe(isDone);
  }

  // 28 (§III) — the CURRENT pill carries NO check and the one full-strength
  //      border on the rail.
  const current = pills.find((p) => classifyPill(p) === "current")!;
  expect(current.hasCheck).toBe(false);
  expect(current.ariaCurrent).toBe("step");

  // 29 (§III) — every pill is in exactly one of the three states. No fourth
  //      treatment renders (the render→spec direction).
  expect(pills.map(classifyPill)).not.toContain("UNKNOWN");
  // 30 — exactly one pill claims to be the page on screen.
  expect(pills.filter((p) => p.ariaCurrent === "step")).toHaveLength(1);

  await captureStateShots(page, "2502-02-midflow-done-current-upcoming");

  // Pass the Name step so the wizard's frontier advances to SECRETS for the
  // arms below — reached the way an operator reaches it, by completing the step
  // in front of it rather than by deep-linking past it. Unique per run:
  // registry-side namespace provisioning survives this suite's DB resets, so a
  // reused namespace refuses to re-provision.
  const display = page.locator("#instance-display-name");
  await expect(display).toBeVisible();
  await fillStable(display, `Lane 2502 Rail ${Date.now()}`);
  await page.click('#instance-name-form button[type="submit"]');
  await page.waitForURL(/\/setup\/(secrets|model)/, { timeout: 60_000 });
});

// ---------------------------------------------------------------------------
// §VII — the Secrets step: named, routed, cardless, and still on the rail
// after it is passed. THE regression this issue exists for.
// ---------------------------------------------------------------------------
test("§VII — /setup/connections redirects to /setup/secrets, and the step is headed Secrets on a CARDLESS body", async () => {
  // 31 — the renamed route keeps its OLD path alive as a PERMANENT redirect.
  //      Asserted on the raw response rather than by driving the browser: the
  //      step forwards on once it is satisfied, so a browser walk would land
  //      wherever the wizard's frontier happens to be and could never tell a
  //      working 308 from a missing one.
  const redirect = await page
    .context()
    .request.get("/setup/connections", { maxRedirects: 0 });
  expect(redirect.status()).toBe(308);
  expect(redirect.headers()["location"]).toContain(SETUP_SECRETS_PATH);

  await page.goto(SETUP_SECRETS_PATH);
  // The step's own surface is only inspectable while it is UNPASSED — once it
  // is satisfied the route forwards on by design. On a stack whose connection
  // service is supplied by the environment the step is already done and this
  // arm has nothing to look at; say so instead of asserting into thin air.
  if (!new URL(page.url()).pathname.startsWith(SETUP_SECRETS_PATH)) {
    test.skip(
      true,
      "the connection service is already configured on this stack — the Secrets step forwards on, so its own surface is unreachable here (the rendered-state proof for it is the DONE arm below)",
    );
  }

  // 32 (§VII) — the step's own heading is the word the rail shows.
  await expect(page.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toHaveCount(0);

  // 33 (§I) — the step body is CARDLESS: the fields sit on the column, not
  //      inside an elevated white card. This is the white background the owner
  //      reported. Checked by walking each field's ancestor chain to <main>.
  await expectNoCardChrome(page, ['input[name="secretKey"]', 'input[name="serverUrl"]']);

  // 34 (§III) — standing on it, the Secrets pill is CURRENT: tinted indigo,
  //      no check, and marked as the page on screen.
  const pills = await readPills(page);
  const secrets = pills.find((p) => p.label === "SECRETS")!;
  expect(classifyPill(secrets)).toBe("current");
  expect(secrets.hasCheck).toBe(false);
  expect(secrets.ariaCurrent).toBe("step");
  // 35 (§IV) — the page on screen is never a link, whatever state it wears.
  expect(secrets.isLink).toBe(false);

  await captureStateShots(page, "2502-03-secrets-step-current-cardless");
});

test("§III/§VII — once PASSED the Secrets step stays on the rail, checked (pre-#2502 it vanished)", async () => {
  await page.goto(SETUP_SECRETS_PATH);
  if (new URL(page.url()).pathname.startsWith(SETUP_SECRETS_PATH)) {
    // The step is the wizard's frontier — PASS it the way an operator does.
    await waitForHydration(page, { selectors: ['input[name="secretKey"]'] });
    await fillStable(page.locator('input[name="secretKey"]'), "lane-2502-conformance-secret-key");
    await page.locator('button[type="submit"]').click();
    // The wizard advances to its next incomplete step.
    await page.waitForURL(/\/setup\/(model|complete)/, { timeout: 60_000 });
  }
  // Either way we are now on a screen the Secrets step is BEHIND, which is the
  // screen this assertion is about.
  expect(new URL(page.url()).pathname).not.toBe(SETUP_SECRETS_PATH);

  // 36 (§VII) — STILL EXACTLY ONE Secrets pill, on a screen the step is behind.
  //      Before this issue the step was dropped from the list the moment it was
  //      satisfied, so it disappeared from the rail here. THIS is the assertion
  //      the issue exists for, and it holds immediately.
  expect((await readPills(page)).filter((p) => p.label === "SECRETS")).toHaveLength(1);

  // 37 (§III) — and it reads DONE: checked, uniformly. The owner's 2026-08-07
  //      decision removed the partial/skipped state — however the step was
  //      satisfied, passed is checked.
  //
  //      POLLED, not read once: the connection service's settings go through a
  //      10 s connector-config read cache (the same one 03-state-matrices waits
  //      out), so a render that lands inside the window still sees the
  //      pre-save value. That is existing caching behaviour, not the rail —
  //      the rail draws whatever status it is handed.
  await expect
    .poll(
      async () => {
        await page.reload();
        const secrets = (await readPills(page)).find((p) => p.label === "SECRETS");
        return secrets ? `${classifyPill(secrets)}:${secrets.hasCheck}` : "MISSING";
      },
      { timeout: 45_000, intervals: [3_000] },
    )
    .toBe("done:true");
  const pills = await readPills(page);
  // …and it is still exactly one pill after the state settles.
  expect(pills.filter((p) => p.label === "SECRETS")).toHaveLength(1);
  // 38 — the rail still carries every step, in order.
  await expectUniversalStepRail(page);

  await captureStateShots(page, "2502-04-secrets-passed-still-checked");
});

test("§IV — the passed Secrets pill's revisit link actually LANDS on the step; it does not bounce", async () => {
  // 38b — THE SILENT BOUNCE §IV names, driven end to end by CLICKING the pill
  //       rather than by typing a URL. Making the step permanent turned its
  //       pill into a revisit link for the first time, and the step's page had
  //       no `?stay=1` read — so the click forwarded straight back to the
  //       wizard's frontier and the rail "looked navigable and behaved as if it
  //       were not". A URL-typed check could not see this: the deliberate
  //       marker is what the LINK carries.
  const secretsLink = railOf(page).locator('a[href^="/setup/secrets"]');
  await expect(secretsLink).toHaveCount(1);
  // The marker rides on the link itself, not on the operator's intent.
  await expect(secretsLink).toHaveAttribute("href", "/setup/secrets?stay=1");

  await secretsLink.click();
  await page.waitForURL(/\/setup\/secrets/, { timeout: 30_000 });
  // It STAYED — the step rendered its own form instead of forwarding on.
  await expect(page.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
  await expect(page.locator('input[name="secretKey"]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(SETUP_SECRETS_PATH);

  // …and §III's precedence holds on the pill the operator just came back to:
  // passed is checked, and only `aria-current` reports where they are.
  const secrets = (await readPills(page)).find((p) => p.label === "SECRETS")!;
  expect(classifyPill(secrets)).toBe("done");
  expect(secrets.hasCheck).toBe(true);
  expect(secrets.ariaCurrent).toBe("step");
  expect(secrets.isLink).toBe(false);

  await captureStateShots(page, "2502-04b-secrets-revisit-link-lands");
});

// ---------------------------------------------------------------------------
// §III precedence + §IV affordances
// ---------------------------------------------------------------------------
test("§III precedence — navigating BACK to a passed step keeps it green and checked; only aria-current moves", async () => {
  await page.goto("/setup/name?stay=1");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const pills = await readPills(page);
  const name = pills.find((p) => p.label === "NAME")!;

  // 39 — DONE WINS: the pill the operator is standing on is a step they have
  //      passed, so it stays green and checked rather than flipping to indigo.
  expect(classifyPill(name)).toBe("done");
  expect(name.hasCheck).toBe(true);
  // 40 — "where am I?" is reported SEPARATELY, by aria-current, whatever colour
  //      the pill is wearing.
  expect(name.ariaCurrent).toBe("step");
  expect(pills.filter((p) => p.ariaCurrent === "step")).toHaveLength(1);
  // 41 (§IV) — and it is not a link: it would link to where the operator is.
  expect(name.isLink).toBe(false);
  // 42 (§III) — no pill un-checked itself on the way here.
  expect(pills.filter((p) => classifyPill(p) === "done").every((p) => p.hasCheck)).toBe(true);

  await captureStateShots(page, "2502-05-done-over-current-precedence");
});

test("§IV — every navigable pill is dressed as a link IN ITS OWN STATE: hover lift + a 2px focus ring", async () => {
  await page.goto("/setup/name?stay=1");
  await waitForHydration(page, { selectors: ["#instance-display-name"] });
  const pills = await readPills(page);

  // 43 (§IV) — a done pill that is not the page on screen IS a link, and its
  //      destination carries the deliberate-navigation marker so the step it
  //      lands on does not immediately forward the operator on.
  const doneLinks = pills.filter((p) => classifyPill(p) === "done" && p.isLink);
  expect(doneLinks.length).toBeGreaterThan(0);
  for (const p of doneLinks) expect(p.href).toMatch(/\?stay=1$/);

  // 44 (§IV) — the ACCOUNT step is never a link even when done: its form
  //      cannot render twice, so a link would be a silent bounce.
  const accountPill = pills.find((p) => p.label === "ACCOUNT")!;
  expect(classifyPill(accountPill)).toBe("done");
  expect(accountPill.isLink).toBe(false);

  // 45 (§IV) — THE UPCOMING RETURN LINK. At most one upcoming step is ever
  //      navigable: the first, and only when the operator is not standing on it
  //      and at least one step is done — i.e. exactly when they have gone back.
  const upcomingLinks = pills.filter((p) => classifyPill(p) === "upcoming" && p.isLink);
  expect(upcomingLinks).toHaveLength(1);
  const returnLink = railOf(page).locator("a").filter({ hasText: upcomingLinks[0].label }).first();

  // 46 (§IV) — it takes a 2px FOCUS RING in its own (upcoming/muted) state
  //      colour. Before cinatra#2502 a keyboard user got no focus indication at
  //      all on this pill.
  const restShadow = await returnLink.evaluate((el) => getComputedStyle(el).boxShadow);
  // REAL KEYBOARD focus, not a programmatic `.focus()`: the ring is drawn by
  // `:focus-visible`, and Chromium only matches that on a link when the last
  // input modality was the keyboard. A scripted focus leaves the ring vars at
  // their 0px defaults and the assertion would measure nothing while looking
  // like it measured something. Shift+Tab then Tab lands back on the same
  // element, this time through the keyboard.
  await returnLink.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(returnLink).toBeFocused();
  // The ring's SPREAD is its width. Parsed off the computed value (colour
  // first, then the four lengths) rather than matched as a substring, so a 1px
  // or 4px ring cannot pass as a 2px one — and POLLED, because the pill carries
  // a `transition` and box-shadow is animated: read once, immediately after the
  // key press, and the measurement lands mid-interpolation at 0.
  const ringSpread = async () =>
    returnLink.evaluate((el) => {
      const shadow = getComputedStyle(el).boxShadow;
      if (shadow === "none") return -1;
      const layers = [
        ...shadow.matchAll(
          /(?:rgba?\([^)]*\)\s*)?(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g,
        ),
      ];
      if (layers.length === 0) return -1;
      return Math.max(...layers.map((m) => Number.parseFloat(m[4])));
    });
  await expect
    .poll(ringSpread, {
      timeout: 5_000,
      message: "the navigable upcoming pill must take a 2px focus ring",
    })
    .toBeCloseTo(2, 0);
  // …and it is the FOCUS that draws it: at rest there is no ring.
  const focusShadow = await returnLink.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(focusShadow, "focusing the pill must change how it is drawn").not.toBe(restShadow);
  await captureStateShots(page, "2502-06-upcoming-return-link-focus-ring");

  // 47 (§IV) — and its TINT LIFTS on hover: white → surface-muted. Before
  //      cinatra#2502 a mouse user got no signal it was clickable at all.
  const atRest = await returnLink.evaluate((el) => getComputedStyle(el).backgroundColor);
  await returnLink.hover();
  await expect
    .poll(async () => returnLink.evaluate((el) => getComputedStyle(el).backgroundColor), {
      timeout: 5_000,
    })
    .not.toBe(atRest);
  await captureStateShots(page, "2502-07-upcoming-return-link-hover");

  // 48 (§IV) — a done link lifts too, in ITS colour.
  const doneLink = railOf(page).locator("a").filter({ hasText: doneLinks[0].label }).first();
  const doneAtRest = await doneLink.evaluate((el) => getComputedStyle(el).backgroundColor);
  await doneLink.hover();
  await expect
    .poll(async () => doneLink.evaluate((el) => getComputedStyle(el).backgroundColor), {
      timeout: 5_000,
    })
    .not.toBe(doneAtRest);

  // 49 (§IV) — an INERT pill is a plain element, not a disabled button: no
  //      pointer affordance, no focus stop. Every non-link pill is a <span>.
  for (const p of pills.filter((x) => !x.isLink)) expect(p.tag).toBe("span");
  // 50 (§IV) — every upcoming step AFTER the first is always inert: the rail
  //      never offers to skip forward past unfinished work.
  const upcoming = pills.filter((p) => classifyPill(p) === "upcoming");
  expect(upcoming.slice(1).filter((p) => p.isLink)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// §I — the wizard frame, on the terminal step
// ---------------------------------------------------------------------------
test("§I — the terminal step is cardless too, and still carries the rail", async () => {
  await page.goto("/setup/complete");
  // The gate may bounce a not-yet-complete instance back into the wizard; the
  // terminal surface is only meaningful once it renders.
  if (!/\/setup\/complete/.test(page.url())) {
    test.skip(true, "the instance is not complete on this run — terminal step unreachable");
  }
  // 51 (§I) — the rail appears on EVERY step page, including this one.
  await expectUniversalStepRail(page);
  // 52 (§I) — from the first step to the terminal one, the body is cardless.
  await expectNoCardChrome(page, ['a[href="/connectors"]', 'a[href="/"]']);
  await captureStateShots(page, "2502-08-terminal-step-cardless");
});
