// -----------------------------------------------------------------------------
// Boot-time marketplace attachment + vendor-state reconciliation.
//
// Wired into `src/instrumentation.node.ts` immediately after `ensureInstanceId`
// so this hook can rely on the durable `instanceId` + `instanceAttachSecret*`
// fields being populated. Idempotent, soft-failing, never blocks boot.
//
// Three concerns, in order:
//
//   1. Consumer attach (one-time, idempotent).
//      If `consumerAttachment` is absent on the persisted identity, call the
//      marketplace `instance_attach_self` ability to mint the consumer-tier
//      WP user + Application Password + Verdaccio htpasswd entry + read
//      token. Encrypt + persist both bearers into `consumerAttachment` with
//      partitioned AADs (CONSUMER_MARKETPLACE_TOKEN_AAD,
//      CONSUMER_VERDACCIO_TOKEN_AAD).
//
//   2. Vendor-state reconcile (every boot).
//      Always call `vendor_application_status()` against the marketplace and
//      mirror the result onto `identity.vendorState` / `vendorScope` /
//      `vendorApplicationId`. These fields are declared in
//      DURABLE_FIELD_NAMES, so `writeInstanceIdentity` preserves them across
//      stale-snapshot writes from any other caller.
//
//   3. Post-approval Verdaccio publish-token rotation (catch-up path).
//      If the vendor application has reached `approved` AND no
//      `tokenCiphertext` is stored locally (e.g. the operator was offline
//      at commercial-approval time and is only now booting), call
//      `vendor_registry_token_rotate_self()` to mint the Verdaccio publish
//      token + encrypt-persist into the existing legacy top-level vendor
//      token slot (`tokenCiphertext` / `tokenIv`, AAD `vendor.token`).
//
// Operator override: when `MARKETPLACE_INSTANCE_TOKEN` is set in the env,
// this hook bails early — the operator has bound a long-lived marketplace
// bearer manually, and the auto-attach + auto-reconcile flow must NOT run
// (it would mint a parallel consumer principal and overwrite the operator-
// supplied identity).
//
// Never throws to the caller — top-level try/catch in
// `instrumentation.node.ts` is the boot-safety net, but this module is
// internally defensive too (each sub-step logs + returns rather than
// propagating).
// -----------------------------------------------------------------------------

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceInstanceAttachSelfOutput } from "@cinatra-ai/marketplace-mcp-client";

import {
  CONSUMER_MARKETPLACE_TOKEN_AAD,
  CONSUMER_VERDACCIO_TOKEN_AAD,
  decryptInstanceAttachSecret,
  readInstanceIdentity,
  writeInstanceIdentity,
  type ConsumerAttachment,
  type InstanceIdentity,
  type VendorState,
} from "@/lib/instance-identity-store";
import { encryptSecret } from "@/lib/instance-secrets";
import { isGatekeptInstallEnabled } from "@/lib/gatekept-install";
import { resolveConsumerOrVendorMarketplaceToken } from "@/lib/marketplace-credentials";

/**
 * Map the cm-side `cinatra_namespace_reservations.status` (returned by
 * `vendor_application_status()`) onto the cinatra-side `VendorState` union.
 * Mirrors the doc-block comment in `instance-identity-store.ts:67-75`:
 *
 *   applied   → applied   (locking — rename gate blocks)
 *   approved  → approved  (locking — rename gate blocks)
 *   rejected  → rejected  (non-locking — operator can re-apply)
 *   cancelled → none
 *   reset     → none
 *   none      → none
 */
function mapMarketplaceStateToVendorState(
  raw: string | undefined,
): VendorState {
  switch (raw) {
    case "applied":
      return "applied";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
    case "reset":
    case "none":
    case undefined:
    default:
      return "none";
  }
}

