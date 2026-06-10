import type { ReactNode } from "react";

import { renderReadmeMarkdown } from "@cinatra-ai/agents/readme-render";

/**
 * MarketplaceReadmeSection — the PRIMARY-BODY slot of the in-app marketplace
 * detail view, mirroring the public page's Description tab (the README body).
 * This component owns only the POSITION of the block: it must be the first
 * section of the detail body for every extension kind. What renders inside is
 * the caller's concern — {@link MarketplaceReadmeMarkdownSection} is the
 * canonical README-markdown filling of this slot.
 */
export function MarketplaceReadmeSection({ children }: { children: ReactNode }) {
  return (
    <section
      data-slot="marketplace-readme"
      className="soft-panel rounded-card px-6 py-5"
    >
      <h2 className="mb-3 text-sm font-semibold text-foreground">Description</h2>
      {children}
    </section>
  );
}

/**
 * Scoped editorial typography for the rendered README body, mirroring the
 * public marketplace's `.cin-ext-readme` rules:
 *
 *   - Reading measure capped at ~65ch (`max-w-[65ch]`), matching the public
 *     page's README column.
 *   - Explicit size/weight per heading level. README headings arrive
 *     pre-demoted one level (`h1→h2 … h5→h6` — the page hero owns the only
 *     `<h1>`), so the scale starts at h2 and steps down from there.
 *   - Styled lists (disc/decimal markers, indentation, item rhythm).
 *   - Styled code: inline `code` chips on the muted surface tone, and fenced
 *     `pre` blocks with horizontal scroll (the inline-chip styles are reset
 *     inside `pre`).
 *
 * Every rule is scoped to descendants of the README container — nothing leaks
 * into the surrounding detail sections.
 */
export const MARKETPLACE_README_BODY_CLASS = [
  // Reading measure + base text.
  "max-w-[65ch] text-sm leading-relaxed text-foreground",
  // No extra top whitespace under the section heading.
  "[&>*:first-child]:mt-0",
  // Heading scale (post-demotion: content headings are h2–h6).
  "[&_h2]:mt-7 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:text-base [&_h4]:font-semibold",
  "[&_h5]:mt-4 [&_h5]:mb-1 [&_h5]:text-sm [&_h5]:font-semibold",
  "[&_h6]:mt-4 [&_h6]:mb-1 [&_h6]:text-sm [&_h6]:font-medium [&_h6]:text-muted-foreground",
  // Prose rhythm.
  "[&_p]:my-3",
  "[&_a]:underline [&_a]:underline-offset-2",
  // Lists.
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6",
  "[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:my-1",
  // Inline code chips.
  "[&_code]:rounded-sm [&_code]:bg-surface-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  // Fenced code blocks (and reset the inline-chip styles inside them).
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-muted [&_pre]:p-4",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  // Quotes, rules, media, tables.
  "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-6 [&_hr]:border-line",
  "[&_img]:my-4 [&_img]:max-w-full [&_img]:rounded-md",
  "[&_table]:my-4 [&_table]:w-full [&_table]:text-left",
  "[&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-1.5 [&_th]:font-semibold",
  "[&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-1.5",
].join(" ");

/**
 * Whether the marketplace `readmeMarkdown` produces any visible README body
 * once rendered through the sanitizing renderer. Callers that own a fallback
 * (e.g. the non-agent plain-text long description) must branch on THIS — not
 * on a raw string check — so a README that sanitizes down to nothing (e.g.
 * raw HTML only) still falls back instead of rendering no primary body.
 * Both Marked instances are cached, so the render here and the render inside
 * {@link MarketplaceReadmeMarkdownSection} stay cheap.
 */
export function hasRenderableReadmeMarkdown(
  markdown: string | null | undefined,
): boolean {
  return renderReadmeMarkdown(markdown, { demoteHeadings: true }).trim() !== "";
}

/**
 * The README primary body of the marketplace detail view, sourced from the
 * marketplace `ExtensionDetail.readmeMarkdown` — the same field the public
 * marketplace.cinatra.ai Description tab renders. Rendering parity with the
 * public page:
 *
 *   - Markdown is rendered through the sanitizing `renderReadmeMarkdown`
 *     helper (raw HTML stripped, link/image schemes allowlisted) — the input
 *     is untrusted vendor content and `dangerouslySetInnerHTML` is acceptable
 *     ONLY because that dedicated, auditable helper sanitizes it first.
 *   - Headings are demoted one level (`h1→h2 …`): the page hero already
 *     renders the only `<h1>` (the extension name), exactly like the public
 *     renderer.
 *   - Typography is scoped via {@link MARKETPLACE_README_BODY_CLASS}.
 *
 * Empty/absent markdown — or markdown that sanitizes down to nothing —
 * renders no section at all: no empty pane.
 */
export function MarketplaceReadmeMarkdownSection({
  markdown,
}: {
  markdown: string | null | undefined;
}) {
  const html = renderReadmeMarkdown(markdown, { demoteHeadings: true });
  if (html.trim() === "") {
    return null;
  }
  return (
    <MarketplaceReadmeSection>
      <div
        data-slot="extension-readme"
        className={MARKETPLACE_README_BODY_CLASS}
        // Sanitized by renderReadmeMarkdown above — see the component doc.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </MarketplaceReadmeSection>
  );
}
