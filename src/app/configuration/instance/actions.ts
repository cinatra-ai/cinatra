// -----------------------------------------------------------------------------
// Administration/instance server actions.
//
// Three actions land here:
//
//   1. editVendorAction (pre-publish):
//      - Replaces credentials WITHOUT appending to oldInstanceNamespaces[].
//      - Allowed only when firstPublishedAt === null.
//      - Provisions a new Verdaccio user under the new vendor name; encrypts
//        the new token + password; persists; redirects.
//
//   2. renameInstanceNamespaceAction (post-freeze):
//      - Same provisioning flow, but ALSO appends the previous identity
//        snapshot to oldInstanceNamespaces[].
//      - Allowed only when firstPublishedAt !== null.
//      - Resets firstPublishedAt to null (will re-freeze on first publish
//        under the new scope).
//      - createdAt is preserved unchanged.
//      - Does NOT touch any extension/template DB tables. Old
//        packages stay reachable via the orphaned scope by design.
//
//   3. reconcileFirstPublishedAt:
//      - Pure helper signature: (identity, packagesUnderCurrentScope) →
//        Promise<InstanceIdentity>. Computes the next identity by scope-
//        filtering and freezing if appropriate. Used by
//        unit tests and by the page server component to drive the data flow.
//      - Idempotent: never resets firstPublishedAt to null once set.
//
//      A separate server-action wrapper, reconcileFirstPublishedAtAndPersist,
//      is invoked from the small client mount component
//      (ReconciliationMount). It reads identity, fetches scoped packages,
//      runs the pure helper, and writes only when the result differs.
//      This keeps mutation out of render time so React Server Component
//      caching expectations are not violated.
//
// Form-data trap fix: the rename form has exactly ONE
// field named 'instanceNamespace' — the hidden input bound to the modal's
// controlled state. The visible "current vendor name" element is a span
// (no input element). See rename-confirmation.tsx.
// -----------------------------------------------------------------------------

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";

import { requireAdminSession } from "@/lib/auth-session";
import {
  composeNamespaceErrorMessage,
  validateInstanceNamespace,
} from "@/lib/instance-namespace";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";
// Cache invalidation lives in a separate module so vi.mock can spy on it
// reliably.
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import { encryptSecret } from "@/lib/instance-secrets";
import {
  getEffectiveViewerScope,
  resolveConsumerOrVendorMarketplaceToken,
  VendorCredentialsMissingError,
} from "@/lib/marketplace-credentials";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceVendorApplicationStatusOutput } from "@cinatra-ai/marketplace-mcp-client";
import {
  loadVerdaccioConfigForReads,
  loadVerdaccioConfigForServer,
} from "@/lib/verdaccio-config";
import {
  createNpmUser,
  VerdaccioUserAlreadyRegisteredError,
  VerdaccioRegistrationDisabledError,
  VerdaccioUnexpectedResponseError,
  listAgentPackages,
} from "@cinatra-ai/registries";

// -----------------------------------------------------------------------------
// Validation
//
// Namespace validation lives in the shared validator module
// (src/lib/instance-namespace) so the same policy hooks the wizard client
// island and the administration rename surfaces.
// -----------------------------------------------------------------------------

const REGISTRY_URL =
  process.env.CINATRA_AGENT_REGISTRY_URL?.trim() || "https://registry.cinatra.ai";

function redirectWithError(message: string): never {
  redirect("/configuration/environment?tab=instance&error=" + encodeURIComponent(message));
  throw new Error("unreachable");
}

// Verdaccio/npm tokens are opaque strings — avoid over-validating their shape.
// Reject only the clearly-broken: too short, or carrying whitespace/control
// chars (the usual sign of a copy-paste or trailing-newline accident in an
// instance .env file). Mirrors the helper in setup/name/actions.ts.
function isPlausibleRegistryToken(token: string): boolean {
  return token.length >= 16 && !/[\s\u0000-\u001f]/.test(token);
}

