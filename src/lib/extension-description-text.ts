/**
 * The plain-text MEANING of an installed extension's description
 * (cinatra#3570).
 *
 * WHY THIS EXISTS. The ratified drawing (specs/app-extensions.html §III, the
 * installed card) gives the card's middle panel as "a white middle carrying the
 * description, then the version with its status beside it": the description is
 * PROSE. Nothing in §III, in its six status sub-sections or in its spec-line
 * section gives a card description a rich-text treatment; the one panel drawn
 * rich is §II's detail modal, which carries its own README stylesheet for the
 * listing detail embedded there.
 *
 * The string the card receives, however, is authored in MARKDOWN for every
 * kind: an agent's and a skill's descriptor description are written in it, and
 * an artifact row carries no native description at all, so it falls back to the
 * registry summary — which the storefront produces by flattening the package's
 * own README into a single line. Drawn raw, the author's control characters
 * reach the reader ("an **external pointer**", "`application/json`"). This
 * projection is the card's one treatment for every kind and every mount.
 *
 * THE PRECEDENT. `normalizeCardDescription` in
 * packages/extensions/src/screens/marketplace-card-model.ts already ruled this
 * road once, for the neighbouring MARKETPLACE card: a card description is plain
 * text, its source is a flattened README, and the full-markdown reading renders
 * elsewhere. It strips ONLY a leading ATX heading marker, and its one
 * production call site is the marketplace card model — the installed row never
 * passes through it, so the installed list gets that rule here for the first
 * time. This module keeps the marker rule with exactly the same semantics (one
 * to six hashes followed by at least one space or tab, anchored and bounded, so
 * `#1 ranked` and `#hashtag` survive) and adds the inline resolutions the
 * precedent does not carry. The two functions stay separate and neither calls
 * the other: they serve differently drawn surfaces, and this one alone ever
 * sees a skill's or an agent's native descriptor description.
 *
 * HOW IT WORKS. One tokenizing pass turns the string into literal text plus
 * emphasis DELIMITER RUNS (a run of asterisks or underscores, with CommonMark's
 * left/right-flanking flags), consuming backslash escapes, code spans and
 * inline links as it meets them; then CommonMark's delimiter pairing walks the
 * runs, so a nested mark pairs with its own partner instead of stealing its
 * neighbour's. Pairing per RUN rather than per character is also what keeps the
 * cost linear in the number of runs: an earlier single-scan draft re-scanned
 * the tail once per delimiter character and cost ~223 ms on a 16,000-mark
 * string, which this shape answers in under a millisecond.
 *
 * WHAT IT IS NOT. It resolves nothing block-level (a heading body, a list mark,
 * a fence): a card description is one clamped prose line, and a block-level
 * rewrite would be a second rule the drawing does not give. It leaves an
 * autolink and a reference link (`[text][ref]`) as the literal text they are —
 * neither is one of the resolutions this projection is scoped to, and a
 * reference link has no definition to resolve against on a one-line
 * description. It never returns markup — only text. It is the IDENTITY on a
 * string carrying none of the marks below, which is the property every existing
 * description reading in the repository rests on, and it is a pure function of
 * its argument: it adds no byte to any payload and no dependency to the
 * repository. Unlike the precedent it does NOT trim or collapse an emptied
 * string to null — that is the precedent's own `string | null` contract
 * concern; the card's guard still reads the RAW prop, so an empty description
 * renders no paragraph, and leaving the text otherwise untouched is what keeps
 * the identity exact.
 */

/**
 * A leading markdown ATX heading marker ("# ", "## ", … up to 6, with at least
 * one trailing space/tab). Anchored + bounded, so it is linear (no
 * backtracking). The same pattern the marketplace card model pins.
 */
const LEADING_ATX_HEADING_RE = /^\s*#{1,6}[ \t]+/;

/** The ASCII punctuation a backslash may escape (CommonMark). */
const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/** Unicode punctuation/symbol, for CommonMark's flanking rules. */
const PUNCTUATION_RE = /[\p{P}\p{S}]/u;

