import "server-only";

// ---------------------------------------------------------------------------
// Require-signatures readiness preflight (eng#162 — the SDK-P0 trust-gate floor).
//
// WHAT THIS ANSWERS: "If we armed `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`
// right now, would EVERY currently-activatable install still activate?" It is the
// GO/NO-GO gate the owner runs BEFORE flipping that production lever — the one
// remaining open item on eng#162. The signature backfill
// (`extension-signature-backfill.ts`) WRITES signatures onto legacy rows; this
// module PROVES the fleet would survive the flip. They are complementary: repair
// vs. confirmation.
//
// HOW: it enumerates every LIVE (active|locked) `verdaccio` install row and, for
// each, runs the EXACT activation-time verdict
// (`resolveSignatureVerdict(..., { required: true })`) over the row's STORED
// anchor fields {packageName, version, integrity, signature, closureHash} — the
// same fields `runtime-package-loader.ts` feeds at boot. `required: true`
// SIMULATES the flip WITHOUT touching any env or any row. A row is ready iff that
// simulated verdict is exactly `true` (a verified signature); `false`/`undefined`
// is NOT-READY (under require=true both deny activation).
//
// FLEET VERDICT: `ready` is true iff (a) at least one trusted signing key is
// configured (`trustedKeys.length > 0` — with zero keys nothing can verify, so
// the flip would deny everything) AND (b) every live row's simulated verdict is
// `true`. Zero live rows + ≥1 trusted key is trivially READY (nothing to deny).
//
// SAFETY: read-only by construction. It performs NO writes, NO env mutation, NO
// secret-value I/O (it counts trusted keys and reads only the public, non-secret
// anchor fields already persisted on the row). The CLI seam
// (`scripts/extensions/signature-readiness.mjs`) prints a `VERDICT: READY` /
// `VERDICT: NOT-READY` line and exits 0/1 — mirroring the ops gatekept-install
// `preflight.sh` ergonomics — so it can gate the owner's arming step.
// ---------------------------------------------------------------------------

import type { ExtensionSourceVerdaccio } from "@cinatra-ai/extensions/canonical-types";

/** The install statuses the anchor treats as live — kept in sync with the
 *  anchor + backfill `LIVE_STATUSES` (a `locked` row is removal-protected but
 *  still activatable, so it must be signature-ready too). */
const LIVE_STATUSES = new Set(["active", "locked"]);

/** Per-row readiness assessment (no secret material — identity + reason only). */
export type SignatureReadinessRow = {
  /** Canonical install row id. */
  id: string;
  /** The CANONICAL package identity (the `packageName` column) — the identity
   *  activation feeds the verdict (`rec.packageName`), not `source.packageName`. */
  packageName: string;
  version: string;
  /** Whether this row would still activate under `require-signatures=true`. */
  ready: boolean;
  /**
   * The simulated activation verdict the readiness check observed:
   *   - `verified`   → a verified signature (`true`) — READY;
   *   - `unverified` → `false` (present-but-invalid, OR required-but-missing) — NOT-READY;
   *   - `unsigned`   → `undefined` under require=false would no-op, but under the
   *                    simulated require=true it is a hard refusal — NOT-READY.
   *   - `identity-drift` → the row's canonical `packageName` column ≠ its
   *                    `source.packageName`; activation verifies the signature
   *                    payload against the CANONICAL name while the signature was
   *                    minted over one identity — a drifted row is suspect → hard
   *                    NOT-READY (we never even reach the crypto verdict).
   * (`unverified`/`unsigned`/`identity-drift` distinguish the NOT-READY shapes.)
   */
  verdict: "verified" | "unverified" | "unsigned" | "identity-drift";
  /** Human-readable remediation hint. */
  reason: string;
};

export type SignatureReadinessResult = {
  /** Fleet-level GO/NO-GO: safe to arm `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`. */
  ready: boolean;
  /** Number of host-configured trusted signing keys (presence count — never the values). */
  trustedKeyCount: number;
  /** Total live (active|locked) verdaccio rows considered. */
  scanned: number;
  /** Live rows that would still activate under require=true. */
  readyCount: number;
  /** Live rows that would be DENIED under require=true (the blockers). */
  notReadyCount: number;
  /** The NOT-READY rows (the actionable blockers), plus every row in `rows`. */
  rows: SignatureReadinessRow[];
  /** Set when the whole assessment short-circuited before scanning. */
  blockingReason?: "no-trusted-keys";
};