// composeNamespaceErrorMessage lives in the shared @/lib/instance-namespace
// barrel (compose-error-message.ts), matching the wizard server action copy.
// The redirect target for these administration actions is handled by
// redirectWithError below.

// -----------------------------------------------------------------------------
// Pure reconciliation helper — exported so the page server component and unit
// tests can call it the same way.
// -----------------------------------------------------------------------------

/**
 * Compute whether `firstPublishedAt` should flip from `null` to `now()`
 * based on the registry showing at least one package under the current
 * vendor scope. Returns the next identity (possibly equal-by-value to the
 * input).
 *
 * Behaviour:
 *   - If `identity.firstPublishedAt !== null` → return identity unchanged
 *     (one-way semantics; never resets to null even if registry shows 0).
 *   - Else filter packages to entries whose `packageName` starts with
 *     `@${identity.instanceNamespace}/` (same-scope only).
 *   - If filtered count >= 1 → return `{ ...identity, firstPublishedAt: now }`.
 *   - Else → return identity unchanged.
 */
export async function reconcileFirstPublishedAt(
  identity: InstanceIdentity,
  packagesUnderCurrentScope: ReadonlyArray<{ packageName: string }>,
): Promise<InstanceIdentity> {
  // One-way: never reset.
  if (identity.firstPublishedAt !== null) {
    return identity;
  }

  // Same-scope filter.
  const scopePrefix = "@" + identity.instanceNamespace + "/";
  const scoped = packagesUnderCurrentScope.filter((p) =>
    p.packageName.startsWith(scopePrefix),
  );

  if (scoped.length >= 1) {
    return { ...identity, firstPublishedAt: new Date().toISOString() };
  }

  return identity;
}

// -----------------------------------------------------------------------------
// Server-action wrapper for ReconciliationMount client component.
// -----------------------------------------------------------------------------

/**
 * Server action invoked from the client mount component on page mount. Reads
 * identity, fetches scoped packages from the registry (best-effort), runs
 * the pure reconciliation helper, and persists ONLY when the result
 * differs. Idempotent — safe to call repeatedly (Strict Mode, refresh).
 *
 * This action is gated behind requireAdminSession. It is invoked by the
 * ReconciliationMount client component after the page has already loaded
 * (and the page itself is admin-gated), so the gate preserves the legitimate
 * mount flow. Without the gate, an unauthenticated POST to the action endpoint
 * would force (a) a DB read on the metadata row, (b) AES-GCM decryption of the
 * stored Verdaccio token, and (c) an HTTP probe to the registry's /-/all
 * endpoint.
 */
export async function reconcileFirstPublishedAtAndPersist(): Promise<void> {
  await requireAdminSession();

  const identity = readInstanceIdentity();
  if (!identity) return;
  if (identity.firstPublishedAt !== null) return; // one-way

  // Best-effort registry probe; never block reconciliation on probe failure.
  // Read-side wrapper — uses consumer Verdaccio read token when the
  // identity is consumer-attached; falls back to vendor token otherwise.
  const config = await loadVerdaccioConfigForReads().catch(() => null);
  if (!config) return;

  // Pass the resolved config to listAgentPackages so the ensureConfig DI guard
  // does not throw and get silently swallowed by .catch(() => []), which would
  // leave allPackages empty regardless of registry state and prevent
  // firstPublishedAt from ever being frozen.
  // Pass the canonical viewer scope so the freeze reconciliation sees same-
  // scope private packages — without it a vendor with ONLY private packages
  // published would never have their identity row's firstPublishedAt frozen.
  const viewerScope = getEffectiveViewerScope(identity);
  const allPackages = await listAgentPackages({ limit: 100, viewerScope }, config).catch(() => []);
  const next = await reconcileFirstPublishedAt(
    identity,
    allPackages as Array<{ packageName: string }>,
  );

  // Idempotent: only write if the helper changed firstPublishedAt.
  if (next.firstPublishedAt !== identity.firstPublishedAt) {
    writeInstanceIdentity(next);
    invalidateInstanceIdentityCache();
    revalidatePath("/configuration/environment");
  }
}

