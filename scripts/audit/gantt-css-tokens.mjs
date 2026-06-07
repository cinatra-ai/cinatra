#!/usr/bin/env node
// Gantt CSS raw-color token guard.
//
// Lints `src/components/workflows/gantt-overrides.css` for raw colors outside
// the semantic-token allowlist. The override file is the SINGLE HOME for
// SVAR-scope CSS overrides; this gate keys off that invariant and only scans
// that one file. Comments are stripped before scanning so doctrine prose may
// freely name raw colors without tripping the gate.
//
// Wired in CI by .github/workflows/gantt-css-tokens-gate.yml.
//
// Exit codes:
//   0 — pass (zero raw-color hits outside the allowlist)
//   1 — gate failure (≥1 raw-color hit reported with file:line:col)
//   2 — unexpected internal error (target file missing, etc.)

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Contract

export const TARGET_REL = "src/components/workflows/gantt-overrides.css";

// Tokens allowed as a color value. The gate only cares about COLOR VALUES;
// structural literals (px, rem, %, fr, calc(...), etc.) are not color tokens
// and never trigger.
export const ALLOWED_COLOR_TOKENS = new Set([
  "currentColor",
  "transparent",
  "inherit",
  "initial",
  "unset",
  "none",
]);

// Full CSS named-color set (CSS Color Module Level 4) + system colors.
// `color-mix(in oklab, ...)` and `color-mix(in oklch, ...)` are allowed —
// the `oklab` / `oklch` identifiers there are color-space keywords, not raw
// color functions, so the named-color list intentionally OMITS them as
// stand-alone names. (The stand-alone color-function forms `oklab(...)` and
// `oklch(...)` are flagged via the function-call patterns below.)
export const CSS_NAMED_COLORS = new Set([
  // Level 4 named colors (148).
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
  "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
  "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
  "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
  "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
  "darksalmon", "darkseagreen", "darkslateblue", "darkslategray",
  "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite",
  "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred",
  "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen",
  "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink",
  "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle",
  "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow",
  "yellowgreen",
  // CSS system colors (Level 4 + deprecated still-recognized).
  "canvas", "canvastext", "linktext", "visitedtext", "activetext",
  "buttonface", "buttontext", "buttonborder", "field", "fieldtext",
  "highlight", "highlighttext", "selecteditem", "selecteditemtext",
  "mark", "marktext", "graytext", "accentcolor", "accentcolortext",
  // Deprecated system colors still parsed by browsers.
  "activeborder", "activecaption", "appworkspace", "background",
  "buttonhighlight", "buttonshadow", "captiontext", "inactiveborder",
  "inactivecaption", "inactivecaptiontext", "infobackground", "infotext",
  "menu", "menutext", "scrollbar", "threeddarkshadow", "threedface",
  "threedhighlight", "threedlightshadow", "threedshadow", "window",
  "windowframe", "windowtext",
]);

// Build the named-color regex once from the set.
const NAMED_COLOR_REGEX = new RegExp(
  `(?<![\\w-])(?:${[...CSS_NAMED_COLORS].join("|")})(?![\\w-])`,
  "gi",
);

