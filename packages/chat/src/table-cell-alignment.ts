// Deterministic cell grammar for the chat markdown table renderer
// (cinatra#3230). The ratified drawing's Table component: "never centre body
// cells; right-align numerics and timestamps." A column's body cells are
// right-aligned when (a) the markdown delimiter row declares the column
// right-aligned, else (b) EVERY non-empty body cell in the column parses under
// this grammar — a number, or a date/time the named parser below accepts.
// Both helpers are plain regular expressions over the trimmed cell text: no
// locale, no `Date.parse`, no environment-dependent result.

import type { Token } from "marked";

/**
 * The text a cell DISPLAYS: the inline tokens flattened to their plain text,
 * so `**12**`, `` `12` `` or `[Sep 3, 2026](…)` classify by what the reader
 * sees rather than by their markdown markup. HTML and images contribute
 * nothing; a hard break reads as a space.
 */
export function cellPlainText(tokens: readonly Token[]): string {
  let out = "";
  for (const token of tokens) {
    const nested = (token as { tokens?: Token[] }).tokens;
    if (nested && nested.length > 0) {
      out += cellPlainText(nested);
      continue;
    }
    switch (token.type) {
      case "text":
      case "codespan":
      case "escape":
        out += token.text;
        break;
      case "br":
        out += " ";
        break;
      default:
        break;
    }
  }
  return out;
}

// A number: optional sign (ASCII or U+2212 minus), optional leading currency
// symbol, digits with optional thousands separators and an optional decimal
// part, optional trailing percent.
const NUMERIC_RE =
  /^[+\-\u2212]?[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const TIME =
  "(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?(?:\\s?[AaPp][Mm])?(?:\\s?(?:Z|UTC|[+\\-]\\d{2}:?\\d{2}))?";
const ISO_DATE = "\\d{4}-\\d{2}-\\d{2}";
const SLASH_DATE = "\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}";

// A date/time, in one of the shapes an assistant turn writes:
//   2026-09-03 · 2026-09-03T14:05:00Z · 2026-09-03 14:05
//   Sep 3, 2026 · September 3, 2026 · Sep 3, 2026 14:05
//   3 Sep 2026 · 03.09.2026 · 9/3/2026
//   14:05 · 14:05:30 · 2:05 PM
const TIMESTAMP_RES: readonly RegExp[] = [
  new RegExp(`^${ISO_DATE}(?:[T ]${TIME})?$`),
  new RegExp(`^${MONTH} \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}(?:,? ${TIME})?$`, "i"),
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)? ${MONTH},? \\d{4}(?:,? ${TIME})?$`, "i"),
  new RegExp(`^${SLASH_DATE}(?: ${TIME})?$`),
  new RegExp(`^${TIME}$`),
];

/** Does the cell text read as a number under the deterministic grammar? */
export function isNumericCellText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && NUMERIC_RE.test(t);
}

/** Does the cell text read as a date and/or time under the named shapes above? */
export function isTimestampCellText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && TIMESTAMP_RES.some((re) => re.test(t));
}

/**
 * Whether a column's body cells are right-aligned: the delimiter row's own
 * declaration first; otherwise every non-empty cell must be a number or a
 * timestamp. A column with no non-empty cell stays left. A centred delimiter
 * is never honoured — the drawing forbids centring body cells.
 */
export function resolveColumnRightAligned(
  declared: "left" | "center" | "right" | null | undefined,
  cellTexts: readonly string[],
): boolean {
  if (declared === "right") return true;
  const nonEmpty = cellTexts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((t) => isNumericCellText(t) || isTimestampCellText(t));
}