// -----------------------------------------------------------------------------
// Rename gate helper — calls the marketplace MCP client's
// vendor_application_status to check whether the current scope is locked by
// an open ("applied") or approved vendor application. Both states block the
// rename; non-locking statuses (rejected/cancelled/reset) do not.
// -----------------------------------------------------------------------------

async function assertNamespaceRenameAllowed(
  identity: InstanceIdentity,
  newName: string,
): Promise<void> {
  // No-op when the namespace is unchanged — pure metadata edits never need
  // to consult the marketplace.
  if (newName === identity.instanceNamespace) {
    return;
  }

  let token: string | null = null;
  try {
    token = resolveConsumerOrVendorMarketplaceToken(identity);
  } catch (err) {
    if (err instanceof VendorCredentialsMissingError) {
      // Only the "actually not attached yet" code
      // (`VENDOR_CREDENTIALS_MISSING` — no consumer attachment + no legacy
      // vendor token) is a safe-rename. `CONSUMER_ATTACHMENT_CORRUPTED`
      // means an attachment row exists but is malformed; a vendor
      // reservation may still live on the cm side, so we must fail-CLOSED
      // and force the operator to repair the row before renaming.
      if (err.code === "VENDOR_CREDENTIALS_MISSING") {
        return;
      }
      console.error(
        "[provisionAndPersist] rename blocked — vendor credentials present but unusable",
        { code: err.code },
      );
      redirectWithError(
        "Could not verify vendor-application status (consumer attachment is " +
          "present but malformed). Repair the marketplace attachment from " +
          "Configuration → Environment → Registries before renaming the " +
          "instance namespace.",
      );
    }
    throw err;
  }
  if (!token) {
    return;
  }

  let status: MarketplaceVendorApplicationStatusOutput | null = null;
  try {
    const client = createHttpMarketplaceMcpClient({ token });
    status = await client.vendorApplicationStatus();
  } catch (err) {
    // Fail-CLOSED on cm unreachable: avoid orphaning a reservation row.
    console.error(
      "[provisionAndPersist] vendor_application_status() failed during rename gate:",
      err,
    );
    redirectWithError(
      "Could not reach the Cinatra Marketplace to verify vendor-application status. " +
        "Please retry in a moment; if the marketplace is down, rename is paused.",
    );
  }

  if (status && (status.state === "applied" || status.state === "approved")) {
    redirectWithError(
      `Namespace is reserved as your vendor scope (status: ${status.state}). ` +
        "Cancel your vendor application from Configuration → Environment → Registries " +
        "before renaming the instance namespace.",
    );
  }
}

// -----------------------------------------------------------------------------
// Provisioning helper — shared between editVendorAction and renameInstanceNamespaceAction.
// -----------------------------------------------------------------------------

