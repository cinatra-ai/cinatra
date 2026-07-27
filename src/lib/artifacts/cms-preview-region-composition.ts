/**
 * PURE region composition for the visual before/after pair (cinatra#2044 S6,
 * sub-lane L-D).
 *
 * WHY THIS EXISTS. #2044 asks for "a screenshot pipeline over pinned captures,
 * feeding both review (base vs proposal) and S4 verification (reviewed vs
 * applied read-back render)". At gate creation the proposal is *deliberately not
 * on the site*: the S5 trigger HOLDS the effect, so what the adapter's
 * authenticated preview renders at that moment is the site's CURRENT (base)
 * state. Fetching it twice would therefore yield the same picture twice — a
 * "before/after" that is a lie.
 *
 * The proposal's picture is instead COMPOSED: the base page's own markup, with
 * the proposed field values placed into the regions THE ADAPTER MARKED AS ITS
 * OWN (`data-cinatra-region="<field>"`, wordpress-plugin#94). So the reviewer
 * sees the proposed content inside the site's real theme chrome — the #2044
 * sentence, exactly — without the change ever touching the site.
 *
 * THE RULES THIS LEAF ENFORCES:
 *   1. ANCHORS ONLY. A region is substituted only where the adapter emitted its
 *      own marker, matched as a WHOLE attribute inside a real tag (never as a
 *      substring of a longer attribute name, never inside a comment). Nothing is
 *      matched by tag, class, heuristic or position — #2044 forbids reviewer-side
 *      CSS guessing, and this module has no selector of its own beyond the
 *      adapter's attribute.
 *   2. NAME JOIN, NOT A TYPE MAP. A proposed field is placed into the region of
 *      the SAME name. Core keys on no concrete field identity (no "title" /
 *      "content" literal anywhere here), so an adapter that marks different
 *      regions composes just as well.
 *   3. HONEST GAPS. EVERY proposed field whose value did not reach the picture is
 *      reported (`unplacedFields`), whatever the cause — no adapter region, an
 *      element whose boundary could not be determined, or a region nested inside
 *      another region that was substituted. The caller states the gap on the gate
 *      rather than showing a picture that quietly disagrees with the decided
 *      content.
 *   4. NOTHING EXECUTABLE IS INTRODUCED, AND WHAT WAS REMOVED IS COUNTED. Each
 *      substituted value goes through the SAME inertness sanitizer the fetched
 *      page does, its removals are returned so the capture can report them, and
 *      the caller re-verifies the whole composed document before it is rendered
 *      or stored.
 *
 * PURE (no DOM, no I/O). The host has no server-side DOM parser in its runtime
 * dependency set, so structure is found by a scan that is deliberately
 * conservative: comment and `<style>` bodies are MASKED before scanning (their
 * text is never structural), attribute quoting is respected when finding a tag's
 * end, and an element whose matching close tag cannot be found FAILS the region
 * (reported) rather than guessing a boundary.
 */
import { sanitizeCapturedHtml } from "./cms-preview-inertness";

/** The adapter's region marker attribute (wordpress-plugin#94). The ONE selector
 * this module knows — and it is the adapter's, not the reviewer's. */
const REGION_ATTRIBUTE = "data-cinatra-region";

export interface RegionCompositionResult {
  /** The composed document (base markup + proposed values in owned regions). */
  readonly html: string;
  /** Region names actually substituted, in document order. */
  readonly substitutedRegions: string[];
  /**
   * EVERY proposed field whose value did not reach the composed picture — no
   * marked region, an undelimitable element, or a region nested inside another
   * substituted region. One closed list, so a gap can never go unreported.
   */
  readonly unplacedFields: string[];
  /** True when the page carried NO adapter marker for ANY proposed field name —
   * the "the site marks none of what changed" case, distinct from "it marks them
   * but they could not be placed". */
  readonly noMatchingAnchors: boolean;
  /** What the sanitizer removed from the SUBSTITUTED VALUES (never from the base
   * page — the caller already counts that), so the capture can report it. */
  readonly removedFromValues: Record<string, number>;
}

