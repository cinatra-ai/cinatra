// -----------------------------------------------------------------------------
// Registries-tab codes-only flash protocol.
//
// Three action groups redirect to `/configuration/environment?tab=registries`
// with an outcome code — feedback that NOTHING rendered before (the three
// "orphaned flash groups"). The <SearchParamToast> island mounted on the
// registries tab maps each code to the STATIC message here and toasts it.
//
//   1. vendor-application-actions.ts → vendor_application_ok / vendor_application_error
//   2. marketplace-publish-actions.ts → publish_* / visibility_* / rotate_*
//   3. network/actions.ts             → net_ok / net_error
//
// Codes only: the specific server/marketplace error is logged server-side by the
// emitter; only a stable code rides the URL, never URL-derived text.
// -----------------------------------------------------------------------------

import type { SearchParamToastConfig } from "@/components/search-param-toast";

// 1. Vendor-application actions -------------------------------------------------
const VENDOR_APP_OK: Record<string, string> = {
  "vendor-application-applied": "Vendor application submitted.",
  "vendor-application-cancelled": "Vendor application cancelled.",
  "vendor-application-refreshed": "Vendor application status refreshed.",
  "consumer-attachment-refreshed": "Marketplace consumer attachment refreshed.",
  "consumer-token-rotated": "Consumer token rotated.",
};
const VENDOR_APP_ERROR: Record<string, string> = {
  "identity-not-configured": "Instance identity is not configured. Run /setup/name first.",
  "attachment-missing":
    "Marketplace consumer attachment is missing. Wait for the boot-time attach hook or restart the app to mint a marketplace bearer.",
  "invalid-tier": "Tier must be 'free' or 'commercial'.",
  "terms-required": "You must accept the marketplace terms to apply as a vendor.",
  "display-name-required": "Vendor display name is required.",
  "display-name-too-long": "Vendor display name must be 190 characters or fewer.",
  "terms-stale": "Marketplace terms have been updated. Re-accept the latest terms and resubmit.",
  "terms-digest-mismatch":
    "The accepted terms digest doesn't match the marketplace's canonical digest. Re-fetch the latest terms and resubmit.",
  "no-open-application": "No open vendor application to cancel.",
  "no-consumer-attachment": "No consumer attachment to refresh. Wait for the boot-time attach hook or restart.",
  "attach-secret-missing": "Instance attach secret is not provisioned. Cannot rotate the consumer token.",
  "decrypt-failed": "Could not decrypt the instance attach secret to rotate the token.",
  "apply-failed": "The vendor application could not be submitted. See server logs for details.",
  "refresh-failed": "Could not refresh the vendor-application status. See server logs for details.",
  "rotate-failed": "Could not rotate the consumer token. See server logs for details.",
};

// 2. Marketplace-publish actions ------------------------------------------------
const PUBLISH_ERROR: Record<string, string> = {
  env_conflict:
    "Marketplace and pre-provisioned registry credentials are both configured (split-brain). Configure exactly one.",
  terms_not_accepted: "You must accept the marketplace terms to register as a vendor.",
  marketplace_unavailable: "The marketplace is not configured on this instance (MARKETPLACE_INSTANCE_TOKEN is unset).",
  encryption_key_unset: "CINATRA_ENCRYPTION_KEY is not set. Configure it before publishing.",
  submit_failed: "Could not complete vendor registration. See server logs for details.",
};
const VISIBILITY_ERROR: Record<string, string> = {
  env_conflict:
    "Marketplace and pre-provisioned registry credentials are both configured (split-brain). Configure exactly one.",
  invalid: "Choose a valid profile visibility.",
  set_failed: "Could not update the profile visibility. See server logs for details.",
};
const ROTATE_ERROR: Record<string, string> = {
  env_conflict:
    "Marketplace and pre-provisioned registry credentials are both configured (split-brain). Configure exactly one.",
  marketplace_unavailable: "The marketplace is not configured on this instance (MARKETPLACE_INSTANCE_TOKEN is unset).",
  encryption_key_unset: "CINATRA_ENCRYPTION_KEY is not set. Configure it before rotating the token.",
  rotate_failed: "Could not rotate the registry token. See server logs for details.",
};

// 3. Network (registry connection) actions -------------------------------------
const NET_OK: Record<string, string> = {
  "local-saved": "Local registry connection saved.",
  "local-disconnected": "Local registry disconnected.",
  "remote-disconnected": "Remote registry disconnected.",
  requested: "Registry connection requested.",
  "requested-reset": "Registry connection reset requested.",
  cancelled: "Registry connection request cancelled.",
};
const NET_ERROR: Record<string, string> = {
  registry_unreachable: "The registry could not be reached. Please retry in a moment.",
  nango_unavailable: "The connection service (Nango) is unavailable. Please retry in a moment.",
  namespace_taken: "That namespace is already taken.",
  request_in_flight: "A registry request is already in flight. Wait for it to settle.",
  idempotency_conflict: "The request conflicted with a concurrent one. Please retry.",
  "setup-required": "Complete instance setup before configuring registries.",
  "url-required": "Registry URL is required.",
  "url-invalid": "Registry URL is not a valid URL.",
  "token-too-short": "Token must be at least 16 characters.",
  "email-invalid": "Enter a valid contact email.",
};

function entries(
  param: string,
  map: Record<string, string>,
  variant: "success" | "error",
): SearchParamToastConfig[] {
  return Object.entries(map).map(([value, message]) => ({ param, value, message, variant }));
}

export const REGISTRIES_FLASH_TOASTS: SearchParamToastConfig[] = [
  ...entries("vendor_application_ok", VENDOR_APP_OK, "success"),
  ...entries("vendor_application_error", VENDOR_APP_ERROR, "error"),
  { param: "publish_ok", value: "1", message: "Vendor registration submitted.", variant: "success" },
  ...entries("publish_error", PUBLISH_ERROR, "error"),
  { param: "visibility_ok", value: "1", message: "Profile visibility updated.", variant: "success" },
  ...entries("visibility_error", VISIBILITY_ERROR, "error"),
  { param: "rotate_ok", value: "1", message: "Registry token rotated.", variant: "success" },
  ...entries("rotate_error", ROTATE_ERROR, "error"),
  ...entries("net_ok", NET_OK, "success"),
  ...entries("net_error", NET_ERROR, "error"),
];
