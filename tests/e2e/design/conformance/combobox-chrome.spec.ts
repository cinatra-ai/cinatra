/**
 * THE COMBOBOX'S CHROME, ON THE REAL BOOT (cinatra#3142).
 *
 * The drawing gives this component four claims that are COLOUR claims, and a
 * colour claim cannot be settled in jsdom, where no token resolves and a class
 * list is the only thing a test can read:
 *
 *   "A Select crossed with the Command menu: an Input-chrome trigger opens a
 *    type-to-filter list. The current value carries an indigo check; the
 *    highlighted row uses the indigo soft-tint."
 *
 * and, for the ground the list opens onto, the surface vocabulary the whole
 * system is drawn from — "5 tokens · paper to white", of which the white one
 * reads "Card bodies, input fields, popovers. Only place pure white lives in
 * the system."
 *
 * So each claim below is measured on the production-equivalent boot, in BOTH
 * themes, against a probe drawn by the SAME palette rather than against a
 * literal: the trigger's fill against a real Input's fill; the popover's ground
 * against the five surfaces; the highlighted row's tint against the indigo
 * soft-tint; the check's ink against the palette's primary.
 */
import { test, expect, type Page } from "@playwright/test";

const FIXTURE = "/design-fixtures/combobox";

const TRIGGER = "#combobox-chrome";
const INPUT = "#input-chrome";
const LIST = '[data-slot="command-list"]';
const CONTENT = '[data-slot="combobox-content"]';

/**
 * The theme is switched the way the pixel harness beside this one switches it,
 * and the way a reader switches it: the persisted `next-themes` key, then a
 * reload so the anti-flicker script settles the root class before paint. The
 * two palettes are EXCLUSIVE classes on the root, so a test that merely adds
 * `dark` beside `cinatra` measures a document neither palette describes.
 */
async function open(page: Page, theme: "light" | "dark") {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    window.localStorage.setItem("theme", t === "dark" ? "dark" : "cinatra");
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  const root = await page.evaluate(() => document.documentElement.className);
  expect(
    root.split(/\s+/),
    `the root carries "${root}" rather than the ${theme} palette's own class`,
  ).toContain(theme === "dark" ? "dark" : "cinatra");
  await expect(page.locator(TRIGGER)).toBeVisible();
}

/** The computed background of one element, read in the page. */
async function ground(page: Page, selector: string): Promise<string> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`no element for ${s}`);
    return getComputedStyle(el).backgroundColor;
  }, selector);
}

