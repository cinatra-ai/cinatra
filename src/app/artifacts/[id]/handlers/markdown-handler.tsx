/**
 * Markdown handler — the server half of the markdown display.
 *
 * It reads the artifact bytes directly via the local blob store (the canonical
 * server-side path the attachment-resolver uses) and renders them through the
 * constrained renderer at request time, then hands both readings to
 * `MarkdownDisplay`, which draws them as the ratified display: TWO TABS, Code
 * and Preview, with only the active one on screen (cinatra#2934, fix leg 10).
 *
 * It used to draw both at once — a two-column grid, "Rendered" beside "Raw
 * source" — which is the one thing the drawing forbids ("They are never drawn
 * side by side, and there is no third reading"). Everywhere this handler is
 * mounted today the display is read-only: the artifact's own page and the review
 * target both draw the same display, and neither offers an edit here.
 */
import "server-only";

import { MarkdownDisplay } from "./markdown-display";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { renderReadmeMarkdown } from "@cinatra-ai/agents/readme-render";

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024; // mirror preview byte cap

async function readArtifactText(input: {
  orgId: string;
  artifactId: string;
  revisionId: string;
}): Promise<string | null> {
  const resolved = resolveArtifactVersionForServe({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.revisionId,
  });
  if (!resolved) return null;
  if (resolved.sizeBytes > MAX_MARKDOWN_BYTES) return null;
  const store = createLocalDiskBlobStore();
  try {
    const handle = await store.openByStorageKey({
      orgId: input.orgId,
      storageKey: resolved.storageKey,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

export type MarkdownHandlerProps = {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly orgId: string;
};

export async function MarkdownHandler({
  artifactId,
  revisionId,
  orgId,
}: MarkdownHandlerProps) {
  const raw = await readArtifactText({ orgId, artifactId, revisionId });
  if (raw === null) {
    return (
      <div className="soft-panel rounded-card p-4 text-muted-foreground text-sm">
        Unable to load markdown content (artifact missing or exceeds the
        10 MB preview cap).
      </div>
    );
  }
  // Reuse the canonical constrained renderer at
  // `packages/agents/src/readme-render.ts` — it strips raw HTML / script /
  // event handlers, normalises link hrefs through `isSafeUrl`, and
  // recurses through link/image child tokens via the same renderer.
  // Same threat model: untrusted user-authored markdown rendered inside
  // Cinatra origin. Marked alone (v18) does NOT sanitise — actor-gated
  // bytes are not sufficient because a malicious artifact would still
  // execute as the viewing user.
  const html = renderReadmeMarkdown(raw);

  return <MarkdownDisplay raw={raw} html={html} />;
}
