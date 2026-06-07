// ---------------------------------------------------------------------------
// @cinatra-ai/asset-blog / integration / renderers
// ---------------------------------------------------------------------------
//
// Server-only React components wired into the object-type registry for the
// three blog types (blog-post, blog-post-idea, saved-media). Three slots per
// type (listRow, card, detail) → nine components total.
//
// Constraints:
//   - No "use client" directive — these components must render on the server
//     and stay out of the client bundle graph.
//   - No imports from client-tagged panels (draft-editor, ideas-panel,
//     image-panel) — slots are preview surfaces, not the canonical editor.
//   - No imports from @/lib/database or any store — slots receive pre-fetched
//     values via ObjectRendererSlotProps.
//   - Use shadcn primitives + semantic tokens; avoid hardcoded palette classes.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import type { ObjectRendererSlotProps } from "@cinatra-ai/objects/renderer-types";
import type {
  BlogPostDraftRecord,
  BlogPostIdeaRecord,
  SavedMediaRecord,
} from "../store";

// ---------------------------------------------------------------------------
// blog-post  (BlogPostDraftRecord — schema has no `status` field; renderers
// surface title + excerpt and link to the draft editor page)
// ---------------------------------------------------------------------------

export function BlogPostListRow({
  value,
  compact,
}: ObjectRendererSlotProps<BlogPostDraftRecord>) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="font-medium">{value.title}</span>
      {!compact && value.excerpt ? (
        <span className="text-xs text-muted-foreground line-clamp-1">{value.excerpt}</span>
      ) : null}
    </div>
  );
}

export function BlogPostCard({ value }: ObjectRendererSlotProps<BlogPostDraftRecord>) {
  return (
    <article className="soft-panel rounded-card p-4">
      <header className="flex items-center gap-2">
        <h3 className="text-base font-semibold">{value.title}</h3>
      </header>
      {value.excerpt ? (
        <p className="mt-1 text-sm text-muted-foreground">{value.excerpt}</p>
      ) : null}
    </article>
  );
}

export function BlogPostDetail({ value }: ObjectRendererSlotProps<BlogPostDraftRecord>) {
  return (
    <section className="soft-panel rounded-card flex flex-col gap-3 p-6">
      <header className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold">{value.title}</h2>
      </header>
      {value.excerpt ? (
        <p className="text-sm text-muted-foreground">{value.excerpt}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Open the draft editor to view and edit the full post body.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// blog-post-idea  (schema has no `status` field; renderers surface title +
// summary only)
// ---------------------------------------------------------------------------

// Idea summaries live in `@cinatra-ai/blog-idea-artifact`. These object-renderer slots are
// preview surfaces (no async fetches inside renderer-slot signatures —
// slots receive pre-fetched values); the slot omits the body preview
// when refs are present. The canonical idea-summary surface is
// `ideas-panel.tsx`, which calls the reader helper server-side.
export function BlogPostIdeaListRow({
  value,
  compact: _compact,
}: ObjectRendererSlotProps<BlogPostIdeaRecord>) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="font-medium">{value.title}</span>
    </div>
  );
}

export function BlogPostIdeaCard({ value }: ObjectRendererSlotProps<BlogPostIdeaRecord>) {
  return (
    <article className="soft-panel rounded-card p-4">
      <header className="flex items-center gap-2">
        <h3 className="text-base font-semibold">{value.title}</h3>
      </header>
      {value.summaryArtifactId ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Open the idea panel to view the full summary.
        </p>
      ) : null}
    </article>
  );
}

export function BlogPostIdeaDetail({ value }: ObjectRendererSlotProps<BlogPostIdeaRecord>) {
  return (
    <section className="soft-panel rounded-card flex flex-col gap-3 p-6">
      <header className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold">{value.title}</h2>
      </header>
      <p className="text-xs text-muted-foreground">
        Open the idea panel to view the full summary.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// saved-media — image bytes live in `@cinatra-ai/blog-image-artifact`. The renderer slot
// builds an artifact-content URL (`/api/artifacts/...`) — same pattern as
// `image-panel.tsx` uses for inline post hero images. Slots are
// preview-only; the URL is dereferenced by the browser, not server-rendered.
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
