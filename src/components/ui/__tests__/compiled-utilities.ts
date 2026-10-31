// Shared compiled-CSS reading for the drawing-conformance suites (cinatra#3189).
//
// The shared compiled-CSS test helper grades a rendered element by the
// compiled rules that match it: it compiles a stylesheet with the installed
// tailwindcss (the shipped `src/app/globals.css`, or the portable sheet the
// sdk-ui copies are drawn with), flattens every emitted rule by `&`
// substitution through nested rules and at-rules, and returns, for an element
// in its current state, every matching declaration with its `!important`, its
// specificity and its source order. It throws on a rule it cannot flatten, on
// a selector `matches()` rejects and on a condition it cannot evaluate,
// instead of skipping it: a rule it cannot read is never a pass.
//
// "Wins" is the matching declaration that is `!important` if any, else of the
// highest specificity, else the last in source order. The cascade also orders
// the layers (and inline styles); when that full cascade would pick another
// declaration than the plain ranking, the helper throws rather than answer.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";

export type Specificity = readonly [number, number, number];

export interface MatchedDeclaration {
  property: string;
  value: string;
  important: boolean;
  specificity: Specificity;
  order: number;
  selector: string;
  /** The layer path, outermost first; empty for an unlayered rule. */
  layer: readonly string[];
  /** The at-rule conditions the rule sits under, outermost first. */
  conditions: readonly string[];
  inline: boolean;
}

interface FlatDeclaration {
  property: string;
  value: string;
  important: boolean;
  order: number;
}

interface FlatRule {
  selectors: string[];
  layer: string[];
  conditions: string[];
  declarations: FlatDeclaration[];
}

interface RegisteredProperty {
  inherits: boolean;
  initialValue: string | undefined;
}

export interface CompiledSheet {
  /** Every matching declaration of `property` on `element`, in source order. */
  matching(element: Element, property: string): MatchedDeclaration[];
  /** The winning declaration of `property` on `element`, or undefined when no rule sets it. */
  winning(element: Element, property: string): MatchedDeclaration | undefined;
  /** `value` with every `var()` replaced by the custom property the cascade gives `element`. */
  resolve(element: Element, value: string): string;
  /** The value the cascade gives the custom property `name` on `element`, inherited or initial. */
  customProperty(element: Element, name: string): string | undefined;
}

/**
 * The @media and @supports preludes the jsdom renders are read under: a
 * current browser with a fine pointer, the light colour scheme, no reduced
 * motion, and jsdom's own 1024 by 768 viewport. A matching rule under any
 * other prelude throws.
 */
const DEFAULT_CONDITIONS: Record<string, boolean> = {
  "(hover: hover)": true,
  "(color: color-mix(in lab, red, red))": true,
  "(width >= 40rem)": true,
  "(max-width: 480px)": false,
  "screen and (max-width: 767px)": false,
  "(prefers-color-scheme: dark)": false,
  "(prefers-reduced-motion: reduce)": false,
  "(prefers-reduced-motion: no-preference)": true,
  print: false,
  "(forced-colors: active)": false,
};

/** At-rules whose bodies hold no style rule for an element. */
const NON_ELEMENT_AT_RULES = new Set(["font-face", "keyframes", "-webkit-keyframes", "page", "counter-style", "font-feature-values"]);
/** Statement at-rules with no body that apply nothing to an element. */
const STATEMENT_AT_RULES = new Set(["import", "charset", "namespace"]);
/**
 * Shorthands that also set a property the suites read. A matching `border`
 * shorthand is read into its width, style and colour; any other matching
 * shorthand, and a per-side border property, is not ranked: it throws.
 */
const SHORTHANDS: Record<string, readonly string[]> = {
  background: ["background-color"],
  border: ["border-width", "border-style", "border-color"],
  font: ["font-family"],
};
const BORDER_SIDE = /^border-(top|right|bottom|left|block|inline)(-start|-end)?(-(width|style|color))?$/;
const BORDER_STYLES = new Set(["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"]);

