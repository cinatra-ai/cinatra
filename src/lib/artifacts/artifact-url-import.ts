import "server-only";

// ---------------------------------------------------------------------------
// URL → semantic artifact service layer.
//
// Composes the SSRF-safe HTTP fetch + cheerio→markdown helper
// (`url-import.ts`) with the canonical artifact writer
// (`createSemanticArtifact`). Lives in `src/lib/artifacts/` so the
// single-write-path invariant test (`service-and-mcp.test.ts`) keeps its
// positive allow-list — the server action (`library-import-actions.ts`) calls
// THIS module, not the writer directly.
// ---------------------------------------------------------------------------

import {
  createSemanticArtifact,
  type CreateSemanticArtifactResult,
} from "./artifact-creation";
import {
  asUtf8Stream,
  fetchUrlAsMarkdown,
  URL_IMPORT_MAX_RAW_BYTES,
  type UrlImportDeps,
  type UrlImportError,
} from "./url-import";
import type { ActorContext } from "@/lib/authz/actor-context";

export type ImportArtifactFromUrlInput = {
  url: string;
  orgId: string;
  actor: ActorContext;
};

/** `deps` is a TEST-ONLY parameter accepted by
 *  `importArtifactFromUrlServiceForTest`, NOT by the public
 *  service. The server action calls the public service with no
 *  deps so external callers cannot weaken numeric caps. */
export type ImportArtifactFromUrlTestInput = ImportArtifactFromUrlInput & {
  deps: UrlImportDeps;
};

export type ImportArtifactFromUrlSuccess = {
  ok: true;
  artifactId: string;
  representationRevisionId: string;
  /** Final URL after redirects (for diagnostics + UI). */
  finalUrl: string;
  /** Title pulled from <title> / first <h1>. */
  title: string;
};

export type ImportArtifactFromUrlError = UrlImportError;

export type ImportArtifactFromUrlResult =
  | ImportArtifactFromUrlSuccess
  | ImportArtifactFromUrlError;

/**
 * Fetch a URL → normalize to markdown → write a semantic artifact.
 * The matcher auto-fires post-creation (classification is async).
 *
 *   - `originKind: "external_link"`
 *   - `declaredMime: "text/markdown"`
 *   - `skipFallbackClassification: false` (we WANT the matcher to run)
 */
export async function importArtifactFromUrlService(
  input: ImportArtifactFromUrlInput,
): Promise<ImportArtifactFromUrlResult> {
  // Public surface — NO test deps. Production resource caps apply.
  return runImportArtifactFromUrl(input, undefined);
}

/** TEST-ONLY entry point that accepts the `deps` parameter. Vitest imports
 *  THIS function; the server action calls `importArtifactFromUrlService`
 *  (no deps). */
export async function importArtifactFromUrlServiceForTest(
  input: ImportArtifactFromUrlTestInput,
): Promise<ImportArtifactFromUrlResult> {
  return runImportArtifactFromUrl(input, input.deps);
}

async function runImportArtifactFromUrl(
  input: ImportArtifactFromUrlInput,
  deps: UrlImportDeps | undefined,
): Promise<ImportArtifactFromUrlResult> {
  const fetched = await fetchUrlAsMarkdown(input.url, deps);
  if (!fetched.ok) return fetched;

  const result: CreateSemanticArtifactResult = await createSemanticArtifact({
    orgId: input.orgId,
    createdBy: input.actor.principalId ?? null,
    ownerLevel: "organization",
    ownerId: input.orgId,
    title: fetched.title,
    declaredMime: "text/markdown",
    originKind: "external_link",
    stream: asUtf8Stream(fetched.markdown),
    maxBytes: URL_IMPORT_MAX_RAW_BYTES,
    skipFallbackClassification: false,
  });

  return {
    ok: true,
    artifactId: result.artifactId,
    representationRevisionId: result.representationRevisionId,
    finalUrl: fetched.finalUrl,
    title: fetched.title,
  };
}
