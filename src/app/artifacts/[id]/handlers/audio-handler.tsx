/**
 * Audio handler.
 *
 * Renders allowlisted audio MIMEs (MP3/M4A/Ogg/WAV/WebM/FLAC/AAC) via a
 * native `<audio>` element pointed at the preview route. Range requests
 * on the preview route make seeking stream-friendly (browsers issue
 * `bytes=0-` then follow-up ranges). No client JS — browser built-in,
 * same rationale as the PDF/video handlers.
 *
 * `preload="metadata"` fetches only the header bytes (duration for the
 * controls), not the whole file. No autoplay.
 */
import type { ReactElement } from "react";

export type AudioHandlerProps = {
  readonly previewHref: string;
};

export function AudioHandler({ previewHref }: AudioHandlerProps): ReactElement {
  return (
    <article className="soft-panel rounded-card overflow-hidden p-6">
      <audio
        src={previewHref}
        controls
        preload="metadata"
        className="block w-full"
        aria-label="Audio preview"
      />
    </article>
  );
}
