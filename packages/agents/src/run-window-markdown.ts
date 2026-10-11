// ---------------------------------------------------------------------------
// THE PROMPT WINDOW'S READING OF ASSISTANT PROSE (cinatra#2934, W5c).
//
// The window shows the same assistant /chat shows, and the picture leg caught
// it printing that assistant's markdown raw: `**idea**` with its asterisks, a
// pipe table as a wall of pipes. What the reader was being shown was the
// model's punctuation instead of its answer.
//
// So the window draws it, with the renderer /chat draws it with — moved into
// this package so both sides can reach it (see `markdown-render-core.ts` for
// why the move went this direction). The window supplies exactly one thing of
// its own: a fenced code block drawn plain. It is a small panel of prose beside
// a form, so it neither loads the syntax highlighter nor offers a copy button
// that nothing in this panel is listening for.
// ---------------------------------------------------------------------------
import {
  createCoreMarked,
  escapeHtml,
  normalizeCoreMarkdown,
  stripEmptyParagraphs,
} from "./markdown-render-core";

/**
 * One assistant line, as HTML.
 *
 * A FRESH INSTANCE PER LINE, on purpose: the shared renderer numbers tables in
 * a closure, and two bubbles sharing one instance would share one table id.
 *
 * The result is injected with `dangerouslySetInnerHTML`, and the text is a
 * model's, which is untrusted. Nothing here is exempt from that — the escaping
 * and the URL allowlist are the core's, applied to every interpolation it
 * writes, which is the reason this calls that renderer instead of keeping a
 * second one.
 */
export function renderRunWindowMarkdown(text: string): string {
  const md = createCoreMarked({
    code({ text: source }) {
      return `<pre class="my-2 overflow-x-auto rounded-control bg-surface px-2 py-1.5 text-xs font-mono leading-relaxed text-foreground"><code>${escapeHtml(source)}</code></pre>`;
    },
  });
  return stripEmptyParagraphs(md.parse(normalizeCoreMarkdown(text), { async: false }) as string);
}
