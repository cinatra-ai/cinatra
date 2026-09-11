"use client";

/**
 * THE MARKDOWN DISPLAY — Code and Preview, and only one of them on screen
 * (cinatra#2934, fix leg 10).
 *
 * The ratified review drawing (§V.1): "Markdown is drawn by a display of its
 * own, and that display carries two tabs — Code and Preview. Only the active
 * tab's view is shown … They are never drawn side by side, and there is no third
 * reading. They are drawn as tabs — the design system's tab strip: labels at 13px
 * sans, the inactive one slate, the active one indigo under a 2px indigo
 * underline." That is the shared `Tabs` / `TabsList` / `TabsTrigger` this file
 * mounts; the treatment is not re-authored here, because tabs are tabs.
 *
 * WHERE IT OPENS. "A review target opens on Preview, with Code one press away: a
 * reviewer decides on the work as it will read, and the source stays a tab away
 * for whoever wants it."
 *
 * READ-ONLY, EVERYWHERE IT IS DRAWN TODAY. "On a review target the same display
 * is drawn read-only — both tabs, neither editable — because a target is pinned
 * to one frozen revision: an edit on this surface would move what is under
 * review, so the surface does not offer one." The editable Code view on the
 * artifact's own page, and the saving indicator that goes with it, are the other
 * half of §V.1 and are NOT built here — they are their own piece of work.
 *
 * The handler above draws this display server-side and hands it both readings
 * already resolved: the sanitized HTML and the source bytes. The client half is
 * only the tab the reader is on.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type MarkdownDisplayProps = {
  /** The markdown source, as written. */
  readonly raw: string;
  /** The rendered reading — already through the constrained renderer. */
  readonly html: string;
};

export function MarkdownDisplay({ raw, html }: MarkdownDisplayProps) {
  return (
    <div
      data-conformance-id="markdown-display"
      className="soft-panel rounded-card overflow-hidden"
    >
      {/* The tab strip IS the display's header — the two tabs and nothing else:
          no renderer chip and no provenance line (§V.1). */}
      <Tabs defaultValue="preview" className="gap-0">
        <TabsList className="w-full justify-start rounded-none px-4">
          <TabsTrigger value="code">Code</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="code" className="overflow-auto p-6">
          <pre className="text-foreground font-mono text-sm break-words whitespace-pre-wrap">
            {raw}
          </pre>
        </TabsContent>
        <TabsContent value="preview" className="overflow-auto p-6">
          <article
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
