// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";

import {
  installedDrizzleCubeStylesPath,
  parseItems,
  splitSelectorList,
} from "../../../sdk-dashboard/scripts/scope-drizzle-cube-styles.mjs";

/**
 * Contract: the Cinatra `--dc-*` token mapping in `dashboard-theme.css` wins
 * over drizzle-cube's own root defaults WHATEVER ORDER the stylesheets load in
 * (cinatra#4311).
 *
 * Three stylesheets declare `--dc-*` on the document root: drizzle-cube's raw
 * `drizzle-cube/client/styles.css` (the dashboards shell imports it), its
 * generated scoped copy (`drizzle-cube-scoped.css`, imported by the read-only
 * composition, which keeps the custom-property rules as they are) and the
 * theme. All three are unlayered. Their load order is a property of the module
 * graph, not of one file: the dashboard home reaches the composition, and so
 * the scoped copy and the theme, through `DashboardGridContainer` BEFORE the
 * shell's raw import runs, so the raw defaults can come last. A root token that
 * the theme declares at the same specificity as the raw file would then take
 * drizzle-cube's palette.
 *
 * Pinned here BY BEHAVIOUR, for every order of the three files: the cascade of
 * the root element is resolved from the real stylesheets (selector match by
 * `Element.matches`, specificity, then source order) for the light document
 * (no theme class, and next-themes' `cinatra` class) and for the dark one
 * (`dark` class). Every order must give the same tokens, and in the light
 * document every token the theme declares must be the theme's value. The dark
 * result is the one the shell's own order (defaults, then theme) gives.
 */

const SDK_COMPONENTS = join(__dirname, "..", "..", "..", "sdk-dashboard", "src", "components");
const SHEETS = {
  raw: readFileSync(
    installedDrizzleCubeStylesPath(join(__dirname, "..", "..", "..", "sdk-dashboard")),
    "utf-8",
  ),
  scoped: readFileSync(join(SDK_COMPONENTS, "drizzle-cube-scoped.css"), "utf-8"),
  theme: readFileSync(join(SDK_COMPONENTS, "dashboard-theme.css"), "utf-8"),
} as const;
type SheetName = keyof typeof SHEETS;

type Item = { kind: string; prelude?: string; body?: string; text?: string };
type Specificity = [number, number, number];
type Rule = { selectors: string[]; decls: Array<[string, string]> };

/** Unlayered style rules that declare `--dc-*` tokens, with those declarations,
 *  walking into @media/@supports (never @layer: a layered declaration loses to
 *  every unlayered one). */
function unlayeredRules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const item of parseItems(css) as Item[]) {
    if (item.kind !== "block") continue;
    const prelude = item.prelude ?? "";
    const body = item.body ?? "";
    if (prelude.startsWith("@")) {
      if (/^@(?:media|supports)\b/.test(prelude)) out.push(...unlayeredRules(body));
      continue;
    }
    const decls = (parseItems(body.endsWith(";") ? body : `${body};`) as Item[])
      .filter((d) => d.kind === "statement" && (d.text ?? "").startsWith("--dc-"))
      .map((d) => {
        const text = (d.text ?? "").replace(/;$/, "");
        const colon = text.indexOf(":");
        return [text.slice(0, colon).trim(), text.slice(colon + 1).trim()] as [string, string];
      });
    if (decls.length) out.push({ selectors: splitSelectorList(prelude), decls });
  }
  return out;
}

function skipIdent(sel: string, i: number): number {
  while (i < sel.length && (/[\w-]/.test(sel[i]) || sel[i] === "\\")) i += sel[i] === "\\" ? 2 : 1;
  return i;
}

function closeParen(sel: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sel.length; i++) {
    if (sel[i] === "(") depth++;
    else if (sel[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`unbalanced selector ${sel}`);
}

const maxSpec = (specs: Specificity[]): Specificity =>
  specs.reduce((m, s) => (compare(s, m) > 0 ? s : m), [0, 0, 0] as Specificity);

/** Selectors Level 4 specificity (`:where` 0; `:not`/`:is`/`:has` their most
 *  specific argument). */
function specificity(sel: string): Specificity {
  const s: Specificity = [0, 0, 0];
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === "#") {
      s[0]++;
      i = skipIdent(sel, i + 1);
    } else if (ch === ".") {
      s[1]++;
      i = skipIdent(sel, i + 1);
    } else if (ch === "[") {
      s[1]++;
      i = sel.indexOf("]", i) + 1;
    } else if (ch === ":" && sel[i + 1] === ":") {
      s[2]++;
      i = skipIdent(sel, i + 2);
    } else if (ch === ":") {
      const end = skipIdent(sel, i + 1);
      const name = sel.slice(i + 1, end).toLowerCase();
      if (sel[end] === "(") {
        const close = closeParen(sel, end);
        if (["not", "is", "has"].includes(name)) {
          const inner = maxSpec(splitSelectorList(sel.slice(end + 1, close)).map(specificity));
          s[0] += inner[0];
          s[1] += inner[1];
          s[2] += inner[2];
        } else if (name !== "where") {
          s[1]++;
        }
        i = close + 1;
      } else {
        s[1]++;
        i = end;
      }
    } else if (/[a-zA-Z_]/.test(ch)) {
      s[2]++;
      i = skipIdent(sel, i);
    } else {
      i++;
    }
  }
  return s;
}

