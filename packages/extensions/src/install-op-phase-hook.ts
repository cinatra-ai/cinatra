import "server-only";

// Install-op JOURNAL-phase reader seam (host-injected, mirroring
// `activate-hook.ts` / `capability-teardown-hook.ts`).
//
// The dispatcher decides "is this live canonical row non-finalized?" — i.e. is it
// a half-installed row the rollback must drop AND a re-install must re-run the
// pipeline against, NOT short-circuit as healthy. Historically that decision keyed
// off PLACEHOLDER integrity (`isNonFinalizedLiveRow`): a row whose `source.integrity`
// is still `dispatcher-install`/etc. The install pipeline records REAL provenance
// (real sha512 integrity) just BEFORE it finalizes the install-op journal, so there
// is a window where the row carries REAL integrity yet the journal is NOT finalized
// (a finalize that fails, or a crash between the two writes). An integrity-only check
// wrongly treats such a row as healthy → the rollback SKIPS it and a re-install SKIPS
// it, stranding an active-but-non-anchorable row forever.
//
// The AUTHORITATIVE non-finalized signal is the install-op journal phase: a live
// (package, org) whose `extension_install_ops` row is NOT `finalized` is
// non-finalized regardless of its integrity. That table lives in the host
// (`@/lib/extension-install-ops`), which `@cinatra-ai/extensions` cannot import
// (it would invert the dependency direction). So the host injects a phase reader
// via a `globalThis`-anchored slot, and the dispatcher consults it.
//
// FAIL-CLOSED + GRACEFUL: when no reader is wired (a worker that never loaded the
// host module, or an existing DI unit test) OR the reader returns `null` (no journal
// row yet / store unreachable), the caller falls back to the integrity-based check —
// so the journal read only ever TIGHTENS the decision (catches the real-integrity-
// but-unfinalized window), never loosens it.

/** Host-injected reader: the install-op journal phase for a (package, org), or
 *  `null` when there is no journal row (or the store is unreachable). May be sync
 *  or async; the consumer awaits it. */
export type ExtensionInstallOpPhaseReader = (
  packageName: string,
  orgId: string | null,
) => (string | null) | Promise<string | null>;

const PHASE_READER_SLOT = Symbol.for("cinatra.extensions.installOpPhaseReader.v1");
type ReaderHolder = { reader: ExtensionInstallOpPhaseReader | null };
function readerHolder(): ReaderHolder {
  const g = globalThis as unknown as Record<symbol, ReaderHolder | undefined>;
  return (g[PHASE_READER_SLOT] ??= { reader: null });
}

/** Host wiring entry: inject the install-op journal-phase reader. Pass `null` to
 *  clear (tests). */
export function setExtensionInstallOpPhaseReader(
  reader: ExtensionInstallOpPhaseReader | null,
): void {
  readerHolder().reader = reader;
}

/**
 * Read the install-op journal phase for `(packageName, orgId)` via the injected
 * host reader. Returns `null` when no reader is wired, no journal row exists, or
 * the read throws (best-effort — a read failure must NOT abort a rollback / install
 * decision; the caller falls back to the integrity-based check on `null`).
 */
export async function readExtensionInstallOpPhase(
  packageName: string,
  orgId: string | null,
): Promise<string | null> {
  const { reader } = readerHolder();
  if (!reader) return null;
  try {
    return await reader(packageName, orgId);
  } catch (err) {
    console.warn(
      `[cinatra:extensions] install-op phase reader threw for "${packageName}" ` +
        "(falling back to integrity-based non-finalized check):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
