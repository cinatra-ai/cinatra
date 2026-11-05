// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE TABLE ZEBRA'S ALTERNATE ROWS, IN BOTH PALETTES (cinatra#3552, reworked
// for the seersucker stripe of cinatra#4286).
// ---------------------------------------------------------------------------
// WHAT A PERSON SAW. On the Skills directory in the DARK palette every second
// body row sat on a pale grey slab while its ink stayed pale, so the extension,
// used-in, skill-id and description cells of those rows were hard to read. The
// cause was the token: `--stripe-light: #e3e8ee` was declared for the LIGHT
// palette only, so the dark palette inherited the light literal from `:root`.
//
// WHAT THE PRIMITIVE PAINTS NOW (cinatra#4286). `TableBody` no longer paints a
// flat band. It carries the drawing's seersucker stripe as ONE arbitrary-value
// utility on the even rows (src/components/ui/table.tsx):
//   [&_tr:nth-child(even)]:bg-[image:repeating-linear-gradient(90deg,
//     transparent_0_6px,var(--stripe-light)_6px_7px,transparent_7px_13px,
//     var(--stripe-mid)_13px_14px)]
// so an even row is two 1px threads over the row's own ground (the table
// frame's `bg-background`, src/components/ui/paginated-table.tsx), and the
// ground shows between them. The threads are opaque; nothing is composited.
//
// WHAT THIS FILE KEEPS OF cinatra#3552. The dark palette declares BOTH thread
// tokens itself, in both token layers, with one declaration text; no dark
// thread is lighter than the palette's own `--surface-muted` step or as dark
// as the un-banded ground; and the muted and body inks of those rows clear the
// body-text floor over EVERY thread, not only over the ground between them.
// The light palette keeps the drawing's two literals. The pattern itself, stop
// for stop, is pinned through Tailwind's own compile in
// src/components/ui/__tests__/table-seersucker-stripe-4286.test.tsx.
//
// WHY THIS READS THE STYLESHEET RATHER THAN A BROWSER. jsdom implements
// neither Tailwind's utility generation nor custom-property substitution, so no
// `getComputedStyle` in this environment can tell a wrong colour from NO
// declaration at all. This file takes the stripe utility off the rendered
// `[data-slot="table-body"]`, reads its thread tokens, resolves each inside
// each palette block, and measures it with the repository's own colour maths
// (src/lib/color-contrast.ts).
//
//   pnpm exec vitest run \
//     src/components/ui/__tests__/table-zebra-band-dark-3552.test.tsx --maxWorkers=2

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  type Rgba,
} from "@/lib/color-contrast";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The stylesheets, parsed as structure rather than searched as text.
// ---------------------------------------------------------------------------

const GLOBALS_CSS = readFileSync(
  path.resolve(__dirname, "../../../app/globals.css"),
  "utf8",
);
const TOKENS_CSS = readFileSync(
  path.resolve(__dirname, "../../../../packages/design/src/tokens.css"),
  "utf8",
);

type Rule = { selector: string; body: string };

function topLevelRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (c === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({
          selector: stripped
            .slice(selectorStart, bodyStart - 1)
            .trim()
            .replace(/\s+/g, " "),
          body: stripped.slice(bodyStart, i),
        });
        selectorStart = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      selectorStart = i + 1;
    }
  }
  return rules;
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const flat = body.replace(/\{[^{}]*\}/g, "");
  for (const part of flat.split(";")) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Every declaration of every block with this selector, in stylesheet order. */
function blockOf(rules: Rule[], selector: string, where: string): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  for (const rule of rules) {
    // A rule may GROUP its selectors (`.dark, .dark *`). The block counts when
    // any grouped PART is exactly this selector; reading the whole selector
    // text instead would let a grouped re-declaration of a token hide from this
    // reading, while a descendant-only block (`.dark .sidebar-brand`) still
    // does not count, because its declarations reach only that element.
    const parts = rule.selector.split(",").map((part) => part.trim());
    if (!parts.includes(selector)) continue;
    seen += 1;
    for (const [k, v] of declarations(rule.body)) out.set(k, v);
  }
  if (seen === 0) throw new Error(`no \`${selector}\` block in ${where}`);
  return out;
}

const GLOBALS_RULES = topLevelRules(GLOBALS_CSS);
const TOKENS_RULES = topLevelRules(TOKENS_CSS);

const ROOT_TOKENS = blockOf(GLOBALS_RULES, ":root", "globals.css");
const PALETTE = {
  light: blockOf(GLOBALS_RULES, ".cinatra", "globals.css"),
  dark: blockOf(GLOBALS_RULES, ".dark", "globals.css"),
} as const;
type Palette = keyof typeof PALETTE;