/** An emphasis delimiter run, as the pairing walk sees it. */
interface DelimiterRun {
  readonly kind: "delimiter";
  readonly ch: "*" | "_";
  /** The run's original length, which the "rule of three" reads. */
  readonly length: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  /** Characters not yet consumed by a pair; whatever is left renders literally. */
  remaining: number;
  /** A run fenced inside a resolved pair can no longer pair with anything. */
  spent: boolean;
}

interface LiteralText {
  readonly kind: "text";
  readonly value: string;
}

type Token = LiteralText | DelimiterRun;

/** How many times `ch` repeats starting at `at`. */
function runLength(src: string, at: number, ch: string): number {
  let n = 0;
  while (at + n < src.length && src[at + n] === ch) n += 1;
  return n;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && PUNCTUATION_RE.test(ch);
}

/**
 * The index of the backtick run that closes the code span opening at `at`, or
 * -1 when it is unpaired. CommonMark matches a run of N backticks with a run of
 * exactly N, so a span containing a backtick survives.
 */
function codeSpanClose(src: string, at: number, open: number): number {
  let j = at + open;
  while (j < src.length) {
    if (src[j] !== "`") {
      j += 1;
      continue;
    }
    const run = runLength(src, j, "`");
    if (run === open) return j;
    j += run;
  }
  return -1;
}

/**
 * CommonMark: a code span's content keeps its own backticks; one space is
 * stripped from each end when BOTH ends carry one and the content is not all
 * spaces, so "`` ` ``" reads as a single backtick.
 */
function codeSpanContent(inner: string): string {
  if (inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
    return inner.slice(1, -1);
  }
  return inner;
}

/**
 * The index of the bracket closing the label that opens at `at`, honouring
 * nesting and backslash escapes, or -1. A nested label ("[a [b] c]") therefore
 * resolves as one label rather than breaking at the inner bracket.
 */
function labelClose(src: string, at: number): number {
  // A string with no closing bracket left cannot open a label: the guard keeps
  // a bracket-heavy description from re-scanning its own tail per bracket.
  if (src.indexOf("]", at) === -1) return -1;
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The index of the parenthesis closing an inline link's destination, which
 * opens at `at`, honouring BALANCED parentheses and escapes, or -1. A
 * destination that carries its own parentheses — "(https://host/a(b)c)" — is
 * therefore consumed whole instead of ending at the first ")".
 */
function destinationClose(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split the string into literal text and emphasis delimiter runs. Escapes, code
 * spans and inline links are resolved here, so a mark that was quoted, escaped
 * or part of a link destination never reaches the pairing walk.
 */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const pushText = (value: string) => {
    if (value === "") return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === "text") {
      tokens[tokens.length - 1] = { kind: "text", value: last.value + value };
      return;
    }
    tokens.push({ kind: "text", value });
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // A backslash escape resolves to the character it escapes.
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      pushText(src[i + 1]);
      i += 2;
      continue;
    }

    // An inline code span resolves to its content.
    if (ch === "`") {
      const open = runLength(src, i, "`");
      const close = codeSpanClose(src, i, open);
      if (close === -1) {
        pushText(src.slice(i, i + open)); // unpaired: the backticks are literal
        i += open;
      } else {
        pushText(codeSpanContent(src.slice(i + open, close)));
        i = close + open;
      }
      continue;
    }

    // An inline link resolves to its link text, an inline image to its alt
    // text (the "!" goes with the image it introduces). Anything that does not
    // parse as one — a reference link, a bare bracket — stays literal.
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const labelStart = ch === "!" ? i + 1 : i;
      const labelEnd = labelClose(src, labelStart);
      if (labelEnd !== -1 && src[labelEnd + 1] === "(") {
        const destEnd = destinationClose(src, labelEnd + 1);
        if (destEnd !== -1) {
          pushText(projectInline(src.slice(labelStart + 1, labelEnd)));
          i = destEnd + 1;
          continue;
        }
      }
      pushText(ch);
      i += 1;
      continue;
    }

    // An emphasis delimiter run, with CommonMark's flanking flags. A run may
    // OPEN only when it is left-flanking and CLOSE only when it is
    // right-flanking, so arithmetic prose like "5 * 3 * 2" keeps its asterisks;
    // an underscore additionally may not open or close inside a word, so
    // `snake_case_name` survives.
    if (ch === "*" || ch === "_") {
      const length = runLength(src, i, ch);
      const before = i > 0 ? src[i - 1] : undefined;
      const after = i + length < src.length ? src[i + length] : undefined;
      const leftFlanking =
        !isWhitespace(after) &&
        (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
      const rightFlanking =
        !isWhitespace(before) &&
        (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
      const canOpen =
        ch === "*" ? leftFlanking : leftFlanking && (!rightFlanking || isPunctuation(before));
      const canClose =
        ch === "*" ? rightFlanking : rightFlanking && (!leftFlanking || isPunctuation(after));
      tokens.push({
        kind: "delimiter",
        ch,
        length,
        canOpen,
        canClose,
        remaining: length,
        spent: false,
      });
      i += length;
      continue;
    }

    pushText(ch);
    i += 1;
  }

  return tokens;
}

