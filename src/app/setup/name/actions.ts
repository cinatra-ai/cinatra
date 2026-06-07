// -----------------------------------------------------------------------------
// saveInstanceIdentityAction validates both the instance display name and the
// namespace, provisions the Verdaccio npm user, encrypts credentials, persists
// via writeInstanceIdentity, and redirects to /setup.
//
// Key behavior:
//   - validates instanceDisplayName (required, 1–120 chars)
//   - validates instanceNamespace using the shared namespace policy
//   - persists both fields to the JSONB blob
//   - redirects to /setup/name?error=... on failure
//   - CINATRA_ENCRYPTION_KEY missing → redirects to /setup/key first
// -----------------------------------------------------------------------------

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { requireAdminSession } from "@/lib/auth-session";
import {
  composeNamespaceErrorMessage,
  validateInstanceNamespace,
} from "@/lib/instance-namespace";
import { getApprovedInstanceNamespaces } from "@/lib/instance-namespace/approved-list";
import {
  buildFreshInstanceIdentityDurableFields,
  readInstanceIdentity,
  writeInstanceIdentity,
} from "@/lib/instance-identity-store";
// Cache invalidation lives in a separate module to keep side effects isolated.
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import { encryptSecret } from "@/lib/instance-secrets";
import { invalidateSetupWizardCache } from "@/lib/setup-wizard";
import {
  createNpmUser,
  VerdaccioUserAlreadyRegisteredError,
  VerdaccioRegistrationDisabledError,
  VerdaccioUnexpectedResponseError,
} from "@cinatra-ai/registries";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import { getMarketplaceTermsAcceptance } from "@/lib/marketplace-terms";
import { reconcileRemoteFromVendorGet } from "@/lib/marketplace-reconcile";
import { detectMarketplaceEnvConflict } from "@/lib/marketplace-env-conflict";
import { withInstanceIdentityWriteLock } from "@/lib/instance-identity-write-lock";
import type { RemoteRegistryConnection } from "@/lib/instance-identity-store";
import { redactSensitive } from "@/lib/redact-sensitive";
import { resolveRegistryUrl, shouldSelfRegisterRegistryUser } from "./registry-url";

// -----------------------------------------------------------------------------
// Validation — npm scope rules for namespace + display name.
//
// Namespace validation lives in the shared validator module
// (src/lib/instance-namespace) so the same policy hooks the wizard client island
// and any control-plane endpoint.
// -----------------------------------------------------------------------------

const instanceDisplayNameSchema = z.object({
  instanceDisplayName: z
    .string()
    .trim()
    .min(1, "Instance display name is required.")
    .max(120, "Instance display name must be 120 characters or fewer."),
});

function redirectWithError(message: string): never {
  redirect("/setup/name?error=" + encodeURIComponent(message));
  // redirect throws; satisfies `never` return.
  throw new Error("unreachable");
}

// Verdaccio/npm tokens are opaque strings — avoid over-validating their shape.
// Reject only the clearly-broken: too short, or carrying whitespace/control
// chars (the usual sign of a copy-paste or trailing-newline accident in an
// instance .env file).
function isPlausibleRegistryToken(token: string): boolean {
  return token.length >= 16 && !/[\s\u0000-\u001f]/.test(token);
}

