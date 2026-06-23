"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceVendorApplicationApplyOutput,
  MarketplaceVendorApplicationStatusOutput,
} from "@cinatra-ai/marketplace-mcp-client";

import { requireAdminSession } from "@/lib/auth-session";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  decryptInstanceAttachSecret,
  CONSUMER_MARKETPLACE_TOKEN_AAD,
  CONSUMER_VERDACCIO_TOKEN_AAD,
  type ConsumerAttachment,
} from "@/lib/instance-identity-store";
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import { encryptSecret } from "@/lib/instance-secrets";
import { isGatekeptInstallEnabled } from "@/lib/gatekept-install";
import {
  resolveConsumerOrVendorMarketplaceToken,
  VendorCredentialsMissingError,
} from "@/lib/marketplace-credentials";
import { getMarketplaceTermsAcceptance } from "@/lib/marketplace-terms";
import { isTerminalAuthFailure } from "./vendor-application-cm-errors";

/**
 * Server actions for the "Become a vendor" UI on
 * `/configuration/environment?tab=registries`.
 *
 * Three actions land here:
 *
 *   1. applyVendorApplicationAction — opens a vendor application (free or
 *      commercial tier). Free tier auto-approves inline and returns the
 *      Verdaccio publish token, which we encrypt + persist into the
 *      vendor token slot (tokenCiphertext/tokenIv, AAD
 *      "vendor.token"). Commercial tier stays in `applied` state pending
 *      moderator review.
 *
 *   2. cancelVendorApplicationAction — operator-driven withdrawal of an
 *      open application. Releases the reservation row's active-status slot
 *      on the cm side and clears `vendorApplicationId` / resets
 *      `vendorState` to "none" locally.
 *
 *   3. refreshVendorApplicationStatusAction — re-fetches the current
 *      application state from cm and reconciles the local vendor* fields.
 *      Operator-triggered (button); the boot-time
 *      `ensureMarketplaceAttachment()` reconcile path handles automatic
 *      sync.
 */

const REGISTRIES_BASE = "/configuration/environment?tab=registries";

function redirectWithVendorError(message: string): never {
  redirect(`${REGISTRIES_BASE}&vendor_application_error=${encodeURIComponent(message.slice(0, 300))}`);
  throw new Error("unreachable");
}

function redirectWithVendorOk(okCode: string): never {
  redirect(`${REGISTRIES_BASE}&vendor_application_ok=${encodeURIComponent(okCode)}`);
  throw new Error("unreachable");
}