/**
 * Build a `ConsumerAttachment` from the marketplace `instance_attach_self`
 * output, branching on whether the marketplace returned a Verdaccio read token.
 *
 * - Token PRESENT (legacy direct-read path; flag OFF or a not-yet-flipped
 *   marketplace): encrypt + store the Verdaccio read-token fields exactly as
 *   before. Behavior is unchanged from the legacy direct-read code path.
 * - Token ABSENT under gatekept mode (flag ON, marketplace honored
 *   `gatekept_install`): write a SANITIZED attachment WITHOUT the read-token
 *   fields. Install reads route through the broker via per-install grants, so no
 *   deployment-wide read token is needed.
 * - Token ABSENT while the flag is OFF: FAIL CLOSED. A flag-OFF instance still
 *   reads the registry directly and requires the read token; a missing token is
 *   not silently accepted — we throw so the caller's catch bails + retries next
 *   boot rather than persisting a half-formed attachment.
 *
 * @throws when the read token is absent and gatekept install is OFF.
 */
function buildConsumerAttachment(
  instanceId: string,
  out: MarketplaceInstanceAttachSelfOutput,
  gatekept: boolean,
): ConsumerAttachment {
  const nowIso = new Date().toISOString();
  const marketplaceEnc = encryptSecret(
    out.marketplace_token,
    CONSUMER_MARKETPLACE_TOKEN_AAD,
  );

  const base: ConsumerAttachment = {
    instanceIdAtAttach: instanceId,
    attachedAt: out.attached_at ?? nowIso,
    lastRefreshedAt: nowIso,
    marketplaceUsername: out.marketplace_username,
    // `verdaccioUsername` is required on the type; the marketplace omits it in
    // gatekept mode, so default to "" when absent (no read principal exists).
    verdaccioUsername: out.verdaccio_username ?? "",
    marketplaceTokenCiphertext: marketplaceEnc.ciphertext,
    marketplaceTokenIv: marketplaceEnc.iv,
    marketplaceTokenAlgo: "aes-256-gcm",
  };

  const readToken = out.verdaccio_read_token;
  const hasReadToken = typeof readToken === "string" && readToken.length > 0;

  if (hasReadToken) {
    // Legacy direct-read path: store the read-token fields exactly as before.
    const verdaccioEnc = encryptSecret(readToken, CONSUMER_VERDACCIO_TOKEN_AAD);
    return {
      ...base,
      verdaccioReadTokenCiphertext: verdaccioEnc.ciphertext,
      verdaccioReadTokenIv: verdaccioEnc.iv,
      verdaccioReadTokenAlgo: "aes-256-gcm",
    };
  }

  if (!gatekept) {
    // Fail-closed: a flag-OFF instance MUST receive the read token. Do not
    // silently persist a tokenless attachment.
    throw new Error(
      "instance_attach_self returned no verdaccio_read_token while " +
        "CINATRA_GATEKEPT_INSTALL is OFF. A direct-read instance requires the " +
        "deployment-wide Verdaccio read token; refusing to persist a " +
        "tokenless consumer attachment.",
    );
  }

  // Gatekept mode: sanitized attachment with no read-token fields.
  return base;
}

/**
 * Boot-time consumer-attach + vendor-state reconcile + post-approval
 * publish-token catch-up. Soft-fails on every error class — the boot
 * sequence stays unblocked and the next boot retries.
 */
