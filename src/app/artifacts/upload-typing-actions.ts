"use server";

// ---------------------------------------------------------------------------
// Server-action surface for the /artifacts library UPLOAD-TYPING affordances
// (epic #1883 slice A4, spec design@16efd8d2 `specs/app-artifacts.html`
// §VI Upload & typing + §VII inline marketplace).
//
// The upload itself (MIME-base typing + refusal-with-recourse) is the existing
// `POST /api/artifacts/upload` route (A1/A2). THESE actions cover the follow-on
// affordances the library surface drives after a base-typed row lands:
//
//   - listInstalledTypesAcceptingMime — the §VI.1 picker's candidate list:
//     installed, file-accepting types whose `accepts` admit the detected MIME.
//   - assertUploadMeaning — the §VI.1 CONFIRM: write a USER-sourced meaning
//     assertion (rank-3, outranks matcher/agent) against the chosen type's
//     defining extension.
//   - listArtifactMarketplacePacks — the §VII marketplace tab's catalog:
//     kind:"artifact" packs from the public storefront browse.
//   - requestTypeInstall — the §VII NON-admin one-click Request install: an
//     occurrence-deduped admin notification (ruling 4).
//   - installArtifactPackInline — the §VII ADMIN inline install: reuses the
//     canonical secure install CTA (`installExtensionPackageFormAction`) but
//     intercepts its terminal redirect so the upload context is preserved
//     (non-redirecting per §VII), then re-warms the object-type registry so the
//     new type is selectable in the picker.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";

import {
  getAuthSession,
  getActorContext,
  isPlatformAdmin,
} from "@/lib/auth-session";
import {
  listInstalledMeaningTypesAcceptingMime,
  type InstalledMeaningType,
} from "@/lib/artifacts/installed-type-picker";
import { assertSemanticType } from "@/lib/artifacts/semantic-assertion-store";
import { readArtifactForDetail } from "@/lib/artifacts/artifact-service";
import { buildTypeInstallRequestNotificationInput } from "@/lib/artifacts/type-install-request";
import {
  createNotificationForRecipient,
  type NotificationRecipient,
} from "@/lib/notifications";
import { loadMarketplaceBrowse } from "@/lib/marketplace-browse";

export type ArtifactMarketplacePack = {
  packageName: string;
  version: string;
  displayName: string;
  description: string | null;
};

export type ListTypesResult =
  | { ok: true; types: InstalledMeaningType[]; mime: string }
  | { ok: false; reason: "auth-required" | "not-found" | "denied" };

/**
 * The §VI.1 picker candidate list, resolved for ONE artifact. The artifact's
 * MIME + base type are re-derived SERVER-SIDE from the stored artifact (never
 * trusted from the client, which only knows the browser-declared Content-Type):
 * the candidates are the installed file-accepting types whose `accepts` admit
 * that authoritative MIME, minus the artifact's own base type (re-asserting the
 * format base as a meaning is a no-op). Gated on the acting user's read of the
 * artifact.
 */
export async function listInstalledTypesForArtifact(
  artifactId: string,
): Promise<ListTypesResult> {
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  const actor = await getActorContext();
  if (!orgId || !actor) return { ok: false, reason: "auth-required" };
  const read = readArtifactForDetail({ orgId, actor, artifactId });
  if (read.kind === "not-found") return { ok: false, reason: "not-found" };
  if (read.kind === "denied") return { ok: false, reason: "denied" };
  const { mime, objectType } = read.artifact;
  const types = listInstalledMeaningTypesAcceptingMime(
    mime,
    objectType ? { excludeTypeId: objectType } : undefined,
  );
  return { ok: true, types, mime };
}

export type AssertMeaningResult =
  | { ok: true }
  | {
      ok: false;
      reason: "auth-required" | "not-found" | "denied" | "invalid-type" | "blocked";
      message: string;
    };

