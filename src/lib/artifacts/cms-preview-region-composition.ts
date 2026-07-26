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
 *      own marker. Nothing is matched by tag, class, heuristic or position —
 *      #2044 forbids reviewer-side CSS guessing, and this module has no selector
 *      of its own beyond the adapter's attribute.
 *   2. NAME JOIN, NOT A TYPE MAP. A proposed field is placed into the region of
 *      the SAME name. Core keys on no concrete field identity (no "title" /
 *      "content" literal anywhere here), so an adapter that marks different
 *      regions composes just as well.
 *   3. HONEST GAPS. A proposed field with no adapter region, and a region whose
 *      element cannot be delimited, are REPORTED (`unmatchedFields`,
 *      `undelimitedRegions`) rather than silently dropped — the caller states the
 *      gap on the gate.
 *   4. NOTHING EXECUTABLE IS INTRODUCED. The substituted value is sanitized with
 *      the SAME inertness sanitizer the fetched page goes through, and the caller
 *      re-verifies the composed document before it is rendered or stored.
 *
 * PURE (no DOM, no I/O). The host has no server-side DOM parser in its runtime
 * dependency set, so the element is delimited by a depth-counted scan over its
 * own tag name — and a scan that cannot find the matching close FAILS the region
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
  /** Proposed field names for which the adapter marked no region. */
  readonly unmatchedFields: string[];
  /** Region names whose element boundary could not be determined (never guessed). */
  readonly undelimitedRegions: string[];
}

/** An anchor element located in the document. */
interface AnchorMatch {
  readonly region: string;
  readonly tagName: string;
  /** Index just after the anchor's opening tag. */
  readonly innerStart: number;
  /** Index of the anchor's matching closing tag. */
  readonly innerEnd: number;
}

/** Locate the opening tag that carries `data-cinatra-region="<name>"`, starting
 * at `from`. Returns the tag name, the region name, and the offsets of the tag. */
function findAnchorOpen(
  html: string,
  from: number,
): { region: string; tagName: string; tagStart: number; tagEnd: number } | null {
  let searchAt = from;
  for (;;) {
    const attrAt = html.indexOf(REGION_ATTRIBUTE, searchAt);
    if (attrAt === -1) return null;
    // Walk back to the '<' that opens this tag; refuse if a '>' intervenes (the
    // attribute text was not inside a tag at all).
    let tagStart = -1;
    for (let i = attrAt; i >= 0 && i > attrAt - 4096; i--) {
      const ch = html[i];
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
    const tagEnd = html.indexOf(">", attrAt);
    if (tagEnd === -1) return null;
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(tagStart, tagEnd + 1));
    const valueMatch = new RegExp(`${REGION_ATTRIBUTE}\\s*=\\s*"([^"]*)"`).exec(
      html.slice(tagStart, tagEnd + 1),
    );
    if (!nameMatch || !valueMatch || valueMatch[1] === undefined || valueMatch[1] === "") {
      searchAt = tagEnd + 1;
      continue;
    }
    // A self-closing anchor has no inner content to substitute.
    if (html[tagEnd - 1] === "/") {
      searchAt = tagEnd + 1;
      continue;
    }
    return {
      region: valueMatch[1],
      tagName: nameMatch[1]!.toLowerCase(),
      tagStart,
      tagEnd,
    };
  }
}

/** Depth-counted scan for the matching close tag of `tagName` starting after an
 * opening tag. Returns the index of `</tagName`, or -1 when it cannot be
 * determined (a truncated/malformed subtree) — the caller then leaves the region
 * untouched and reports it, never guessing a boundary. */
function findMatchingClose(html: string, tagName: string, searchFrom: number): number {
  const open = new RegExp(`<${tagName}(?=[\\s/>])`, "gi");
  const close = new RegExp(`</${tagName}\\s*>`, "gi");
  let depth = 1;
  let cursor = searchFrom;
  for (;;) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      // A self-closed same-name tag (<div/>) does not add depth.
      const tagClose = html.indexOf(">", nextOpen.index);
      const selfClosing = tagClose !== -1 && html[tagClose - 1] === "/";
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
  const anchors: AnchorMatch[] = [];
  let cursor = 0;
  for (;;) {
    const open = findAnchorOpen(html, cursor);
    if (!open) break;
    const innerStart = open.tagEnd + 1;
    const closeAt = findMatchingClose(html, open.tagName, innerStart);
    anchors.push({
      region: open.region,
      tagName: open.tagName,
      innerStart,
      innerEnd: closeAt,
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

  const unmatchedFields: string[] = [];
  const undelimitedRegions: string[] = [];
  /** Edits collected first, then applied back-to-front. */
  const edits: { field: string; start: number; end: number; value: string }[] = [];

  for (const [field, value] of Object.entries(proposedFields)) {
    const matches = byRegion.get(field);
    if (!matches || matches.length === 0) {
      unmatchedFields.push(field);
      continue;
    }
    for (const anchor of matches) {
      if (anchor.innerEnd === -1) {
        if (!undelimitedRegions.includes(anchor.region)) undelimitedRegions.push(anchor.region);
        continue;
      }
      edits.push({
        field,
        start: anchor.innerStart,
        end: anchor.innerEnd,
        value: sanitizeCapturedHtml(value).html,
      });
    }
  }

  // NESTING GUARD: a marked region may legitimately sit inside another marked
  // region (the adapter decides its own anchors). Two overlapping replacements
  // would corrupt the document, so an edit CONTAINED in another edit is dropped
  // — the outer region wins, because its proposed value already carries whatever
  // the inner region should show.
  const outermost = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const applied: typeof edits = [];
  for (const edit of outermost) {
    const contained = applied.some((k) => edit.start >= k.start && edit.end <= k.end);
    if (!contained) applied.push(edit);
  }

  // Document order for the report (stable, independent of object key order) —
  // and only the edits that were actually applied.
  const substitutedRegions: string[] = [];
  for (const edit of [...applied].sort((a, b) => a.start - b.start)) {
    if (!substitutedRegions.includes(edit.field)) substitutedRegions.push(edit.field);
  }

  applied.sort((a, b) => b.start - a.start);
  let html = baseHtml;
  for (const edit of applied) {
    html = html.slice(0, edit.start) + edit.value + html.slice(edit.end);
  }

  return { html, substitutedRegions, unmatchedFields, undelimitedRegions };
}
