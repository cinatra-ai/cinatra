// ---------------------------------------------------------------------------
// DOM normalization for render-parity compare (cinatra#1222, epic #1216 S6).
//
// A rendered HTML string is compared DOM-NORMALIZED, not byte-for-byte: two
// surfaces that draw the SAME DOM must pass even if their serializers differ in
// attribute order or incidental whitespace. Normalization parses the HTML into
// a real DOM (via a <template>), then re-serializes canonically:
//
//   - attributes sorted by name (serializer-order independent),
//   - insignificant inter-element / text whitespace collapsed, EXCEPT inside
//     `<pre>`/`<code>` where whitespace is significant (code blocks),
//   - comment nodes dropped.
//
// `domNormalize` is a SELF-CONTAINED browser function (references only DOM
// globals, no outer scope) so Playwright can serialize it into the page via
// `page.evaluate(domNormalize, html)`. This is genuine DOM normalization — the
// browser's own HTML parser builds the tree — the strongest available compare
// short of a live pixel diff.
// ---------------------------------------------------------------------------

/**
 * Canonicalize an HTML string by parsing it in the browser DOM and
 * re-serializing with sorted attributes and collapsed insignificant whitespace.
 * Runs IN the page (Playwright serializes it); do not reference module scope.
 */
export function domNormalize(html: string): string {
  // Whitespace is significant inside these elements (code blocks, raw text
  // areas) and is preserved verbatim; elsewhere runs of whitespace collapse to
  // a SINGLE space — matching HTML's own inline collapsing while KEEPING a
  // single significant space between inline elements (dropping it entirely
  // would make "<span>a</span> <span>b</span>" compare equal to the un-spaced
  // form and mask a real render drift).
  const WHITESPACE_SIGNIFICANT = new Set(["PRE", "CODE", "TEXTAREA"]);

  // Attribute values are re-quoted, so `"` and `&` in a value must be escaped —
  // otherwise the canonical form is not injective (a value containing a quote
  // could collide with a different attribute set).
  function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function serialize(node: Node, inPre: boolean): string {
    // Element node.
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      const attrs = Array.from(el.attributes)
        .map((a) => ({ name: a.name, value: a.value }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
        .join("");
      const nextInPre = inPre || WHITESPACE_SIGNIFICANT.has(el.tagName);
      let inner = "";
      el.childNodes.forEach((child) => {
        inner += serialize(child, nextInPre);
      });
      return `<${tag}${attrs}>${inner}</${tag}>`;
    }
    // Text node.
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (inPre) return text;
      // Collapse runs of whitespace to a single space outside pre/code — this
      // preserves a single significant inter-element space rather than deleting
      // it (no aggressive tag-boundary strip).
      return text.replace(/\s+/g, " ");
    }
    // Drop comments (nodeType 8) and everything else.
    return "";
  }

  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  let out = "";
  tpl.content.childNodes.forEach((child) => {
    out += serialize(child, false);
  });
  return out.trim();
}
