/**
 * Image handler.
 *
 * Renders any allowlisted image MIME (PNG/JPEG/GIF/WebP/SVG) via a plain
 * `<img>` element. SVG specifically goes through `<img src=...>` so the
 * browser treats it as a passive image — never as an inline `<svg>` from
 * artifact content (which would execute script/event handlers if not
 * sanitised). Guardrail: any future inline-SVG path must add a
 * sanitiser or render inside a sandboxed iframe.
 *
 * Not using Next `<Image>` because the artifact preview path is
 * already-auth-gated + dynamic; Next `<Image>` adds upstream optimisation
 * via `/_next/image` which would bypass our actor-scoped fetch.
 */
import type { ReactElement } from "react";

export type ImageHandlerProps = {
  readonly previewHref: string;
  readonly alt: string;
};

export function ImageHandler({ previewHref, alt }: ImageHandlerProps): ReactElement {
  return (
    <article className="soft-panel rounded-card overflow-hidden p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={previewHref}
        alt={alt}
        className="mx-auto block max-h-[75vh] max-w-full object-contain"
      />
    </article>
  );
}