/**
 * CommonMark's delimiter pairing, reduced to what plain text needs: each closer
 * takes the NEAREST eligible opener before it, the pair's delimiter characters
 * are consumed, and runs fenced between a resolved pair can pair no further.
 * Whatever is never consumed stays literal text.
 */
function pairDelimiters(tokens: Token[]): void {
  for (let closerIdx = 0; closerIdx < tokens.length; closerIdx += 1) {
    const closer = tokens[closerIdx];
    if (closer.kind !== "delimiter" || !closer.canClose) continue;

    while (closer.remaining > 0 && !closer.spent) {
      let openerIdx = -1;
      for (let j = closerIdx - 1; j >= 0; j -= 1) {
        const candidate = tokens[j];
        if (candidate.kind !== "delimiter") continue;
        if (candidate.ch !== closer.ch || !candidate.canOpen) continue;
        if (candidate.remaining === 0 || candidate.spent) continue;
        // CommonMark's "rule of three": a run that can both open and close
        // pairs with a partner only when their lengths do not sum to a
        // multiple of three (unless both are multiples of three).
        const oddMatch =
          (closer.canOpen || candidate.canClose) &&
          (closer.length + candidate.length) % 3 === 0 &&
          !(closer.length % 3 === 0 && candidate.length % 3 === 0);
        if (oddMatch) continue;
        openerIdx = j;
        break;
      }
      if (openerIdx === -1) break;

      const opener = tokens[openerIdx] as DelimiterRun;
      const used = opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1;
      opener.remaining -= used;
      closer.remaining -= used;
      for (let between = openerIdx + 1; between < closerIdx; between += 1) {
        const fenced = tokens[between];
        if (fenced.kind === "delimiter") fenced.spent = true;
      }
    }
  }
}

/**
 * Tokenize, pair and render one inline span. A link label runs through this
 * rather than through the exported entry point, so the leading-heading rule
 * applies once, to the description itself.
 */
function projectInline(src: string): string {
  const tokens = tokenize(src);
  pairDelimiters(tokens);
  return tokens
    .map((token) => (token.kind === "text" ? token.value : token.ch.repeat(token.remaining)))
    .join("");
}

/**
 * Project a card description onto its plain-text meaning: inline emphasis and
 * strong emphasis resolved to their inner text, inline code spans to their
 * content, an inline link to its link text, a backslash escape to the character
 * it escapes, and ONE leading ATX heading marker stripped. The identity on a
 * string carrying none of those.
 */
export function extensionDescriptionText(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return projectInline(raw.replace(LEADING_ATX_HEADING_RE, ""));
}