export async function ensureMarketplaceAttachment(): Promise<void> {
  // Read identity once at entry. ensureInstanceId() already ran in
  // instrumentation.node.ts; if it failed (no DB, no row, fresh install
  // pre-setup wizard) we bail quiet — there's nothing to attach.
  let identity: InstanceIdentity | null;
  try {
    identity = readInstanceIdentity();
  } catch (err) {
    console.error(
      "[marketplace-attach] readInstanceIdentity failed — bailing:",
      err,
    );
    return;
  }
  if (!identity) {
    return;
  }
  if (
    !identity.instanceId ||
    !identity.instanceAttachSecretCiphertext ||
    !identity.instanceAttachSecretIv ||
    identity.instanceAttachSecretAlgo !== "aes-256-gcm"
  ) {
    // ensureInstanceId hasn't successfully populated durable fields yet.
    return;
  }

  // Operator-supplied marketplace bearer takes precedence over auto-attach
  // (split-brain guard — see file header).
  const envToken = process.env.MARKETPLACE_INSTANCE_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    return;
  }

  // --- (1) Consumer attach -------------------------------------------------
  if (identity.consumerAttachment === undefined) {
    try {
      // The attach call is PRINCIPAL_PUBLIC + rate-limited. The bearer used
      // for the transport is intentionally empty here — the marketplace's
      // `instance_attach_self` ability does not require a logged-in caller;
      // it authenticates the request via the proof-of-ownership secret.
      const gatekept = isGatekeptInstallEnabled();
      const client = createHttpMarketplaceMcpClient({});
      const plaintextSecret = decryptInstanceAttachSecret(identity);
      const out = await client.instanceAttachSelf({
        instance_id: identity.instanceId,
        instance_attach_secret: plaintextSecret,
        display_name: identity.instanceDisplayName,
        // Only declare gatekept-capability when the master flag is ON.
        // When ON, the marketplace OMITS the Verdaccio read token; when absent
        // (flag OFF) the marketplace keeps minting it (exact legacy behavior).
        ...(gatekept ? { gatekept_install: true } : {}),
      });

      const attachment = buildConsumerAttachment(identity.instanceId, out, gatekept);

      writeInstanceIdentity({ ...identity, consumerAttachment: attachment });
      // Re-read so the rest of this function works on the persisted shape
      // (durable-field preservation in writeInstanceIdentity may have merged
      // additional fields not present on our local copy).
      identity = readInstanceIdentity() ?? identity;
    } catch (err) {
      console.error(
        "[marketplace-attach] instance_attach_self failed — will retry on next boot:",
        err,
      );
      // Without an attachment we cannot reconcile vendor state (vendor calls
      // require the consumer bearer). Bail rather than fall through and
      // mis-report state.
      return;
    }
  }

  // --- (2) Vendor-state reconcile -----------------------------------------
  let nextVendorState: VendorState | null = null;
  let nextVendorScope: string | null | undefined = undefined;
  let nextApplicationId: string | null | undefined = undefined;
  try {
    const token = resolveConsumerOrVendorMarketplaceToken(identity);
    const client = createHttpMarketplaceMcpClient({ token });
    const status = await client.vendorApplicationStatus();
    nextVendorState = mapMarketplaceStateToVendorState(status.state);
    nextVendorScope = status.scope ?? null;
    nextApplicationId = status.application_id ?? null;
  } catch (err) {
    console.error(
      "[marketplace-attach] vendor_application_status failed — preserving prior vendorState:",
      err,
    );
    // Fall through; nextVendorState stays null so we skip the write below.
  }

  if (nextVendorState !== null) {
    const stateChanged =
      identity.vendorState !== nextVendorState ||
      identity.vendorScope !== nextVendorScope ||
      identity.vendorApplicationId !== nextApplicationId;
    if (stateChanged) {
      try {
        writeInstanceIdentity({
          ...identity,
          vendorState: nextVendorState,
          vendorScope: nextVendorScope,
          vendorApplicationId: nextApplicationId,
        });
        identity = readInstanceIdentity() ?? identity;
      } catch (err) {
        console.error(
          "[marketplace-attach] persisting reconciled vendorState failed — will retry on next boot:",
          err,
        );
      }
    }
  }

  // --- (3) Post-approval Verdaccio publish-token rotation -----------------
  //
  // Only when the application has reached `approved` AND the publish-token
  // slot is empty. This catches the case where commercial-tier approval
  // happened while the operator was offline; the boot reconcile sees the
  // approved state and mints the publish token on the operator's behalf.
  // For the free-tier inline auto-approve path, the publish token was
  // already minted by `vendor_application_apply` and persisted by the
  // application server action — this block becomes a no-op.
  const hasPublishToken =
    typeof identity.tokenCiphertext === "string" &&
    identity.tokenCiphertext.length > 0 &&
    typeof identity.tokenIv === "string" &&
    identity.tokenIv.length > 0;
  if (identity.vendorState === "approved" && !hasPublishToken) {
    try {
      const token = resolveConsumerOrVendorMarketplaceToken(identity);
      const client = createHttpMarketplaceMcpClient({ token });
      const minted = await client.vendorRegistryTokenRotateSelf();
      const enc = encryptSecret(minted.plaintext_token, "vendor.token");
      writeInstanceIdentity({
        ...identity,
        tokenCiphertext: enc.ciphertext,
        tokenIv: enc.iv,
        tokenAlgo: "aes-256-gcm",
        tokenUpdatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        "[marketplace-attach] vendor_registry_token_rotate_self (post-approval catch-up) failed — will retry on next boot:",
        err,
      );
    }
  }
}
