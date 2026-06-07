/**
 * Markdown handler for the artifact detail page.
 *
 * Renders TWO views side-by-side: (a) the rendered markdown HTML via the
 * `marked` package already declared at `packages/chat/package.json`,
 * (b) the raw source in `<pre>` with `whitespace-pre-wrap`. Server
 * component — reads the artifact bytes directly via the local blob
 * store (the canonical server-side path the attachment-resolver uses)
 * and parses them at request time. No client component, no chat-page
 * coupling.
 */
import "server-only";

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

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <article className="soft-panel rounded-card overflow-auto p-6">
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
          Rendered
        </h2>
        <div
          className="prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>
      <article className="soft-panel rounded-card overflow-auto p-6">
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
          Raw source
        </h2>
        <pre className="text-foreground text-sm font-mono whitespace-pre-wrap break-words">
          {raw}
        </pre>
      </article>
    </div>
  );
}
