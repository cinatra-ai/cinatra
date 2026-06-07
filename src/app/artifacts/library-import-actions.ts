"use server";

// ---------------------------------------------------------------------------
// Server-action surface for artifact library imports.
//
//   - importArtifactFromUrl: LIVE.
//     Server-side SSRF-guarded fetch via `@/lib/artifacts/url-import`
//     (undici Agent with connect-time DNS validation) → cheerio
//     HTML→Markdown normalize → `createSemanticArtifact`
//     (originKind: external_link, declaredMime: text/markdown,
//     skipFallbackClassification: false). Matcher auto-fires
//     post-creation; classification is async. The `web-scrape-agent`
//     is a structured-extraction LLM agent, mismatched to "fetch the
//     page as-is."
//
//   - createArtifactFromTemplate: LIVE deterministic no-skill path.
//     Materializes a starter representation + writes a user-asserted
//     eligibility for the chosen extension. There is no skill in the
//     loop for this path, just a button click. Chat-driven authoring
//     is live through the `chat-create-artifact` chat skill + the
//     `artifact_authoring_emit` MCP primitive.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { getAuthSession, getActorContext } from "@/lib/auth-session";
import { materializeArtifactFromTemplate } from "@/lib/artifacts/artifact-template";
import { importArtifactFromUrlService } from "@/lib/artifacts/artifact-url-import";
import { canAccessArtifactExtension } from "@/lib/artifacts/artifact-extension-access";

// Split validation errors from the upstream-deferred not-yet-available
// stub. Callers can switch on `reason` without inferring "is this
// validation?" from blockedOn.
export type LibraryImportError =
  | {
      ok: false;
      reason: "invalid-url" | "invalid-extension" | "auth-required" | "access-denied";
      message: string;
    }
  | {
      ok: false;
      reason: "not-yet-available";
      message: string;
      /** Identifies the capability that must be available before this action can run. */
      blockedOn: string;
    }
  | {
      // URL import rejection reasons surfaced from `fetchUrlAsMarkdown`.
      // The chat / UI maps these to user-friendly copy; the server-action
      // just propagates the reason verbatim.
      ok: false;
      reason:
        | "userinfo-not-allowed"
        | "private-ip-blocked"
        | "dns-failed"
        | "redirect-loop"
        | "too-many-redirects"
        | "bad-status"
        | "content-too-large"
        | "fetch-failed"
        | "fetch-timeout"
        | "no-readable-content"
        | "unsupported-content-type";
      message: string;
      /** Final URL the redirect chain settled on (diagnostics). */
      finalUrl?: string;
    };

export type LibraryImportSuccess = {
  ok: true;
  artifactId: string;
};

export type LibraryImportResult = LibraryImportError | LibraryImportSuccess;

/**
 * `importArtifactFromUrl` is live.
 *
 * Pipeline:
 *   (1) AuthN/Z gate — requires an authenticated session with an
 *       active organization.
 *   (2) `importArtifactFromUrlService` (`@/lib/artifacts/artifact-url-import`)
 *       — composes `fetchUrlAsMarkdown` (SSRF-guarded fetch + cheerio
 *       HTML→Markdown) with `createSemanticArtifact`. The matcher
 *       auto-fires post-creation; classification is asynchronous.
 *   (3) `revalidatePath("/artifacts")` — refresh the library SSR
 *       cache so the new row shows up on next navigation.
 *
 * **Server-action signature is `(url: string)` — NO deps param**
 * The deps-injectable surface lives on the lib service
 * (`importArtifactFromUrlService`); tests import the service directly.
 * Exposing deps on the public action would let a crafted call weaken
 * numeric caps (maxRawBytes, fetchTimeoutMs, maxRedirects).
 */
export async function importArtifactFromUrl(
  url: string,
): Promise<LibraryImportResult> {
  // AuthN/Z gate. The fetch is server-side and could be used as an
  // SSRF lever by an unauthenticated caller; require auth even before
  // touching the network.
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  const actor = await getActorContext();
  if (!orgId || !actor) {
    return {
      ok: false,
      reason: "auth-required",
      message:
        "Add URL requires an authenticated session with an active organization.",
    };
  }

  // Fetch + normalize + write. All SSRF / redirect / size / content-
  // type guards live inside `fetchUrlAsMarkdown`; the writer call
  // lives inside `importArtifactFromUrlService` (lib-service layer —
  // single-write-path invariant respected).
  // No `deps` parameter passed through; resource caps stay
  // server-controlled, not LLM/caller-controlled.
  const result = await importArtifactFromUrlService({
    url,
    orgId,
    actor,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      finalUrl: result.finalUrl,
    };
  }

  revalidatePath("/artifacts");
  return { ok: true, artifactId: result.artifactId };
}

// Tighter scoped-package regex for artifact extension package names.
// Malformed names like `@cinatra-ai/-artifact` (empty inner segment) and
// `@cinatra-ai/foo/bar-artifact` (nested path) are invalid. Match the npm
// scoped-package shape: one segment of [a-z0-9][a-z0-9-]* between the
// scope and the -artifact suffix.
const CINATRA_ARTIFACT_PACKAGE_REGEX =
  /^@cinatra-ai\/[a-z0-9][a-z0-9-]*-artifact$/;

export async function createArtifactFromTemplate(
  extension: string,
): Promise<LibraryImportResult> {
  if (!CINATRA_ARTIFACT_PACKAGE_REGEX.test(extension)) {
    return {
      ok: false,
      reason: "invalid-extension",
      message: `Not a valid Cinatra artifact extension: "${extension}"`,
    };
  }

  // Materialize a starter representation via the deterministic no-skill
  // path. Chat-assistant authoring uses its own skill/MCP flow.
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  const actor = await getActorContext();
  if (!orgId || !actor) {
    return {
      ok: false,
      reason: "auth-required",
      message:
        "Create from Template requires an authenticated session with an active organization.",
    };
  }

  // Gate the deterministic template path on the same uniform
  // extension-access (execute) as the chat authoring emit — otherwise a caller
  // who knows a denied extension's package name could materialize a typed
  // artifact + semantic_assertion through this server action, bypassing the gate.
  if (!(await canAccessArtifactExtension(extension, actor, "execute"))) {
    return {
      ok: false,
      reason: "access-denied",
      message: `You do not have access to create artifacts with extension "${extension}".`,
    };
  }

  const result = await materializeArtifactFromTemplate({
    orgId,
    actor,
    extension,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: "invalid-extension",
      message: result.message,
    };
  }

  revalidatePath("/artifacts");
  return { ok: true, artifactId: result.artifactId };
}