/** The longhand `property` (border-width, -style or -color) that the `border` shorthand `value` sets. */
function fromBorderShorthand(value: string, property: string): string {
  const parts: string[] = [];
  let rest = value.trim();
  while (rest) {
    let depth = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && /\s/.test(ch)) break;
    }
    parts.push(rest.slice(0, i));
    rest = rest.slice(i).trim();
  }
  let width: string | undefined;
  let style: string | undefined;
  let color: string | undefined;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (part.startsWith("var(")) throw new Error(`compiled-utilities: cannot read the border shorthand "${value}"`);
    if (BORDER_STYLES.has(lower) && style === undefined) style = part;
    else if ((/^[\d.]/.test(part) || ["thin", "medium", "thick"].includes(lower)) && width === undefined) width = part;
    else if (color === undefined) color = part;
    else throw new Error(`compiled-utilities: cannot read the border shorthand "${value}"`);
  }
  if (property === "border-width") return width ?? "medium";
  if (property === "border-style") return style ?? "none";
  return color ?? "currentcolor";
}

// ---------------------------------------------------------------------------
// Compile

const ROOT = process.cwd();

/** The portable sheet the sdk-ui copies are drawn with. */
export const PORTABLE_SHEET = [
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/utilities.css" layer(utilities);',
  '@import "./packages/design/src/tokens.css";',
  '@import "./packages/design/src/theme.css";',
].join("\n");

