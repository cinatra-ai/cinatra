/**
 * Markdown handler — THE HOST'S MARKDOWN DISPLAY.
 *
 * Server component: it reads the artifact bytes directly via the local blob
 * store (the canonical server-side path the attachment-resolver uses), applies
 * the size cap, and renders them through the constrained sanitising renderer at
 * request time.
 *
 * IT DRAWS ONE PANEL UNDER A CODE / PREVIEW STRIP (cinatra#3046, fix leg 17;
 * cinatra#3295). It used to draw TWO panels side by side, headed "Rendered" and
 * "Raw source" — both readings at once. The ratified drawing gives this display
 * a two-tab strip over a single body ("A kind written as text is drawn through
 * the markdown display on its Code and Preview tabs"), and the thirteenth graded
 * reading measured the strip's absence on the resolved review display in both
 * palettes. The strip itself is `MarkdownCodePreview` beside this file, because
 * choosing a reading is the one interactive thing here; the bytes, the cap and
 * the sanitiser stay on this side and are untouched.
 *
 * AND THAT IS WHY ONE EDIT REACHES THREE SURFACES. This display is drawn on the
 * artifact's own page, in the review step on the run page, and on the review
 * card in a conversation — "a display's chrome travels with it: what it carries
 * here it carries there" — so the strip lands on the pending and the settled
 * review from this one definition. It is the HOST's own form-rendering rung, not
 * an extension renderer, so no package is special-cased to get it.
 */
import "server-only";

import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { renderReadmeMarkdown } from "@cinatra-ai/agents/readme-render";

import { MarkdownCodePreview } from "./markdown-code-preview";

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

  return <MarkdownCodePreview html={html} raw={raw} />;
}
