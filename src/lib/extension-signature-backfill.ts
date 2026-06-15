import "server-only";

// ---------------------------------------------------------------------------
// Instance signature backfill.
//
// The boot trust gate reads the Ed25519 signature from the persisted install
// ROW (`installed_extension.source.signature`, via the install anchor) — NOT
// from the live packument. So once the marketplace starts serving
// `dist.cinatraSignature`, EXISTING install rows (installed before signing) keep
// a null `source.signature` and would be denied activation the moment
// `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`. This one-shot, boot-time
// pass backfills `source.signature` onto those rows so the fleet is ready BEFORE
// the flip.
//
// LIVE STATUSES: the install anchor treats `active` OR `locked` as a live
// install (`extension-install-anchor.ts` — `locked` = removal-protected, still
// activatable), reading `source.signature` + `source.closureHash` off either.
// So the backfill MUST cover both statuses; a `locked` row left unsigned would
// be denied activation the moment signatures become mandatory exactly like an
// `active` one.
//
// FAIL-CLOSED: for each live (active|locked) `verdaccio` row with a null
// signature, it re-resolves the served signature for the row's CONCRETE version
// and verifies it against the row's STORED {packageName, version, integrity}.
// It writes the signature ONLY when that verifies — it NEVER replaces the stored
// integrity/version, so a re-published / digest-changed artifact can never
// silently re-sign a stale row (those rows skip and require an operator
// re-install/update).
//
// CLOSURE HASH (cinatra#181): the activation-time v2 verdict reads
// `source.closureHash` and applies a downgrade-refusal matrix — a non-null
// closureHash requires a v2 signature binding that EXACT recomputed hash. So the
// backfill must NOT trust the row's recorded closureHash: it RECOMPUTES the hash
// from the served materialization plan (mirroring the install pipeline), feeds
// THAT to the verdict, and PERSISTS it alongside the signature. The persisted
// `source.closureHash` is therefore always the exact hash the persisted
// signature binds — so activation never sees a signature/hash mismatch. Rows are
// never DOWNGRADED (a row recorded WITH a closure is skipped if the registry no
// longer serves a plan) and never have their recorded closure REBASED to a
// different hash (counted failed, retried next boot).
//
// Inert + safe by construction: key-guarded (no-op until
// `CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS` is set), kill-switchable
// (`CINATRA_EXTENSION_SIGNATURE_BACKFILL=off`), idempotent (only touches
// null-signature rows), bounded per-row timeout, and soft-failing (never blocks
// boot). Writes ONLY through the sanctioned `sourceSwitchExtension` (so it stays
// out of the `installed_extension` raw-SQL guard, and provenance is
// re-validated on write).
// ---------------------------------------------------------------------------

import type { ExtensionSourceVerdaccio } from "@cinatra-ai/extensions/canonical-types";

/** Env lever: set to `off` to disable the pass entirely (kill switch). */
const KILL_SWITCH_ENV = "CINATRA_EXTENSION_SIGNATURE_BACKFILL";
const DEFAULT_PER_ROW_TIMEOUT_MS = 8000;

/** The install statuses the anchor treats as live (kept in sync with the anchor + dispatch/resolution `LIVE_STATUSES`). */
const LIVE_STATUSES = new Set(["active", "locked"]);

export type SignatureBackfillResult = {
  scanned: number;
  written: number;
  skipped: number;
  failed: number;
  /** Set when the whole pass short-circuited before scanning. */
  skippedReason?: "kill-switch" | "no-trusted-keys";
};

/** What the registry currently SERVES for a package@version (signature + the raw materialization plan transport). */
export type ServedSignature = {
  /**
   * The base64 Ed25519 signature served in `dist.cinatraSignature`, or null when
   * none is served.
   */
  signature: string | null;
  /**
   * The RAW served materialization plan transport (cinatra#181), passed through
   * UNVALIDATED — this module recomputes the closureHash from it. `null` when the
   * version carries no plan (the closure-less default).
   */
  materializationPlan: unknown;
};