/** An anchor element located in the document. */
interface AnchorMatch {
  readonly region: string;
  readonly tagName: string;
  /** Index just after the anchor's opening tag. */
  readonly innerStart: number;
  /** Index of the anchor's matching closing tag, or -1 when undelimitable. */
  readonly innerEnd: number;
}

/**
 * A same-length copy of the document in which the CONTENT of comments and
 * `<style>` elements is blanked. Every structural scan below runs on this copy
 * and slices from the ORIGINAL, so text that merely looks like markup (a
 * `</div>` inside a comment) can never be mistaken for structure while all
 * offsets stay valid.
 */
function maskNonStructuralText(html: string): string {
  const blank = (len: number) => " ".repeat(len);
  let out = html;
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => blank(m.length));
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open, body, close) =>
    `${open}${blank(String(body).length)}${close}`,
  );
  return out;
}

/** Index of the `>` that ends the tag starting at `tagStart`, respecting quoted
 * attribute values (a `>` inside `title=">"` is NOT the tag end). -1 if none. */
function findTagEnd(html: string, tagStart: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = tagStart; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

/** Whether the marker occurrence at `at` is a WHOLE attribute name (preceded by
 * a tag/attribute boundary and followed by `=` or whitespace) — never a suffix
 * of a longer attribute such as `x-data-cinatra-region`. */
function isWholeAttribute(html: string, at: number): boolean {
  const before = at === 0 ? "" : html[at - 1]!;
  if (!/[\s/]/.test(before)) return false;
  const after = html[at + REGION_ATTRIBUTE.length];
  return after === "=" || after === undefined || /[\s/>]/.test(after);
}

/** Locate the opening tag that carries `data-cinatra-region="<name>"`, starting
 * at `from`, scanning the MASKED document. */
function findAnchorOpen(
  masked: string,
  raw: string,
  from: number,
): { region: string; tagName: string; tagStart: number; tagEnd: number } | null {
  let searchAt = from;
  for (;;) {
    const attrAt = masked.indexOf(REGION_ATTRIBUTE, searchAt);
    if (attrAt === -1) return null;
    if (!isWholeAttribute(masked, attrAt)) {
      searchAt = attrAt + REGION_ATTRIBUTE.length;
      continue;
    }
    // Walk back to the '<' that opens this tag; refuse if a '>' intervenes (the
    // attribute text was not inside a tag at all).
    let tagStart = -1;
    for (let i = attrAt; i >= 0 && i > attrAt - 8192; i--) {
      const ch = masked[i];
      if (ch === ">") break;
      if (ch === "<") {
        tagStart = i;
        break;
      }
    }
    if (tagStart === -1) {
      searchAt = attrAt + REGION_ATTRIBUTE.length;
      continue;
    }
    const tagEnd = findTagEnd(masked, tagStart);
    if (tagEnd === -1) return null;
    const openTag = raw.slice(tagStart, tagEnd + 1);
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(openTag);
    const valueMatch = new RegExp(`[\\s/]${REGION_ATTRIBUTE}\\s*=\\s*"([^"]*)"`).exec(openTag);
    if (!nameMatch || !valueMatch || !valueMatch[1]) {
      searchAt = tagEnd + 1;
      continue;
    }
    // A self-closing anchor has no inner content to substitute.
    if (masked[tagEnd - 1] === "/") {
      searchAt = tagEnd + 1;
      continue;
    }
    return { region: valueMatch[1], tagName: nameMatch[1]!.toLowerCase(), tagStart, tagEnd };
  }
}

/** Depth-counted scan (on the MASKED document) for the matching close tag of
 * `tagName`. Returns the index of `</tagName`, or -1 when it cannot be
 * determined (a truncated/malformed subtree) — the caller then leaves the region
 * untouched and reports it, never guessing a boundary. */
function findMatchingClose(masked: string, tagName: string, searchFrom: number): number {
  const open = new RegExp(`<${tagName}(?=[\\s/>])`, "gi");
  const close = new RegExp(`</${tagName}\\s*>`, "gi");
  let depth = 1;
  let cursor = searchFrom;
  for (;;) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(masked);
    const nextClose = close.exec(masked);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      const tagClose = findTagEnd(masked, nextOpen.index);
      const selfClosing = tagClose !== -1 && masked[tagClose - 1] === "/";
      if (!selfClosing) depth += 1;
      cursor = tagClose === -1 ? nextOpen.index + nextOpen[0].length : tagClose + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose.index;
    cursor = nextClose.index + nextClose[0].length;
  }
}