export type SignatureReadinessDeps = {
  /** Number of host-configured trusted public keys (the key guard). */
  loadTrustedKeyCount: () => number;
  /**
   * ALL live (active|locked) `verdaccio` install rows — both signed and
   * unsigned. `packageName` is the CANONICAL identity (the row's `packageName`
   * column) — the identity activation feeds the verdict — carried ALONGSIDE the
   * `source` so the readiness check can detect canonical-vs-source drift and use
   * the canonical name in the verdict payload (mirroring activation).
   */
  listLiveVerdaccioRows: () => Promise<
    Array<{ id: string; packageName: string; source: ExtensionSourceVerdaccio }>
  >;
  /**
   * Run the EXACT activation-time verdict with `required: true` over the row's
   * STORED anchor fields. Returns `true` (verified), `false` (present-but-invalid
   * or required-but-missing), or `undefined` (no signing configured — which the
   * required=true simulation already collapses to `false` internally, so callers
   * should only ever observe `true`/`false`, but the union is kept for fidelity
   * with `resolveSignatureVerdict`). MUST be the real verdict — never an
   * approximation.
   */
  simulateRequiredVerdict: (fields: {
    packageName: string;
    version: string;
    integrity: string;
    signature?: string | null;
    closureHash?: string | null;
  }) => boolean | undefined;
  log?: (msg: string) => void;
};

/**
 * Map a simulated verdict + the presence of a stored signature to the per-row
 * readiness shape. Pure + exported for direct testing.
 *
 * Under the require=true simulation: `true` is the ONLY ready state; both `false`
 * and `undefined` are NOT-READY. We split the NOT-READY reason by whether the row
 * carries a stored signature at all so the operator knows whether to re-sign
 * (no signature) or re-install/update (signature present but not verifying — e.g.
 * tampered, wrong key, or a v1/closure-mismatch downgrade refusal).
 */
export function classifyRowReadiness(
  verdict: boolean | undefined,
  hasStoredSignature: boolean,
): { ready: boolean; verdict: SignatureReadinessRow["verdict"]; reason: string } {
  if (verdict === true) {
    return { ready: true, verdict: "verified", reason: "verified signature binds the stored package identity + integrity" };
  }
  if (hasStoredSignature) {
    return {
      ready: false,
      verdict: "unverified",
      reason:
        "a signature is stored but does NOT verify against a trusted key under require=true " +
        "(tampered / wrong key / v1-or-closure downgrade refusal) — re-install or update the package",
    };
  }
  return {
    ready: false,
    verdict: "unsigned",
    reason:
      "no signature stored on the install row — run the signature backfill (boot pass, or re-install) " +
      "so the served signature is persisted before arming require-signatures",
  };
}

/**
 * Assess whether the fleet is ready for `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`.
 * Tests inject in-memory deps; the CLI uses `makeDefaultSignatureReadinessDeps()`.
 * NEVER throws on a per-row issue — but an enumeration failure DOES throw (the CLI
 * treats any throw as a hard NOT-READY, fail-closed: we must never report READY
 * on an incomplete scan).
 */