/**
 * The §VI.1 CONFIRM — write a USER-sourced meaning assertion (the highest-ranked
 * identity in Renderer dispatch §III) against the chosen type's DEFINING
 * extension. Gated on the acting user's read of the artifact (they own the
 * upload). The base (format axis) is untouched — the picker never re-types.
 */
export async function assertUploadMeaning(input: {
  artifactId: string;
  extension: string;
}): Promise<AssertMeaningResult> {
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  const actor = await getActorContext();
  if (!orgId || !actor) {
    return {
      ok: false,
      reason: "auth-required",
      message: "Asserting a meaning requires an authenticated session.",
    };
  }
  // Access gate: the acting user must be able to READ the artifact.
  const read = readArtifactForDetail({ orgId, actor, artifactId: input.artifactId });
  if (read.kind === "not-found") {
    return { ok: false, reason: "not-found", message: "Artifact not found." };
  }
  if (read.kind === "denied") {
    return {
      ok: false,
      reason: "denied",
      message: "You do not have access to this artifact.",
    };
  }
  // Candidate validation (fail-closed): the chosen extension MUST be one of the
  // installed file-accepting types whose `accepts` admit the artifact's
  // SERVER-DERIVED MIME — never a raw client-supplied string. This closes an
  // arbitrary / uninstalled / wrong-MIME / cross-org extension being asserted
  // through a crafted server-action call; the MIME + base type are re-derived
  // from the stored artifact, not trusted from the client.
  const { mime, objectType } = read.artifact;
  const candidates = listInstalledMeaningTypesAcceptingMime(
    mime,
    objectType ? { excludeTypeId: objectType } : undefined,
  );
  if (!candidates.some((c) => c.extension === input.extension)) {
    return {
      ok: false,
      reason: "invalid-type",
      message:
        "That type is not an installed type that accepts this file — refresh and pick again.",
    };
  }
  const result = assertSemanticType({
    orgId,
    artifactId: input.artifactId,
    extension: input.extension,
    assertedBy: "user",
    principal: actor.principalId ?? null,
  });
  if (result.blockedByPrecedence) {
    // A user assertion is rank-3 (the ceiling) so precedence should never block
    // it, but surface honestly rather than claim success on a no-op insert.
    return {
      ok: false,
      reason: "blocked",
      message: "A higher-ranked meaning already applies to this artifact.",
    };
  }
  revalidatePath("/artifacts");
  return { ok: true };
}

/**
 * The §VII marketplace tab catalog — kind:"artifact" packs from the public
 * storefront browse (the storefront itself is Application Design — Marketplace).
 * `registryConnected` drives the not-connected empty state; the accepts-narrowing
 * label is presentational (the public browse card carries no per-type accepts).
 */
export async function listArtifactMarketplacePacks(): Promise<{
  ok: true;
  packs: ArtifactMarketplacePack[];
  registryConnected: boolean;
  canInstall: boolean;
} | { ok: false; reason: "auth-required" }> {
  const session = await getAuthSession();
  if (!session?.session?.activeOrganizationId) {
    return { ok: false, reason: "auth-required" };
  }
  const browse = await loadMarketplaceBrowse();
  const packs: ArtifactMarketplacePack[] = browse.cards
    .filter((c) => c.kindSlug === "artifact")
    .map((c) => ({
      packageName: c.packageName,
      version: c.packageVersion,
      displayName: c.displayName,
      description: c.description,
    }));
  return {
    ok: true,
    packs,
    registryConnected: browse.registryConnected,
    canInstall: isPlatformAdmin(session),
  };
}

export type RequestInstallResult =
  | { ok: true }
  | { ok: false; reason: "auth-required"; message: string };

/**
 * The §VII NON-admin one-click Request install (ruling 4). Notifies the platform
 * admins — pack, requester, marketplace deep link — and coalesces repeat clicks
 * onto one request per (requester, pack) via the occurrence dedupe key. Real,
 * not a placeholder; the admin completes the install from the notification.
 */
