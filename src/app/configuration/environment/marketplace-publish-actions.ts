// SPDX-License-Identifier: LicenseRef-Cinatra-Proprietary
"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceMcpClient,
  MarketplaceVendorGetSelfOutput,
  MarketplaceVendorRegisterSelfOutput,
  MarketplaceVendorVisibility,
} from "@cinatra-ai/marketplace-mcp-client";

import { requireAdminSession } from "@/lib/auth-session";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
} from "@/lib/instance-identity-store";
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import { encryptSecret } from "@/lib/instance-secrets";
import { getMarketplaceTermsAcceptance } from "@/lib/marketplace-terms";
import { reconcileRemoteFromVendorGet, reconcileRemoteOnFailure } from "@/lib/marketplace-reconcile";
import { detectMarketplaceEnvConflict } from "@/lib/marketplace-env-conflict";
import { withInstanceIdentityWriteLock } from "@/lib/instance-identity-write-lock";

/**
 * Server actions for the marketplace-governed Registries surface at
 * `/configuration/environment?tab=registries`.
 *
 * Post-P6a-2b the actions speak ONLY the live self-service abilities:
 *   - `requestMarketplacePublishAction` → `vendor_register_self`
 *   - `readMarketplaceVendorStatus`     → `vendor_get_self`
 *   - `setMarketplaceProfileVisibilityAction` → `vendor_profile_visibility_set`
 *   - `rotateMarketplaceRegistryTokenAction`   → `vendor_registry_token_rotate_self`
 *
 * Concurrency model:
 *   Every operation that ROTATES the marketplace registry token OR writes
 *   `instance_identity` runs inside {@see withTokenWriteLock}. The lock is
 *   held across the remote MCP call AND the local persist, so two concurrent
 *   rotators are fully serialised — the DB cannot end up with a token the
 *   marketplace already revoked. Non-rotate writes (status reconcile) take
 *   the same lock and use **patch-style merges** (only the `registries.remote`
 *   slot) so they cannot clobber a freshly rotated `tokenCiphertext`.
 *
 *   Multi-process serialisation (a true DB-level advisory lock or SQL CAS)
 *   is a follow-up; the per-process lock closes the realistic intra-process
 *   race, and admin actions are admin-rate.
 */

function resolveInstanceToken(): string | undefined {
  return process.env.MARKETPLACE_INSTANCE_TOKEN;
}

function abortOnConflict(redirectPath: string): void {
  const conflict = detectMarketplaceEnvConflict();
  if (conflict) {
    const encoded = encodeURIComponent(conflict.reason.slice(0, 300));
    redirect(`${redirectPath}&env_conflict=1&detail=${encoded}`);
  }
}

/** Shared lock — see `@/lib/instance-identity-write-lock` for the rationale. */
const withTokenWriteLock = withInstanceIdentityWriteLock;

/** The status pane consumes a flat shape; this maps `vendor_get_self`. */
export interface MarketplaceVendorStatusView {
  namespace: string | null;
  state: string;
  tier: string | null;
  profileVisibility: string;
  publishedCount: number;
  hasRegistryToken: boolean;
  registryUrl: string;
}

function toStatusView(record: MarketplaceVendorGetSelfOutput): MarketplaceVendorStatusView {
  return {
    namespace: record.namespace,
    state: record.state,
    tier: record.tier,
    profileVisibility: record.profile_visibility,
    publishedCount: record.published_count,
    hasRegistryToken: record.has_registry_token,
    registryUrl: record.registry_url,
  };
}

/**
 * Inside-the-lock helper: ensure a usable plaintext registry token by calling
 * the marketplace. Returns `{plaintext, tokenUpdatedAt}` or throws. Must be
 * called INSIDE {@see withTokenWriteLock} so the remote rotate (when it
 * fires) is serialised against other rotators.
 */
