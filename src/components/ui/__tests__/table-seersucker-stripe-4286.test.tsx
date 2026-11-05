// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE TABLE'S SEERSUCKER STRIPE, IN BOTH PALETTES (cinatra#4286).
// ---------------------------------------------------------------------------
// THE DRAWING. specs/app-components.html, section "Table" (cinatra-ai/design,
// app-components 0.8.0): "Alternate rows carry the seersucker stripe in both
// palettes. Every second body row is drawn with the fabric stripe of
// Application Design III: over the row's own ground, a one-pixel thread at 6px
// and a second at 13px, repeating every 14px. In the light palette the first
// thread is --stripe-light #E3E8EE and the second --stripe-mid #B8C4D4. In the
// application's dark palette the threads take --surface-strong and
// --surface-muted, the dark palette's two upper surface steps, in the same
// order [...]. The threads are the whole ornament: the even row lays no flat
// band under them, and odd rows carry none." Its example rows paint
//   repeating-linear-gradient(90deg, transparent 0 6px, var(--stripe-light)
//   6px 7px, transparent 7px 13px, var(--stripe-mid) 13px 14px)
// on the even row only.
//
// THE DEFECT. `TableBody` painted one flat band,
// `[&_tr:nth-child(even)]:bg-stripe-light/50`, and the dark palette declared no
// `--stripe-mid`, so neither the pattern nor its second colour reached a row.
//
// HOW THIS FILE READS IT. jsdom generates no Tailwind utilities, so it compiles
// the rendered `TableBody`'s own class list with Tailwind (`compileAst`, as
// avatar-corners-4294.test.tsx and separator-drawing-conformance.test.tsx do)
// and keeps the background declarations whose selector reaches each real row.
// Each class is compiled on its own, and the class part of each emitted
// selector is matched as the body element that carries the class
// (`[data-slot="table-body"]`), which avoids handing jsdom's selector engine
// the escaped arbitrary-value class name. The tokens are read from the
// two token layers (src/app/globals.css, which the app compiles, and
// packages/design/src/tokens.css, the portable mirror), each resolved through
// its own `:root`. It reads the utility layer and the token declarations, not
// browser paint.
//
//   pnpm exec vitest run \
//     src/components/ui/__tests__/table-seersucker-stripe-4286.test.tsx --maxWorkers=2

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { compileAst } from "tailwindcss";

import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The rows the primitive paints.
// ---------------------------------------------------------------------------

function renderBody(): { body: HTMLElement; rows: HTMLElement[] } {
  const { container } = render(
    <Table>
      <TableBody>
        {["Outreach", "Digest", "Follow-up", "Weekly report"].map((name) => (
          <TableRow key={name}>
            <TableCell>{name}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>,
  );
  const body = container.querySelector<HTMLElement>('[data-slot="table-body"]');
  expect(body, "the table body renders").not.toBeNull();
  const rows = [...body!.querySelectorAll<HTMLElement>('[data-slot="table-row"]')];
  expect(rows).toHaveLength(4);
  return { body: body!, rows };
}

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

/** The background declarations that the body's own utilities put on `row`.
 *  The class part of each emitted selector is replaced by the body's own
 *  `[data-slot]` (the element carries that class), whether Tailwind nests the
 *  variant under `&` or writes it after the class. */
async function rowBackgrounds(body: HTMLElement, row: HTMLElement): Promise<Map<string, string>> {
  const compiler = await compileAst([
    { kind: "at-rule", name: "@tailwind", params: "utilities", nodes: [] },
  ]);
  const out = new Map<string, string>();
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
        if (
          parent !== "" &&
          node.property.startsWith("background") &&
          node.value !== undefined &&
          row.matches(parent)
        ) {
          out.set(node.property, node.value);
        }
      } else if ("nodes" in node && Array.isArray(node.nodes)) {
        // `@layer`, `@property` and Tailwind's context wrappers.
        visit(node.nodes as AstNode[], parent, cls);
      }
    }
  }
  for (const cls of body.classList) visit(compiler.build([cls]), "", cls);
  return out;
}

/** Top-level comma split of a CSS function's arguments, whitespace normalised. */
function gradientStops(value: string): { fn: string; args: string[] } {
  const m = /^([a-z-]+)\(([\s\S]*)\)$/.exec(value.trim());
  expect(m, `not a CSS function: ${value}`).not.toBeNull();
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of m![2]!) {
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      args.push(cur);
      cur = "";
    } else cur += c;
  }
  args.push(cur);
  return { fn: m![1]!, args: args.map((a) => a.replace(/\s+/g, " ").trim()) };
}

/** The drawing's stripe, stop for stop. */
const DRAWN_STRIPE = {
  fn: "repeating-linear-gradient",
  args: [
    "90deg",
    "transparent 0 6px",
    "var(--stripe-light) 6px 7px",
    "transparent 7px 13px",
    "var(--stripe-mid) 13px 14px",
  ],
};

