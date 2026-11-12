// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE TABLE'S ALTERNATE-ROW BAND IS ONE FLAT GROUND IN BOTH PALETTES
// (cinatra#4286).
// ---------------------------------------------------------------------------
// THE DRAWING. specs/app-components.html, section "Table": "Alternate rows
// carry one flat band in both palettes. Every second body row lays one flat
// ground one step off the page: darker in the light palette, lighter in the
// dark one. In the light palette the band is --surface-muted #E8E8E3 on the
// page --paper #F1F1ED [...]. In the application's dark palette [...] the band
// is one step lighter than the page [...]: --surface oklch(0.165 0.04 259),
// never a light value. The band is flat: the even row draws no pattern over
// it, and odd rows carry no ground. Body and muted ink keep their contrast on
// the band in both palettes." The stripe colours (--stripe-light,
// --stripe-mid) fill empty media frames and placeholders only, never table
// rows.
//
// THE DEFECT. `TableBody` painted `[&_tr:nth-child(even)]:bg-stripe-light/50`:
// a stripe colour at half opacity, in both palettes.
//
// HOW THIS FILE READS IT. jsdom generates no Tailwind utilities, so the
// rendered `TableBody`'s own class list is compiled with Tailwind
// (`compileAst`, as avatar-corners-4294.test.tsx and
// separator-drawing-conformance.test.tsx do), against the colour registrations
// of the shipped `@theme inline` block and the shipped `dark` custom variant
// of src/app/globals.css. Each class is compiled on its own; the class part of
// each emitted selector is matched as the body element that carries the class
// (`[data-slot="table-body"]`), and the dark variant's `:is(.dark *)` is read
// as a flag that holds only for a table rendered inside a `.dark` element. The
// colours are then resolved through each token layer (src/app/globals.css,
// which the app compiles, and packages/design/src/tokens.css, the portable
// mirror), each through its own `:root`. It reads the utility layer and the
// token declarations, not browser paint.
//
//   pnpm exec vitest run \
//     src/components/ui/__tests__/table-flat-band-4286.test.tsx --maxWorkers=2

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { compileAst } from "tailwindcss";

import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  type Rgba,
} from "@/lib/color-contrast";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The stylesheets, parsed as structure.
// ---------------------------------------------------------------------------

const GLOBALS_CSS = readFileSync(path.resolve(__dirname, "../../../app/globals.css"), "utf8");
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
          selector: stripped.slice(selectorStart, bodyStart - 1).trim().replace(/\s+/g, " "),
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

/** Every custom property of every block whose grouped selector names `selector`. */
function blockOf(rules: Rule[], selector: string, where: string): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  for (const rule of rules) {
    if (!rule.selector.split(",").map((p) => p.trim()).includes(selector)) continue;
    seen += 1;
    const flat = rule.body.replace(/\{[^{}]*\}/g, "");
    for (const part of flat.split(";")) {
      const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
      if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
    }
  }
  if (seen === 0) throw new Error(`no \`${selector}\` block in ${where}`);
  return out;
}

const LAYERS = {
  host: topLevelRules(GLOBALS_CSS),
  portable: topLevelRules(TOKENS_CSS),
} as const;
type Layer = keyof typeof LAYERS;
type Palette = "light" | "dark";
const PALETTE_SELECTOR: Record<Palette, ".cinatra" | ".dark"> = {
  light: ".cinatra",
  dark: ".dark",
};