async function provisionAndPersist(
  current: InstanceIdentity,
  newName: string,
  email: string,
  opts: { append: boolean },
): Promise<void> {
  // Marketplace-mode block.
  //
  // When MARKETPLACE_INSTANCE_TOKEN is set the namespace is governed by the
  // Cinatra Marketplace (see /setup/name's mode (c)); the marketplace owns the
  // reservation and any rename must round-trip through it. The marketplace-
  // backed rename flow is not implemented — explicitly block here
  // with an operator-actionable message rather than silently degrading to
  // direct Verdaccio provisioning under modes (a)/(b), which would split
  // ownership of the namespace.
  if (process.env.MARKETPLACE_INSTANCE_TOKEN?.trim()) {
    redirectWithError(
      "Renaming the instance namespace on a marketplace-backed instance is not yet supported. Contact Cinatra Marketplace support to coordinate the change.",
    );
  }

  // Rename gate: when a vendor application is opened (or approved), the
  // scope is reserved on the marketplace side and renaming would orphan the
  // reservation. Synchronously check status via the marketplace MCP client
  // before persisting any namespace change. The check uses the LOCKING
  // status set { applied, approved } — non-locking statuses (rejected,
  // cancelled, reset) do NOT block a rename.
  //
  // Fail-CLOSED on cm unreachable: reject the rename with a retry CTA
  // rather than allow a rename that could orphan the reservation row.
  await assertNamespaceRenameAllowed(current, newName);

  // Two provisioning modes (mirrors setup/name/actions.ts):
  //
  //   (a) Pre-provisioned (locked-down registry). Operator pre-mints the new
  //       namespace's npm user out-of-band via the registry-token provisioning
  //       flow and supplies CINATRA_AGENT_REGISTRY_TOKEN/URL/SCOPE in the instance
  //       env. The wizard's anonymous adduser PUT would 409 on Verdaccio with
  //       max_users:-1, so we accept the supplied token directly.
  //
  //   (b) Self-registration. No env token → original flow (create the user
  //       via anonymous adduser).
  //
  // Mode (a) cross-check: loadVerdaccioConfigAsync takes an env-only fast
  // path whenever CINATRA_AGENT_REGISTRY_TOKEN is set — it derives the URL
  // and scope from env (defaulting URL to LOOPBACK, scope to the build
  // default), NOT this identity row. So when env-token is active we require
  // the companion env to be present AND consistent with the NEW namespace
  // before persisting anything.
  const envToken = process.env.CINATRA_AGENT_REGISTRY_TOKEN?.trim();

  let token: string;
  let password: string;

  if (envToken) {
    // Mode (a) — pre-provisioned token.
    if (!isPlausibleRegistryToken(envToken)) {
      redirectWithError(
        "Pre-provisioned registry token (CINATRA_AGENT_REGISTRY_TOKEN) looks malformed. Operator: check the instance environment for stray whitespace.",
      );
    }
    if (!process.env.CINATRA_AGENT_REGISTRY_URL?.trim()) {
      redirectWithError(
        "Pre-provisioned registry token is set but CINATRA_AGENT_REGISTRY_URL is missing. Operator: set the registry URL in the instance environment.",
      );
    }
    const expectedScope = `@${newName}`;
    if (process.env.CINATRA_AGENT_REGISTRY_SCOPE?.trim() !== expectedScope) {
      redirectWithError(
        `Pre-provisioned registry scope must match the new namespace. Operator: mint a new token for "${newName}" via the registry-token provisioning flow and set CINATRA_AGENT_REGISTRY_SCOPE=${expectedScope} + the new TOKEN in the instance environment BEFORE renaming.`,
      );
    }
    token = envToken;
    // No in-app password in the pre-provisioned flow — the operator holds the
    // htpasswd credential out-of-band. Persist a random placeholder so the
    // row's encrypted shape is intact; publish/install authenticate with the
    // token, never this password.
    password =
      process.env.CINATRA_AGENT_REGISTRY_PASSWORD?.trim() ||
      randomBytes(32).toString("base64url");
  } else {
    // Mode (b) — self-register on a registry that allows it. Generate a
    // 32-byte base64url password (43 chars on the wire), then provision the
    // npm user under the new name.
    password = randomBytes(32).toString("base64url");
    try {
      const result = await createNpmUser({
        instanceNamespace: newName,
        password,
        email,
        registryUrl: REGISTRY_URL,
      });
      token = result.token;
    } catch (e) {
      if (e instanceof VerdaccioUserAlreadyRegisteredError) {
        redirectWithError("That vendor name is already taken.");
      }
      if (e instanceof VerdaccioRegistrationDisabledError) {
        redirectWithError(
          "Registry self-registration is disabled. Operator: pre-provision the new namespace with the registry-token provisioning flow and set CINATRA_AGENT_REGISTRY_TOKEN/URL/SCOPE in the instance environment.",
        );
      }
      if (e instanceof VerdaccioUnexpectedResponseError) {
        redirectWithError(
        "Registry returned an unexpected response. Operator: see server logs.",
      );
      }
      // Emit a generic redirect message and log the full error server-side.
      // Reflecting the inner Error.message into ?error= leaks network
      // diagnostics (DNS errors with the configured registry host,
      // EHOSTUNREACH targets, etc.) into URL query params.
      console.error("[provisionAndPersist] unexpected registry error:", e);
      redirectWithError(
        "Could not provision registry user. Operator: see server logs.",
      );
      throw e; // unreachable; satisfies TS narrowing
    }
  }

  // Encrypt BEFORE writing so a failed encrypt never leaves partial state.
  // Per-field AAD binding prevents a metadata-row swap of
  // tokenCiphertext+tokenIv with passwordCiphertext+passwordIv from yielding a
  // successful decryption of the wrong field.
  const tokenEnc = encryptSecret(token, "vendor.token");
  const passwordEnc = encryptSecret(password, "vendor.password");

  // Build the next identity. createdAt is preserved. firstPublishedAt
  // is reset to null — under a new scope nothing is published yet.
  const next: InstanceIdentity = {
    ...current,
    instanceNamespace: newName,
    tokenCiphertext: tokenEnc.ciphertext,
    tokenIv: tokenEnc.iv,
    tokenAlgo: "aes-256-gcm",
    passwordCiphertext: passwordEnc.ciphertext,
    passwordIv: passwordEnc.iv,
    firstPublishedAt: null,
  };

  if (opts.append) {
    // Append the previous identity to oldInstanceNamespaces[]. Old packages
    // remain on the registry under the orphaned scope; extension-template DB
    // rows are not rewritten.
    next.oldInstanceNamespaces = [
      ...(current.oldInstanceNamespaces ?? []),
      {
        name: current.instanceNamespace,
        frozenAt: new Date().toISOString(),
        lastTokenCiphertext: current.tokenCiphertext ?? "",
        lastTokenIv: current.tokenIv ?? "",
      },
    ];
  }

  // provisionAndPersist is the canonical rename path (called by both
  // editVendorAction pre-freeze and renameInstanceNamespaceAction post-freeze).
  // Pass `allowNamespaceRename: true` so the post-freeze invariant in
  // writeInstanceIdentity accepts the namespace change.
  writeInstanceIdentity(next, { allowNamespaceRename: true });
  invalidateInstanceIdentityCache();
  revalidatePath("/setup");
  revalidatePath("/configuration/environment");
}