// Color forms the gate detects.
const RAW_COLOR_PATTERNS = [
  // Hex: #RRGGBB(AA), #RGB(A). 3/4/6/8 hex digits, word-boundary on both ends.
  { kind: "hex", regex: /#[0-9a-fA-F]{3,8}\b/g },
  // Functional notations — match the opening token. The closing paren is left
  // implicit; reporting the function start is enough for human triage.
  // `color-mix(` is NOT listed here — it's allowed when constituents are
  // allowlisted (constituents are scanned recursively as the regex sweeps the
  // body); `color(` IS listed because the Level-4 `color()` function takes
  // raw RGB / display-p3 / rec2020 etc. coordinates, not tokens.
  { kind: "rgb", regex: /\brgba?\s*\(/g },
  { kind: "hsl", regex: /\bhsla?\s*\(/g },
  { kind: "hwb", regex: /\bhwb\s*\(/g },
  { kind: "lab", regex: /\blab\s*\(/g },
  { kind: "lch", regex: /\blch\s*\(/g },
  { kind: "oklab-raw", regex: /\boklab\s*\(/g },
  { kind: "oklch-raw", regex: /\boklch\s*\(/g },
  { kind: "color-fn", regex: /(?<![\w-])color\s*\(/g },
  { kind: "device-cmyk", regex: /\bdevice-cmyk\s*\(/g },
  { kind: "light-dark", regex: /\blight-dark\s*\(/g },
  // All CSS named colors + system colors. Adjacency lookaround forbids
  // hyphen/word characters on either side so CSS identifiers
  // (`--my-red-token`, `redColor`, `whitespace`) don't trip.
  { kind: "named", regex: NAMED_COLOR_REGEX },
];

// ---------------------------------------------------------------------------
// Comment-aware scanner

// Strip `/* … */` blocks from CSS while preserving line numbers (replace
// stripped bytes with spaces so column offsets and line breaks survive).
export function stripCssComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] === "/" && source[i + 1] === "*") {
      // Consume the comment, emitting whitespace so positions line up.
      const start = i;
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = start; j < stop; j++) {
        out += source[j] === "\n" ? "\n" : " ";
      }
      i = stop;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

// Line+column from a flat offset into `text`.
function offsetToLineCol(text, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

// Extract `{ ... }` block bodies from a CSS source string. Returns an array of
// { body, offset } where `body` is the contents between matching braces and
// `offset` is its starting index in the original source (so we can recompute
// line/col on a hit). Handles nested braces (rare in plain CSS but possible
// inside `@supports` / `@media` blocks).
export function extractRuleBlocks(source) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  let blockStart = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) {
        start = i + 1;
        blockStart = i + 1;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        blocks.push({ body: source.slice(blockStart, i), offset: blockStart });
        start = -1;
        blockStart = -1;
      }
    }
  }
  return blocks;
}

// Extract declaration VALUE spans from a single block body. A value span is
// everything between the first `:` after a property name and the next `;` or
// the block end. Returns an array of { value, offset } pairs.
export function extractValueSpans(blockBody, blockOffset) {
  const spans = [];
  // Split on `;` for declarations, then take everything after the first `:`.
  let i = 0;
  while (i < blockBody.length) {
    const semi = blockBody.indexOf(";", i);
    const end = semi === -1 ? blockBody.length : semi;
    const segment = blockBody.slice(i, end);
    const colon = segment.indexOf(":");
    if (colon !== -1) {
      const valueStart = i + colon + 1;
      spans.push({
        value: blockBody.slice(valueStart, end),
        offset: blockOffset + valueStart,
      });
    }
    i = end + 1;
  }
  return spans;
}

// Scan a comment-stripped CSS body for raw-color hits. Only value spans inside
// `{ ... }` rule blocks are scanned — property names and selectors are NEVER
// matched. (This is what makes `background:` safe even though `background` is
// also a deprecated CSS system-color name.)
export function scanCssBody(body) {
  const hits = [];
  const blocks = extractRuleBlocks(body);
  for (const block of blocks) {
    const spans = extractValueSpans(block.body, block.offset);
    for (const span of spans) {
      for (const { kind, regex } of RAW_COLOR_PATTERNS) {
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(span.value)) !== null) {
          const match = m[0];
          if (ALLOWED_COLOR_TOKENS.has(match)) continue;
          // Locate the hit in the original `body` coordinate space.
          const absOffset = span.offset + m.index;
          const { line, col } = offsetToLineCol(body, absOffset);
          hits.push({ kind, match, line, col });
        }
      }
    }
  }
  // Stable ordering: by line, then column, then kind.
  hits.sort((a, b) => a.line - b.line || a.col - b.col || a.kind.localeCompare(b.kind));
  return hits;
}

// Public — read file, strip comments, scan, return hits.
export async function scanCssFile(absPath) {
  const source = await readFile(absPath, "utf8");
  const body = stripCssComments(source);
  return scanCssBody(body);
}

// ---------------------------------------------------------------------------
// CLI entry

function repoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

async function main() {
  let root;
  try {
    root = repoRoot();
  } catch (err) {
    console.error("[gantt-css-tokens] FAIL — not in a git repo");
    process.exit(2);
  }
  const targetAbs = resolve(root, TARGET_REL);

  let hits;
  try {
    hits = await scanCssFile(targetAbs);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `[gantt-css-tokens] FAIL — target file missing: ${TARGET_REL}\n` +
          "  This gate keys off the single-home invariant; the override file must exist.",
      );
      process.exit(2);
    }
    console.error("[gantt-css-tokens] FAIL — internal error:", err?.message ?? err);
    process.exit(2);
  }

  if (hits.length === 0) {
    console.log(`[gantt-css-tokens] PASS — 0 raw-color hits in ${TARGET_REL}`);
    process.exit(0);
  }

  console.error(`[gantt-css-tokens] FAIL — ${hits.length} raw-color hit(s) in ${TARGET_REL}:`);
  for (const h of hits) {
    console.error(`  ${TARGET_REL}:${h.line}:${h.col}  (${h.kind})  ${h.match}`);
  }
  console.error(
    "\nUse semantic tokens (`var(--color-foreground)`, `var(--color-line)`, etc.) or the\n" +
      "allowed structural literals (`currentColor`, `transparent`, `inherit`, `initial`,\n" +
      "`unset`, `none`). `color-mix(...)` is fine when every constituent is allowlisted.",
  );
  process.exit(1);
}

// Only run as CLI if invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[gantt-css-tokens] FAIL — uncaught:", err?.message ?? err);
    process.exit(2);
  });
}