function resolveIn(
  root: Map<string, string>,
  block: Map<string, string>,
  name: string,
  seen = new Set<string>(),
): string {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`);
  seen.add(name);
  const raw = block.get(name) ?? root.get(name);
  if (raw === undefined) throw new Error(`no token ${name}`);
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(raw);
  return m ? resolveIn(root, block, m[1]!, seen) : raw;
}

/** A token's literal in one palette of one layer, through that layer's own `:root`. */
function tokenIn(layer: Layer, palette: Palette, name: string): string {
  const where = layer === "host" ? "globals.css" : "tokens.css";
  const root = blockOf(LAYERS[layer], ":root", where);
  const block = blockOf(LAYERS[layer], PALETTE_SELECTOR[palette], where);
  return resolveIn(root, block, name).toLowerCase();
}

function colour(literal: string): Rgba {
  const parsed = parseCssColor(literal);
  expect(parsed, `unsupported colour notation: ${literal}`).not.toBeNull();
  return parsed!;
}

// ---------------------------------------------------------------------------
// The utilities the primitive carries, compiled the way the app compiles them.
// ---------------------------------------------------------------------------

/** The shipped colour registrations (`@theme inline`) of src/app/globals.css. */
const THEME = blockOf(LAYERS.host, "@theme inline", "globals.css");

/** The shipped `dark` variant of src/app/globals.css. */
const DARK_VARIANT = (() => {
  const m = /@custom-variant\s+dark\s+(\([^;]*\))\s*;/.exec(GLOBALS_CSS);
  if (!m) throw new Error("no `@custom-variant dark` in globals.css");
  return m[1]!;
})();

/** The selector part the dark variant adds (`(&:is(.dark *))` -> `:is(.dark *)`). */
const DARK_QUALIFIER = (() => {
  const m = /^\(\s*&([\s\S]*)\)$/.exec(DARK_VARIANT);
  if (!m) throw new Error(`unexpected dark variant shape: ${DARK_VARIANT}`);
  return m[1]!.trim();
})();

type AstNode = Parameters<typeof compileAst>[0][number];

const BODY_SELECTOR = '[data-slot="table-body"]';

/** CSSOM `CSS.escape` (jsdom ships none); Tailwind escapes a class name the same way. */
function cssEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (code === 0) out += "\uFFFD";
    else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)
    ) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && value.length === 1 && ch === "-") out += `\\${ch}`;
    else if (code >= 0x80 || /[-_0-9A-Za-z]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

async function compileClass(cls: string): Promise<AstNode[]> {
  const theme: AstNode[] = [...THEME].map(([property, value]) => ({
    kind: "declaration",
    property,
    value,
    important: false,
  })) as AstNode[];
  const compiler = await compileAst([
    { kind: "at-rule", name: "@custom-variant", params: `dark ${DARK_VARIANT}`, nodes: [] },
    { kind: "at-rule", name: "@theme", params: "inline", nodes: theme },
    { kind: "at-rule", name: "@tailwind", params: "utilities", nodes: [] },
  ] as AstNode[]);
  return compiler.build([cls]);
}

/** One background declaration a body utility emits, with the selector that
 *  reaches the row (the dark qualifier taken out) and whether it holds only
 *  inside the dark palette. */
type Paint = { property: string; value: string; selector: string; dark: boolean };

/** Every background declaration the body's own utilities put on `row`. */
async function rowPaints(body: HTMLElement, row: HTMLElement): Promise<Paint[]> {
  const out: Paint[] = [];
  const inDark = row.closest(".dark") !== null;
  function visit(nodes: AstNode[], parent: string, cls: string) {
    for (const node of nodes) {
      if (node.kind === "rule") {
        let selector: string;
        if (parent === "") {
          // A top-level rule that is not the class's own (Tailwind's
          // `@layer properties` fallback, for one) reaches no row.
          const own = `.${cssEscape(cls)}`;
          if (!node.selector.startsWith(own)) continue;
          selector = BODY_SELECTOR + node.selector.slice(own.length);
        } else {
          selector = node.selector.replaceAll("&", parent);
        }
        visit(node.nodes, selector, cls);
      } else if (node.kind === "declaration") {
        if (parent === "" || !node.property.startsWith("background") || node.value === undefined) {
          continue;
        }
        const dark = parent.includes(DARK_QUALIFIER);
        const selector = parent.split(DARK_QUALIFIER).join("");
        if (dark && !inDark) continue;
        if (!row.matches(selector)) continue;
        out.push({ property: node.property, value: node.value, selector, dark });
      } else if ("nodes" in node && Array.isArray(node.nodes)) {
        // `@layer`, `@property` and Tailwind's context wrappers.
        visit(node.nodes as AstNode[], parent, cls);
      }
    }
  }
  for (const cls of body.classList) visit(await compileClass(cls), "", cls);
  return out;
}

/** The table the product paints, mounted from the primitive itself, inside a
 *  `.dark` element for the dark palette. */
function renderBody(palette: Palette): { body: HTMLElement; rows: HTMLElement[] } {
  const table = (
    <Table>
      <TableBody>
        {["Outreach", "Digest", "Follow-up", "Weekly report"].map((name) => (
          <TableRow key={name}>
            <TableCell>{name}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  const { container } = render(
    palette === "dark" ? <div className="dark">{table}</div> : <div className="cinatra">{table}</div>,
  );
  const body = container.querySelector<HTMLElement>(BODY_SELECTOR);
  expect(body, "the table body renders").not.toBeNull();
  const rows = [...body!.querySelectorAll<HTMLElement>('[data-slot="table-row"]')];
  expect(rows).toHaveLength(4);
  return { body: body!, rows };
}

/** The token a compiled colour value names (`var(--surface-muted)`, or
 *  `var(--color-surface-muted)` read through the `@theme inline` registration). */
function tokenOf(value: string): string {
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(value.trim());
  expect(m, `the band is not a token reference: ${value}`).not.toBeNull();
  const name = m![1]!;
  const reg = THEME.get(name);
  if (reg === undefined) return name;
  const inner = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(reg);
  expect(inner, `the registration of ${name} is not a token reference: ${reg}`).not.toBeNull();
  return inner![1]!;
}

/** The band that wins on an even row of `palette`: the dark-qualified paint
 *  when one reaches the row, else the plain one. The dark paint wins only
 *  because its selector is the plain selector plus the dark qualifier, which
 *  adds specificity; the case below proves that shape. */
async function band(palette: Palette): Promise<{ token: string; paints: Paint[] }> {
  const { body, rows } = renderBody(palette);
  const paints = await rowPaints(body, rows[1]!);
  const winners = paints.filter((p) => p.dark === (palette === "dark"));
  expect(winners, `exactly one ${palette} band reaches the even row`).toHaveLength(1);
  expect(winners[0]!.property).toBe("background-color");
  return { token: tokenOf(winners[0]!.value), paints };
}

/** WCAG 2.x body-text floor. */
const BODY_TEXT_FLOOR = 4.5;

// ---------------------------------------------------------------------------
// 1. THE BAND THE PRIMITIVE PAINTS.
// ---------------------------------------------------------------------------
describe("the even body rows carry one flat band", () => {
  it("light palette: the band is --surface-muted, a flat colour and nothing else", async () => {
    const { token, paints } = await band("light");
    expect(token).toBe("--surface-muted");
    expect(paints.map((p) => p.property)).toEqual(["background-color"]);
  });

  it("dark palette: the band is --surface, a flat colour and nothing else", async () => {
    const { token, paints } = await band("dark");
    expect(token).toBe("--surface");
    expect(paints.every((p) => p.property === "background-color")).toBe(true);
  });

  it("dark palette: the dark band outranks the light one on the same row", async () => {
    const { paints } = await band("dark");
    const light = paints.filter((p) => !p.dark);
    const dark = paints.filter((p) => p.dark);
    expect(light).toHaveLength(1);
    expect(dark).toHaveLength(1);
    // Same row selector, plus the dark qualifier: one more class-level part,
    // so the dark band wins the cascade.
    expect(dark[0]!.selector).toBe(light[0]!.selector);
  });

  it("draws no pattern: no row carries a background image in either palette", async () => {
    for (const palette of ["light", "dark"] as const) {
      const { body, rows } = renderBody(palette);
      for (const row of rows) {
        const paints = await rowPaints(body, row);
        expect(paints.filter((p) => p.property !== "background-color")).toEqual([]);
      }
      cleanup();
    }
  });

  it("leaves the odd rows without a ground in either palette", async () => {
    for (const palette of ["light", "dark"] as const) {
      const { body, rows } = renderBody(palette);
      for (const row of [rows[0]!, rows[2]!]) {
        expect(await rowPaints(body, row)).toEqual([]);
      }
      cleanup();
    }
  });

  it("paints no stripe colour on a row", async () => {
    for (const palette of ["light", "dark"] as const) {
      const { body, rows } = renderBody(palette);
      for (const row of rows) {
        for (const paint of await rowPaints(body, row)) {
          expect(paint.value).not.toMatch(/stripe/);
        }
      }
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE BAND'S COLOUR AND ITS INK, IN BOTH TOKEN LAYERS.
// ---------------------------------------------------------------------------
describe("the band's colour in each palette", () => {
  for (const layer of ["host", "portable"] as const) {
    it(`${layer} light: --surface-muted #e8e8e3 on the page #f1f1ed, one step darker`, async () => {
      const { token } = await band("light");
      expect(tokenIn(layer, "light", token)).toBe("#e8e8e3");
      expect(tokenIn(layer, "light", "--background")).toBe("#f1f1ed");
      const b = colour(tokenIn(layer, "light", token));
      const page = colour(tokenIn(layer, "light", "--background"));
      expect(relativeLuminance(b)).toBeLessThan(relativeLuminance(page));
    });

    it(`${layer} dark: --surface oklch(0.165 0.04 259), one step lighter than the page`, async () => {
      const { token } = await band("dark");
      expect(tokenIn(layer, "dark", token)).toBe("oklch(0.165 0.04 259)");
      const b = colour(tokenIn(layer, "dark", token));
      const page = colour(tokenIn(layer, "dark", "--background"));
      const surfaceMuted = colour(tokenIn(layer, "dark", "--surface-muted"));
      expect(relativeLuminance(b)).toBeGreaterThan(relativeLuminance(page));
      // Never a light value: below the palette's next surface step.
      expect(relativeLuminance(b)).toBeLessThan(relativeLuminance(surfaceMuted));
    });

    for (const palette of ["light", "dark"] as const) {
      it(`${layer} ${palette}: body and muted ink keep the body-text floor on the band`, async () => {
        const { token } = await band(palette);
        const b = colour(tokenIn(layer, palette, token));
        const body = colour(tokenIn(layer, palette, "--foreground"));
        const muted = colour(tokenIn(layer, palette, "--muted-foreground"));
        expect(contrastRatio(body, b)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
        expect(contrastRatio(muted, b)).toBeGreaterThanOrEqual(BODY_TEXT_FLOOR);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 3. THE READING ITSELF.
// ---------------------------------------------------------------------------
describe("the reading", () => {
  it("reads the shipped dark variant as a selector qualifier", () => {
    expect(DARK_QUALIFIER).toBe(":is(.dark *)");
  });

  it("would see a pattern: a background image utility on the even rows is read as one", async () => {
    const { container } = render(
      <table>
        <tbody
          data-slot="table-body"
          className="[&_tr:nth-child(even)]:bg-[image:linear-gradient(90deg,#e3e8ee,#b8c4d4)]"
        >
          <tr data-slot="table-row" />
          <tr data-slot="table-row" />
        </tbody>
      </table>,
    );
    const body = container.querySelector<HTMLElement>(BODY_SELECTOR)!;
    const rows = [...body.querySelectorAll<HTMLElement>("tr")];
    expect((await rowPaints(body, rows[1]!)).map((p) => p.property)).toEqual(["background-image"]);
    expect(await rowPaints(body, rows[0]!)).toEqual([]);
  });

  it("reads a dark-qualified band only inside the dark palette", async () => {
    const make = (dark: boolean) => {
      const tbody = (
        <table>
          <tbody data-slot="table-body" className="dark:[&_tr:nth-child(even)]:bg-surface">
            <tr data-slot="table-row" />
            <tr data-slot="table-row" />
          </tbody>
        </table>
      );
      const { container } = render(dark ? <div className="dark">{tbody}</div> : tbody);
      const body = container.querySelector<HTMLElement>(BODY_SELECTOR)!;
      return { body, rows: [...body.querySelectorAll<HTMLElement>("tr")] };
    };
    const light = make(false);
    expect(await rowPaints(light.body, light.rows[1]!)).toEqual([]);
    cleanup();
    const dark = make(true);
    const paints = await rowPaints(dark.body, dark.rows[1]!);
    expect(paints.map((p) => [p.property, p.dark])).toEqual([["background-color", true]]);
    expect(tokenOf(paints[0]!.value)).toBe("--surface");
  });

  it("reports a token a palette block leaves undeclared as the :root fallback", () => {
    const rules = topLevelRules(":root { --surface: #f7f7f3; } .dark { --background: #020618; }");
    const root = blockOf(rules, ":root", "synthetic");
    const dark = blockOf(rules, ".dark", "synthetic");
    expect(dark.has("--surface")).toBe(false);
    expect(resolveIn(root, dark, "--surface")).toBe("#f7f7f3");
  });
});