// -----------------------------------------------------------------------------
// editVendorAction — pre-publish credential replacement
// -----------------------------------------------------------------------------

export async function editVendorAction(formData: FormData): Promise<void> {
  const session = await requireAdminSession();
  const operatorEmail = session.user.email ?? "";
  if (!operatorEmail) {
    redirectWithError("Could not determine operator email. Please sign in again.");
  }

  const instanceDisplayName = String(formData.get("instanceDisplayName") ?? "").trim();
  if (!instanceDisplayName) {
    redirectWithError("Instance display name is required.");
  }
  if (instanceDisplayName.length > 120) {
    redirectWithError("Instance display name must be 120 characters or fewer.");
  }

  const current = readInstanceIdentity();
  if (!current) {
    redirectWithError("Instance identity is not configured. Run /setup/name first.");
  }

  // Namespace validation routes through the shared validator. The canonical
  // form (trim → lowercase) is what we persist.
  const namespaceResult = validateInstanceNamespace(
    String(formData.get("instanceNamespace") ?? current.instanceNamespace),
  );
  if (!namespaceResult.ok) {
    redirectWithError(composeNamespaceErrorMessage(namespaceResult.error));
  }
  const newName = namespaceResult.canonical;

  if (current.firstPublishedAt !== null) {
    writeInstanceIdentity({ ...current, instanceDisplayName });
    invalidateInstanceIdentityCache();
    revalidatePath("/configuration/environment");
    redirect("/configuration/environment?tab=instance");
  }
  // Short-circuit no-op edits so the registry never sees a duplicate adduser
  // call, which Verdaccio answers with 409 and we misinterpret as "name taken
  // by someone else".
  if (newName === current.instanceNamespace) {
    writeInstanceIdentity({ ...current, instanceDisplayName });
    invalidateInstanceIdentityCache();
    revalidatePath("/configuration/environment");
    redirect("/configuration/environment?tab=instance");
  }

  await provisionAndPersist({ ...current, instanceDisplayName }, newName, operatorEmail, { append: false });

  redirect("/configuration/environment?tab=instance");
}