/** The portable mirror the app ships to other surfaces. */
const TOKENS_ROOT = blockOf(TOKENS_RULES, ":root", "tokens.css");
const TOKENS_PALETTE = {
  light: blockOf(TOKENS_RULES, ".cinatra", "tokens.css"),
  dark: blockOf(TOKENS_RULES, ".dark", "tokens.css"),
} as const;

/** Resolve a token to a literal by walking `var(...)` inside one palette block,
 *  falling back to the sheet's `:root` the way the cascade does for a value the
 *  block does not re-declare. */
function resolveIn(
  root: Map<string, string>,
  tokens: Map<string, string>,
  name: string,
  seen = new Set<string>(),
): string {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`);
  seen.add(name);
  const raw = tokens.get(name) ?? root.get(name);
  if (raw === undefined) throw new Error(`no token ${name}`);
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(raw);
  return m ? resolveIn(root, tokens, m[1]!, seen) : raw;
}

/** The two token layers, each read against ITS OWN `:root` fallback: the host
 *  sheet the app compiles and the portable sheet the package ships. Reading the
 *  portable layer through the host sheet's `:root` would let a broken portable
 *  value borrow a correct host one, which is the same shape of lie this file
 *  exists to refuse. */
const SHEETS = {
  host: { root: ROOT_TOKENS, palette: PALETTE },
  portable: { root: TOKENS_ROOT, palette: TOKENS_PALETTE },
} as const;
type Sheet = keyof typeof SHEETS;

const resolve = (
  tokens: Map<string, string>,
  name: string,
  sheet: Sheet = "host",
) => resolveIn(SHEETS[sheet].root, tokens, name, new Set<string>());

function colour(literal: string): Rgba {
  const parsed = parseCssColor(literal);
  expect(parsed, `unsupported colour notation: ${literal}`).not.toBeNull();
  return parsed!;
}

// ---------------------------------------------------------------------------
// The stripe utility, taken off the primitive the product actually paints.
// ---------------------------------------------------------------------------

/** The arbitrary variant the zebra is drawn through. */
const BAND_VARIANT = "[&_tr:nth-child(even)]:";

/** The function the stripe utility paints, with its Tailwind type hint. */
const STRIPE_OPEN = "bg-[image:repeating-linear-gradient(";

type Thread = { token: string; from: string; to: string };

/** The threads of the alternate-row stripe a `TableBody` class list carries:
 *  every non-transparent stop of the gradient, as its token and its span.
 *  A missing prefix, a second carrier, a variant-qualified sibling, a flat
 *  colour utility, or a thread that is not a token FAILS here rather than
 *  being ignored. */
function stripeThreads(className: string): Thread[] {
  const classes = className.split(/\s+/).filter(Boolean);
  const carriers = classes.filter(
    (c) => c.includes("nth-child(even)") && /(?:^|:)bg-/.test(c),
  );
  expect(
    carriers.length,
    `expected exactly one alternate-row background utility in: ${className}`,
  ).toBe(1);
  const carrier = carriers[0]!;
  expect(
    carrier.startsWith(BAND_VARIANT),
    `the alternate-row stripe carries a qualifier ahead of \`${BAND_VARIANT}\` in: ${carrier}`,
  ).toBe(true);
  const rest = carrier.slice(BAND_VARIANT.length);
  expect(
    rest.startsWith(STRIPE_OPEN) && rest.endsWith(")]"),
    `the alternate-row background is not the seersucker gradient in: ${carrier}`,
  ).toBe(true);
  const args = rest.slice(STRIPE_OPEN.length, -2).replace(/_/g, " ");
  const stops: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      stops.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  stops.push(cur.trim());
  const threads: Thread[] = [];
  for (const stop of stops.slice(1)) {
    if (stop.startsWith("transparent ")) continue;
    const m = /^var\((--[A-Za-z0-9-]+)\) (\S+) (\S+)$/.exec(stop);
    expect(m, `a stripe thread that is not a token at a span: ${stop}`).not.toBeNull();
    threads.push({ token: m![1]!, from: m![2]!, to: m![3]! });
  }
  return threads;
}

/** The table body the product paints, mounted from the primitive itself so the
 *  class this file reads is the class the Skills directory renders. */
