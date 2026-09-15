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

/**
 * THE OPEN LIST AGAINST ITS TRIGGER, AND THE ROW THAT FILTERS IT (cinatra#3142).
 *
 * The four claims above measure the list's COLOURS. These two measure the shape
 * the drawing draws around them — the second thing a reader sees, and the two
 * sentences the second proof round read off the render as departing.
 *
 * The drawing's own Combobox picture draws the trigger and its open list as ONE
 * control. The trigger takes `border-radius: 7px 7px 0 0`; the list beneath it
 * takes `border-radius: 0 0 7px 7px` with `border-top: 0`; both are outlined
 * `1px solid var(--line-strong)`; and nothing separates them — the seam IS the
 * trigger's own bottom edge. A list floating clear of its trigger on a
 * different, lighter line is two controls, which is what the render drew.
 *
 * Inside it, the type-to-filter row is a flat row on the list's own ground:
 * `display: flex; align-items: center; gap: 8px; padding: 9px 12px;
 * border-bottom: 1px solid var(--line)`, holding a 13px search glyph in
 * `var(--muted)` and its placeholder text in `var(--muted)`. It is not a
 * separately-filled, separately-bordered field pill floating inside the list.
 *
 * One palette note the drawing cannot carry on its own: `--line-strong` is the
 * LIGHT palette's control boundary, reached through `--input`. The dark palette
 * deliberately hands controls a different boundary (cinatra#3107 measured it, and
 * control-border-contrast pins it) because full-navy is invisible on a dark
 * ground. So the claim under test is the one the drawing is actually making —
 * the list is outlined in THE TRIGGER'S OWN boundary, whatever the palette hands
 * it — checked against the strong line by name in the palette that has it.
 */

const SEARCH_ROW = '[data-slot="command-input-wrapper"]';
const SEARCH_INPUT = '[data-slot="command-input"]';
const SEARCH_GLYPH = '[data-slot="command-input-icon"]';

/** Computed properties of one element (or one of its pseudo-elements). */
async function styles(
  page: Page,
  selector: string,
  properties: string[],
  pseudo?: string,
): Promise<Record<string, string>> {
  return page.evaluate(
    ({ s, props, pe }) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`no element for ${s}`);
      const computed = getComputedStyle(el, pe ?? undefined);
      return Object.fromEntries(
        props.map((name) => [name, computed.getPropertyValue(name).trim()]),
      );
    },
    { s: selector, props: properties, pe: pseudo ?? null },
  );
}

/**
 * The ink the cascade gives an input's PLACEHOLDER, normalised so it can be
 * compared with an ordinary computed colour.
 *
 * Not `getComputedStyle(el, "::placeholder")`: Chromium answers that read with
 * a value that does not reflect the cascade at all — measured on this very
 * fixture, it returns fully transparent black in one palette and an almost
 * fully transparent colour in the other, for a placeholder that is plainly
 * painted on screen in both. So the ink is read where it is actually declared:
 * the `::placeholder` rules that MATCH this element, last one winning, then
 * resolved through the element's own custom properties and normalised by
 * letting the browser compute it on a scratch node. Every step happens in the
 * page, in the palette under test, so what comes back is still a measurement
 * and never a literal from the test.
 */