export async function assessSignatureReadiness(
  overrides: Partial<SignatureReadinessDeps> = {},
): Promise<SignatureReadinessResult> {
  // Only treat the overrides as a COMPLETE deps injection when ALL three
  // required functions are present (tests inject the full set). A PARTIAL
  // override must merge over the real defaults, or a missing function would
  // be undefined and crash mid-scan.
  const hasFullDepsOverride =
    typeof overrides.loadTrustedKeyCount === "function" &&
    typeof overrides.listLiveVerdaccioRows === "function" &&
    typeof overrides.simulateRequiredVerdict === "function";
  const deps = hasFullDepsOverride
    ? (overrides as SignatureReadinessDeps)
    : { ...(await makeDefaultSignatureReadinessDeps()), ...overrides };

  const trustedKeyCount = deps.loadTrustedKeyCount();

  // KEY GUARD (fail-closed): with zero trusted keys, NOTHING can verify, so
  // arming require=true would deny every live install. Short-circuit to NOT-READY
  // — but still enumerate the rows so the operator sees the blast radius.
  const rowsRaw = await deps.listLiveVerdaccioRows();
  const rows: SignatureReadinessRow[] = [];
  let readyCount = 0;
  let notReadyCount = 0;

  for (const row of rowsRaw) {
    // IDENTITY: activation feeds the verdict the CANONICAL `packageName` column
    // (`rec.packageName`) + the anchor's version/integrity/signature/closureHash
    // (which come from `source`). So we verify against the CANONICAL name, and
    // treat a canonical-vs-source drift as a hard NOT-READY (fail-closed — the
    // signature was minted over ONE identity; a drifted row is suspect and would
    // not verify the same way activation does).
    const canonicalPackageName = row.packageName;
    const { version, integrity } = row.source;
    const signature = row.source.signature ?? null;
    const closureHash = row.source.closureHash ?? null;

    if (canonicalPackageName !== row.source.packageName) {
      notReadyCount++;
      const reason =
        `canonical packageName column (${canonicalPackageName}) ≠ source.packageName (${row.source.packageName}) — ` +
        `activation verifies the signature against the CANONICAL identity; a drifted row is suspect, re-install it`;
      deps.log?.(`[signature-readiness] NOT-READY ${canonicalPackageName}@${version} (${row.id}): ${reason}`);
      rows.push({ id: row.id, packageName: canonicalPackageName, version, ready: false, verdict: "identity-drift", reason });
      continue;
    }

    // The EXACT activation verdict with require=true (the simulated flip) — over
    // the CANONICAL packageName, matching `runtime-package-loader.ts`.
    const verdict = deps.simulateRequiredVerdict({ packageName: canonicalPackageName, version, integrity, signature, closureHash });
    // Presence flag must mirror how `resolveSignatureVerdict` reads the signature
    // (it `.trim()`s it), so a whitespace-only value is classified as "unsigned"
    // (matching the verdict's view) rather than "unverified".
    const assessment = classifyRowReadiness(verdict, Boolean(signature?.trim()));
    if (assessment.ready) readyCount++;
    else {
      notReadyCount++;
      deps.log?.(`[signature-readiness] NOT-READY ${canonicalPackageName}@${version} (${row.id}): ${assessment.reason}`);
    }
    rows.push({ id: row.id, packageName: canonicalPackageName, version, ready: assessment.ready, verdict: assessment.verdict, reason: assessment.reason });
  }

  // Fleet verdict: ready iff ≥1 trusted key AND no NOT-READY row. The key guard is
  // independent of the per-row scan — even an all-rows-pass scan is NOT ready with
  // zero keys (a row with NO signature can be `ready:false` only via the verdict;
  // but with zero keys a SIGNED row also fails to verify, so notReadyCount already
  // reflects it — the explicit key guard makes the zero-rows-zero-keys case correct).
  const keysOk = trustedKeyCount > 0;
  const ready = keysOk && notReadyCount === 0;

  return {
    ready,
    trustedKeyCount,
    scanned: rowsRaw.length,
    readyCount,
    notReadyCount,
    rows,
    ...(keysOk ? {} : { blockingReason: "no-trusted-keys" as const }),
  };
}

/** Build the real (server-only) deps. Mirrors the backfill's default-deps wiring. */
export async function makeDefaultSignatureReadinessDeps(): Promise<SignatureReadinessDeps> {
  const [
    { listInstalledExtensions },
    { resolveSignatureVerdict, loadTrustedPublicKeys },
  ] = await Promise.all([
    import("@cinatra-ai/extensions/canonical-store"),
    import("@/lib/extension-signature"),
  ]);

  const trustedKeys = loadTrustedPublicKeys();

  return {
    loadTrustedKeyCount: () => trustedKeys.length,

    listLiveVerdaccioRows: async () => {
      // Enumerate ALL rows and keep the anchor's live set (active|locked) +
      // verdaccio — both signed and unsigned (the readiness check must see signed
      // rows to confirm they still verify, AND unsigned rows to flag them).
      // Carry the CANONICAL `packageName` column (the identity activation uses)
      // alongside the source so the assessor can detect drift.
      const installed = await listInstalledExtensions({});
      return installed
        .filter((r) => LIVE_STATUSES.has(r.status) && r.source.type === "verdaccio")
        .map((r) => ({ id: r.id, packageName: r.packageName, source: r.source as ExtensionSourceVerdaccio }));
    },

    simulateRequiredVerdict: (fields) =>
      // The EXACT activation verdict the boot loader runs — but with required:true
      // to SIMULATE the flip. trustedKeys is captured above (read-only). closureHash
      // is threaded through unchanged so the v2 downgrade-refusal matrix applies
      // identically to boot.
      resolveSignatureVerdict(fields, { trustedKeys, required: true }),
  };
}
