import type { ReactElement, ReactNode } from "react";

import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

/**
 * THE GENERIC READ-ONLY STRUCTURED-DATA VIEW — the host's never-blank floor node
 * (cinatra#3319).
 *
 * `specs/app-artifacts.html` §III, the third dispatch case: "Generic fallback —
 * anything whose type ships no renderer and has no MIME handler falls back to a
 * read-only structured-data (JSON) view plus metadata. There is always a
 * renderer; the fallback is never a blank." That is this node, and §III's own
 * example (`data-conformance-id="artifact-render-fallback"`) draws it element for
 * element: a header strip carrying the artifact's TYPE ID beside a mono
 * `structured data` label, over a preformatted block holding the JSON.
 *
 * ONE NODE, BOTH SURFACES. `specs/app-artifact-review.html` §V asks for the same
 * reading beneath the review floor's diagnostic — "A type-level floor ... still
 * has an authorized representation, so its diagnostic sits above the generic
 * read-only structured-data view of that representation" — so the artifact page
 * and the review target panel hand this ONE component to the shared display
 * mount rather than each wording a floor of its own. (An ARTIFACT-level floor
 * passes no node at all: "it renders the diagnostic alone (no representation
 * content, because there is no authorized representation to render)".)
 *
 * IT IS THE FLOOR, NOT A DISPLAY, and the core/extension border is why every
 * omission below is deliberate. It draws no download control — bytes nothing can
 * name belong to the binary base pack's own card (§V.2) — and it names no
 * renderer, no package and no provenance, because §V forbids a display from
 * saying anything about itself and this node is drawn on that surface too. It
 * fetches nothing and mounts nothing: it renders the projection the host already
 * read, authorized and capped, and never reaches for bytes.
 */
export function ArtifactStructuredDataView({
  props,
}: {
  /** The host's own display-props snapshot — the same one a resolved display
   *  would have been handed, which is what makes this the floor for THIS row
   *  rather than a generic apology. */
  props: ArtifactRendererProps;
}): ReactElement {
  const { artifact } = props;
  const body = structuredDataBody(props.content);

  return (
    <div
      data-conformance-id="artifact-render-fallback"
      className="rounded-panel border border-line bg-surface-strong"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span
          data-artifact-structured-type=""
          className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 font-mono text-badge-2xs tracking-tight text-muted-foreground"
        >
          {artifact.objectType}
        </span>
        <span className="font-mono text-badge-2xs tracking-widest text-muted-foreground">
          structured data
        </span>
      </div>

      {/* THE READ-ONLY STRUCTURED-DATA BODY, switched on the content channel's
          own discriminator — never inferred from a mime and never fetched. The
          `none` arm draws no body at all and lets the metadata below stand as
          the whole reading, which is the honest answer for a row that has no
          authorized representation to show. */}
      {body === null ? null : (
        <pre
          data-artifact-structured-body=""
          className="m-0 overflow-x-auto bg-surface px-3 py-3 font-mono text-xs leading-relaxed text-foreground"
        >
          {body}
        </pre>
      )}

      {/* THE METADATA §III asks for beside the JSON — the row's own fields, read
          off the same authorized snapshot and nothing else. */}
      <dl
        data-artifact-structured-metadata=""
        className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-line px-3 py-3 text-xs"
      >
        <MetadataField label="Title" value={artifact.title} />
        <MetadataField label="Type" value={artifact.objectType} />
        <MetadataField label="Media type" value={artifact.mime} />
        <MetadataField label="Size" value={`${artifact.size} bytes`} />
        <MetadataField label="Owner level" value={artifact.ownerLevel} />
        <MetadataField label="Visibility" value={artifact.visibility} />
        <MetadataField label="Created" value={artifact.createdAt} />
        <MetadataField label="Updated" value={artifact.updatedAt} />
      </dl>
    </div>
  );
}

/** One metadata row. A null title is the row's own honest state, so it reads as
 *  an em dash rather than as a blank cell the reader cannot tell apart from a
 *  field the view forgot to draw. */
function MetadataField({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): ReactNode {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-foreground">
        {value ?? "—"}
      </dd>
    </>
  );
}

/**
 * The projection, as the JSON the drawing draws. Each content class yields its
 * own carried substance; `none` yields no body at all.
 *
 * `JSON.stringify` answers `undefined` for an undefined value, which would
 * render as nothing inside a block that says it holds the work — so that answer
 * is normalized to no body rather than to an empty frame.
 */
function structuredDataBody(content: ArtifactContentProjection): string | null {
  switch (content.kind) {
    case "text":
      return content.text;
    case "configuration":
      return JSON.stringify(content.configuration, null, 2) ?? null;
    case "page":
      return JSON.stringify(content.page, null, 2) ?? null;
    case "object":
      return JSON.stringify(content.data, null, 2) ?? null;
    case "none":
      return null;
  }
}
