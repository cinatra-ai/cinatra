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
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  listInstalledMeaningTypesAcceptingMime,
  type InstalledMeaningType,
} from "@/lib/artifacts/installed-type-picker";
import { resolveActiveInstallForActor } from "@/lib/extension-install-resolution";
import { assertSemanticType } from "@/lib/artifacts/semantic-assertion-store";
import { planPromotionEntry } from "@/lib/artifacts/typed-promotion";
import {
  readArtifactForDetail,
  readArtifactForMeaningWrite,
} from "@/lib/artifacts/artifact-service";
import { buildTypeInstallRequestNotificationInput } from "@/lib/artifacts/type-install-request";
import {
  createNotificationForRecipient,
  type NotificationRecipient,
} from "@/lib/notifications";
import { resolveRecipientToUserIds } from "@cinatra-ai/notifications/server";
import { loadMarketplaceBrowse } from "@/lib/marketplace-browse";

/**
 * Apply the per-actor extension-ACCESS gate to raw §VI.1 picker candidates. The
 * pure candidate list reads the PROCESS-GLOBAL registries (object-type +
 * matcher-manifest channel), so an extension the acting user cannot address
 * would otherwise pass validation. The gate is CHANNEL-SPLIT so the picker's
 * "offered" set equals the surface that will actually PRESENT the meaning — no
 * dead picks, no phantom under-offers:
 *
 *   MATCHER-MANIFEST channel members (incl. hybrids that also define an
 *   own-namespace type) → gated SOLELY by `isArtifactExtensionWriteAllowed(pkg,
 *   orgId)`, the EXACT org-scoped gate the A6 presentation host resolves
 *   matcher-pack liveness through (`buildMatcherLiveExtensionSet`): org-owned or
 *   ambient LIVE `kind:"artifact"` install, or NO install row (ungoverned
 *   bundled/disk → live), cross-org-only → DENY. `resolveActiveInstallForActor`
 *   is deliberately NOT applied here — it is actor-scoped and not
 *   artifact-kind-filtered, so ANDing it in would REJECT A6-live packs the
 *   resolver will present (an ungoverned non-system pack, an owner-scoped org
 *   install), a phantom under-offer (codex seam-verdict finding 3). Matching the
 *   resolver's org gate EXACTLY makes offered == will-present.
 *
 *   NON-channel OBJECT-TYPE candidates → the A4 addressability gate, UNCHANGED:
 *   a host-declared SYSTEM extension OR an addressable ACTIVE install for this
 *   actor's scope (`resolveActiveInstallForActor`).
 */
async function filterCandidatesByActorAccess(
  candidates: InstalledMeaningType[],
  actor: ActorContext,
  orgId: string,
): Promise<InstalledMeaningType[]> {
  if (candidates.length === 0) return [];
  const { isSystemExtension } = await import(
    "@cinatra-ai/extensions/system-extension-inventory"
  );
  const { matcherManifestRegistry } = await import("@cinatra-ai/objects/registry");
  const channelPackages = new Set(
    matcherManifestRegistry.list().map((e) => e.packageName),
  );
  // The org-scoped write gate (== the A6 resolver) is loaded ONLY when a
  // candidate is actually a matcher-channel member, so the common object-type
  // path never pulls the server-only artifact-extension-access module.
  const orgWriteAllowed = candidates.some((c) => channelPackages.has(c.extension))
    ? (
        await import("@/lib/artifacts/artifact-extension-access")
      ).isArtifactExtensionWriteAllowed
    : null;
  const uniqueExtensions = [...new Set(candidates.map((c) => c.extension))];
  const accessible = new Set<string>();
  await Promise.all(
    uniqueExtensions.map(async (extension) => {
      if (channelPackages.has(extension)) {
        // Matcher-channel member: the A6 org-scoped write gate ALONE (offered ==
        // will-present). `orgWriteAllowed` is guaranteed non-null here (some
        // candidate is a channel member ⇒ the module was loaded).
        if (orgWriteAllowed && (await orgWriteAllowed(extension, orgId))) {
          accessible.add(extension);
        }
        return;
      }
      // Non-channel object-type candidate: the A4 addressability gate (unchanged).
      if (
        isSystemExtension(extension) ||
        (await resolveActiveInstallForActor(extension, actor)) !== null
      ) {
        accessible.add(extension);
      }
    }),
  );
  return candidates.filter((c) => accessible.has(c.extension));
}

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
  const raw = listInstalledMeaningTypesAcceptingMime(
    mime,
    objectType ? { excludeTypeId: objectType } : undefined,
  );
  // Per-actor extension-access gate: drop candidates whose defining extension
  // is not addressable by THIS actor (foreign-org / foreign-scope / torn-down),
  // and matcher-channel members not org-writable (== the A6 resolver's gate).
  const types = await filterCandidatesByActorAccess(raw, actor, orgId);
  return { ok: true, types, mime };
}

