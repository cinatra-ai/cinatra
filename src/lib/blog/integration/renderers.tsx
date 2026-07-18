// ---------------------------------------------------------------------------
// @cinatra-ai/asset-blog / integration / renderers
// ---------------------------------------------------------------------------
//
// Server-only React components wired into the object-type registry for the two
// live blog types (blog-post, blog-post-idea) — three slots per type (listRow,
// card, detail). The dead `saved-media` renderer slots were removed here
// (cinatra#1630 AC-3): that type registers null renderers and has no writers.
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

import type { ObjectRendererSlotProps } from "@cinatra-ai/objects/renderer-types";
import type {
  BlogPostDraftRecord,
  BlogPostIdeaRecord,
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

// NOTE: the `saved-media` renderer slots (SavedMediaListRow/Card/Detail) were
// DELETED here (cinatra#1630 AC-3). They were dead — the `saved-media` type is
// registered with null renderers and has no writers, and they re-implemented an
// in-core inline-image preview off `/api/artifacts/.../content`. The neutral
// capability-gated preview slot (`ArtifactInlinePreview`) is the replacement for
// in-core inline-image reuse.