function buildDeferredRemoteRegistry(
  instanceNamespace: string,
  registryUrl: string,
): RemoteRegistryConnection | undefined {
  if (!registryUrl || !/^https?:\/\//i.test(registryUrl)) return undefined;
  return {
    url: registryUrl,
    namespace: instanceNamespace,
    status: "not_connected",
  };
}

async function attachMarketplaceConsumerBestEffort(): Promise<void> {
  try {
    const { ensureMarketplaceAttachment } = await import("@/lib/marketplace-attach");
    await ensureMarketplaceAttachment();
  } catch (e) {
    console.error(
      "[saveInstanceIdentityAction] marketplace consumer attach failed; will retry on boot:",
      redactSensitive(e),
    );
  }
}

async function persistDeferredInstanceIdentity(input: {
  instanceNamespace: string;
  instanceDisplayName: string;
  registryUrl: string;
}): Promise<void> {
  const remote = buildDeferredRemoteRegistry(input.instanceNamespace, input.registryUrl);
  writeInstanceIdentity({
    instanceNamespace: input.instanceNamespace,
    instanceDisplayName: input.instanceDisplayName,
    ...buildFreshInstanceIdentityDurableFields(),
    registryUrl: input.registryUrl,
    firstPublishedAt: null,
    createdAt: new Date().toISOString(),
    ...(remote ? { registries: { remote } } : {}),
  });
  invalidateInstanceIdentityCache();
  await attachMarketplaceConsumerBestEffort();
}

// composeNamespaceErrorMessage lives in the shared @/lib/instance-namespace
// barrel (compose-error-message.ts). The link in the contact channel is NOT
// hyperlinked here (server-redirect copy is plain text consumed by an Alert);
// the clickable variant lives in the wizard client island
// (src/app/setup/name/instance-namespace-input.tsx) and the administration
// rename modal (src/app/configuration/instance/rename-confirmation.tsx).

// -----------------------------------------------------------------------------
// Action
// -----------------------------------------------------------------------------

export async function saveInstanceIdentityAction(formData: FormData): Promise<void> {
  // Step 1 — Auth session. Email comes from the session, NEVER from the
  // form input.
  //
  // The setup wizard mutates registry identity for the entire instance;
  // allowing any authenticated user to submit would let a regular user
  // re-provision the registry under their chosen namespace and silently rotate
  // the platform's published scope.
  //
  // Env-var probing happens AFTER the auth gate so the ?error=... redirect
  // cannot be used as an oracle for whether the instance has
  // CINATRA_ENCRYPTION_KEY configured.
  const session = await requireAdminSession();
  const operatorEmail = session.user.email ?? "";
  if (!operatorEmail) {
    redirectWithError("Could not determine operator email. Please sign in again.");
  }

  // Step 2 — Block re-provisioning when an identity row already exists. After
  // setup the ONLY paths that may mutate the identity are the admin-gated
  // edit/rename actions in /configuration/instance — both of which enforce the
  // freeze invariant.
  const existingIdentity = readInstanceIdentity();
  if (existingIdentity) {
    redirectWithError(
      "Instance namespace is already configured. Use Administration → Instance to edit or rename.",
    );
  }

  // Step 3 — CINATRA_ENCRYPTION_KEY pre-check. The /setup/key page is wizard
  // step 0 and blocks navigation here until the key is set, but we re-check at
  // the action layer because env vars can change between page render and submit
  // (process restart, operator pulled the var, etc.).
  if (!process.env.CINATRA_ENCRYPTION_KEY?.trim()) {
    redirectWithError(
      "CINATRA_ENCRYPTION_KEY is not set. Configure it via /setup/key first.",
    );
  }

  // Step 4 — Validate both fields.
  //
  // Display-name validation stays as Zod. Namespace validation routes through
  // the shared validator so client and server use one policy module.
  const displayNameParsed = instanceDisplayNameSchema.safeParse({
    instanceDisplayName: String(formData.get("instanceDisplayName") ?? ""),
  });
  if (!displayNameParsed.success) {
    redirectWithError(displayNameParsed.error.issues[0]?.message ?? "Invalid input.");
  }
  const { instanceDisplayName } = displayNameParsed.data;

  const namespaceResult = validateInstanceNamespace(
    String(formData.get("instanceNamespace") ?? ""),
    { approvedExactNames: getApprovedInstanceNamespaces() },
  );
  if (!namespaceResult.ok) {
    redirectWithError(composeNamespaceErrorMessage(namespaceResult.error));
  }
  // Always persist the canonical form.
  const instanceNamespace = namespaceResult.canonical;

  // Step 5/6 — Resolve the registry credentials. THREE provisioning modes:
  //
  //   (c) Marketplace mode (P6a-2b). When the instance has a marketplace
  //       account credential (MARKETPLACE_INSTANCE_TOKEN), reserve the
  //       namespace through the marketplace (`vendor_register_self`) — the
  //       marketplace is the authoritative namespace gate post-repoint and
  //       returns the registry URL + a one-time registry token.
  //
  //   (a) Pre-provisioned (locked-down registry). Operator pre-created the
  //       namespace out-of-band; supplies CINATRA_AGENT_REGISTRY_TOKEN + _URL
  //       + _SCOPE. Used for registries that run with self-signup disabled.
  //
  //   (b) Self-registration. No marketplace token + no pre-provisioned env →
  //       anonymous adduser against a self-signup-enabled local Verdaccio
  //       (dev/local).
  //
  // CONFLICT GUARD: (c) and (a) configured simultaneously is split-brain —
  // setup may persist a marketplace-issued token while runtime's env-override
  // path (loadVerdaccioConfigAsync) silently prefers the pre-provisioned env
  // values. Hard-fail with an operator-actionable error.
  const marketplaceInstanceToken = process.env.MARKETPLACE_INSTANCE_TOKEN?.trim();
  const envToken = process.env.CINATRA_AGENT_REGISTRY_TOKEN?.trim();
  const conflict = detectMarketplaceEnvConflict();
  if (conflict) {
    redirectWithError(conflict.reason);
  }

  let token: string;
  let password: string;
  let resolvedRegistryUrl: string = resolveRegistryUrl();
  let marketplaceRemote: RemoteRegistryConnection | undefined;

  if (marketplaceInstanceToken) {
    // Mode (c) — marketplace bootstrap. The ENTIRE flow (re-check existing
    // identity → remote register → remote rotate-if-null → encrypt → write)
    // runs inside the shared identity-write lock so two concurrent setup
    // submits cannot both pass an empty-row check and end up with the DB
    // holding a marketplace-revoked token. The function `return`s from
    // INSIDE the lock callback because we redirect — modes (a)/(b) fall
    // through to the common bottom-of-function write.
    const expectedScope = `@${instanceNamespace}`;
    const terms = getMarketplaceTermsAcceptance();
    const client = createHttpMarketplaceMcpClient({ token: marketplaceInstanceToken });

    let redirectTarget: string | null = null;
    try {
      await withInstanceIdentityWriteLock(async () => {
        // Re-check existing identity INSIDE the lock — defends against a
        // concurrent setup submit that already wrote.
        const existingNow = readInstanceIdentity();
        if (existingNow) {
          redirectTarget =
            "/setup/name?error=" +
            encodeURIComponent(
              "Instance namespace is already configured. Use Administration → Instance to edit or rename.",
            );
          return;
        }

        const registered = await client.vendorRegisterSelf({
          namespace: expectedScope,
          terms_version: terms.termsVersion,
          terms_digest:  terms.termsDigest,
          terms_url:     terms.termsUrl,
          display_name:  instanceDisplayName,
        });

        // Idempotent re-register returns null token — recover via self-rotate.
        let plaintext = registered.registry_token?.plaintext_token ?? null;
        if (!plaintext) {
          const rotated = await client.vendorRegistryTokenRotateSelf();
          plaintext = rotated.plaintext_token;
        }

        const marketplaceUrl = registered.registry_url || resolveRegistryUrl();
        const remote = reconcileRemoteFromVendorGet({
          previous: undefined,
          vendor: {
            vendor_id: registered.vendor_id,
            namespace: registered.namespace,
            tier: registered.tier,
            state: registered.state,
            profile_visibility: registered.profile_visibility,
            published_count: registered.published_count,
            has_registry_token: true,
            registry_url: marketplaceUrl,
          },
          namespace: expectedScope,
        });
        const tokenEnc = encryptSecret(plaintext, "vendor.token");
        // No in-app npm password in marketplace mode — keep the row shape
        // intact with a random placeholder; auth flows via the bearer.
        const passwordEnc = encryptSecret(randomBytes(32).toString("base64url"), "vendor.password");

        // Generate instanceId + the encrypted attach-secret inline so the
        // very first identity write already contains them. Boot-time
        // ensureInstanceId() then becomes a no-op for fresh installs.
        writeInstanceIdentity({
          instanceNamespace,
          instanceDisplayName,
          ...buildFreshInstanceIdentityDurableFields(),
          tokenCiphertext: tokenEnc.ciphertext,
          tokenIv: tokenEnc.iv,
          tokenAlgo: "aes-256-gcm",
          passwordCiphertext: passwordEnc.ciphertext,
          passwordIv: passwordEnc.iv,
          registryUrl: marketplaceUrl,
          firstPublishedAt: null,
          createdAt: new Date().toISOString(),
          registries: { remote },
        });
        invalidateInstanceIdentityCache();
      });
    } catch (e) {
      console.error("[saveInstanceIdentityAction] marketplace bootstrap failed:", e);
      redirectWithError(
        "Could not reserve the namespace on the Cinatra Marketplace. Operator: check MARKETPLACE_INSTANCE_TOKEN and the marketplace endpoint, then see server logs.",
      );
    }
    if (redirectTarget) {
      redirect(redirectTarget);
    }
    invalidateSetupWizardCache();
    revalidatePath("/setup");
    revalidatePath("/configuration/environment");
    redirect("/setup");
  } else if (envToken) {
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
    const expectedScope = `@${instanceNamespace}`;
    if (process.env.CINATRA_AGENT_REGISTRY_SCOPE?.trim() !== expectedScope) {
      redirectWithError(
        `Pre-provisioned registry scope must match the namespace. Operator: set CINATRA_AGENT_REGISTRY_SCOPE=${expectedScope} in the instance environment.`,
      );
    }
    token = envToken;
    // The pre-provisioned flow has no in-app password — the operator holds the
    // htpasswd credential out-of-band. Persist a random placeholder so the
    // row's encrypted shape is intact; publish/install authenticate with the
    // token, never this password. Rotation = rotate the env token (config.ts
    // prefers it) or re-run setup. If CINATRA_AGENT_REGISTRY_PASSWORD is
    // supplied we store the real one for a future re-login flow.
    password =
      process.env.CINATRA_AGENT_REGISTRY_PASSWORD?.trim() ||
      randomBytes(32).toString("base64url");
  } else {
    if (!shouldSelfRegisterRegistryUser()) {
      await persistDeferredInstanceIdentity({
        instanceNamespace,
        instanceDisplayName,
        registryUrl: resolvedRegistryUrl,
      });
      invalidateSetupWizardCache();
      revalidatePath("/setup");
      revalidatePath("/configuration/environment");
      redirect("/setup");
    }

    // Mode (b) — self-register on a registry that allows it. Generate a
    // 32-byte base64url password, then provision the npm user. The try/catch
    // covers ONLY the network call; the success-path redirect is OUTSIDE it
    // because Next.js's redirect() throws internally and must propagate.
    password = randomBytes(32).toString("base64url");
    try {
      const result = await createNpmUser({
        instanceNamespace,
        password,
        email: operatorEmail,
        registryUrl: resolveRegistryUrl(),
      });
      token = result.token;
    } catch (e) {
      if (e instanceof VerdaccioUserAlreadyRegisteredError) {
        redirectWithError("That namespace is already taken.");
      }
      if (e instanceof VerdaccioRegistrationDisabledError) {
        await persistDeferredInstanceIdentity({
          instanceNamespace,
          instanceDisplayName,
          registryUrl: resolvedRegistryUrl,
        });
        invalidateSetupWizardCache();
        revalidatePath("/setup");
        revalidatePath("/configuration/environment");
        redirect("/setup");
      }
      if (e instanceof VerdaccioUnexpectedResponseError) {
        // Operator preflight handover.
        redirectWithError(
          "Registry returned an unexpected response. Operator: see the Verdaccio preflight notes.",
        );
      }
      // Emit a generic redirect message and log the full error server-side.
      // Reflecting the inner Error.message into the ?error= query param leaked
      // network diagnostics.
      console.error("[saveInstanceIdentityAction] unexpected registry error:", e);
      redirectWithError(
        "Could not provision registry user. Operator: see server logs.",
      );
      throw e; // unreachable; satisfies TS narrowing
    }
  }

  // Step 7 — Encrypt both secrets BEFORE writing to the DB. If either
  // encryption call throws (e.g. CINATRA_ENCRYPTION_KEY became invalid between
  // the pre-check and now), no partial state lands in metadata.
  //
  // Bind each ciphertext to its field name via AES-GCM aad.
  const tokenEnc = encryptSecret(token, "vendor.token");
  const passwordEnc = encryptSecret(password, "vendor.password");

  // Step 8 — Persist the identity row. When marketplace bootstrap (mode c) is
  // used, seed `registries.remote` from the marketplace vendor record so the
  // env-page registries tab is immediately accurate without waiting for the
  // first reconcile.
  // See the marketplace-mode block above for the instanceId + attach-secret
  // rationale (identity fields seeded inline at first write).
  writeInstanceIdentity({
    instanceNamespace,
    instanceDisplayName,
    ...buildFreshInstanceIdentityDurableFields(),
    tokenCiphertext: tokenEnc.ciphertext,
    tokenIv: tokenEnc.iv,
    tokenAlgo: "aes-256-gcm",
    passwordCiphertext: passwordEnc.ciphertext,
    passwordIv: passwordEnc.iv,
    registryUrl: resolvedRegistryUrl,
    firstPublishedAt: null,
    createdAt: new Date().toISOString(),
    ...(marketplaceRemote ? { registries: { remote: marketplaceRemote } } : {}),
  });

  // Step 9 — Invalidate caches and revalidate the setup + administration paths.
  invalidateInstanceIdentityCache();
  invalidateSetupWizardCache();
  revalidatePath("/setup");
  revalidatePath("/configuration/environment");

  // Step 10 — Continue to the next wizard step.
  redirect("/setup");
}
