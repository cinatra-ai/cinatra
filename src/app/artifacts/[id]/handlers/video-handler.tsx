/**
 * Video handler.
 *
 * Renders allowlisted video MIMEs (MP4/WebM/Ogg) via a native `<video>`
 * element pointed at the preview route. Range requests on the preview
 * route make this stream-friendly: browsers issue `bytes=0-` for
 * playback and follow-up ranges when the user scrubs. No client JS —
 * the browser's media stack does the work (same guardrail rationale as
 * the `<embed>` PDF handler: a browser built-in is not a JS bundle, so
 * dynamic import is N/A).
 *
 * `preload="metadata"` fetches only the moov/header bytes up front
 * (duration + dimensions for the controls), not the whole file. No
 * autoplay — playback is always user-initiated.
 */
import type { ReactElement } from "react";

export type VideoHandlerProps = {
  readonly previewHref: string;
};

export function VideoHandler({ previewHref }: VideoHandlerProps): ReactElement {
  return (
    <article className="soft-panel rounded-card overflow-hidden p-0">
      {/* No <track>: an artifact is a single blob with no caption
          sidecar; the download route serves the same bytes for
          assistive tooling. */}
      <video
        src={previewHref}
        controls
        preload="metadata"
        className="mx-auto block max-h-[75vh] w-full bg-black"
        aria-label="Video preview"
      />
    </article>
  );
}