function tableBody(): HTMLElement {
  const { container } = render(
    <Table>
      <TableBody>
        <TableRow>
          <TableCell>Send the weekly digest</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Reconcile the CRM</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
  const body = container.querySelector<HTMLElement>('[data-slot="table-body"]');
  expect(body, "the table body renders").not.toBeNull();
  return body!;
}

/** Each thread as a person sees it (opaque, so its own colour), and the
 *  un-banded ground the stripe sits on and that shows between the threads. */
function paintedThreads(
  palette: Palette,
  sheet: Sheet = "host",
): { threads: Rgba[]; ground: Rgba } {
  const tokens = SHEETS[sheet].palette[palette];
  const threads = stripeThreads(tableBody().className).map((t) =>
    colour(resolve(tokens, t.token, sheet)),
  );
  expect(threads.length, "the stripe has its two threads").toBe(2);
  return { threads, ground: colour(resolve(tokens, "--background", sheet)) };
}

/** The inks the Skills directory puts on those rows: the four muted cells take
 *  `text-muted-foreground` and the skill-name cell inherits the body ink
 *  (packages/skills/src/plugin-pages.tsx). */
function inks(palette: Palette, sheet: Sheet = "host"): { muted: Rgba; body: Rgba } {
  const tokens = SHEETS[sheet].palette[palette];
  return {
    muted: colour(resolve(tokens, "--muted-foreground", sheet)),
    body: colour(resolve(tokens, "--foreground", sheet)),
  };
}

/** WCAG 2.x body-text floor. */
const BODY_TEXT_FLOOR = 4.5;

const THREAD_TOKENS = ["--stripe-light", "--stripe-mid"] as const;

// ---------------------------------------------------------------------------
// 1. THE DARK PALETTE.
// ---------------------------------------------------------------------------
describe("the alternate-row stripe in the DARK palette", () => {
  it("declares both thread tokens for the dark palette, in BOTH token layers, with one declaration text", () => {
    for (const name of THREAD_TOKENS) {
      const inGlobals = PALETTE.dark.get(name);
      const inTokens = TOKENS_PALETTE.dark.get(name);
      expect(
        inGlobals,
        `the \`.dark\` block of src/app/globals.css does not declare ${name}, so the thread inherits the light literal from :root`,
      ).toBeDefined();
      expect(
        inTokens,
        `the \`.dark\` block of packages/design/src/tokens.css does not declare ${name}, so the portable layer carries the same defect`,
      ).toBeDefined();
      expect(
        inTokens,
        `the host layer and the portable layer must carry the SAME declaration text for ${name}`,
      ).toBe(inGlobals);
    }
  });

  it("draws DARK threads: none lighter than the palette's own --surface-muted step, each lighter than the un-banded ground", () => {
    const { threads, ground } = paintedThreads("dark");
    const surfaceMuted = relativeLuminance(
      colour(resolve(PALETTE.dark, "--surface-muted")),
    );
    // The dark palette's own surface ladder, as declared: --background 0.0021,
    // --surface 0.0044, --surface-strong 0.0092, --surface-muted 0.0216.
    expect(surfaceMuted).toBeCloseTo(0.0216, 4);
    expect(relativeLuminance(ground)).toBeCloseTo(0.0021, 4);
    for (const thread of threads) {
      // The light literal #e3e8ee would read 0.79 here, #b8c4d4 0.54.
      expect(relativeLuminance(thread)).toBeLessThanOrEqual(surfaceMuted);
      expect(relativeLuminance(thread)).toBeGreaterThan(relativeLuminance(ground));
    }
  });

  it("carries the muted cells (extension, used in, skill id, description) over the body-text floor on every thread", () => {
    const { threads } = paintedThreads("dark");
    for (const thread of threads) {
      expect(contrastRatio(inks("dark").muted, thread)).toBeGreaterThanOrEqual(
        BODY_TEXT_FLOOR,
      );
    }
  });

  it("carries the skill-name cell's body ink over the same floor on every thread", () => {
    const { threads } = paintedThreads("dark");
    for (const thread of threads) {
      expect(contrastRatio(inks("dark").body, thread)).toBeGreaterThanOrEqual(
        BODY_TEXT_FLOOR,
      );
    }
  });

  it("draws the same dark threads in the PORTABLE token layer, resolved through that layer's own tokens", () => {
    // The declaration-text case above proves the two sheets carry the same
    // WORDS. This one proves the portable sheet's own values make those words
    // mean the same thing.
    const { threads, ground } = paintedThreads("dark", "portable");
    const { muted, body } = inks("dark", "portable");
    const surfaceMuted = relativeLuminance(
      colour(resolve(TOKENS_PALETTE.dark, "--surface-muted", "portable")),
    );
    for (const thread of threads) {
      expect(relativeLuminance(thread)).toBeLessThanOrEqual(surfaceMuted);
      expect(relativeLuminance(thread)).toBeGreaterThan(relativeLuminance(ground));
      expect(contrastRatio(muted, thread)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
      expect(contrastRatio(body, thread)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
    }
  });

  it("leaves the ground between the threads, and the odd rows, where they already read", () => {
    const { ground } = paintedThreads("dark");
    const { muted, body } = inks("dark");
    expect(contrastRatio(muted, ground)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
    expect(contrastRatio(body, ground)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// 2. THE LIGHT PALETTE KEEPS THE DRAWING'S TWO LITERALS.
// ---------------------------------------------------------------------------
describe("the alternate-row stripe in the LIGHT palette", () => {
  it("keeps the fabric stripe literals in every light block of both token layers", () => {
    for (const [where, tokens] of [
      ["globals.css :root", ROOT_TOKENS],
      ["globals.css .cinatra", PALETTE.light],
      ["tokens.css :root", TOKENS_ROOT],
      ["tokens.css .cinatra", TOKENS_PALETTE.light],
    ] as const) {
      expect(tokens.get("--stripe-light")?.toLowerCase(), where).toBe("#e3e8ee");
      expect(tokens.get("--stripe-mid")?.toLowerCase(), where).toBe("#b8c4d4");
    }
  });

  it("paints those literals as its two threads", () => {
    const { threads } = paintedThreads("light");
    expect(threads).toEqual([colour("#e3e8ee"), colour("#b8c4d4")]);
  });

  it("keeps its muted and body inks over the floor on the ground between the threads", () => {
    // The threads are 1px hairlines; the cell text sits on the row's ground,
    // which the stripe leaves as it is.
    const { ground } = paintedThreads("light");
    const { muted, body } = inks("light");
    expect(contrastRatio(muted, ground)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
    expect(contrastRatio(body, ground)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// 3. THE UTILITY THE SHARED PRIMITIVE CARRIES.
// ---------------------------------------------------------------------------
describe("the utility the shared primitive carries", () => {
  it("names the two stripe tokens as its threads, at the drawn spans, with no flat band", () => {
    expect(stripeThreads(tableBody().className)).toEqual([
      { token: "--stripe-light", from: "6px", to: "7px" },
      { token: "--stripe-mid", from: "13px", to: "14px" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. THE READING REFUSES THE WAYS IT COULD LIE. Each case below is SYNTHETIC,
//    so none of them is pinned to a live token's state.
// ---------------------------------------------------------------------------
describe("the reading itself", () => {
  it("sees a token re-declared by a GROUPED palette selector, through the reader itself", () => {
    const grouped = topLevelRules(
      ".dark { --stripe-light: #000000; } .dark, .dark * { --stripe-light: #ffffff; }",
    );
    expect(blockOf(grouped, ".dark", "synthetic").get("--stripe-light")).toBe(
      "#ffffff",
    );
    // A descendant-only block still does not count as the palette block.
    expect(() =>
      blockOf(topLevelRules(".dark .sidebar { --stripe-light: #ffffff; }"), ".dark", "synthetic"),
    ).toThrow();
  });

  it("reports the :root fallback a palette block leaves undeclared, which is the shape of this defect", () => {
    const rules = topLevelRules(
      ":root { --stripe-mid: #b8c4d4; } .dark { --background: #020618; }",
    );
    const root = blockOf(rules, ":root", "synthetic");
    const dark = blockOf(rules, ".dark", "synthetic");
    expect(dark.has("--stripe-mid")).toBe(false);
    expect(resolveIn(root, dark, "--stripe-mid")).toBe("#b8c4d4");
  });

  it("refuses the former flat band instead of reading it as a stripe", () => {
    expect(() => stripeThreads(`${BAND_VARIANT}bg-stripe-light/50`)).toThrow();
  });

  it("refuses a dark-qualified sibling instead of ignoring it", () => {
    const stripe =
      `${BAND_VARIANT}${STRIPE_OPEN}90deg,transparent_0_6px,var(--stripe-light)_6px_7px,transparent_7px_13px,var(--stripe-mid)_13px_14px)]`;
    expect(stripeThreads(stripe)).toHaveLength(2);
    expect(() =>
      stripeThreads(`${stripe} dark:${BAND_VARIANT}bg-surface-muted`),
    ).toThrow();
    expect(() => stripeThreads(`dark:${stripe}`)).toThrow();
  });

  it("refuses a thread drawn as a literal colour instead of a token", () => {
    expect(() =>
      stripeThreads(
        `${BAND_VARIANT}${STRIPE_OPEN}90deg,transparent_0_6px,#e3e8ee_6px_7px)]`,
      ),
    ).toThrow();
  });

  it("refuses a class list that carries no stripe utility at all", () => {
    expect(() => stripeThreads("[&_tr:last-child]:border-0")).toThrow();
  });
});
