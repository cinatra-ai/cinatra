import "server-only";

import { Validator } from "@cfworker/json-schema";

import authInitSchema from "./wp-drupal-auth-init.schema.json";

// ---------------------------------------------------------------------------
// Versioned plugin↔core contract for the WordPress plugin / Drupal module
// assistant. The canonical contract (JSON Schemas + golden fixtures) lives in
// the cinatra-ai/wordpress-assistant-connector repo under
// contracts/wp-drupal-assistant/v1/ (shared with the Drupal assistant
// connector); this module is the cinatra-side runtime validator that pins the
// wire contract so a plugin built against one version fails loud
// (admin-visible) rather than silently when the contract later changes.
//
// The co-located wp-drupal-auth-init.schema.json is core's ENFORCED COPY of
// the canonical v1 auth-init schema (bundled, no runtime file I/O). The
// contract repo's CI deep-compares this copy against the canonical schema, so
// the two cannot drift silently — update both sides together.
//
// Forward-compatibility rule: to add a v2 contract, add v2 schemas in the
// contract repo, update the enforced copy here, and extend
// SUPPORTED_CONTRACT_VERSIONS + the per-version validator map below. The
// validator CORE does not change.
// ---------------------------------------------------------------------------

export const CURRENT_CONTRACT_VERSION = "v1" as const;

export const SUPPORTED_CONTRACT_VERSIONS = ["v1"] as const;

export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

export type ContractErrorCode =
  | "unsupported_contract_version"
  | "invalid_request_shape";

/**
 * Structured, admin-visible contract error. Serialised as the JSON body of a
 * 400 response (never a 500) so the CMS admin sees an actionable message in the
 * widget panel rather than an opaque server error.
 */
export type ContractError = {
  code: ContractErrorCode;
  message: string;
  supportedVersions: string[];
  received?: unknown;
};

export type ContractCheckResult =
  | { ok: true; legacy: boolean }
  | { ok: false; error: ContractError };

export function isSupportedContractVersion(
  value: unknown,
): value is ContractVersion {
  return (
    typeof value === "string" &&
    (SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(value)
  );
}

/**
 * Validate the `contractVersion` field of an incoming plugin/module request.
 *
 * - present + supported  → ok (legacy: false)
 * - present + unsupported → structured error (admin-visible)
 * - absent               → ok (legacy: true) — pre-contract callers are not
 *                          hard-broken at v0.1.0; callers may log a warning.
 *
 * Only an explicitly-present, unrecognised version is rejected — matching the
 * milestone requirement to "reject unknown contractVersion values".
 */
export function validateContractVersion(received: unknown): ContractCheckResult {
  if (received === undefined || received === null) {
    return { ok: true, legacy: true };
  }
  if (isSupportedContractVersion(received)) {
    return { ok: true, legacy: false };
  }
  return {
    ok: false,
    error: {
      code: "unsupported_contract_version",
      message:
        `This Cinatra instance does not support assistant contract version ` +
        `${JSON.stringify(received)}. Supported: ` +
        `${SUPPORTED_CONTRACT_VERSIONS.join(", ")}. Update the Cinatra plugin/` +
        `module on your CMS, or update this Cinatra instance.`,
      supportedVersions: [...SUPPORTED_CONTRACT_VERSIONS],
      received,
    },
  };
}

const authInitValidator = new Validator(
  authInitSchema as unknown as Record<string, unknown>,
  "2020-12",
);

/**
 * Validate a full stream-init (auth-init) request body against the v1 contract.
 *
 * Version is checked first so the admin-visible message is precise. When a
 * recognised `contractVersion` is present the body is validated against the
 * full auth-init JSON Schema; legacy (unversioned) callers skip strict shape
 * validation so they are not hard-broken.
 */
export function validateAuthInitRequest(body: unknown): ContractCheckResult {
  // Non-object bodies (null, arrays, primitives) are never a valid request —
  // including the "legacy" unversioned shape — so reject them up front rather
  // than letting a downstream `body.messages` access throw a 500.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: {
        code: "invalid_request_shape",
        message: "Assistant request body must be a JSON object.",
        supportedVersions: [...SUPPORTED_CONTRACT_VERSIONS],
        received: body,
      },
    };
  }

  const received = (body as { contractVersion?: unknown }).contractVersion;

  const versionCheck = validateContractVersion(received);
  if (!versionCheck.ok) {
    return versionCheck;
  }

  if (!versionCheck.legacy) {
    const result = authInitValidator.validate(body);
    if (!result.valid) {
      const detail = result.errors
        .map((e) => `${e.instanceLocation || "/"}: ${e.error}`)
        .slice(0, 5)
        .join("; ");
      return {
        ok: false,
        error: {
          code: "invalid_request_shape",
          message:
            `Assistant request does not conform to contract ` +
            `${CURRENT_CONTRACT_VERSION}: ${detail}`,
          supportedVersions: [...SUPPORTED_CONTRACT_VERSIONS],
          received,
        },
      };
    }
  }

  return versionCheck;
}
