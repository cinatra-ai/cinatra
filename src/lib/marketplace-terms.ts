import "server-only";

import { createHash } from "node:crypto";

/**
 * Single source of truth for the ToS payload sent to the marketplace as part
 * of `vendor_register_self`. Both `/setup/name` (first-run namespace
 * reservation via the marketplace) and the registries-card "register vendor"
 * action call this so the marketplace receives the same `terms_version` +
 * `terms_digest` regardless of entry point.
 *
 * The digest is a FULL sha256 of the terms-identifier bytes (version + url) —
 * the previous in-line truncated 16-char digest was undersized for the
 * marketplace contract (which requires ^[a-f0-9]{64}$). When we wire fetching
 * the actual ToS HTML/Markdown body, this digest will hash THOSE bytes;
 * meantime, hashing version+url keeps re-runs with the same intent idempotent.
 */
export interface MarketplaceTermsAcceptance {
  termsVersion: string;
  termsUrl: string;
  /** sha256(termsVersion|termsUrl) — full 64-char hex. */
  termsDigest: string;
  /** ISO timestamp captured at call-site. */
  termsAcceptedAt: string;
}

const TERMS_VERSION_DEFAULT = "0.1.0-DRAFT";
const TERMS_URL_DEFAULT     = "https://marketplace.cinatra.ai/terms";

/** Compute the canonical marketplace ToS payload for a vendor-side accept call. */
export function getMarketplaceTermsAcceptance(): MarketplaceTermsAcceptance {
  const termsVersion = process.env.MARKETPLACE_TERMS_VERSION?.trim() || TERMS_VERSION_DEFAULT;
  const termsUrl     = process.env.MARKETPLACE_TERMS_URL?.trim()     || TERMS_URL_DEFAULT;
  const termsDigest  = createHash("sha256").update(`${termsVersion}|${termsUrl}`).digest("hex");
  return {
    termsVersion,
    termsUrl,
    termsDigest,
    termsAcceptedAt: new Date().toISOString(),
  };
}