async function probe(page: Page, testid: string): Promise<string> {
  return ground(page, `[data-testid="${testid}"]`);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`the Combobox's chrome — ${theme} theme`, () => {
    test('"an Input-chrome trigger" — the trigger\'s fill is the Input\'s fill', async ({
      page,
    }) => {
      await open(page, theme);
      const trigger = await ground(page, TRIGGER);
      const input = await ground(page, INPUT);
      expect(
        trigger,
        `the trigger fills with ${trigger} while the Input it is told to mirror ` +
          `fills with ${input} — the trigger does not carry the Input's chrome`,
      ).toBe(input);
    });

    test("the list opens onto one of the system's five surfaces — the white popover one", async ({
      page,
    }) => {
      await open(page, theme);
      await page.locator(TRIGGER).click();
      await expect(page.locator(LIST)).toBeVisible();

      const popover = await ground(page, CONTENT);
      const surfaces = {
        paper: await probe(page, "surface-paper"),
        surface: await probe(page, "surface"),
        "surface-strong": await probe(page, "surface-strong"),
        "surface-muted": await probe(page, "surface-muted"),
        sidebar: await probe(page, "surface-sidebar"),
      };
      const named = Object.entries(surfaces).find(([, v]) => v === popover)?.[0];
      expect(
        named,
        `the popover's ground is ${popover}, which is none of the system's five ` +
          `surfaces (${Object.entries(surfaces)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")})`,
      ).toBeDefined();
      expect(
        named,
        "popovers sit on the white surface — \"Card bodies, input fields, " +
          'popovers. Only place pure white lives in the system."',
      ).toBe("surface-strong");

      // The list the rows sit in draws the same ground — a popover with a
      // second ground inside it is two surfaces, not one.
      expect(await ground(page, LIST)).toBe("rgba(0, 0, 0, 0)");
    });

    test('"the highlighted row uses the indigo soft-tint" — and only that row', async ({
      page,
    }) => {
      await open(page, theme);
      await page.locator(TRIGGER).click();
      await expect(page.locator(LIST)).toBeVisible();

      const tint = await probe(page, "soft-tint");
      const rows = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll('[data-slot="command-item"]'),
        ).map((el) => ({
          text: (el.textContent ?? "").trim(),
          selected: el.getAttribute("data-selected"),
          background: getComputedStyle(el).backgroundColor,
        }));
      });
      expect(rows.length, "the fixture's rows must be on screen").toBe(5);

      const tinted = rows.filter((r) => r.background === tint);
      expect(
        tinted.map((r) => r.text),
        `${tinted.length} of ${rows.length} rows carry the indigo soft-tint — ` +
          "the drawing tints THE highlighted row, so a tint on every row marks " +
          "nothing at all",
      ).toHaveLength(1);
      expect(
        tinted[0]?.selected,
        "the tinted row is not the highlighted one",
      ).toBe("true");
      // The drawing opens the list on the current value's row — highlighted and
      // checked, as its own picture draws it. A list that opens anywhere else
      // scrolls the check out of sight the moment the option count grows, which
      // is the whole reason the drawing reaches for this control past ~8.
      expect(
        tinted[0]?.text,
        "the list opens on a row other than the current value, so the check the " +
          "drawing puts on the current value is not where the list opens",
      ).toContain("Salesforce Connector");

      const plain = rows.filter((r) => r.background !== tint);
      expect(
        plain.map((r) => r.background),
        "an unhighlighted row draws a ground of its own",
      ).toEqual(plain.map(() => "rgba(0, 0, 0, 0)"));

      // Moving the highlight moves the tint with it. The open popover puts
      // focus in the type-to-filter input, which is where cmdk reads the arrow
      // keys — the trigger behind it is no longer the focused element.
      await page.locator('[data-slot="command-input"]').press("ArrowDown");
      const afterwards = await page.evaluate(() => {
        const el = document.querySelector('[data-slot="command-item"][data-selected="true"]');
        return {
          text: (el?.textContent ?? "").trim(),
          background: el ? getComputedStyle(el).backgroundColor : null,
        };
      });
      expect(afterwards.text).not.toBe(tinted[0]?.text);
      expect(
        afterwards.background,
        "the tint stayed behind when the highlight moved",
      ).toBe(tint);
    });

    test('"the current value carries an indigo check" — measured, not read off a class', async ({
      page,
    }) => {
      await open(page, theme);
      await page.locator(TRIGGER).click();
      await expect(page.locator(LIST)).toBeVisible();

      const checked = page.locator(`${LIST} [data-checked="true"]`);
      await expect(
        checked,
        "exactly one row — the current value — carries the check",
      ).toHaveCount(1);
      await expect(checked).toContainText("Salesforce Connector");

      const mark = checked.locator("svg");
      await expect(mark).toBeVisible();
      expect(
        await mark.evaluate((el) => getComputedStyle(el).opacity),
        "the check is drawn but transparent, so the current value carries nothing",
      ).toBe("1");

      const inks = await page.evaluate((listSelector) => {
        const read = (el: Element | null) =>
          el ? getComputedStyle(el).color : null;
        return {
          primary: read(document.querySelector('[data-testid="primary-ink"]')),
          foreground: read(document.querySelector('[data-testid="foreground-ink"]')),
          check: read(
            document.querySelector(`${listSelector} [data-checked="true"] svg`),
          ),
        };
      }, LIST);

      expect(inks.check, "the check's ink could not be read").not.toBeNull();
      expect(
        inks.check,
        `the check draws ${inks.check} while the palette's primary is ` +
          `${inks.primary} — the drawing gives the current value an INDIGO check`,
      ).toBe(inks.primary);
      expect(
        inks.check,
        "the check draws in the ordinary foreground ink, so nothing marks the " +
          "current value apart from the rows around it",
      ).not.toBe(inks.foreground);
    });
  });
}