export type AssertMeaningResult =
  | {
      ok: true;
      /**
       * THE TYPED PROMOTION ROAD's outcome (enabler 0.14 of `PLAN: Agents
       * Lifecycle (C)`, cinatra#3028), when the confirmed extension is one the
       * MATCHER associated with this row.
       *
       * Reported, never silent, and never a condition of the confirmation:
       * writing the person's meaning is the thing they asked for, and a
       * promotion that could not run must say WHY rather than leave the surface
       * claiming a retype that did not happen. Absent when nothing about this
       * row was promotable.
       */
      promotion?:
        | {
            promoted: true;
            toType: string;
            representationRevisionId: string;
            /** Null when the revision was already present — a converging re-run
             *  of a promotion an earlier call left half-applied. */
            revision: number | null;
          }
        | { promoted: false; reason: string };
    }
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
  // WRITE-authority gate: asserting a user meaning MUTATES the artifact's
  // identity, so the acting user must pass canonical `object.update` — not
  // merely `object.read`. `readArtifactForMeaningWrite` layers the write gate
  // on the read gate (cinatra#1428): the uploader (user-owner short-circuit)
  // and org_admins pass; a mere READER of a shared org-visible artifact is
  // DENIED and can never write a meaning on someone else's upload.
  const read = readArtifactForMeaningWrite({ orgId, actor, artifactId: input.artifactId });
  if (read.kind === "not-found") {
    return { ok: false, reason: "not-found", message: "Artifact not found." };
  }
  if (read.kind === "denied") {
    return {
      ok: false,
      reason: "denied",
      message: "You do not have permission to change this artifact.",
    };
  }
  // Candidate validation (fail-closed): the chosen extension MUST be one of the
  // installed file-accepting types whose `accepts` admit the artifact's
  // SERVER-DERIVED MIME AND that are ADDRESSABLE by this actor — never a raw
  // client-supplied string. This closes an arbitrary / uninstalled / wrong-MIME
  // / foreign-scope extension being asserted through a crafted server-action
  // call; the MIME + base type are re-derived from the stored artifact, and the
  // per-actor extension-access gate drops types the actor cannot address.
  const { mime, objectType } = read.artifact;
  const raw = listInstalledMeaningTypesAcceptingMime(
    mime,
    objectType ? { excludeTypeId: objectType } : undefined,
  );
  const candidates = await filterCandidatesByActorAccess(raw, actor, orgId);
  if (!candidates.some((c) => c.extension === input.extension)) {
    // THE CONVERGING RE-CONFIRMATION, and the reason it lives HERE rather than
    // behind the candidate gate: the candidate list EXCLUDES every candidate of
    // the extension that defines the row's CURRENT type, so a row an earlier
    // confirmation already retyped can never reach the road again through the
    // gate above. That is exactly the row an interrupted promotion leaves —
    // retyped, with its promotion revision missing — so without this the
    // convergence the road promises is unreachable from the product.
    //
    // It completes and nothing else: the road itself still demands the matcher's
    // assertion at its threshold, so a row that merely CARRIES this extension's
    // type is refused there and this call falls through to the same
    // `invalid-type` it always answered. No meaning assertion is written — the
    // call that retyped the row wrote the person's, and a second identical
    // assertion would stack a duplicate for a choice already recorded.
    if (objectType && (await extensionDefinesType(input.extension, objectType))) {
      const completed = await promoteOnConfirmedMeaning({
        orgId,
        artifactId: input.artifactId,
        extension: input.extension,
        principalId: actor.principalId ?? null,
        userId: session?.user?.id ?? null,
      });
      if (completed?.promoted) {
        revalidatePath("/artifacts");
        return { ok: true, promotion: completed };
      }
    }
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

  // THE TYPED PROMOTION ROAD (enabler 0.14). The plan: "a matched base-type row
  // — an upload the matcher associated with an extension — is promoted into that
  // extension's own type as a new revision sharing the content, ON THE MATCHER'S
  // ASSERTION AT ITS THRESHOLD AND WITH THE PERSON'S CONFIRMATION WHERE THE
  // PRODUCT ALREADY ASKS FOR ONE."
  //
  // THIS IS THAT PLACE, and deliberately the only one: §VI.1's Confirm is where
  // the product already asks. No new confirmation surface is invented, and the
  // person's meaning assertion is written FIRST — the promotion rides a
  // confirmation that has already landed, so a promotion that refuses leaves the
  // meaning they chose intact.
  const promotion = await promoteOnConfirmedMeaning({
    orgId,
    artifactId: input.artifactId,
    extension: input.extension,
    principalId: actor.principalId ?? null,
    userId: session?.user?.id ?? null,
  });

  revalidatePath("/artifacts");
  return promotion ? { ok: true, promotion } : { ok: true };
}

