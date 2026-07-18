// ---------------------------------------------------------------------------
// @cinatra-ai/asset-blog / integration / renderers
// ---------------------------------------------------------------------------
//
// DEAD CODE — the `SavedMedia*` object-renderer slots only.
//
// The `blog-post` and `blog-idea` object-renderer slots (BlogPost{ListRow,
// Card,Detail} + BlogPostIdea{ListRow,Card,Detail}) were RELOCATED into their
// owning blog extensions — `@cinatra-ai/blog-post-artifact` and
// `@cinatra-ai/blog-idea-artifact` — per cinatra#1631 AC2 (epic #1620 S7/M2)
// per the 2026-07-18 owner ruling ("remove from core, move to the
// respective extensions, do not add in prod"). Core keeps the TYPE
// registration (schema / lifecycle / relations / crudPolicy — the live
// machinery) with EMPTY renderer slots (see `register-object-types.ts`). The
// only observable delta is a dimmed presence icon on the admin Types & approvals
// screen for these two types — in BOTH dev and production: even with the dev
// blog extensions installed they register a SEPARATE `<pkg>:artifact` umbrella
// type (generic renderers) rather than repopulating these host
// `@cinatra-ai/assets:*` slots, so nothing re-lights them. systemExtensions and
// the required-extensions lock are untouched (the extensions stay dev-only).
//
// The `SavedMedia*` renderers below are the DEAD remainder: the `saved-media`
// object type has no writers/consumers and is not registered anywhere (it was
// never imported by `register-object-types.ts`). It has no REGISTERED object
// type (the image bytes themselves live in `@cinatra-ai/blog-image-artifact`),
// so it does not ride the AC2 relocation. It is left in place, unchanged, for
// the dedicated dead-blog-code cleanup tracked by cinatra#1775.
//
// Constraints (retained for the SavedMedia remainder):
//   - No "use client" directive — server-only components.
//   - No imports from client-tagged panels — slots are preview surfaces.
//   - No imports from @/lib/database or any store — slots receive pre-fetched
//     values via ObjectRendererSlotProps.
//   - Use shadcn primitives + semantic tokens; avoid hardcoded palette classes.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import type { ObjectRendererSlotProps } from "@cinatra-ai/objects/renderer-types";
import type { SavedMediaRecord } from "../store";

// ---------------------------------------------------------------------------
// saved-media — DEAD (no owning type, no writers; tracked by cinatra#1775).
// Image bytes live in `@cinatra-ai/blog-image-artifact`. The renderer slot
// builds an artifact-content URL (`/api/artifacts/...`) — same pattern as
// `image-panel.tsx` uses for inline post hero images. Slots are preview-only;
// the URL is dereferenced by the browser, not server-rendered.
// ---------------------------------------------------------------------------

function buildMediaArtifactUrl(value: SavedMediaRecord): string | null {
  if (!value.imageArtifactId || !value.imageRepresentationRevisionId) return null;
  return `/api/artifacts/${encodeURIComponent(value.imageArtifactId)}/versions/${encodeURIComponent(value.imageRepresentationRevisionId)}/content`;
}

export function SavedMediaListRow({ value }: ObjectRendererSlotProps<SavedMediaRecord>) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="font-medium">{value.title}</span>
      {value.kind ? (
        <Badge className="rounded-full px-2 py-0.5 text-xs uppercase">{value.kind}</Badge>
      ) : null}
    </div>
  );
}

export function SavedMediaCard({ value }: ObjectRendererSlotProps<SavedMediaRecord>) {
  const src = buildMediaArtifactUrl(value);
  return (
    <article className="soft-panel rounded-card p-4">
      {src ? (
        // Native img tag — next/image requires configured domains; slots must stay config-free.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={value.title}
          className="rounded-card h-32 w-full object-cover"
        />
      ) : (
        <div
          className="rounded-card bg-surface-muted h-32 w-full"
          aria-label="Image preview unavailable"
        />
      )}
      <p className="mt-2 text-sm font-medium">{value.title}</p>
    </article>
  );
}

export function SavedMediaDetail({ value }: ObjectRendererSlotProps<SavedMediaRecord>) {
  const src = buildMediaArtifactUrl(value);
  return (
    <section className="soft-panel rounded-card flex flex-col gap-3 p-6">
      <header>
        <h2 className="text-2xl font-semibold">{value.title}</h2>
      </header>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={value.title} className="rounded-card max-h-96 object-contain" />
      ) : (
        <div
          className="rounded-card bg-surface-muted flex h-48 w-full items-center justify-center text-xs text-muted-foreground"
          aria-label="Image preview unavailable"
        >
          Image preview unavailable
        </div>
      )}
      {value.description ? (
        <p className="text-sm text-muted-foreground">{value.description}</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{value.kind}</dd>
      </dl>
    </section>
  );
}
