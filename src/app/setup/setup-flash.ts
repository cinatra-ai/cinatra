// -----------------------------------------------------------------------------
// Setup-wizard codes-only flash protocol.
//
// The setup wizard is a shell-bypass route where `useNotify()` is unavailable,
// so wizard server actions report outcomes by redirecting with a stable CODE on
// `?error=<code>`. The <SearchParamToast> island mounted in the setup layout
// maps each code to a STATIC message here — it NEVER toasts URL-derived text
// (a crafted `?error=<spoofed link>` maps to no entry and is ignored). This
// module is the single source of truth so the action emitters and the mount-site
// message map cannot drift.
//
// Field-scoped specifics (namespace shape, display-name length) are surfaced
// inline at the field by the wizard client island + native HTML validation;
// these codes are the server-side backstop, so a single generic code per
// validation family is intentional.
// -----------------------------------------------------------------------------

import type { SearchParamToastConfig } from "@cinatra-ai/sdk-ui/search-param-toast";

export const SETUP_ERROR_MESSAGES = {
  // S6 (cinatra#2093) AI step: the provider choice + the readiness saga.
  // The saga's ACTIONABLE detail (and its fix-forward prompt) is rendered
  // inline on the step from the stored failure record — never carried in the
  // query string, per this module's codes-only protocol.
  "setup-provider-invalid":
    "Choose one of the offered AI providers and enter its credentials.",
  // The provider CREDENTIAL save failed (distinct from the readiness run below,
  // which never started). The actionable detail — including which step to
  // complete first — renders inline at the credential form from the stored
  // failure record; this code is the transient flash, and carries no text of
  // its own per the codes-only protocol.
  "setup-provider-save-failed":
    "That provider key could not be saved. The step shows what failed and what to do first.",
  // The switch is ordered so that no partial outcome can read as ready; the
  // step re-renders whatever durable state survived, so the code says "look at
  // the step" rather than asserting what did or did not change.
  "setup-mcp-mode-switch-failed":
    "Could not switch the Anthropic connector to native MCP delivery. The step shows the current state — try again, or see server logs.",
  "setup-readiness-failed":
    "AI setup could not be verified. The step shows what failed and how to fix it.",
  "operator-email-missing": "Could not determine operator email. Please sign in again.",
  "identity-exists":
    "Instance namespace is already configured. Use Administration → Instance to edit or rename.",
  "encryption-key-missing":
    "CINATRA_ENCRYPTION_KEY is not set. Configure it via /setup/key first.",
  "invalid-display-name": "Instance display name is required (1–120 characters).",
  "invalid-namespace":
    "That instance namespace isn't valid — check the namespace field for the exact requirement.",
  "marketplace-env-conflict":
    "Marketplace and pre-provisioned registry credentials are both configured (split-brain). Configure exactly one.",
  "marketplace-register-failed":
    "Could not reserve the namespace on the Cinatra Marketplace. Operator: check MARKETPLACE_INSTANCE_TOKEN and the marketplace endpoint, then see server logs.",
  "registry-token-malformed":
    "Pre-provisioned registry token (CINATRA_AGENT_REGISTRY_TOKEN) looks malformed. Operator: check the instance environment for stray whitespace.",
  "registry-url-missing":
    "Pre-provisioned registry token is set but CINATRA_AGENT_REGISTRY_URL is missing. Operator: set the registry URL in the instance environment.",
  "registry-scope-mismatch":
    "Pre-provisioned registry scope must match the namespace. Operator: set CINATRA_AGENT_REGISTRY_SCOPE to your instance's @namespace in the instance environment.",
  "namespace-taken": "That namespace is already taken.",
  "registry-unexpected-response":
    "Registry returned an unexpected response. Operator: see the Verdaccio preflight notes.",
  "registry-provision-failed":
    "Could not provision registry user. Operator: see server logs.",
} as const;

export type SetupErrorCode = keyof typeof SETUP_ERROR_MESSAGES;

// One <SearchParamToast> config entry per code: all on the `error` param,
// rendered as an error-variant toast, with the STATIC message above. Passed to
// the island mounted in src/app/setup/layout.tsx.
export const SETUP_FLASH_TOASTS: SearchParamToastConfig[] = Object.entries(
  SETUP_ERROR_MESSAGES,
).map(([code, message]) => ({
  param: "error",
  value: code,
  message,
  variant: "error" as const,
}));