async function placeholderInk(page: Page, selector: string): Promise<string> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`no element for ${s}`);

    // The utility that carries this ink is emitted as a NESTED rule —
    // `.placeholder\:text-muted-foreground { &::placeholder { color: … } }` —
    // so the walk has to resolve `&` against the rule it is nested in before it
    // can ask whether the selector matches this input.
    let declared = "";
    const visit = (rules: CSSRuleList, parent: string) => {
      for (const rule of Array.from(rules)) {
        const selectorText = (rule as CSSStyleRule).selectorText;
        const nested = (rule as CSSGroupingRule).cssRules;

        if (typeof selectorText !== "string") {
          // A grouping rule: `@layer`, `@media`, `@supports`. It selects
          // nothing itself, so the nesting context passes straight through.
          if (nested) visit(nested, parent);
          continue;
        }

        const resolved = selectorText.split(",").map((one) => {
          const selector = one.trim();
          if (!parent) return selector;
          return selector.includes("&")
            ? selector.replace(/&/g, parent)
            : `${parent} ${selector}`;
        });

        for (const selector of resolved) {
          if (!selector.includes("::placeholder")) continue;
          // The app hides a placeholder while its field HAS focus, on purpose
          // and everywhere ("so it doesn't fight with the user's cursor"), and
          // an open list always holds focus in this row — so the rule that
          // matches at this instant paints the prompt transparent rather than
          // in any ink. What is under test is the ink the ROW gives its prompt,
          // which is the rule that applies whenever the prompt is drawn at all.
          if (selector.includes(":focus")) continue;
          const base = selector.replace("::placeholder", "").trim();
          if (!base) continue;
          try {
            if (!el.matches(base)) continue;
          } catch {
            continue;
          }
          const color = (rule as CSSStyleRule).style.getPropertyValue("color");
          if (color) declared = color.trim();
        }

        if (nested) visit(nested, resolved[0] ?? parent);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules, "");
      } catch {
        // A cross-origin sheet cannot be read; none of ours are.
      }
    }
    if (!declared) return "";

    const variable = declared.match(/^var\((--[\w-]+)\)$/);
    const resolved = variable
      ? getComputedStyle(el).getPropertyValue(variable[1]).trim()
      : declared;
    if (!resolved) return "";

    // Normalise: the token may serialise as `oklch(...)` where an ordinary
    // computed colour serialises as `rgb(...)`. Letting the browser compute
    // both puts them in the same vocabulary.
    const scratch = document.createElement("span");
    scratch.style.color = resolved;
    document.body.appendChild(scratch);
    const normalised = getComputedStyle(scratch).color;
    scratch.remove();
    return normalised;
  }, selector);
}