/**
 * Does this extension's package define the type the row already carries?
 *
 * The one question the converging re-confirmation asks: it is what separates
 * "this row is already in the type this extension defines" (the interrupted
 * promotion's own row) from "this extension has nothing to do with this row".
 */
async function extensionDefinesType(extension: string, objectType: string): Promise<boolean> {
  try {
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    return objectTypeRegistry.getRegisteringPackage(objectType) === extension;
  } catch {
    return false;
  }
}

/**
 * Run the typed promotion road for a confirmation, or say why it did not run.
 *
 * Returns NULL when the road does not apply at all — the extension declares no
 * type of its own, so there is nothing to promote INTO and nothing worth
 * reporting on the surface. Every other outcome is reported: a refusal names its
 * reason, so "I confirmed and nothing was retyped" is answerable.
 *
 * BEST-EFFORT AROUND AN INFRASTRUCTURE FAILURE ONLY. A thrown store error is
 * reported as a refusal rather than failing the confirmation the person already
 * completed; a business refusal is a value from the road itself.
 */
async function promoteOnConfirmedMeaning(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  principalId: string | null;
  userId: string | null;
}): Promise<Exclude<Extract<AssertMeaningResult, { ok: true }>["promotion"], undefined> | null> {
  if (!input.userId) return null;
  try {
    const { matcherManifestRegistry, objectTypeRegistry } = await import(
      "@cinatra-ai/objects/registry"
    );
    const { semanticRendererRegistry } = await import(
      "@cinatra-ai/objects/artifact-renderer-registry"
    );
    // THE EXTENSION'S OWN TYPE: the one artifact type its package REGISTERED.
    // The count is not always one, and `planPromotionEntry` names every outcome
    // rather than folding them into one silence — because two very different
    // worlds both register zero types:
    //
    //   a PURE MATCHER PACK declares none, so the road does not apply; and
    //   a PACK WHOSE DECLARED TYPE NEVER REGISTERED — ownership is by namespace
    //   and its declared id sits in a namespace no installed package owns — is a
    //   broken installation whose display can never be reached at all.
    //
    // The second is what the wave-3 proof leg measured (cinatra#3091): a deck
    // confirmation that retyped nothing and reported nothing. It is separated
    // from the first by the pack's OWN registration state — a semantic display
    // registered for an object type no package registers.
    const owned = objectTypeRegistry
      .getTypesForPackage(input.extension)
      .map((typeId) => ({ typeId, def: objectTypeRegistry.resolve(typeId) }))
      .filter((t) => t.def?.isArtifact != null);
    const entryPlan = planPromotionEntry({
      ownedRegisteredTypes: owned.map((t) => t.typeId),
      shipsDisplayForUnregisteredType: semanticRendererRegistry
        .listByPackage(input.extension)
        .some((d) => objectTypeRegistry.getRegisteringPackage(d.objectTypeId) === null),
    });
    if (entryPlan.kind === "not-applicable") return null;
    if (entryPlan.kind === "refuse") return { promoted: false, reason: entryPlan.reason };
    const ownType = owned.find((t) => t.typeId === entryPlan.typeId)!;
    const acceptsMimes = ownType.def?.isArtifact?.accepts?.file?.mimeTypes ?? [];

    // THE THRESHOLD IS THE EXTENSION'S OWN, read from the same matcher channel
    // the matcher itself resolved it from — never a default invented here. A
    // package with no matcher declaration never matched this row, so the road
    // refuses on the missing assertion rather than on a fabricated threshold.
    const entry = matcherManifestRegistry
      .list()
      .find((e) => e.packageName === input.extension);
    if (!entry) return null;

    // The org-write kernel authority the canonical objects writer requires,
    // minted HERE from the acting session — the store leaf never mints one.
    const { verifySessionAuthority } = await import("@/lib/org-write/authority");
    const authority = await verifySessionAuthority(input.userId, input.orgId);
    const { promoteMatchedArtifactType } = await import(
      "@/lib/artifacts/typed-promotion-store"
    );
    const outcome = await promoteMatchedArtifactType({
      orgId: input.orgId,
      artifactId: input.artifactId,
      extension: input.extension,
      ownType: { typeId: ownType.typeId, acceptsMimes },
      threshold: entry.matcherConfidenceThreshold,
      confirmed: true,
      createdBy: input.principalId,
      actor: { userId: input.userId, orgId: input.orgId },
      authority,
    });
    return outcome.ok
      ? {
          promoted: true,
          toType: outcome.toType,
          representationRevisionId: outcome.representationRevisionId,
          revision: outcome.revision,
        }
      : { promoted: false, reason: outcome.reason };
  } catch {
    return { promoted: false, reason: "promotion-unavailable" };
  }
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
  | { ok: true; alreadyRequested: boolean }
  | { ok: false; reason: "auth-required" | "no-admins"; message: string };

/**
 * The §VII NON-admin one-click Request install (ruling 4). Notifies the platform
 * admins — pack, requester, marketplace deep link — and coalesces repeat clicks
 * onto one request per (org, requester, pack) via the occurrence dedupe key.
 * Real, not a placeholder; the admin completes the install from the notification.
 *
 * Honest outcomes:
 *   - `no-admins` — there is literally NO platform admin to receive the request,
 *     so the click leads nowhere. Surfaced DISTINCTLY (never a false ok:true):
 *     an empty `createNotificationForRecipient` result is AMBIGUOUS (it also
 *     means the occurrence dedupe coalesced a repeat request), so the admin
 *     roster is resolved independently UP FRONT to tell the two apart.
 *   - `ok, alreadyRequested:false` — a fresh admin bell row was written.
 *   - `ok, alreadyRequested:true`  — admins DID exist but the request was a
 *     repeat that coalesced onto the standing occurrence (still an honest
 *     success: the admins were already notified).
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
  // Resolve the admin roster ONCE. Zero admins ⇒ the click leads nowhere:
  // surface that distinctly. The SAME resolved roster is then threaded into the
  // create call (`recipientUserIds`) so the created-row count is derived from
  // this exact expansion — never a second, independent resolution that a
  // vanishing last-admin (or a defensive empty read) could turn into a false
  // "already requested" success (TOCTOU).
  const adminUserIds = await resolveRecipientToUserIds({ kind: "admins" });
  if (adminUserIds.length === 0) {
    return {
      ok: false,
      reason: "no-admins",
      message:
        "No platform administrators are available to receive this request. Contact your workspace owner to install the type.",
    };
  }
  const notification = buildTypeInstallRequestNotificationInput({
    orgId,
    requesterId,
    packageName: input.packageName,
    displayName: input.displayName,
    requesterLabel: session.user?.name ?? session.user?.email ?? undefined,
  });
  const created = await createNotificationForRecipient(
    { kind: "admins" } satisfies NotificationRecipient,
    notification,
    { recipientUserIds: adminUserIds },
  );
  // The roster was non-empty and used verbatim, so an empty result here can
  // ONLY mean the occurrence dedupe coalesced this repeat onto the standing
  // request — an honest success, not a vanished-recipient false positive.
  return { ok: true, alreadyRequested: created.length === 0 };
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
