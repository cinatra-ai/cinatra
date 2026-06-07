"use strict";

// ---------------------------------------------------------------------------
// Pure helpers for the bulk extension signer. NO I/O, NO credentials — all the
// registry/child-process/credential wiring lives in the CLI orchestrator. These
// helpers are unit-tested in isolation.
//
// The signature itself is produced by `scripts/extension-signer.mjs`
// (byte-compatible with the host verifier; signature-format-parity.test.ts
// cross-checks them) — these helpers only SELECT what to sign and SHAPE the
// metadata-only packument PATCH that serves it.
// ---------------------------------------------------------------------------

/** Keep only packages under the given npm scope (e.g. "@cinatra-ai"). */
export function filterScopePackages(packageNames, scope) {
  const prefix = `${scope}/`;
  return packageNames.filter((n) => typeof n === "string" && n.startsWith(prefix));
}

/**
 * Build the argv for `extension-signer.mjs sign`. The private key is NEVER on
 * argv — the caller passes it via `--key-file` (or the env the signer reads).
 */
export function buildSignerArgv({ packageName, version, integrity }) {
  if (!packageName || !version || !integrity) {
    throw new Error("buildSignerArgv: packageName, version and integrity are all required");
  }
  if (!/^sha512-/.test(integrity)) {
    throw new Error(`buildSignerArgv: integrity must be a sha512 SRI (got "${integrity}")`);
  }
  return ["sign", "--package", packageName, "--version", version, "--integrity", integrity];
}

/**
 * Return a NEW packument doc with `versions[version].dist.cinatraSignature` set
 * — the metadata-only PATCH body. Preserves EVERYTHING else (incl. `_rev`,
 * `dist.tarball/shasum/integrity`, all other versions) and adds NO `_attachments`
 * (so Verdaccio treats it as a metadata update, not a re-publish). Fail-closed:
 * throws when the version or its dist is absent (never invents a dist).
 */
export function injectSignatureIntoPackument(packument, version, signature) {
  if (!packument || typeof packument !== "object") throw new Error("injectSignatureIntoPackument: packument must be an object");
  if (!signature || typeof signature !== "string") throw new Error("injectSignatureIntoPackument: signature must be a non-empty string");
  const versions = packument.versions;
  if (!versions || typeof versions !== "object" || !versions[version]) {
    throw new Error(`injectSignatureIntoPackument: version ${version} not present in packument`);
  }
  const ver = versions[version];
  if (!ver.dist || typeof ver.dist !== "object" || typeof ver.dist.integrity !== "string") {
    throw new Error(`injectSignatureIntoPackument: version ${version} has no dist.integrity`);
  }
  // Structured clone WITHOUT _attachments (a metadata-only PUT must not re-upload
  // the tarball). Deep-copy via JSON is safe: packuments are plain JSON.
  const { _attachments, ...rest } = packument;
  const next = JSON.parse(JSON.stringify(rest));
  next.versions[version].dist.cinatraSignature = signature;
  return next;
}

/** Idempotency: the served packument already carries exactly this signature. */
export function isAlreadySigned(packument, version, signature) {
  const dist = packument?.versions?.[version]?.dist;
  return Boolean(dist && dist.cinatraSignature === signature);
}

/**
 * Guard before a metadata-only PATCH: the live packument must STILL carry the
 * EXACT sha512 integrity the signature was computed over. If the served artifact
 * changed since we resolved+signed it (re-publish / digest churn), the signature
 * would no longer bind the served bytes — throw and refuse to PATCH.
 */
export function assertServedIntegrityMatches(packument, version, expectedIntegrity) {
  const got = packument?.versions?.[version]?.dist?.integrity;
  if (got !== expectedIntegrity) {
    throw new Error(
      `served integrity for ${version} is "${got ?? "(absent)"}", expected "${expectedIntegrity}" — ` +
        "the artifact changed since signing; refusing to PATCH a signature that no longer binds the served bytes",
    );
  }
}

/** Resolve the push mode; PATCH is preferred (metadata-only), bump is the fallback. */
export function selectPushMode(mode) {
  const m = (mode ?? "patch").toLowerCase();
  if (m !== "patch" && m !== "bump") {
    throw new Error(`selectPushMode: unknown push mode "${mode}" (use "patch" or "bump")`);
  }
  return m;
}

/**
 * Summarize a signing run for the dry-run report / acceptance gate. `results` is
 * an array of `{ packageName, version, integrity, signature, verifiedLocal }`.
 */
export function summarizeRun(results) {
  const total = results.length;
  const signed = results.filter((r) => r.signature).length;
  const verified = results.filter((r) => r.verifiedLocal === true).length;
  const failed = results.filter((r) => r.error).length;
  return { total, signed, verified, failed, allVerified: total > 0 && verified === total && failed === 0 };
}