/** One computed property of one element. */
async function style(
  page: Page,
  selector: string,
  property: string,
): Promise<string> {
  return (await styles(page, selector, [property]))[property];
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`the Combobox's open list against its trigger — ${theme} theme`, () => {
    test("the list is JOINED to its trigger — no gap, one outline, the corners meeting", async ({
      page,
    }) => {
      // Room below the control, so the list opens where the drawing draws it.
      // The fixture stacks its probes above the combobox, and a viewport short
      // enough to leave no room under the trigger sends the list up the other
      // side of it — the collision fallback, which is a different picture.
      await page.setViewportSize({ width: 1280, height: 1240 });
      await open(page, theme);
      await page.locator(TRIGGER).click();
      await expect(page.locator(LIST)).toBeVisible();

      // The fixture leaves room below the control, so the list opens where the
      // drawing draws it. A collision-flipped list is a picture the drawing
      // does not draw, and measuring one would measure the fallback instead.
      await expect(page.locator(CONTENT)).toHaveAttribute("data-side", "bottom");

      const geometry = await page.evaluate(
        ({ t, c }) => {
          const trigger = document.querySelector(t)!.getBoundingClientRect();
          const content = document.querySelector(c)!.getBoundingClientRect();
          return {
            gap: content.top - trigger.bottom,
            inset: content.left - trigger.left,
          };
        },
        { t: TRIGGER, c: CONTENT },
      );

      expect(
        Math.abs(geometry.gap),
        `the open list floats ${geometry.gap}px clear of its trigger — the ` +
          "drawing sets the list's top edge ON the trigger's bottom edge and " +
          "drops the list's own top border, so the pair reads as one control",
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(geometry.inset),
        `the list starts ${geometry.inset}px off the trigger's own left edge, so ` +
          "the two outlines do not line up",
      ).toBeLessThanOrEqual(0.5);

      const outline = await styles(page, CONTENT, [
        "border-top-width",
        "border-left-width",
        "border-right-width",
        "border-bottom-width",
        "border-left-color",
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-left-radius",
      ]);
      const trigger = await styles(page, TRIGGER, [
        "border-left-color",
        "border-top-left-radius",
        "border-bottom-left-radius",
      ]);
      const hairline = await style(
        page,
        '[data-testid="line-hairline"]',
        "border-top-color",
      );
      const strong = await style(
        page,
        '[data-testid="line-strong"]',
        "border-top-color",
      );
      const boundary = await style(
        page,
        '[data-testid="control-boundary"]',
        "border-top-color",
      );

      expect(
        outline["border-top-width"],
        "the list draws a top border of its own along the seam, so the joined " +
          "edge reads as two stacked lines rather than the trigger's own edge",
      ).toBe("0px");
      for (const side of [
        "border-left-width",
        "border-right-width",
        "border-bottom-width",
      ] as const) {
        expect(
          outline[side],
          `the drawing outlines the pair in a 1px line; ${side} draws ${outline[side]}`,
        ).toBe("1px");
      }

      // AND NOTHING OUTSIDE THAT ONE OUTLINE.
      //
      // The drawing gives the pair a single 1px border and a soft drop shadow
      // — nothing else. The shared popover layer additionally rings its content
      // (`ring-1 ring-foreground/10`), and a ring is a hard 1px line painted
      // OUTSIDE the border box on all four sides: a second outline around the
      // list, and one that runs straight along the seam the border-top was
      // dropped to open. That is the very reading sentence 19 rejects — a list
      // outlined in a low-alpha line of its own — so it is measured here, off
      // the resolved box-shadow rather than off a class name.
      const rings = await page.evaluate((s) => {
        const shadow = getComputedStyle(document.querySelector(s)!).boxShadow;
        if (!shadow || shadow === "none") return [];
        const layers: string[] = [];
        let depth = 0;
        let current = "";
        for (const character of shadow) {
          if (character === "(") depth += 1;
          else if (character === ")") depth -= 1;
          if (character === "," && depth === 0) {
            layers.push(current.trim());
            current = "";
          } else {
            current += character;
          }
        }
        if (current.trim()) layers.push(current.trim());
        // A hard hairline: no offset, no blur, a spread of its own. A soft drop
        // shadow always carries blur, so this catches rings and nothing else.
        return layers.filter((layer) =>
          /(?:^|\s)0px 0px 0px (?!0px)[\d.]+px/.test(layer),
        );
      }, CONTENT);
      expect(
        rings,
        `the list carries ${rings.length} hard hairline ring(s) outside its own ` +
          `border (${rings.join(" · ")}) — a second outline the drawing does ` +
          "not draw, running along the seam as well as around the sides",
      ).toEqual([]);

      expect(
        outline["border-left-color"],
        `the list is outlined in ${outline["border-left-color"]} while its own ` +
          `trigger is outlined in ${trigger["border-left-color"]} — the drawing ` +
          "gives the joined pair ONE continuous outline",
      ).toBe(trigger["border-left-color"]);
      expect(
        outline["border-left-color"],
        "the list is outlined in something other than the boundary this palette " +
          "hands its controls",
      ).toBe(boundary);
      expect(
        outline["border-left-color"],
        "the list is outlined in the section hairline — the low-alpha line the " +
          "drawing reserves for dividers — so the pair reads as two controls, " +
          "not one",
      ).not.toBe(hairline);
      if (theme === "light") {
        expect(
          outline["border-left-color"],
          "in the palette the drawing is drawn in, the pair's outline IS the " +
            "strong line the drawing names",
        ).toBe(strong);
      }

      expect(
        outline["border-top-left-radius"],
        "the list rounds the corners it meets the trigger at, so a notch opens " +
          "at the seam",
      ).toBe("0px");
      expect(outline["border-top-right-radius"]).toBe("0px");
      expect(
        outline["border-bottom-left-radius"],
        "the list's far corners are square, so the pair has no outer radius at all",
      ).not.toBe("0px");
      expect(
        trigger["border-bottom-left-radius"],
        "the OPEN trigger keeps its bottom corners rounded while the list under " +
          "it is square, so the seam draws a notch on both sides",
      ).toBe("0px");
      expect(
        trigger["border-top-left-radius"],
        "the open trigger squared its outer corners too — the drawing keeps the " +
          "pair's outer corners rounded and squares only the seam",
      ).not.toBe("0px");
    });

    test("the type-to-filter row is the drawing's flat row — ground, glyph, placeholder, closing rule", async ({
      page,
    }) => {
      await open(page, theme);
      await page.locator(TRIGGER).click();
      await expect(page.locator(LIST)).toBeVisible();

      // Its ground: the drawing gives the row no fill of its own, so the list's
      // white shows through it. A fill of its own makes the row a second
      // surface inside a popover the surfaces section allows only one of.
      expect(
        await style(page, SEARCH_ROW, "background-color"),
        "the search row fills with a ground of its own, so the list opens onto " +
          "two surfaces stacked on each other",
      ).toBe("rgba(0, 0, 0, 0)");

      // And no pill around it: the drawing draws a row, not a bordered field
      // dropped inside the list.
      await expect(
        page.locator(`${CONTENT} [data-slot="input-group"]`),
        "the search row is drawn as a bordered field pill inside the list — the " +
          "drawing draws a flat row with a rule under it",
      ).toHaveCount(0);

      // Its closing rule: a 1px hairline under the row, in the divider ink —
      // NOT the stronger boundary the pair's own outline is drawn in.
      const rule = await styles(page, SEARCH_ROW, [
        "border-bottom-width",
        "border-bottom-color",
      ]);
      const hairline = await style(
        page,
        '[data-testid="line-hairline"]',
        "border-top-color",
      );
      expect(
        rule["border-bottom-width"],
        "no rule closes the search row, so the filter and the rows it filters " +
          "run together",
      ).toBe("1px");
      expect(
        rule["border-bottom-color"],
        `the row's closing rule draws ${rule["border-bottom-color"]} rather than ` +
          "the divider hairline the drawing rules it with",
      ).toBe(hairline);

      // Its glyph and its placeholder: both in the muted ink, both measured
      // against a probe drawn by the same palette.
      const muted = await style(page, '[data-testid="muted-ink"]', "color");
      expect(
        await style(page, SEARCH_GLYPH, "color"),
        "the search glyph is drawn in an ink other than the muted one the " +
          "drawing gives it",
      ).toBe(muted);

      const glyph = await page.locator(SEARCH_GLYPH).boundingBox();
      expect(glyph, "the drawing puts a search glyph in the row").not.toBeNull();
      expect(
        Math.round(glyph!.width),
        `the glyph is ${glyph!.width}px wide where the drawing draws it at 13px`,
      ).toBe(13);

      await expect(
        page.locator(SEARCH_INPUT),
        "the row's placeholder is not the wording the drawing types into it",
      ).toHaveAttribute("placeholder", "Search connectors…");
      expect(
        await style(page, SEARCH_INPUT, "color"),
        "the row's own type is drawn in the muted ink, so what a reader TYPES " +
          "reads no darker than the prompt it replaces",
      ).not.toBe(muted);
      // The ink the row gives its prompt. (The prompt itself is hidden for as
      // long as the row holds focus — an app-wide behaviour, not this
      // control's; see the reader in `placeholderInk`.)
      const placeholder = await placeholderInk(page, SEARCH_INPUT);
      expect(
        placeholder,
        "no rule gives the row's placeholder an ink of its own, so the prompt " +
          "reads in whatever the input inherits",
      ).not.toBe("");
      expect(
        placeholder,
        `the placeholder is drawn in ${placeholder} rather than the muted ink ` +
          "the drawing gives it",
      ).toBe(muted);
    });
  });
}
