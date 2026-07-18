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

/**
 * Make a rendered content fragment HYDRATION-INVARIANT at its code blocks
 * (cinatra#1222 live-run slice). The live `/chat` surface asynchronously swaps
 * each `.chat-code-block` placeholder for shiki-highlighted markup (the
 * chat-messages-view hydration effect at ~L871-893: it `replaceWith`s the
 * `<pre>` and removes ONLY the `data-shiki-code` attribute), whereas the
 * committed golden captures the PRE-hydration placeholder the reference renderer
 * emits in Node (shiki cold → placeholder). The deterministic render-parity DOM
 * gate covers the CONTENT layer; shiki syntax-highlighting is a client
 * enhancement the static slice deliberately keeps OUT of the golden.
 *
 * This canonicalizer neutralizes EXACTLY the two things that legitimately differ
 * between the placeholder and the hydrated shape, and NOTHING else — so it can
 * never mask a real divergence:
 *   1. the `data-shiki-code` div attribute (present only on the placeholder — it
 *      is the one attribute the hydration removes), and
 *   2. the `<pre>` element itself (its class/style AND its inner markup — escaped
 *      source in `<pre><code>…</code></pre>` vs shiki's highlighted `<pre>`),
 *      replaced by one canonical `<pre data-code-canon>` carrying just the source.
 * Everything else is KEPT and therefore still COMPARED: the wrapper `<div>` and
 * its `data-shiki-lang` / `data-shiki-theme` (both present in BOTH shapes, so a
 * real LANGUAGE or code-THEME divergence still fails), and the copy button. The
 * source is recovered identically from either shape via the `<pre>`'s
 * `textContent` (the placeholder's `<code>` and shiki's token spans both
 * preserve the source text); only shiki's single-trailing-newline serialization
 * artifact is normalized (`/\n$/`, exactly one — a multi-newline drift is NOT
 * masked). A fixture with no `.chat-code-block` is untouched (the compare is then
 * plain `domNormalize`, identical to the static gate).
 *
 * Self-contained (references only DOM globals) so Playwright can serialize it
 * into the page via `page.evaluate(canonicalizeCodeBlocks, html)`. Returns an
 * HTML string; feed it to `domNormalize` for the canonical compare.
 */
export function canonicalizeCodeBlocks(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll(".chat-code-block").forEach((el) => {
    // Recover the source from the <pre> — present and text-preserving in BOTH
    // the placeholder (`<pre><code>escaped</code></pre>`) and the hydrated shiki
    // <pre> (its line/token spans preserve the source text verbatim).
    const pre = el.querySelector("pre");
    // Normalize ONLY shiki's single-trailing-newline serialization artifact; a
    // genuine multi-newline source drift survives (not `\n+$`).
    const source = (pre?.textContent ?? el.textContent ?? "").replace(/\n$/, "");
    // Drop the ONE attribute that differs placeholder↔hydrated. data-shiki-lang
    // and data-shiki-theme are present in BOTH and are KEPT, so a real language
    // or code-theme divergence is still compared.
    el.removeAttribute("data-shiki-code");
    // Replace the <pre> (its class/style + highlight internals legitimately
    // differ between the two shapes) with one canonical source marker; the
    // wrapper div, its retained data-shiki-lang/theme, and the copy button stay
    // for the compare. textContent lets the browser escape &,<,> so the marker
    // round-trips through domNormalize's re-parse.
    const canon = document.createElement("pre");
    canon.setAttribute("data-code-canon", "1");
    canon.textContent = source;
    if (pre) pre.replaceWith(canon);
    else el.replaceChildren(canon);
  });
  return tpl.innerHTML;
}