async function ensurePlaintextTokenLocked(
  client: MarketplaceMcpClient,
  registered: MarketplaceVendorRegisterSelfOutput,
): Promise<{ plaintext: string; tokenUpdatedAt: string }> {
  if (registered.registry_token?.plaintext_token) {
    // Register doesn't return a created_at on the token; use now() as a
    // monotonic-ish marker. (Multiple rotates inside the lock are still
    // strictly ordered because remote calls happen sequentially here.)
    return {
      plaintext: registered.registry_token.plaintext_token,
      tokenUpdatedAt: new Date().toISOString(),
    };
  }
  const rotated = await client.vendorRegistryTokenRotateSelf();
  return { plaintext: rotated.plaintext_token, tokenUpdatedAt: rotated.created_at };
}

/**
 * Free-vendor self-registration triggered from the registries card. The
 * namespace IS the instance namespace; the only form input is the ToS
 * checkbox. The entire flow — register → recover token if null → reconcile
 * → encrypt + write — runs inside the identity-write lock so a concurrent
 * rotation can't interleave between the marketplace call and our persist.
 */
export async function requestMarketplacePublishAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  abortOnConflict("/configuration/environment?tab=registries&publish_error=env_conflict");

  if (formData.get("termsAccepted") !== "on") {
    redirect("/configuration/environment?tab=registries&publish_error=terms_not_accepted");
  }
  if (!resolveInstanceToken()) {
    redirect("/configuration/environment?tab=registries&publish_error=marketplace_unavailable");
  }
  if (!process.env.CINATRA_ENCRYPTION_KEY?.trim()) {
    redirect("/configuration/environment?tab=registries&publish_error=encryption_key_unset");
  }

  const client = createHttpMarketplaceMcpClient({ token: resolveInstanceToken() });
  const terms = getMarketplaceTermsAcceptance();

  let outcome: { ok: true; namespace: string } | { ok: false; code: string; detail?: string };
  try {
    outcome = await withTokenWriteLock(async () => {
      const identity = readInstanceIdentity();
      if (!identity) {
        return { ok: false, code: "instance_not_configured" } as const;
      }
      const namespace = `@${identity.instanceNamespace}`;

      const registered = await client.vendorRegisterSelf({
        namespace,
        terms_version: terms.termsVersion,
        terms_digest:  terms.termsDigest,
        terms_url:     terms.termsUrl,
        display_name:  identity.instanceDisplayName,
      });
      const token = await ensurePlaintextTokenLocked(client, registered);

      // Re-read identity RIGHT BEFORE the write so writes from OTHER modules
      // (e.g. markFirstPublishedIfCurrentScope OR a concurrent registries.remote
      // update from network/actions.ts / registry-poll-job.ts) that happened
      // during the remote calls are merged forward, not reverted. Reconcile
      // the marketplace state onto `fresh.registries.remote` so the merge base
      // is the latest persisted state, not the pre-HTTP snapshot.
      const fresh = readInstanceIdentity() ?? identity;
      const reconciledRemote = reconcileRemoteFromVendorGet({
        previous: fresh.registries?.remote ?? undefined,
        vendor: {
          vendor_id: registered.vendor_id,
          namespace: registered.namespace,
          tier: registered.tier,
          state: registered.state,
          profile_visibility: registered.profile_visibility,
          published_count: registered.published_count,
          has_registry_token: true,
          registry_url: registered.registry_url,
        },
        namespace,
      });
      const tokenEnc = encryptSecret(token.plaintext, "vendor.token");
      const passwordEnc = fresh.passwordCiphertext
        ? { ciphertext: fresh.passwordCiphertext, iv: fresh.passwordIv }
        : (() => {
            const p = encryptSecret(randomBytes(32).toString("base64url"), "vendor.password");
            return { ciphertext: p.ciphertext, iv: p.iv };
          })();

      writeInstanceIdentity({
        ...fresh,
        tokenCiphertext: tokenEnc.ciphertext,
        tokenIv: tokenEnc.iv,
        tokenAlgo: "aes-256-gcm",
        tokenUpdatedAt: token.tokenUpdatedAt,
        passwordCiphertext: passwordEnc.ciphertext,
        passwordIv: passwordEnc.iv,
        registryUrl: registered.registry_url || fresh.registryUrl,
        registries: { ...(fresh.registries ?? {}), remote: reconciledRemote },
      });
      invalidateInstanceIdentityCache();
      return { ok: true, namespace } as const;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const encoded = encodeURIComponent(message.slice(0, 200));
    redirect(`/configuration/environment?tab=registries&publish_error=submit_failed&detail=${encoded}`);
  }

  if (!outcome.ok) {
    redirect(`/configuration/environment?tab=registries&publish_error=${outcome.code}`);
  }
  revalidatePath("/configuration/environment");
  redirect(`/configuration/environment?tab=registries&publish_ok=1&namespace=${encodeURIComponent(outcome.namespace)}`);
}

/**
 * Status poll — returns the calling instance's own vendor record from the
 * marketplace, or null when the marketplace is unreachable / not yet wired.
 * Never throws (the registries tab renders the not-connected state instead).
 *
 * Concurrency: the marketplace call is non-mutating and runs OUTSIDE the
 * write lock. The on-success reconcile write IS inside the lock and is
 * **patch-style** — it only updates `registries.remote`, never the token
 * fields — so it cannot roll back a token a concurrent rotation just wrote.
 */
export async function readMarketplaceVendorStatus(): Promise<MarketplaceVendorStatusView | null> {
  if (!resolveInstanceToken() || detectMarketplaceEnvConflict()) {
    return null;
  }
  const client = createHttpMarketplaceMcpClient({ token: resolveInstanceToken() });
  try {
    const record = await client.vendorGetSelf();
    await withTokenWriteLock(async () => {
      const current = readInstanceIdentity();
      if (!current) return;
      const namespace = `@${current.instanceNamespace}`;
      const reconciled = reconcileRemoteFromVendorGet({
        previous: current.registries?.remote ?? undefined,
        vendor: record,
        namespace,
      });
      writeInstanceIdentity({
        ...current, // re-read INSIDE the lock so token fields can't be stale
        registries: { ...(current.registries ?? {}), remote: reconciled },
      });
      invalidateInstanceIdentityCache();
    });
    return toStatusView(record);
  } catch (error) {
    await withTokenWriteLock(async () => {
      const current = readInstanceIdentity();
      if (!current || !current.registries?.remote) return;
      const namespace = `@${current.instanceNamespace}`;
      const degraded = reconcileRemoteOnFailure({
        previous: current.registries.remote,
        error: error instanceof Error ? error.message : String(error),
        namespace,
      });
      if (degraded) {
        writeInstanceIdentity({
          ...current,
          registries: { ...(current.registries ?? {}), remote: degraded },
        });
        invalidateInstanceIdentityCache();
      }
    });
    return null;
  }
}

/**
 * Operator-driven visibility toggle. Stateless wrt `instance_identity` — no
 * local write is needed because the marketplace state surfaces via the next
 * `readMarketplaceVendorStatus` reconcile.
 */
export async function setMarketplaceProfileVisibilityAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  abortOnConflict("/configuration/environment?tab=registries&visibility_error=env_conflict");

  const visibilityRaw = String(formData.get("visibility") ?? "").trim();
  if (visibilityRaw !== "private" && visibilityRaw !== "public") {
    redirect("/configuration/environment?tab=registries&visibility_error=invalid");
  }
  const visibility = visibilityRaw as MarketplaceVendorVisibility;

  const client = createHttpMarketplaceMcpClient({ token: resolveInstanceToken() });
  try {
    await client.vendorProfileVisibilitySet({ visibility });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const encoded = encodeURIComponent(message.slice(0, 200));
    redirect(`/configuration/environment?tab=registries&visibility_error=set_failed&detail=${encoded}`);
  }

  revalidatePath("/configuration/environment");
  redirect(`/configuration/environment?tab=registries&visibility_ok=1&visibility=${visibility}`);
}

