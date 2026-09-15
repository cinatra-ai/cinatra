"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * THE MARKDOWN DISPLAY'S CODE / PREVIEW STRIP (cinatra#3046, fix leg 17;
 * cinatra#3295).
 *
 * The ratified drawing gives the markdown display one panel with a two-tab strip
 * over it: "that display carries two tabs — Code and Preview. Only the active
 * tab's view is shown … They are never drawn side by side, and there is no third
 * reading." A review target "opens on Preview, with Code one press away".
 *
 * WHAT STOOD HERE. Two panels side by side, headed "Rendered" and "Raw source" —
 * both readings at once, neither of them a tab, and no strip anywhere. The
 * thirteenth graded reading measured its absence on the resolved review display
 * in both palettes.
 *
 * AND THE STRIP IS THE DESIGN SYSTEM'S OWN TAB STRIP, NOT A SECOND ONE. The
 * drawing is explicit that these are "the design system's tab strip
 * (Components §Tabs): labels at 13px sans, the inactive one slate, the active
 * one indigo under a 2px indigo underline — never a toggle and never a
 * segmented control". `@/components/ui/tabs` IS that strip and already carries
 * every one of those measures, so this display mounts it rather than
 * hand-rolling a second row of buttons that would drift from it at the first
 * change.
 *
 * WHY THIS IS A CLIENT COMPONENT AND THE HANDLER STAYS A SERVER ONE. The bytes,
 * the size cap and the sanitising renderer all belong on the server and do not
 * move: the handler still reads and sanitises, and hands this component the
 * finished html and the raw source. Only the CHOICE of reading is interactive,
 * so only the choice crosses — and it must, because a server component may hold
 * no selection state at all.
 *
 * AND THE CHROME TRAVELS WITH THE DISPLAY. "The same display is drawn,
 * unchanged, wherever the artifact is read — the artifact page here, the review
 * step on the run page and the review card in a conversation … A display's
 * chrome travels with it: what it carries here it carries there." This component
 * is the display, so the strip reaches the artifact page, the pending review and
 * the settled review from one definition rather than three.
 *
 * THE BORDER IS NOT CROSSED. The markdown reading is the HOST's own
 * form-rendering rung (`ReviewTargetMount`'s `form` arm), not an extension
 * renderer, so this is host chrome for a host display and no package is
 * special-cased by it.
 *
 * Conformance anchor: `markdown-display`; the strip is `markdown-display-tabs`.
 */
export function MarkdownCodePreview({
  html,
  raw,
}: {
  /** Already sanitised on the server by the constrained readme renderer. */
  readonly html: string;
  readonly raw: string;
}) {
  return (
    <div
      data-conformance-id="markdown-display"
      className="overflow-hidden rounded-card border border-line bg-surface-strong"
    >
      {/* PREVIEW IS THE ACTIVE READING, which is what the drawing draws selected
          on a review target, with Code one press away. */}
      <Tabs defaultValue="preview">
        <TabsList
          data-conformance-id="markdown-display-tabs"
          className="w-full bg-surface px-3.5"
        >
          {/* The drawn order: Code first, Preview second. */}
          <TabsTrigger value="code">Code</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        {/* ONE body region on screen, whichever reading is chosen — the drawing
            draws a single panel under the strip, never two side by side. */}
        <TabsContent value="code" className="overflow-auto p-3.5">
          <pre className="text-foreground text-sm font-mono whitespace-pre-wrap break-words">
            {raw}
          </pre>
        </TabsContent>
        <TabsContent value="preview" className="overflow-auto p-3.5">
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