/** Every adapter-marked region in the document, in document order. Regions that
 * cannot be delimited are returned with `innerEnd === -1`. */
export function findRegionAnchors(html: string): AnchorMatch[] {
  const masked = maskNonStructuralText(html);
  const anchors: AnchorMatch[] = [];
  let cursor = 0;
  for (;;) {
    const open = findAnchorOpen(masked, html, cursor);
    if (!open) break;
    const innerStart = open.tagEnd + 1;
    anchors.push({
      region: open.region,
      tagName: open.tagName,
      innerStart,
      innerEnd: findMatchingClose(masked, open.tagName, innerStart),
    });
    // Continue INSIDE this anchor: a nested marked region is still discovered,
    // and the anchor just matched can never be re-matched (the scan is already
    // past its opening tag).
    cursor = innerStart;
  }
  return anchors;
}

/**
 * Compose the proposal's document: the base page with each proposed field placed
 * into the adapter-marked region of the SAME name.
 *
 * Substitution is applied back-to-front so earlier offsets stay valid, and each
 * value is passed through the inertness sanitizer before it is placed (the
 * caller re-verifies the whole composed document afterwards).
 */
export function composeProposedRegions(
  baseHtml: string,
  proposedFields: Readonly<Record<string, string>>,
): RegionCompositionResult {
  const anchors = findRegionAnchors(baseHtml);
  const byRegion = new Map<string, AnchorMatch[]>();
  for (const a of anchors) {
    const list = byRegion.get(a.region) ?? [];
    list.push(a);
    byRegion.set(a.region, list);
  }

  const removedFromValues: Record<string, number> = {};
  const noteRemovals = (removed: Readonly<Record<string, number>>) => {
    for (const [kind, n] of Object.entries(removed)) {
      const count = Number(n) || 0;
      if (count > 0) removedFromValues[kind] = (removedFromValues[kind] ?? 0) + count;
    }
  };

  /** Edits collected first, then applied back-to-front. */
  const edits: { field: string; start: number; end: number; value: string }[] = [];
  const fields = Object.keys(proposedFields);
  let anyMatchingAnchor = false;

  for (const field of fields) {
    const matches = byRegion.get(field);
    if (!matches || matches.length === 0) continue;
    anyMatchingAnchor = true;
    for (const anchor of matches) {
      if (anchor.innerEnd === -1) continue; // undelimitable — reported below
      const sanitized = sanitizeCapturedHtml(proposedFields[field]!);
      noteRemovals(sanitized.removed);
      edits.push({ field, start: anchor.innerStart, end: anchor.innerEnd, value: sanitized.html });
    }
  }

  // NESTING GUARD: a marked region may legitimately sit inside another marked
  // region (the adapter decides its own anchors). Two overlapping replacements
  // would corrupt the document, so an edit CONTAINED in another edit is dropped —
  // the outer region wins, because its proposed value is what that whole subtree
  // will show. The dropped field is REPORTED as unplaced (its own value never
  // reached the picture), never silently lost.
  const outermost = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const applied: typeof edits = [];
  for (const edit of outermost) {
    const contained = applied.some((k) => edit.start >= k.start && edit.end <= k.end);
    if (!contained) applied.push(edit);
  }

  const substitutedRegions: string[] = [];
  for (const edit of applied) {
    if (!substitutedRegions.includes(edit.field)) substitutedRegions.push(edit.field);
  }
  const unplacedFields = fields.filter((f) => !substitutedRegions.includes(f));

  const backToFront = [...applied].sort((a, b) => b.start - a.start);
  let html = baseHtml;
  for (const edit of backToFront) {
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  }

  return {
    html,
    substitutedRegions,
    unplacedFields,
    noMatchingAnchors: !anyMatchingAnchor,
    removedFromValues,
  };
}