/**
 * Self-service rotation of the instance's registry bearer. The remote rotate
 * AND the local persist run inside the identity-write lock — two concurrent
 * rotators are fully serialised (A holds the lock through both its remote
 * call and its DB write before B even calls vendor_registry_token_rotate_self),
 * so the DB can never end up with a marketplace-revoked token.
 */
export async function rotateMarketplaceRegistryTokenAction(): Promise<void> {
  await requireAdminSession();
  abortOnConflict("/configuration/environment?tab=registries&rotate_error=env_conflict");

  if (!resolveInstanceToken()) {
    redirect("/configuration/environment?tab=registries&rotate_error=marketplace_unavailable");
  }
  if (!process.env.CINATRA_ENCRYPTION_KEY?.trim()) {
    redirect("/configuration/environment?tab=registries&rotate_error=encryption_key_unset");
  }

  const client = createHttpMarketplaceMcpClient({ token: resolveInstanceToken() });

  let outcome: { ok: true } | { ok: false; code: string };
  try {
    outcome = await withTokenWriteLock(async () => {
      const identity = readInstanceIdentity();
      if (!identity) {
        return { ok: false, code: "instance_not_configured" } as const;
      }
      const namespace = `@${identity.instanceNamespace}`;

      // Remote rotate INSIDE the lock — serialises across concurrent rotators.
      const rotated = await client.vendorRegistryTokenRotateSelf();

      // Opportunistic remote reconcile — cache the record now; we reconcile
      // AFTER the second readInstanceIdentity so the merge base is the latest
      // persisted state (covers concurrent writes to registries.remote from
      // other modules during the HTTP wait, e.g. network/actions.ts).
      let remoteRecord: MarketplaceVendorGetSelfOutput | null = null;
      try {
        remoteRecord = await client.vendorGetSelf();
      } catch {
        // ignore; the rotate succeeded, persist regardless
      }

      // Re-read identity RIGHT BEFORE the write so writes from other modules
      // (markFirstPublishedIfCurrentScope, registry-poll-job, etc.) are merged
      // forward, not reverted by our pre-HTTP snapshot.
      const fresh = readInstanceIdentity() ?? identity;
      const reconciledRemote = remoteRecord
        ? reconcileRemoteFromVendorGet({
            previous: fresh.registries?.remote ?? undefined,
            vendor: remoteRecord,
            namespace,
          })
        : fresh.registries?.remote ?? undefined;
      const tokenEnc = encryptSecret(rotated.plaintext_token, "vendor.token");
      const passwordEnc = fresh.passwordCiphertext
        ? { ciphertext: fresh.passwordCiphertext, iv: fresh.passwordIv }
        : (() => {
            const p = encryptSecret(randomBytes(32).toString("base64url"), "vendor.password");
            return { ciphertext: p.ciphertext, iv: p.iv };
          })();

      writeInstanceIdentity({
        ...fresh,
        tokenCiphertext: tokenEnc.ciphertext,
        tokenIv: tokenEnc.iv,
        tokenAlgo: "aes-256-gcm",
        tokenUpdatedAt: rotated.created_at,
        passwordCiphertext: passwordEnc.ciphertext,
        passwordIv: passwordEnc.iv,
        registries: {
          ...(fresh.registries ?? {}),
          remote: reconciledRemote ?? {
            url: fresh.registryUrl ?? "",
            namespace,
            status: "connected",
          },
        },
      });
      invalidateInstanceIdentityCache();
      return { ok: true } as const;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const encoded = encodeURIComponent(message.slice(0, 200));
    redirect(`/configuration/environment?tab=registries&rotate_error=rotate_failed&detail=${encoded}`);
  }

  if (!outcome.ok) {
    redirect(`/configuration/environment?tab=registries&rotate_error=${outcome.code}`);
  }
  revalidatePath("/configuration/environment");
  redirect("/configuration/environment?tab=registries&rotate_ok=1");
}