export type SignatureBackfillDeps = {
  /** Number of host-configured trusted public keys (the key guard). */
  loadTrustedKeyCount: () => number;
  /** LIVE (active|locked) `verdaccio` install rows whose `source.signature` is null/empty. */
  listLiveVerdaccioRowsMissingSignature: () => Promise<
    Array<{ id: string; source: ExtensionSourceVerdaccio }>
  >;
  /**
   * What the registry currently SERVES for this exact package@version — the
   * `dist.cinatraSignature` (or null) AND the raw materialization plan transport
   * (or null). MAY throw on a registry/network error (→ counted as `failed`,
   * retried next boot).
   */
  resolveServed: (input: { packageName: string; version: string }) => Promise<ServedSignature>;
  /**
   * Recompute the closureHash the v2 signature must bind, from the raw served
   * materialization plan. The plan's self-declared identity MUST equal the
   * expected {packageName, version} (a mismatch THROWS → counted `failed`,
   * fail-closed). Returns the 128-hex sha512 closureHash. NEVER caller-trusted —
   * always derived from the parsed plan itself (mirrors the install pipeline).
   */
  recomputeClosureHash: (
    materializationPlan: unknown,
    expected: { packageName: string; version: string },
  ) => string;
  /**
   * Verify the served signature against the row's STORED {packageName, version,
   * integrity} plus the RECOMPUTED `closureHash` (null = closure-less / v1
   * semantics). `true` only when it verifies against a trusted key; anything else
   * (false/undefined) → skip (never write).
   */
  verifySignature: (
    fields: { packageName: string; version: string; integrity: string; closureHash?: string | null },
    signature: string,
  ) => boolean | undefined;
  /**
   * COMPARE-AND-SET write. Re-reads the row by id and persists the signature
   * (and the recomputed closureHash) via the sanctioned source-switch writer
   * ONLY if the row is STILL live (active|locked) + verdaccio, still has a null
   * signature, its stored {packageName, version, integrity} STILL equal the
   * `verified` fields the signature was checked against, AND its stored
   * closureHash is CAS-compatible with the recomputed one (equal, or a
   * null→real upgrade — never real→null / real→different). So a concurrent
   * update/reinstall/closure-change between scan and write can never be clobbered.
   * Returns "written" on success, "skipped-changed" on a CAS miss.
   */
  writeBackfilledSignature: (
    id: string,
    verified: { packageName: string; version: string; integrity: string; closureHash?: string | null },
    signature: string,
  ) => Promise<"written" | "skipped-changed">;
  perRowTimeoutMs?: number;
  log?: (msg: string) => void;
};

/**
 * The closureHash CAS rule (cinatra#181). The recomputed closureHash
 * we persist is exactly the one the verified v2 signature binds, so writing it
 * is safe — but we still guard provenance: allow only an EXACT match or a
 * `null → real` upgrade (a legacy row gaining its closure binding). A
 * `real → null` (downgrade) or `real → different` (rebase) is a CAS miss: the
 * concurrent/served closure state diverged from what the row recorded, so we
 * fail closed rather than rewrite the anchor's closure posture. Pure + exported
 * for direct testing.
 */
export function closureHashCasOk(stored: string | null | undefined, verified: string | null | undefined): boolean {
  const cur = stored ?? null;
  const next = verified ?? null;
  return cur === next || (cur === null && next !== null);
}

/**
 * The compare-and-set predicate for the write leg: write the backfilled signature
 * ONLY if the (re-read) row is still live (active|locked) + verdaccio + unsigned,
 * its stored {packageName, version, integrity} STILL equal the fields the
 * signature was verified against, and its stored closureHash is CAS-compatible
 * with the recomputed one. Pure + exported for direct testing.
 */