// -----------------------------------------------------------------------------
// renameInstanceNamespaceAction — post-freeze hard rename
// -----------------------------------------------------------------------------

export async function renameInstanceNamespaceAction(formData: FormData): Promise<void> {
  const session = await requireAdminSession();
  const operatorEmail = session.user.email ?? "";
  if (!operatorEmail) {
    redirectWithError("Could not determine operator email. Please sign in again.");
  }

  // Namespace validation routes through the shared validator. The canonical
  // form (trim → lowercase) is what we persist.
  const namespaceResult = validateInstanceNamespace(
    String(formData.get("instanceNamespace") ?? ""),
  );
  if (!namespaceResult.ok) {
    redirectWithError(composeNamespaceErrorMessage(namespaceResult.error));
  }
  const newName = namespaceResult.canonical;

  const current = readInstanceIdentity();
  if (!current) {
    redirectWithError("Instance identity is not configured. Run /setup/name first.");
  }
  if (current.firstPublishedAt === null) {
    redirectWithError(
      "Use Edit instead of Rename for unpublished identities.",
    );
  }
  // Short-circuit no-op renames. Without this guard, the registry sees a
  // duplicate adduser call and either (a) emits 409 misinterpreted as "name
  // taken by someone else" or (b) silently rotates credentials while appending
  // a semantic-duplicate entry to oldInstanceNamespaces[].
  if (newName === current.instanceNamespace) {
    redirectWithError("New vendor name must differ from the current one.");
  }

  await provisionAndPersist(current, newName, operatorEmail, { append: true });

  redirect("/configuration/environment?tab=instance");
}

// -----------------------------------------------------------------------------
// savePrivateDestinationCredential
//
// Provides a production call site for writeDestinationCredential so the
// extension_destinations table can be populated through the application.
//
// Without this action, every call to resolvePublishDestination("private")
// or resolveInstallEnvironment (for private extensions) would throw
// PublishDestinationNotConfiguredError because readDestinationCredential
// always returns null for an empty table.
//
// The `ops` repo invokes this action (or the CLI equivalent) after provisioning
// the private registry and obtaining the per-destination tokens.
//
// Tokens are encrypted with per-field AAD:
//   publishToken → aad: "destination.<destinationId>.publish-token"
//   readToken    → aad: "destination.<destinationId>.read-token"
// Gated by requireAdminSession().
// -----------------------------------------------------------------------------

/**
 * Upserts encrypted credentials for a private publish destination.
 *
 * Intended call sites:
 *   - Admin administration UI
 *   - Operations provisioning script via server action HTTP POST
 *   - `cinatra setup prod` CLI (via a thin action wrapper)
 *
 * Plaintext tokens are encrypted in-action; callers never touch ciphertexts.
 */
export async function savePrivateDestinationCredential(input: {
  destinationId: string;
  label: string;
  registryUrl: string;
  publishTokenPlaintext: string;
  readTokenPlaintext?: string;
}): Promise<void> {
  await requireAdminSession();
  const { encryptSecret } = await import("@/lib/instance-secrets");
  const { writeDestinationCredential } = await import("@/lib/extension-destinations-store");

  const tokenEnc = encryptSecret(
    input.publishTokenPlaintext,
    `destination.${input.destinationId}.publish-token`,
  );
  const readEnc = input.readTokenPlaintext
    ? encryptSecret(input.readTokenPlaintext, `destination.${input.destinationId}.read-token`)
    : undefined;

  await writeDestinationCredential({
    id: input.destinationId,
    label: input.label,
    registryUrl: input.registryUrl,
    tokenCiphertext: tokenEnc.ciphertext,
    tokenIv: tokenEnc.iv,
    readTokenCiphertext: readEnc?.ciphertext,
    readTokenIv: readEnc?.iv,
  });
}