function resolveTokenOrFail(): string {
  const identity = readInstanceIdentity();
  if (!identity) {
    redirectWithVendorError("Instance identity is not configured. Run /setup/name first.");
  }
  try {
    return resolveConsumerOrVendorMarketplaceToken(identity);
  } catch (err) {
    if (err instanceof VendorCredentialsMissingError) {
      redirectWithVendorError(
        "Marketplace consumer attachment is missing. Wait for the boot-time attach hook " +
          "or restart the app to mint a marketplace bearer.",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. applyVendorApplicationAction
// ---------------------------------------------------------------------------

/**
 * Opens a vendor application. Free tier auto-approves inline; commercial
 * tier stays `applied` pending moderator review.
 *
 * Form fields:
 *   - tier           "free" | "commercial"
 *   - terms_version  semver-shaped string (server-validated against cm)
 *   - terms_digest   sha256 hex (server-validated against cm)
 *   - display_name   operator-supplied vendor display name
 *
 * On free-tier success, the response carries a `publish_token` — encrypt
 * with AAD "vendor.token" and persist into the vendor token slot
 * (tokenCiphertext/tokenIv). The commercial path persists vendor metadata
 * only; the publish token reaches the operator via a separate
 * `vendor_registry_token_rotate_self` call after approval.
 */
export async function applyVendorApplicationAction(formData: FormData): Promise<void> {
  await requireAdminSession();

  const tierRaw = String(formData.get("tier") ?? "").trim();
  if (tierRaw !== "free" && tierRaw !== "commercial") {
    redirectWithVendorError("Tier must be 'free' or 'commercial'.");
  }
  const tier = tierRaw as "free" | "commercial";

  const termsAccepted = formData.get("termsAccepted");
  if (termsAccepted !== "on" && termsAccepted !== "true") {
    redirectWithVendorError("You must accept the marketplace terms to apply as a vendor.");
  }

  const displayName = String(formData.get("display_name") ?? "").trim();
  if (!displayName) {
    redirectWithVendorError("Vendor display name is required.");
  }
  if (displayName.length > 190) {
    redirectWithVendorError("Vendor display name must be 190 characters or fewer.");
  }

  // terms_version + terms_digest are derived from the marketplace-terms helper
  // (operator-supplied env or sane defaults). cm server-validates these against
  // the canonical current terms — caller-supplied values that don't match get
  // rejected with TERMS_VERSION_STALE / TERMS_DIGEST_MISMATCH so the UI can
  // re-prompt with fresh terms.
  const acceptance = getMarketplaceTermsAcceptance();
  const termsVersion = String(formData.get("terms_version") ?? acceptance.termsVersion).trim();
  const termsDigest = String(formData.get("terms_digest") ?? acceptance.termsDigest).trim();

  const identity = readInstanceIdentity();
  if (!identity) {
    redirectWithVendorError("Instance identity is not configured. Run /setup/name first.");
  }
  const proposedScope = `@${identity.instanceNamespace}`;

  // Resolve the marketplace token + build the client BEFORE any local
  // state write. A missing token is a LOCAL precondition
  // failure that creates NO cm-side application row, so it must not leave a
  // false "applied" marker behind (which would hide the apply form with no
  // recovery path). All local preconditions run above this line.
  const token = resolveTokenOrFail();
  const client = createHttpMarketplaceMcpClient({ token });

  // application_id retry handling: cm relies on a stable
  // application_id for idempotent retry semantics. If a previous submit hit
  // a transient cm-side failure (broker unreachable, etc.) we MUST reuse
  // the same application_id on retry so cm matches the existing row
  // instead of creating a duplicate. Reuse when state is "applied" (open
  // application pending review or retry of a transient failure); otherwise
  // mint fresh.
  const reuseExisting =
    identity.vendorState === "applied" &&
    typeof identity.vendorApplicationId === "string" &&
    identity.vendorApplicationId.length > 0;
  const applicationId = reuseExisting
    ? (identity.vendorApplicationId as string)
    : randomUUID();

  // Capture prior markers so a structured-terms rejection (which creates NO
  // cm row — cm verifies terms before the INSERT) can be rolled back. Without
  // this rollback a false "applied" state would persist with no recovery path.
  //
  // Coalesce vendorState to a CONCRETE "none" rather than undefined: durable
  // fields are preserve-on-undefined at the write boundary, so writing
  // `vendorState: undefined` on rollback would leave the persist-first
  // "applied" marker in place — re-introducing the false-pending state. A
  // concrete "none" forces the field to actually clear.
  const priorVendorState: NonNullable<typeof identity.vendorState> =
    identity.vendorState ?? "none";
  const priorVendorApplicationId = identity.vendorApplicationId ?? null;
  // Captured for the rollback's success-detection: every cm-success write sets
  // `vendorScope` to the cm-confirmed `response.scope`, whereas the persist-first
  // stamp leaves it untouched. A change here therefore proves a concurrent
  // success committed (a real cm row exists) and must block the rollback.
  const priorVendorScope = identity.vendorScope ?? null;

  // Roll back the persist-first marker to the prior (concrete) state. Only the
  // FRESH case ever stamps the marker, so reuse-existing applications are left
  // untouched (their marker pre-dates this submit and must survive for retry).
  //
  // COMPARE-AND-CLEAR against the EXACT transient shape this invocation wrote.
  // We re-read inside the boundary and only clear when the row is still our own
  // un-advanced persist-first stamp on ALL of:
  //   - vendorApplicationId === our applicationId   (still our id)
  //   - vendorState === "applied"                   (not flipped to approved)
  //   - vendorApplicationRepairStuckAt == null       (no reconcile worker write)
  //   - vendorScope === priorVendorScope             (NO cm-success write landed)
  //
  // The last clause is the success guard. The cm-success branch is the ONLY
  // writer of `vendorScope = response.scope`; the persist-first stamp never
  // touches it. So if a CONCURRENT invocation (e.g. one that reused our id with
  // valid terms) successfully created the cm row, it will have advanced
  // `vendorScope`, and this rollback is blocked — we never erase a marker that
  // backs a real cm row. This closes the structured-terms + terminal-auth
  // rollback races regardless of why this invocation failed (no-row terms
  // rejection, terminal auth, etc.): a committed concurrent success always
  // moves at least one of these fields off the transient stamp shape.
  const rollbackPersistFirstMarker = (): void => {
    if (reuseExisting) {
      return;
    }
    const reverted = readInstanceIdentity();
    if (
      reverted &&
      reverted.vendorApplicationId === applicationId &&
      reverted.vendorState === "applied" &&
      (reverted.vendorApplicationRepairStuckAt ?? null) === null &&
      (reverted.vendorScope ?? null) === priorVendorScope
    ) {
      writeInstanceIdentity({
        ...reverted,
        vendorState: priorVendorState,
        vendorApplicationId: priorVendorApplicationId,
      });
      invalidateInstanceIdentityCache();
    }
  };

  if (!reuseExisting) {
    // PERSIST-FIRST defence: stamp vendorState='applied' +
    // vendorApplicationId BEFORE the cm call so a Next.js process crash
    // mid-call doesn't lose the idempotency marker — retry then reuses the
    // same application_id. On the success branch below this is overwritten
    // with the server-confirmed state; on a THROWN call the marker survives
    // (cm row may exist after a network failure → retry reuses); on a
    // structured TERMS_* rejection the marker is rolled back below (cm
    // created no row).
    writeInstanceIdentity({
      ...identity,
      vendorApplicationId: applicationId,
      vendorState: "applied",
      // A fresh application must never inherit a stale repair-stuck flag from
      // a prior application id. Reset to null on the persist-first write so a
      // subsequently-thrown cm call (which keeps this marker) doesn't make the
      // reconcile worker skip the fresh application forever.
      vendorApplicationRepairStuckAt: null,
    });
    invalidateInstanceIdentityCache();
  }

  // The cm ability returns a discriminated union — applied / approved / one
  // of two structured terms errors. We narrow before persisting.
  let response: MarketplaceVendorApplicationApplyOutput;
  try {
    response = await client.vendorApplicationApply({
      application_id: applicationId,
      proposed_scope: proposedScope,
      tier,
      terms_version: termsVersion,
      terms_digest: termsDigest,
      display_name: displayName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vendor-application] apply failed:", err);
    // A TERMINAL auth refusal (-32010 / "Unauthorized: User not authenticated")
    // is rejected at cm's auth middleware BEFORE any reservation row is created
    // — so NO cm row exists and retrying the same application_id can never
    // reconcile. Roll back the persist-first marker (fresh case only, mirroring
    // the structured-terms path below) so the operator isn't trapped in a false
    // "applied (pending review or recovery)" state that never clears.
    //
    // Any OTHER thrown error stays ambiguous: the cm row MAY exist (e.g. a
    // network failure after the INSERT committed server-side), so the marker
    // survives and a retry reuses the same application_id — do NOT roll back.
    if (isTerminalAuthFailure(err)) {
      rollbackPersistFirstMarker();
    }
    redirectWithVendorError(`Vendor application failed: ${message}`);
  }

  // Structured terms errors: cm signals stale terms / digest mismatch via the
  // `error_code` discriminator instead of throwing. cm verifies terms BEFORE
  // creating any reservation row, so NO cm-side application exists on these
  // paths — roll back the local persist-first marker (fresh case only) so the
  // operator isn't trapped in a false "applied" state, then re-prompt.
  if ("error_code" in response) {
    rollbackPersistFirstMarker();
    if (response.error_code === "TERMS_VERSION_STALE") {
      redirectWithVendorError(
        `Marketplace terms have been updated (current version: ${response.current_version}). ` +
          `Re-accept the latest terms at ${response.terms_url} and resubmit.`,
      );
    }
    redirectWithVendorError(
      `Marketplace terms digest does not match the canonical server-side digest. ` +
        `Re-fetch the latest terms body at ${response.terms_url} and resubmit.`,
    );
  }

  // Map cm's `state` to the local `VendorState` union. cm only returns
  // `applied` (commercial pending) or `approved` (free-tier inline) on the
  // success branch; `rejected` flows through the moderation path, never
  // through apply.
  const nextVendorState: "applied" | "approved" =
    response.state === "approved" ? "approved" : "applied";

  // Re-read RIGHT BEFORE writing so concurrent boot-hook writes
  // (consumerAttachment, vendor* reconciliation) are merged forward.
  const fresh = readInstanceIdentity() ?? identity;
  const nextIdentity = {
    ...fresh,
    vendorState: nextVendorState,
    vendorScope: response.scope,
    vendorApplicationId: response.application_id,
    // A (re)submitted application is freshly server-confirmed; any stuck flag
    // from a prior application must not carry over onto this id. The reconcile
    // worker / status refresh will re-set it if cm reports this one stuck.
    vendorApplicationRepairStuckAt: null,
  } as typeof fresh;

  // Free-tier inline auto-approve: encrypt + persist the Verdaccio publish
  // token into the existing vendor token slot. AAD "vendor.token"
  // matches the resolver's back-compat path so installs/publishes find it.
  //
  // Field name `publish_token` matches the cm-side `vendor_application_apply`
  // ability return shape (see VendorApplicationApply.php); only the register
  // ability uses `registry_token`. Reading the wrong key silently drops the
  // token on success and marks the instance approved without a stored
  // publish credential.
  if (
    response.state === "approved" &&
    response.publish_token &&
    typeof response.publish_token.plaintext_token === "string" &&
    response.publish_token.plaintext_token.length > 0
  ) {
    const enc = encryptSecret(response.publish_token.plaintext_token, "vendor.token");
    nextIdentity.tokenCiphertext = enc.ciphertext;
    nextIdentity.tokenIv = enc.iv;
    nextIdentity.tokenAlgo = "aes-256-gcm";
    nextIdentity.tokenUpdatedAt = response.decided_at;
  }

  writeInstanceIdentity(nextIdentity);
  invalidateInstanceIdentityCache();
  revalidatePath("/configuration/environment");
  redirectWithVendorOk("vendor-application-applied");
}

// ---------------------------------------------------------------------------
// 2. cancelVendorApplicationAction
// ---------------------------------------------------------------------------

/**
 * Operator-driven withdrawal of an open vendor application. Clears the
 * cm-side reservation row's active-status slot and resets the local
 * `vendorState` to "none" / clears `vendorApplicationId`.
 *
 * Form field:
 *   - application_id (optional) — falls back to identity.vendorApplicationId.
 */
export async function cancelVendorApplicationAction(formData: FormData): Promise<void> {
  await requireAdminSession();

  const identity = readInstanceIdentity();
  if (!identity) {
    redirectWithVendorError("Instance identity is not configured. Run /setup/name first.");
  }

  const applicationIdRaw = String(formData.get("application_id") ?? "").trim();
  const applicationId = applicationIdRaw || identity.vendorApplicationId || "";
  if (!applicationId) {
    redirectWithVendorError("No open vendor application to cancel.");
  }

  // Cancel must ALWAYS clear the local marker — even when cm is unreachable or
  // refuses the bearer. The cm `vendorApplicationCancel` is therefore
  // best-effort: a stranded marker most commonly arises in exactly the
  // situation where cm is down/unauthorized (see Defect 1), and gating the
  // local reset on a successful cm round-trip would leave the operator unable
  // to withdraw the application from the UI at all (the only recovery left
  // being a hand-edit of the `instance_identity` row). Releasing the cm-side
  // reservation slot is the happy path; on failure we log and fall through to
  // the local reset so withdrawal works offline. A reset boot-reconcile /
  // status refresh later reconciles any cm-side row that did survive.
  //
  // resolveTokenOrFail() is intentionally NOT used here: it redirects on a
  // missing token, which would block a local withdrawal. We resolve the bearer
  // defensively — a missing OR crypto-corrupted token must not stop the
  // operator from clearing a stranded marker — and only attempt the cm release
  // when a token is available. ALL failures (token resolution + the cm call
  // itself) are swallowed; we log and fall through to the local reset.
  try {
    let token: string | null = null;
    try {
      token = resolveConsumerOrVendorMarketplaceToken(identity);
    } catch (tokenErr) {
      console.warn(
        "[vendor-application] cancel: marketplace token unavailable; skipping " +
          "cm release and clearing the local marker only:",
        tokenErr,
      );
    }
    if (token) {
      const client = createHttpMarketplaceMcpClient({ token });
      await client.vendorApplicationCancel({ application_id: applicationId });
    }
  } catch (err) {
    // Best-effort: log and continue to the local reset so the operator can
    // always withdraw, even when cm is down/unauthorized.
    console.error(
      "[vendor-application] cancel: cm release failed (clearing local marker anyway):",
      err,
    );
  }

  // Re-read inside the persist boundary so concurrent writes (e.g. boot-hook
  // consumer-attachment reconcile) are merged forward.
  const fresh = readInstanceIdentity() ?? identity;
  writeInstanceIdentity({
    ...fresh,
    vendorState: "none",
    vendorApplicationId: null,
    // The application is gone; any stuck-recovery flag tied to it is moot.
    vendorApplicationRepairStuckAt: null,
  });
  invalidateInstanceIdentityCache();
  revalidatePath("/configuration/environment");
  redirectWithVendorOk("vendor-application-cancelled");
}

// ---------------------------------------------------------------------------
// 3. refreshVendorApplicationStatusAction
// ---------------------------------------------------------------------------

/**
 * Re-fetches the calling instance's vendor-application state from cm and
 * reconciles the local vendor* fields onto the identity row. Operator-
 * triggered via the registries-card "Refresh" button; the boot-time
 * `ensureMarketplaceAttachment()` reconcile path handles automatic sync.
 *
 * Non-blocking on cm errors — surfaces the error in the redirect but never
 * mutates local state on failure.
 */
export async function refreshVendorApplicationStatusAction(): Promise<void> {
  await requireAdminSession();

  const identity = readInstanceIdentity();
  if (!identity) {
    redirectWithVendorError("Instance identity is not configured. Run /setup/name first.");
  }

  const token = resolveTokenOrFail();
  const client = createHttpMarketplaceMcpClient({ token });

  let status: MarketplaceVendorApplicationStatusOutput;
  try {
    status = await client.vendorApplicationStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vendor-application] status refresh failed:", err);
    redirectWithVendorError(`Refresh vendor-application status failed: ${message}`);
  }

  const nextVendorState = (() => {
    if (status.state === "approved") return "approved" as const;
    if (status.state === "applied") return "applied" as const;
    if (status.state === "rejected") return "rejected" as const;
    // cm-side terminal states `cancelled` / `reset` AND the "no row"
    // sentinel "none" all collapse to local "none" per the
    // InstanceIdentity vendorState contract.
    return "none" as const;
  })();

  const fresh = readInstanceIdentity() ?? identity;

  // Mirror cm's recovery-stuck truth onto the local durable flag so the boot
  // reconcile + operator refresh stay in sync. cm only reports a stuck saga
  // while the application is still `applied`; once it flips to approved (or
  // any non-applied state) there is no in-flight recovery to be stuck on, so
  // clear the flag. The flag is tied to the application_id we mirror below —
  // if cm has no application (state "none"), there is nothing to be stuck on.
  const nextApplicationId = status.application_id ?? fresh.vendorApplicationId ?? null;
  const nextRepairStuckAt: string | null =
    nextVendorState === "applied" && typeof status.repair_stuck_at === "string"
      ? status.repair_stuck_at
      : null;

  writeInstanceIdentity({
    ...fresh,
    vendorState: nextVendorState,
    vendorScope: status.scope ?? fresh.vendorScope ?? null,
    vendorApplicationId: nextApplicationId,
    vendorApplicationRepairStuckAt: nextRepairStuckAt,
  });
  invalidateInstanceIdentityCache();
  revalidatePath("/configuration/environment");
  redirectWithVendorOk("vendor-application-refreshed");
}

// ---------------------------------------------------------------------------
// 4. refreshConsumerAttachmentAction (Refresh button)
// ---------------------------------------------------------------------------

/**
 * Operator-triggered refresh of the consumer attachment side of the
 * MarketplaceConnectionCard. Touches `lastRefreshedAt` and re-runs the
 * `vendor_application_status` round-trip so the operator sees current
 * cm-side state without waiting for the next 5-minute reconcile tick.
 *
 * Distinct from boot-time `ensureMarketplaceAttachment()` — that only
 * runs when `consumerAttachment === undefined` (first-time attach). This
 * action assumes attachment exists and just refreshes the timestamp +
 * triggers `refreshVendorApplicationStatusAction` semantics.
 */
export async function refreshConsumerAttachmentAction(): Promise<void> {
  await requireAdminSession();

  const identity = readInstanceIdentity();
  if (!identity) {
    redirectWithVendorError("Instance identity is not configured. Run /setup/name first.");
  }
  if (!identity.consumerAttachment) {
    redirectWithVendorError(
      "No consumer attachment to refresh. Wait for the boot-time attach hook or restart.",
    );
  }

  const fresh = readInstanceIdentity() ?? identity;
  const nowIso = new Date().toISOString();
  const existing = fresh.consumerAttachment as ConsumerAttachment;
  writeInstanceIdentity({
    ...fresh,
    consumerAttachment: {
      ...existing,
      lastRefreshedAt: nowIso,
    },
  });
  invalidateInstanceIdentityCache();
  revalidatePath("/configuration/environment");
  redirectWithVendorOk("consumer-attachment-refreshed");
}

// ---------------------------------------------------------------------------
// 5. rotateConsumerTokenAction (Rotate consumer token)
// ---------------------------------------------------------------------------

/**
 * Re-runs `instance_attach_self` against cm to mint fresh marketplace +
 * verdaccio-read consumer tokens. The cm-side ability is idempotent on
 * `instance_id` + `instance_attach_secret` — re-calling rotates the
 * tokens without creating a new attachment row.
 */
export async function rotateConsumerTokenAction(): Promise<void> {
  await requireAdminSession();

  const identity = readInstanceIdentity();
  if (!identity) {
    redirectWithVendorError("Instance identity is not configured. Run /setup/name first.");
  }
  if (
    !identity.instanceId ||
    !identity.instanceAttachSecretCiphertext ||
    !identity.instanceAttachSecretIv ||
    identity.instanceAttachSecretAlgo !== "aes-256-gcm"
  ) {
    redirectWithVendorError(
      "Instance attach secret is not provisioned. Cannot rotate consumer token.",
    );
  }

  let plaintextSecret: string;
  try {
    plaintextSecret = decryptInstanceAttachSecret(identity);
  } catch (err) {
    console.error("[vendor-application] decrypt instanceAttachSecret failed:", err);
    redirectWithVendorError("Could not decrypt the instance attach secret to rotate the token.");
  }

  try {
    const gatekept = isGatekeptInstallEnabled();
    // `instance_attach_self` is PRINCIPAL_PUBLIC + auth'd by the proof-of-
    // ownership secret, so the bearer is intentionally empty here.
    const client = createHttpMarketplaceMcpClient({});
    const out = await client.instanceAttachSelf({
      instance_id: identity.instanceId,
      instance_attach_secret: plaintextSecret,
      display_name: identity.instanceDisplayName,
      // Only declare gatekept-capability when the master flag is ON.
      ...(gatekept ? { gatekept_install: true } : {}),
    });

    const marketplaceEnc = encryptSecret(out.marketplace_token, CONSUMER_MARKETPLACE_TOKEN_AAD);
    const nowIso = new Date().toISOString();

    const fresh = readInstanceIdentity() ?? identity;
    const existing = (fresh.consumerAttachment ?? {}) as Partial<ConsumerAttachment>;
    const base: ConsumerAttachment = {
      instanceIdAtAttach: identity.instanceId,
      attachedAt: existing.attachedAt ?? out.attached_at ?? nowIso,
      lastRefreshedAt: nowIso,
      marketplaceUsername: out.marketplace_username,
      // Omitted by the marketplace in gatekept mode (no read principal).
      verdaccioUsername: out.verdaccio_username ?? "",
      marketplaceTokenCiphertext: marketplaceEnc.ciphertext,
      marketplaceTokenIv: marketplaceEnc.iv,
      marketplaceTokenAlgo: "aes-256-gcm",
    };

    const readToken = out.verdaccio_read_token;
    const hasReadToken = typeof readToken === "string" && readToken.length > 0;

    let nextAttachment: ConsumerAttachment;
    if (hasReadToken) {
      // Legacy direct-read path: store the read-token fields exactly as before.
      const verdaccioEnc = encryptSecret(readToken, CONSUMER_VERDACCIO_TOKEN_AAD);
      nextAttachment = {
        ...base,
        verdaccioReadTokenCiphertext: verdaccioEnc.ciphertext,
        verdaccioReadTokenIv: verdaccioEnc.iv,
        verdaccioReadTokenAlgo: "aes-256-gcm",
      };
    } else if (!gatekept) {
      // Fail-closed: a flag-OFF instance MUST receive the read token. Surface
      // the failure rather than persisting a tokenless attachment.
      throw new Error(
        "instance_attach_self returned no verdaccio_read_token while " +
          "gatekept install is OFF. Cannot rotate the consumer token without " +
          "the deployment-wide Verdaccio read token.",
      );
    } else {
      // Gatekept mode: sanitized attachment with no read-token fields.
      nextAttachment = base;
    }
    writeInstanceIdentity({ ...fresh, consumerAttachment: nextAttachment });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vendor-application] rotateConsumerToken failed:", err);
    redirectWithVendorError(`Rotate consumer token failed: ${message}`);
  }

  invalidateInstanceIdentityCache();
  revalidatePath("/configuration/environment");
  redirectWithVendorOk("consumer-token-rotated");
}
