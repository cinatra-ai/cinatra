/**
 * Plain-text handler.
 *
 * Reads the artifact bytes server-side and renders inside a `<pre>` with
 * `whitespace-pre-wrap break-words` so long lines wrap rather than
 * scrolling horizontally.
 */
import "server-only";

import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

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
  if (resolved.sizeBytes > MAX_TEXT_BYTES) return null;
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

export type PlainTextHandlerProps = {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly orgId: string;
};

export async function PlainTextHandler({
  artifactId,
  revisionId,
  orgId,
}: PlainTextHandlerProps) {
  const raw = await readArtifactText({ orgId, artifactId, revisionId });
  if (raw === null) {
    return (
      <div className="soft-panel rounded-card p-4 text-muted-foreground text-sm">
        Unable to load text content (artifact missing or exceeds the 10
        MB preview cap).
      </div>
    );
  }
  return (
    <article className="soft-panel rounded-card overflow-auto p-6">
      <pre className="text-foreground text-sm font-mono whitespace-pre-wrap break-words">
        {raw}
      </pre>
    </article>
  );
}