export function casShouldWrite(
  current:
    | { status: string; source: { type: string; signature?: string; packageName?: string; version?: string; integrity?: string; closureHash?: string } }
    | null
    | undefined,
  verified: { packageName: string; version: string; integrity: string; closureHash?: string | null },
): boolean {
  if (!current || !LIVE_STATUSES.has(current.status)) return false;
  const s = current.source;
  return (
    s.type === "verdaccio" &&
    !s.signature &&
    s.packageName === verified.packageName &&
    s.version === verified.version &&
    s.integrity === verified.integrity &&
    // cinatra#181: the recomputed closureHash we are about to persist
    // is the one the verified signature binds; allow an exact match or a
    // null→real upgrade, but never a real→null downgrade or a real→different
    // rebase (those mean the closure state diverged → fail-closed skip).
    closureHashCasOk(s.closureHash, verified.closureHash)
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`signature-backfill: per-row timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Run the backfill. Tests inject in-memory deps; boot uses the real deps wired by
 * `makeDefaultSignatureBackfillDeps()`. Never throws — soft-fails per row.
 */
export async function runExtensionSignatureBackfill(
  overrides: Partial<SignatureBackfillDeps> = {},
): Promise<SignatureBackfillResult> {
  const empty: SignatureBackfillResult = { scanned: 0, written: 0, skipped: 0, failed: 0 };

  // Kill switch — flat no-op.
  if ((process.env[KILL_SWITCH_ENV] ?? "").trim().toLowerCase() === "off") {
    return { ...empty, skippedReason: "kill-switch" };
  }

  const deps = overrides.loadTrustedKeyCount
    ? (overrides as SignatureBackfillDeps)
    : { ...(await makeDefaultSignatureBackfillDeps()), ...overrides };

  // Key guard — inert until the host trusts at least one signing key.
  if (deps.loadTrustedKeyCount() === 0) {
    return { ...empty, skippedReason: "no-trusted-keys" };
  }

  const timeoutMs = deps.perRowTimeoutMs ?? DEFAULT_PER_ROW_TIMEOUT_MS;
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;

  // Wrapped so the pass NEVER throws (enumeration/deps errors included) — the
  // contract is a soft no-op that boot can ignore.
  try {
    const rows = await deps.listLiveVerdaccioRowsMissingSignature();
    scanned = rows.length;

    for (const row of rows) {
      const { packageName, version, integrity } = row.source;
      // The row's RECORDED closure posture (scan-time) — used only for the
      // downgrade/rebase guards below; the verdict + persisted hash use the
      // RECOMPUTED value derived from the served plan, never this.
      const storedClosureHash = (row.source as { closureHash?: string }).closureHash ?? null;
      try {
        const served = await withTimeout(deps.resolveServed({ packageName, version }), timeoutMs);
        if (!served.signature) {
          skipped++;
          continue;
        }

        // cinatra#181: RECOMPUTE the closureHash from the served materialization
        // plan (never trust the row's recorded hash). A plan whose self-declared
        // identity mismatches {packageName, version} THROWS → counted failed
        // (fail-closed), retried next boot.
        let effectiveClosureHash: string | null = null;
        if (served.materializationPlan !== null && served.materializationPlan !== undefined) {
          effectiveClosureHash = deps.recomputeClosureHash(served.materializationPlan, { packageName, version });
        }

        // DOWNGRADE / REBASE guards: never weaken a row's recorded
        // closure posture. If the row recorded a closure but the registry no
        // longer serves a plan (real→null), or serves a plan yielding a
        // DIFFERENT hash (real→different), do NOT backfill — the closure state
        // diverged from what we durably recorded.
        if (storedClosureHash !== null && effectiveClosureHash === null) {
          skipped++;
          deps.log?.(`[signature-backfill] skip ${packageName}@${version}: row recorded a closureHash but the registry serves no plan (refusing v2→v1 downgrade)`);
          continue;
        }
        if (storedClosureHash !== null && effectiveClosureHash !== null && storedClosureHash !== effectiveClosureHash) {
          failed++;
          deps.log?.(`[signature-backfill] FAILED ${packageName}@${version} (soft, retried next boot): served plan recomputes a DIFFERENT closureHash than the row recorded (refusing closure rebase)`);
          continue;
        }

        // FAIL-CLOSED: verify the served signature against the row's STORED
        // {packageName, version, integrity} + the RECOMPUTED closureHash. Never
        // trust a signature that doesn't bind the bytes we actually installed;
        // never replace `integrity`.
        const verdict = deps.verifySignature({ packageName, version, integrity, closureHash: effectiveClosureHash }, served.signature);
        if (verdict !== true) {
          skipped++;
          deps.log?.(`[signature-backfill] skip ${packageName}@${version}: served signature did not verify against the stored integrity`);
          continue;
        }
        // COMPARE-AND-SET: re-read + write only if the row still matches what we
        // verified (a concurrent update/reinstall/closure-change cannot be
        // clobbered). Persist the RECOMPUTED closureHash so the persisted
        // signature and hash always agree.
        const outcome = await deps.writeBackfilledSignature(
          row.id,
          { packageName, version, integrity, closureHash: effectiveClosureHash },
          served.signature,
        );
        if (outcome === "written") written++;
        else {
          skipped++;
          deps.log?.(`[signature-backfill] skip ${packageName}@${version}: row changed between scan and write (CAS miss)`);
        }
      } catch (err) {
        failed++;
        deps.log?.(`[signature-backfill] FAILED ${packageName}@${version} (soft, retried next boot): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    deps.log?.(`[signature-backfill] enumeration failed (soft, retried next boot): ${err instanceof Error ? err.message : String(err)}`);
    return { scanned, written, skipped, failed: failed + 1 };
  }

  return { scanned, written, skipped, failed };
}

