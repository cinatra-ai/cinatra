// -----------------------------------------------------------------------------
// Instance-administration codes-only flash protocol.
//
// The instance edit/rename server actions (./actions.ts) report an outcome by
// redirecting to `/configuration/environment?tab=instance` with a stable CODE
// on `?error=<code>` (or `?saved=1` on success). The <SearchParamToast> island
// mounted on the instance tab maps each code to the STATIC message here — it
// NEVER toasts URL-derived text (a crafted `?error=<spoofed link>` maps to no
// entry and is ignored). This module is the single source of truth so the
// action emitters and the mount-site message map cannot drift.
//
// Namespace-format specifics are surfaced at the field by the shared namespace
// input island (composeNamespaceErrorMessage) and by the rename modal; the
// `invalid-namespace` code here is the server-side backstop, so a single generic
// code for the whole namespace-validation family is intentional (mirrors
// src/app/setup/setup-flash.ts).
// -----------------------------------------------------------------------------

import type { SearchParamToastConfig } from "@/components/search-param-toast";

export const INSTANCE_ERROR_MESSAGES = {
  "operator-email-missing": "Could not determine operator email. Please sign in again.",
  "invalid-display-name": "Instance display name is required.",
  "display-name-too-long": "Instance display name must be 120 characters or fewer.",
  "identity-not-configured": "Instance identity is not configured. Run /setup/name first.",
  "invalid-namespace":
    "That instance namespace isn't valid — check the namespace field for the exact requirement.",
  "namespace-taken": "That vendor name is already taken.",
  "namespace-unchanged": "New vendor name must differ from the current one.",
  "use-edit-not-rename": "Use Edit instead of Rename for unpublished identities.",
  "attachment-malformed":
    "Could not verify vendor-application status (the marketplace attachment is present but malformed). Repair it from Configuration → Environment → Registries before renaming the instance namespace.",
  "marketplace-unreachable-rename":
    "Could not reach the Cinatra Marketplace to verify vendor-application status. Please retry in a moment; if the marketplace is down, rename is paused.",
  "namespace-reserved":
    "This namespace is reserved as your vendor scope. Cancel your vendor application from Configuration → Environment → Registries before renaming the instance namespace.",
  "marketplace-rename-unsupported":
    "Renaming the instance namespace on a marketplace-backed instance is not yet supported. Contact Cinatra Marketplace support to coordinate the change.",
  "registry-token-malformed":
    "Pre-provisioned registry token (CINATRA_AGENT_REGISTRY_TOKEN) looks malformed. Operator: check the instance environment for stray whitespace.",
  "registry-url-missing":
    "Pre-provisioned registry token is set but CINATRA_AGENT_REGISTRY_URL is missing. Operator: set the registry URL in the instance environment.",
  "registry-scope-mismatch":
    "Pre-provisioned registry scope must match the new namespace. Operator: mint a new token for the new namespace via the registry-token provisioning flow and set CINATRA_AGENT_REGISTRY_SCOPE + the new TOKEN in the instance environment BEFORE renaming.",
  "registry-registration-disabled":
    "Registry self-registration is disabled. Operator: pre-provision the new namespace with the registry-token provisioning flow and set CINATRA_AGENT_REGISTRY_TOKEN/URL/SCOPE in the instance environment.",
  "registry-unexpected-response":
    "Registry returned an unexpected response. Operator: see server logs.",
  "registry-provision-failed": "Could not provision registry user. Operator: see server logs.",
} as const;

export type InstanceErrorCode = keyof typeof INSTANCE_ERROR_MESSAGES;

// One <SearchParamToast> entry per error code, plus the success flash. Passed to
// the island mounted in the environment page's instance tab.
export const INSTANCE_FLASH_TOASTS: SearchParamToastConfig[] = [
  { param: "saved", value: "1", message: "Your instance identity changes have been saved.", variant: "success" },
  ...Object.entries(INSTANCE_ERROR_MESSAGES).map(([code, message]) => ({
    param: "error" as const,
    value: code,
    message,
    variant: "error" as const,
  })),
];