function compare(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The winning `--dc-*` declarations on the root element for one load order. */
function resolveRoot(order: SheetName[]): Map<string, string> {
  const root = document.documentElement;
  const best = new Map<string, { value: string; spec: Specificity; pos: number }>();
  let pos = 0;
  for (const name of order) {
    for (const rule of unlayeredRules(SHEETS[name])) {
      pos++;
      const matching = rule.selectors.filter((sel) => {
        if (sel.includes("::")) return false; // a pseudo-element is never the root itself
        try {
          return root.matches(sel);
        } catch {
          throw new Error(`selector does not parse: ${sel}`);
        }
      });
      if (!matching.length) continue;
      const spec = maxSpec(matching.map(specificity));
      for (const [prop, value] of rule.decls) {
        const held = best.get(prop);
        if (!held || compare(spec, held.spec) > 0 || (compare(spec, held.spec) === 0 && pos > held.pos)) {
          best.set(prop, { value, spec, pos });
        }
      }
    }
  }
  return new Map([...best].map(([prop, { value }]) => [prop, value]));
}

const ORDERS: SheetName[][] = [
  ["raw", "scoped", "theme"],
  ["raw", "theme", "scoped"],
  ["scoped", "raw", "theme"],
  ["scoped", "theme", "raw"],
  ["theme", "raw", "scoped"],
  ["theme", "scoped", "raw"],
];

/** The `--dc-*` tokens the theme maps on the light root, with their values. */
function themeLightTokens(): Map<string, string> {
  const block = unlayeredRules(SHEETS.theme).find((r) => r.decls.some(([p]) => p === "--dc-card-bg"));
  expect(block, "the theme's root token block was not found").toBeTruthy();
  return new Map(block!.decls);
}

function pick(resolved: Map<string, string>, props: Iterable<string>): Record<string, string | undefined> {
  return Object.fromEntries([...props].map((p) => [p, resolved.get(p)]));
}

afterEach(() => {
  document.documentElement.className = "";
});

describe("the theme's root tokens do not depend on the stylesheet load order", () => {
  it("reads the three stylesheets' root token rules (the parse is not empty)", () => {
    expect(themeLightTokens().size).toBeGreaterThan(50);
    expect(unlayeredRules(SHEETS.raw).some((r) => r.decls.some(([p]) => p === "--dc-card-bg"))).toBe(true);
    expect(unlayeredRules(SHEETS.scoped).some((r) => r.decls.some(([p]) => p === "--dc-card-bg"))).toBe(true);
  });

  describe.each([
    ["the light document with no theme class", ""],
    ["the light document with the cinatra theme class", "cinatra"],
  ])("%s", (_name, className) => {
    it.each(ORDERS.map((o) => [o.join(" -> "), o] as const))(
      "%s: every token the theme maps is the theme's value",
      (_label, order) => {
        document.documentElement.className = className;
        const tokens = themeLightTokens();
        expect(pick(resolveRoot(order), tokens.keys())).toEqual(Object.fromEntries(tokens));
      },
    );
  });

  it("the home's road (scoped copy, theme, then the shell's raw defaults) keeps the theme's card ground", () => {
    expect(resolveRoot(["scoped", "theme", "raw"]).get("--dc-card-bg")).toBe("var(--card)");
  });

  it("the dark document resolves the same tokens in every order", () => {
    document.documentElement.className = "dark";
    const props = [...themeLightTokens().keys()];
    const reference = pick(resolveRoot(["raw", "scoped", "theme"]), props);
    for (const order of ORDERS) {
      expect(pick(resolveRoot(order), props), order.join(" -> ")).toEqual(reference);
    }
    expect(reference["--dc-primary-rgb"]).toBe("226, 232, 240");
  });

  it("the dark document keeps the tokens the shell's defaults-then-theme order gave", () => {
    // Neither drizzle-cube's dark palette nor the theme's tokens that it lacks
    // (radius, --dc-primary-bg, ...) may change with the fix: the dark result
    // equals the raw-defaults-then-theme cascade the shell always loaded.
    document.documentElement.className = "dark";
    const props = [...themeLightTokens().keys()];
    expect(pick(resolveRoot(["scoped", "theme", "raw"]), props)).toEqual(
      pick(resolveRoot(["raw", "theme"] as SheetName[]), props),
    );
    expect(resolveRoot(["scoped", "theme", "raw"]).get("--dc-radius-md")).toBe("var(--radius-lg, 0.5rem)");
    const rawDark = unlayeredRules(SHEETS.raw).find((r) => r.selectors.includes("html.dark"));
    expect(rawDark, "drizzle-cube's dark token block was not found").toBeTruthy();
    const home = resolveRoot(["scoped", "theme", "raw"]);
    for (const [prop, value] of rawDark!.decls) expect(home.get(prop), prop).toBe(value);
  });
});