// ---------------------------------------------------------------------------
// The token layers, parsed as structure.
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

function palette(layer: Layer, selector: ":root" | ".cinatra" | ".dark") {
  const where = layer === "host" ? "globals.css" : "tokens.css";
  const root = blockOf(LAYERS[layer], ":root", where);
  const block = blockOf(LAYERS[layer], selector, where);
  return {
    declared: (name: string) => block.get(name),
    resolve: (name: string) => resolveIn(root, block, name).toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// 1. THE PATTERN THE PRIMITIVE PAINTS.
// ---------------------------------------------------------------------------
describe("the even body rows carry the drawn seersucker stripe", () => {
  it("paints the stripe as a background image on every even row, stop for stop as drawn", async () => {
    const { body, rows } = renderBody();
    for (const row of [rows[1]!, rows[3]!]) {
      const bg = await rowBackgrounds(body, row);
      const image = bg.get("background-image");
      expect(image, "an even row carries no background image").toBeDefined();
      expect(gradientStops(image!)).toEqual(DRAWN_STRIPE);
    }
  });

  it("lays no flat band under the threads: an even row takes no background colour", async () => {
    const { body, rows } = renderBody();
    const bg = await rowBackgrounds(body, rows[1]!);
    expect([...bg.keys()]).toEqual(["background-image"]);
  });

  it("leaves the odd rows bare", async () => {
    const { body, rows } = renderBody();
    for (const row of [rows[0]!, rows[2]!]) {
      expect([...(await rowBackgrounds(body, row)).keys()]).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE THREAD COLOURS IN EACH PALETTE, IN BOTH TOKEN LAYERS.
// ---------------------------------------------------------------------------
describe("the light palette threads are the drawing's two light colours", () => {
  for (const layer of ["host", "portable"] as const) {
    for (const selector of [":root", ".cinatra"] as const) {
      it(`${layer} ${selector}: --stripe-light #e3e8ee, --stripe-mid #b8c4d4`, () => {
        const p = palette(layer, selector);
        expect(p.resolve("--stripe-light")).toBe("#e3e8ee");
        expect(p.resolve("--stripe-mid")).toBe("#b8c4d4");
      });
    }
  }
});

describe("the dark palette threads are its two upper surface steps, in the drawn order", () => {
  for (const layer of ["host", "portable"] as const) {
    it(`${layer} .dark declares both thread tokens itself`, () => {
      const p = palette(layer, ".dark");
      expect(p.declared("--stripe-light")).toBe("var(--surface-strong)");
      expect(p.declared("--stripe-mid")).toBe("var(--surface-muted)");
    });

    it(`${layer} .dark resolves them to the drawn values`, () => {
      const p = palette(layer, ".dark");
      expect(p.resolve("--stripe-light")).toBe("oklch(0.21 0.04 259)");
      expect(p.resolve("--stripe-mid")).toBe("oklch(0.279 0.041 260.031)");
    });

    it(`${layer} .dark never carries a light literal into a thread`, () => {
      const p = palette(layer, ".dark");
      for (const name of ["--stripe-light", "--stripe-mid"]) {
        expect(["#e3e8ee", "#b8c4d4"]).not.toContain(p.resolve(name));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. THE READING ITSELF.
// ---------------------------------------------------------------------------
describe("the reading", () => {
  it("splits a gradient at its top-level commas only", () => {
    expect(
      gradientStops("repeating-linear-gradient(90deg,transparent 0 6px,var(--a) 6px 7px)"),
    ).toEqual({
      fn: "repeating-linear-gradient",
      args: ["90deg", "transparent 0 6px", "var(--a) 6px 7px"],
    });
  });

  it("would see a flat band: a background colour utility on the even rows is read as one", async () => {
    const { container } = render(
      <table>
        <tbody data-slot="table-body" className="[&_tr:nth-child(even)]:bg-[#e3e8ee]">
          <tr data-slot="table-row" />
          <tr data-slot="table-row" />
        </tbody>
      </table>,
    );
    const body = container.querySelector<HTMLElement>('[data-slot="table-body"]')!;
    const rows = [...body.querySelectorAll<HTMLElement>("tr")];
    expect([...(await rowBackgrounds(body, rows[1]!)).keys()]).toEqual(["background-color"]);
    expect([...(await rowBackgrounds(body, rows[0]!)).keys()]).toEqual([]);
  });

  it("reports a token a palette block leaves undeclared as the :root fallback", () => {
    const rules = topLevelRules(":root { --stripe-mid: #b8c4d4; } .dark { --background: #020618; }");
    const root = blockOf(rules, ":root", "synthetic");
    const dark = blockOf(rules, ".dark", "synthetic");
    expect(dark.has("--stripe-mid")).toBe(false);
    expect(resolveIn(root, dark, "--stripe-mid")).toBe("#b8c4d4");
  });
});