async function compileSource(source: string, base: string) {
  const require = createRequire(resolve(ROOT, "package.json"));
  return compile(source, {
    base,
    loadStylesheet: async (id, from) => {
      let path: string;
      if (id === "tw-animate-css") {
        // This dependency exports CSS under the standard style condition.
        const root = resolve(ROOT, "node_modules", id);
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        path = resolve(root, manifest.exports["."].style);
      } else {
        path = id.startsWith(".") ? resolve(from, id) : require.resolve(id, { paths: [from] });
      }
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
}

/** Compile the shipped host stylesheet, `src/app/globals.css`. */
export async function compileHostSheet(): Promise<CompiledSheet> {
  const stylesheet = resolve(ROOT, "src/app/globals.css");
  const compiler = await compileSource(await readFile(stylesheet, "utf8"), dirname(stylesheet));
  return sheetFrom((candidates) => compiler.build(candidates));
}

/** Compile the portable sheet: tailwind's theme and utilities with the design package's tokens and theme. */
export async function compilePortableSheet(): Promise<CompiledSheet> {
  const compiler = await compileSource(PORTABLE_SHEET, ROOT);
  return sheetFrom((candidates) => compiler.build(candidates));
}

/** Read an already compiled stylesheet, as the compiled sheets above are read. */
export function readCompiledCss(css: string): CompiledSheet {
  return sheetFrom(() => css);
}

function candidatesOf(element: Element): string[] {
  const doc = element.ownerDocument;
  const out = new Set<string>();
  for (const node of [doc.documentElement, ...Array.from(doc.querySelectorAll("[class]"))]) {
    for (const name of Array.from(node.classList)) out.add(name);
  }
  return [...out];
}

function sheetFrom(build: (candidates: string[]) => string, conditions: Record<string, boolean> = DEFAULT_CONDITIONS): CompiledSheet {
  let lastCss = "";
  let parsed: ParsedSheet | undefined;
  const sheetFor = (element: Element) => {
    const css = build(candidatesOf(element));
    if (css !== lastCss || !parsed) {
      parsed = flatten(parse(css));
      lastCss = css;
    }
    return parsed;
  };

  function matching(element: Element, property: string): MatchedDeclaration[] {
    const sheet = sheetFor(element);
    const found: MatchedDeclaration[] = [];
    for (const rule of sheet.rules) {
      const borderLonghand = property === "border-width" || property === "border-style" || property === "border-color";
      const declarations = rule.declarations.filter(
        (d) => d.property === property || SHORTHANDS[d.property]?.includes(property) || (borderLonghand && BORDER_SIDE.test(d.property)),
      );
      if (declarations.length === 0) continue;
      let best: { selector: string; specificity: Specificity } | undefined;
      for (const selector of rule.selectors) {
        if (!selectorMatches(element, selector)) continue;
        const specificity = specificityOf(selector);
        if (!best || compareSpecificity(specificity, best.specificity) > 0) best = { selector, specificity };
      }
      if (!best) continue;
      for (const condition of rule.conditions) {
        if (!(condition in conditions)) {
          throw new Error(`compiled-utilities: cannot evaluate the condition "${condition}" of the matching rule "${best.selector}"`);
        }
      }
      if (!rule.conditions.every((condition) => conditions[condition])) continue;
      for (const d of declarations) {
        let value = d.value;
        if (d.property !== property) {
          if (d.property !== "border") {
            throw new Error(`compiled-utilities: the matching rule "${best.selector}" sets ${property} through ${d.property}, which this helper does not read`);
          }
          value = fromBorderShorthand(d.value, property);
        }
        found.push({ ...d, property, value, selector: best.selector, specificity: best.specificity, layer: rule.layer, conditions: rule.conditions, inline: false });
      }
    }
    const style = (element as HTMLElement).style;
    if (style) {
      const value = style.getPropertyValue(property);
      if (value) {
        found.push({
          property,
          value,
          important: style.getPropertyPriority(property) === "important",
          specificity: [0, 0, 0],
          order: Number.MAX_SAFE_INTEGER,
          selector: "[style]",
          layer: [],
          conditions: [],
          inline: true,
        });
      }
    }
    return found;
  }

  function winning(element: Element, property: string) {
    const found = matching(element, property);
    if (found.length === 0) return undefined;
    const sheet = sheetFor(element);
    const plain = [...found].sort(plainRank)[found.length - 1];
    const cascade = [...found].sort((a, b) => cascadeRank(a, b, sheet.layerOrder))[found.length - 1];
    if (plain !== cascade) {
      throw new Error(
        `compiled-utilities: the plain ranking picks "${plain.selector}" but the cascade picks "${cascade.selector}" for ${property}`,
      );
    }
    return plain;
  }

  function customProperty(element: Element, name: string): string | undefined {
    const sheet = sheetFor(element);
    const registered = sheet.registered.get(name);
    for (let node: Element | null = element; node; node = node.parentElement) {
      const win = winning(node, name);
      if (win) return win.value.trim();
      if (registered && !registered.inherits) break;
    }
    return registered?.initialValue;
  }

  function resolveValue(element: Element, value: string, depth = 0): string {
    if (depth > 32) throw new Error(`compiled-utilities: var() nesting too deep in "${value}"`);
    let out = "";
    let i = 0;
    while (i < value.length) {
      const at = value.indexOf("var(", i);
      if (at < 0) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, at);
      const end = closingParen(value, at + 3);
      const inner = value.slice(at + 4, end);
      const comma = topLevelIndex(inner, ",");
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim();
      const found = customProperty(element, name);
      if (found !== undefined && found !== "") out += resolveValue(element, found, depth + 1);
      else if (fallback !== undefined) out += resolveValue(element, fallback, depth + 1);
      else throw new Error(`compiled-utilities: ${name} has no value on the element and no fallback`);
      i = end + 1;
    }
    return out;
  }

  return { matching, winning, customProperty, resolve: (element, value) => resolveValue(element, value) };
}

function plainRank(a: MatchedDeclaration, b: MatchedDeclaration) {
  if (a.important !== b.important) return a.important ? 1 : -1;
  if (a.inline !== b.inline) return a.inline ? 1 : -1;
  return compareSpecificity(a.specificity, b.specificity) || a.order - b.order;
}

function cascadeRank(a: MatchedDeclaration, b: MatchedDeclaration, layerOrder: Map<string, number>) {
  if (a.important !== b.important) return a.important ? 1 : -1;
  if (a.inline !== b.inline) return a.inline ? 1 : -1;
  const layers = compareLayers(a.layer, b.layer, layerOrder);
  if (layers !== 0) return a.important ? -layers : layers;
  return compareSpecificity(a.specificity, b.specificity) || a.order - b.order;
}

/** > 0 when layer `a` wins over layer `b` for normal declarations. */
function compareLayers(a: readonly string[], b: readonly string[], order: Map<string, number>) {
  for (let i = 0; ; i++) {
    if (i === a.length && i === b.length) return 0;
    // A layer's own rules come after its sub-layers; unlayered rules come last.
    if (i === a.length) return 1;
    if (i === b.length) return -1;
    if (a[i] !== b[i]) {
      const ka = order.get(a.slice(0, i + 1).join("."));
      const kb = order.get(b.slice(0, i + 1).join("."));
      if (ka === undefined || kb === undefined) throw new Error(`compiled-utilities: unknown layer order for ${a.join(".")} / ${b.join(".")}`);
      return ka - kb;
    }
  }
}

function compareSpecificity(a: Specificity, b: Specificity) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Parse

type Node =
  | { kind: "rule"; selector: string; nodes: Node[] }
  | { kind: "at-rule"; name: string; params: string; nodes: Node[] | null }
  | { kind: "declaration"; property: string; value: string; important: boolean };

function skipString(css: string, i: number) {
  const quote = css[i];
  for (let j = i + 1; j < css.length; j++) {
    if (css[j] === "\\") j++;
    else if (css[j] === quote) return j;
  }
  throw new Error("compiled-utilities: unterminated string in the compiled CSS");
}

function parse(css: string): Node[] {
  let i = 0;
  function block(top: boolean): Node[] {
    const nodes: Node[] = [];
    let start = i;
    let depth = 0;
    while (i < css.length) {
      const ch = css[i];
      if (ch === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        if (end < 0) throw new Error("compiled-utilities: unterminated comment in the compiled CSS");
        css = css.slice(0, i) + " ".repeat(end + 2 - i) + css.slice(end + 2);
        continue;
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipString(css, i) + 1;
        continue;
      }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && (ch === ";" || ch === "}" || ch === "{")) {
        const prelude = css.slice(start, i).trim();
        if (ch === "{") {
          i++;
          const children = block(false);
          if (prelude.startsWith("@")) {
            const m = prelude.match(/^@([\w-]+)\s*([\s\S]*)$/);
            if (!m) throw new Error(`compiled-utilities: cannot read the at-rule "${prelude}"`);
            nodes.push({ kind: "at-rule", name: m[1], params: m[2].trim(), nodes: children });
          } else {
            if (prelude.startsWith("--")) throw new Error(`compiled-utilities: a block where a custom property was expected: "${prelude}"`);
            if (prelude === "") throw new Error("compiled-utilities: a rule without a selector");
            nodes.push({ kind: "rule", selector: prelude, nodes: children });
          }
          start = i;
          continue;
        }
        if (prelude !== "") {
          if (prelude.startsWith("@")) {
            const m = prelude.match(/^@([\w-]+)\s*([\s\S]*)$/);
            if (!m) throw new Error(`compiled-utilities: cannot read the at-rule "${prelude}"`);
            nodes.push({ kind: "at-rule", name: m[1], params: m[2].trim(), nodes: null });
          } else {
            const colon = prelude.indexOf(":");
            if (colon <= 0) throw new Error(`compiled-utilities: cannot read the declaration "${prelude}"`);
            let value = prelude.slice(colon + 1).trim();
            const bang = value.match(/!\s*important\s*$/i);
            if (bang) value = value.slice(0, bang.index).trim();
            nodes.push({ kind: "declaration", property: prelude.slice(0, colon).trim(), value, important: Boolean(bang) });
          }
        }
        i++;
        if (ch === "}") {
          if (top) throw new Error("compiled-utilities: an unbalanced } in the compiled CSS");
          return nodes;
        }
        start = i;
        continue;
      }
      i++;
    }
    if (!top) throw new Error("compiled-utilities: an unclosed block in the compiled CSS");
    if (css.slice(start).trim() !== "") throw new Error(`compiled-utilities: trailing text "${css.slice(start).trim()}"`);
    return nodes;
  }
  return block(true);
}

// ---------------------------------------------------------------------------
// Flatten

interface ParsedSheet {
  rules: FlatRule[];
  layerOrder: Map<string, number>;
  registered: Map<string, RegisteredProperty>;
}

function flatten(nodes: Node[]): ParsedSheet {
  const rules: FlatRule[] = [];
  const layerOrder = new Map<string, number>();
  const registered = new Map<string, RegisteredProperty>();
  let order = 0;
  const noteLayer = (path: string[]) => {
    for (let i = 1; i <= path.length; i++) {
      const key = path.slice(0, i).join(".");
      if (!layerOrder.has(key)) layerOrder.set(key, layerOrder.size);
    }
  };

  function visit(list: Node[], selectors: string[] | null, layer: string[], conditions: string[]) {
    let current: FlatRule | null = null;
    for (const node of list) {
      if (node.kind === "declaration") {
        if (!selectors) throw new Error(`compiled-utilities: the declaration ${node.property} sits outside any rule`);
        if (!current) {
          current = { selectors, layer, conditions, declarations: [] };
          rules.push(current);
        }
        current.declarations.push({ property: node.property, value: node.value, important: node.important, order: order++ });
        continue;
      }
      current = null;
      if (node.kind === "rule") {
        const own = splitList(node.selector);
        const next: string[] = [];
        for (const child of own) {
          if (!selectors) {
            if (hasNesting(child)) throw new Error(`compiled-utilities: a top-level selector holds &: "${child}"`);
            next.push(child);
          } else {
            for (const parent of selectors) next.push(hasNesting(child) ? replaceNesting(child, parent) : `${parent} ${child}`);
          }
        }
        visit(node.nodes, next, layer, conditions);
        continue;
      }
      const name = node.name.toLowerCase();
      if (name === "layer") {
        if (node.nodes === null) {
          for (const entry of splitList(node.params)) noteLayer([...layer, ...entry.split(".")]);
        } else {
          const path = [...layer, ...(node.params ? node.params.split(".") : [`<anonymous ${order}>`])];
          noteLayer(path);
          visit(node.nodes, selectors, path, conditions);
        }
      } else if (name === "media" || name === "supports" || name === "container") {
        if (node.nodes === null) throw new Error(`compiled-utilities: @${name} without a body`);
        visit(node.nodes, selectors, layer, [...conditions, node.params.replace(/\s+/g, " ").trim()]);
      } else if (name === "property") {
        if (node.nodes === null) throw new Error("compiled-utilities: @property without a body");
        const decl = (p: string) => node.nodes?.find((n) => n.kind === "declaration" && n.property === p) as { value: string } | undefined;
        registered.set(node.params.trim(), {
          inherits: decl("inherits")?.value.trim() !== "false",
          initialValue: decl("initial-value")?.value.trim(),
        });
      } else if (NON_ELEMENT_AT_RULES.has(name)) {
        // Font faces, keyframes and pages declare no style of an element.
      } else if (STATEMENT_AT_RULES.has(name) && node.nodes === null) {
        // A statement with no body applies nothing to an element.
      } else {
        throw new Error(`compiled-utilities: cannot flatten the at-rule @${node.name} ${node.params}`);
      }
    }
  }
  visit(nodes, null, [], []);
  return { rules, layerOrder, registered };
}

/** True when the selector holds a nesting `&` (an escaped `\&` in a class name is not one). */
function hasNesting(selector: string) {
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\") i++;
    else if (ch === '"' || ch === "'") i = skipString(selector, i);
    else if (ch === "&") return true;
  }
  return false;
}