/** Build the real (server-only) deps. */
export async function makeDefaultSignatureBackfillDeps(): Promise<SignatureBackfillDeps> {
  const [
    { listInstalledExtensions, readInstalledExtensionById },
    { sourceSwitchExtension },
    { resolveExtensionDistIntegrity },
    { loadVerdaccioConfigForServer },
    { resolveSignatureVerdict, loadTrustedPublicKeys },
    { parseMaterializationPlan, computeClosureHash },
  ] = await Promise.all([
    import("@cinatra-ai/extensions/canonical-store"),
    import("@cinatra-ai/extensions/lifecycle-primitive"),
    import("@cinatra-ai/registries"),
    import("@/lib/verdaccio-config"),
    import("@/lib/extension-signature"),
    import("@/lib/extension-materialization-plan-core"),
  ]);

  return {
    loadTrustedKeyCount: () => loadTrustedPublicKeys().length,

    listLiveVerdaccioRowsMissingSignature: async () => {
      // The store filters on a single status; enumerate ALL rows and keep the
      // anchor's live set (active|locked) — a locked row is still activatable
      // and must be signed too.
      const rows = await listInstalledExtensions({});
      return rows
        .filter(
          (r) =>
            LIVE_STATUSES.has(r.status) &&
            r.source.type === "verdaccio" &&
            !(r.source as ExtensionSourceVerdaccio).signature,
        )
        .map((r) => ({ id: r.id, source: r.source as ExtensionSourceVerdaccio }));
    },

    resolveServed: async ({ packageName, version }) => {
      const config = await loadVerdaccioConfigForServer();
      const resolved = await resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
      return { signature: resolved.signature ?? null, materializationPlan: resolved.materializationPlan ?? null };
    },

    recomputeClosureHash: (materializationPlan, expected) => {
      // FAIL-CLOSED parse + identity bind, mirroring the install pipeline: the
      // plan must self-identify as the EXACT {packageName, version} of the row.
      const plan = parseMaterializationPlan(materializationPlan);
      if (plan.package.name !== expected.packageName || plan.package.version !== expected.version) {
        throw new Error(
          `[signature-backfill] ${expected.packageName}@${expected.version}: the served materialization plan ` +
            `identifies as ${plan.package.name}@${plan.package.version} — a plan must bind the exact recorded ` +
            `package; refusing`,
        );
      }
      return computeClosureHash(plan);
    },

    verifySignature: (fields, signature) =>
      // required:false — this backfill verifies additively; the fleet-wide flip
      // to mandatory signatures happens separately.
      resolveSignatureVerdict({ ...fields, signature }, { trustedKeys: loadTrustedPublicKeys(), required: false }),

    writeBackfilledSignature: async (id, verified, signature) => {
      // CAS: re-read the row and write only if it STILL matches what we verified.
      const current = await readInstalledExtensionById(id);
      if (!casShouldWrite(current, verified)) return "skipped-changed";
      await sourceSwitchExtension(
        id,
        {
          ...(current!.source as ExtensionSourceVerdaccio),
          signature,
          // Persist the RECOMPUTED closureHash so the persisted signature + hash
          // always agree (activation reads source.closureHash). Only set it when
          // non-null — a closure-less row keeps no closureHash key (v1 semantics).
          ...(verified.closureHash ? { closureHash: verified.closureHash } : {}),
        },
        { actor: { source: "system:signature-backfill" }, reason: "instance signature backfill" },
      );
      return "written";
    },
  };
}