export async function requestTypeInstall(input: {
  packageName: string;
  displayName?: string;
}): Promise<RequestInstallResult> {
  const session = await getAuthSession();
  const requesterId = session?.user?.id;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!orgId || !requesterId) {
    return {
      ok: false,
      reason: "auth-required",
      message: "Requesting an install requires an authenticated session.",
    };
  }
  const notification = buildTypeInstallRequestNotificationInput({
    orgId,
    requesterId,
    packageName: input.packageName,
    displayName: input.displayName,
    requesterLabel: session.user?.name ?? session.user?.email ?? undefined,
  });
  await createNotificationForRecipient(
    { kind: "admins" } satisfies NotificationRecipient,
    notification,
  );
  return { ok: true };
}

export type InstallPackResult =
  | { ok: true }
  | { ok: false; reason: "not-admin" | "install-failed"; message: string };

/**
 * The §VII ADMIN inline install. Reuses the canonical, secure marketplace
 * install CTA (`installExtensionPackageFormAction` — admin gate, access-target
 * authorization + persistence, dependency-batch install) VERBATIM, but the
 * picker context must be preserved (§VII "without a redirect"), so we intercept
 * the action's terminal `redirect()` (a NEXT_REDIRECT sentinel = SUCCESS) and
 * stay inline. On success the object-type registry is re-warmed so the new type
 * is immediately selectable in the picker (§VII "the picker refreshes to include
 * it"). A returned result object is a typed FAILURE surfaced honestly.
 *
 * `accessTarget` is the §VII install-scope choice; artifact is an install-access
 * kind, so the reused action REQUIRES it (fail-closed) — never a silent grant.
 */
export async function installArtifactPackInline(input: {
  packageName: string;
  version: string;
  accessTarget: {
    level: "organization" | "team" | "project" | "workspace" | "admin";
    id: string;
  };
}): Promise<InstallPackResult> {
  const session = await getAuthSession();
  if (!isPlatformAdmin(session)) {
    return {
      ok: false,
      reason: "not-admin",
      message: "Installing a type is platform-admin-only.",
    };
  }
  const { installExtensionPackageFormAction } = await import(
    "@cinatra-ai/extensions/actions"
  );
  try {
    const result = await installExtensionPackageFormAction({
      packageName: input.packageName,
      packageVersion: input.version,
      accessTarget: input.accessTarget,
    });
    // A returned result object means the action did NOT redirect → failure.
    if (result && typeof result === "object" && "ok" in result && !result.ok) {
      return {
        ok: false,
        reason: "install-failed",
        message: "The install did not complete. Try again from the marketplace.",
      };
    }
    // No throw, no failure object → treat as success (defensive; the action
    // normally redirects on success, handled in the catch below).
  } catch (err) {
    // The canonical action redirect()s on SUCCESS — a NEXT_REDIRECT sentinel.
    // Intercept it so the upload/picker context is preserved (non-redirecting
    // inline install per §VII). Anything else is a real failure.
    if (!isNextRedirectError(err)) {
      return {
        ok: false,
        reason: "install-failed",
        message: err instanceof Error ? err.message : "The install failed.",
      };
    }
  }
  // Re-warm the in-process object-type registry so the freshly-installed type's
  // rows resolve and it becomes selectable in the §VI.1 picker on next open.
  try {
    const { registerAllObjectTypes } = await import(
      "@/lib/register-all-object-types"
    );
    registerAllObjectTypes();
  } catch {
    // A re-warm miss is non-fatal: the type is installed; a page reload picks it
    // up. Never turn a successful install into an error over the re-warm.
  }
  revalidatePath("/artifacts");
  return { ok: true };
}

/** Next's `redirect()` throws an error whose `digest` starts with
 *  `NEXT_REDIRECT`. Detect it structurally (same idiom as the marketplace
 *  install form's redirect-sentinel re-throw) so a SUCCESS redirect is not
 *  misread as an install failure. */
function isNextRedirectError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