function replaceNesting(child: string, parent: string) {
  const list = splitList(parent);
  const substitute = list.length === 1 ? parent : `:is(${parent})`;
  let out = "";
  for (let i = 0; i < child.length; i++) {
    const ch = child[i];
    if (ch === "\\") {
      out += child.slice(i, i + 2);
      i++;
    } else if (ch === '"' || ch === "'") {
      const end = skipString(child, i);
      out += child.slice(i, end + 1);
      i = end;
    } else if (ch === "&") out += substitute;
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selectors

function closingParen(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === '"' || ch === "'") i = skipString(text, i);
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  throw new Error(`compiled-utilities: unbalanced parenthesis in "${text}"`);
}

function topLevelIndex(text: string, needle: string) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === '"' || ch === "'") i = skipString(text, i);
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && ch === needle) return i;
  }
  return -1;
}

function splitList(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const at = topLevelIndex(rest, ",");
    if (at < 0) break;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at + 1);
  }
  parts.push(rest.trim());
  if (parts.some((p) => p === "")) throw new Error(`compiled-utilities: an empty selector in "${text}"`);
  return parts;
}

const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

function readIdent(text: string, i: number) {
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) j++;
    else break;
  }
  return j;
}

/** True when the selector names a pseudo-element: an element itself never matches one. */
function hasPseudoElement(selector: string) {
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\") i++;
    else if (ch === '"' || ch === "'") i = skipString(selector, i);
    else if (ch === "[") i = topLevelIndexFrom(selector, i);
    else if (ch === ":") {
      if (selector[i + 1] === ":") return true;
      const end = readIdent(selector, i + 1);
      if (LEGACY_PSEUDO_ELEMENTS.has(selector.slice(i + 1, end).toLowerCase())) return true;
    }
  }
  return false;
}

function topLevelIndexFrom(text: string, open: number) {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === '"' || ch === "'") i = skipString(text, i);
    else if (ch === "]") return i;
  }
  throw new Error(`compiled-utilities: unbalanced bracket in "${text}"`);
}

function selectorMatches(element: Element, selector: string) {
  if (hasPseudoElement(selector)) return false;
  try {
    return element.matches(selector);
  } catch (error) {
    throw new Error(`compiled-utilities: matches() rejects the selector "${selector}": ${(error as Error).message}`);
  }
}

/** The specificity of one complex selector, as Selectors Level 4 counts it. */
export function specificityOf(selector: string): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  const add = (s: Specificity) => {
    a += s[0];
    b += s[1];
    c += s[2];
  };
  const maxOf = (list: string) =>
    splitList(list)
      .map(specificityOf)
      .reduce<Specificity>((m, s) => (compareSpecificity(s, m) > 0 ? s : m), [0, 0, 0]);
  for (let i = 0; i < selector.length; ) {
    const ch = selector[i];
    if (ch === "&") throw new Error(`compiled-utilities: an unflattened & in "${selector}"`);
    if (ch === "#") {
      a++;
      i = readIdent(selector, i + 1);
    } else if (ch === ".") {
      b++;
      i = readIdent(selector, i + 1);
    } else if (ch === "[") {
      b++;
      i = topLevelIndexFrom(selector, i) + 1;
    } else if (ch === ":") {
      const element = selector[i + 1] === ":";
      const start = i + (element ? 2 : 1);
      const end = readIdent(selector, start);
      const name = selector.slice(start, end).toLowerCase();
      let args: string | undefined;
      i = end;
      if (selector[i] === "(") {
        const close = closingParen(selector, i);
        args = selector.slice(i + 1, close);
        i = close + 1;
      }
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) c++;
      else if (name === "where") {
        // zero
      } else if (name === "is" || name === "not" || name === "has" || name === "matches") {
        if (args === undefined) throw new Error(`compiled-utilities: :${name} without arguments in "${selector}"`);
        add(maxOf(args));
      } else if ((name === "nth-child" || name === "nth-last-child") && args && /\sof\s/i.test(args)) {
        b++;
        add(maxOf(args.slice(args.search(/\sof\s/i) + 4)));
      } else b++;
    } else if (/[\w-]/.test(ch) || ch === "\\" || ch.charCodeAt(0) > 127) {
      c++;
      i = readIdent(selector, i);
      if (selector[i] === "|") i++;
    } else i++;
  }
  return [a, b, c];
}
