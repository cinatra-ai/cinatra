import "server-only";

// Types live in @cinatra-ai/extension-types (dep-inversion package).
// Re-exported here for backward compat so existing consumers do not break.
export type {
  PackageRef,
  ValidationResult,
  Actor,
  ExtensionTypeHandler,
} from "@cinatra-ai/extension-types";

import type {
  ExtensionTypeHandler,
  PackageRef,
  ValidationResult,
  Actor,
} from "@cinatra-ai/extension-types";

// ---------------------------------------------------------------------------
// DanglingReferences type (re-exported from audit-log)
// ---------------------------------------------------------------------------
export type { DanglingReferences } from "./audit-log";
import type { DanglingReferences } from "./audit-log";
import { isNonFinalizedLiveRowAware } from "./non-finalized-row";

// ---------------------------------------------------------------------------
// ActiveDependentError: thrown when an active dependent
// blocks a hard-delete uninstall. The message is user-facing copy (matches
// UI-SPEC §dependency-blocking error copy).
// ---------------------------------------------------------------------------
export class ActiveDependentError extends Error {
  constructor(public readonly dependentName: string) {
    super(
      `Cannot uninstall — ${dependentName} requires this extension. Uninstall ${dependentName} first.`,
    );
    this.name = "ActiveDependentError";
  }
}

// ---------------------------------------------------------------------------
// extensionHasBeenUsed predicate
// Returns true when the extension's agent template has one or more agent_runs.
// Lives at the dispatcher layer (never inside handlers) per architecture spec.
// Dynamic import avoids circular dep: @cinatra-ai/agents -> @cinatra-ai/extensions.
// ---------------------------------------------------------------------------
export async function extensionHasBeenUsed(ref: PackageRef): Promise<boolean> {
  const { readAgentTemplateByPackageName, countRunsForTemplate } = await import("@cinatra-ai/agents");
  const template = await readAgentTemplateByPackageName(ref.packageName);
  if (!template) return false;
  return (await countRunsForTemplate(template.id)) > 0;
}

// Batch variant: single SQL join replaces N per-row round-trips.
// Dynamic import preserves the same circular-dep avoidance as extensionHasBeenUsed.
export async function extensionHasBeenUsedBatch(
  packageNames: string[],
): Promise<Set<string>> {
  if (packageNames.length === 0) return new Set();
  const { countRunsForTemplates } = await import("@cinatra-ai/agents");
  const counts = await countRunsForTemplates(packageNames);
  return new Set([...counts.entries()].filter(([, n]) => n > 0).map(([name]) => name));
}

// ---------------------------------------------------------------------------
// checkDependents (module-private)
// Reads all agent_templates that depend on ref.packageName.
// - Active dep → throws ActiveDependentError (hard block)
// - Archived dep only → returns { archivedDependentExists: true } (forces archive)
// - No deps → returns { archivedDependentExists: false } (permits hard-delete)
// ---------------------------------------------------------------------------
type DependentCascade = { archivedDependentExists: boolean };

async function checkDependents(ref: PackageRef): Promise<DependentCascade> {
  const { readAgentTemplatesDependingOn } = await import("@cinatra-ai/agents");
  const dependents = await readAgentTemplatesDependingOn(ref.packageName);
  if (dependents.length === 0) return { archivedDependentExists: false };

  // Resolve each dependent's status from the canonical manifest. An absent
  // canonical row defaults to "active" (fail-safe — over-block a destructive
  // uninstall rather than risk dropping a live dependent).
  const { readEffectiveStatusByPackageNames } = await import("./canonical-store");
  const depNames = dependents
    .map((d) => d.packageName)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  const statusMap = await readEffectiveStatusByPackageNames(depNames);
  const effective = (d: { packageName?: string | null }): "active" | "archived" =>
    (d.packageName ? statusMap.get(d.packageName) : undefined) ?? "active";

  const activeDep = dependents.find((d) => effective(d) === "active");
  if (activeDep) {
    throw new ActiveDependentError(
      activeDep.name ?? activeDep.packageName ?? "an active extension",
    );
  }
  const archivedDep = dependents.find((d) => effective(d) === "archived");
  return { archivedDependentExists: archivedDep !== undefined };
}

// ---------------------------------------------------------------------------
// Locked-row dispatcher guard.
//
// `assertNoLockedCanonicalRow` is a kind-agnostic pre-flight check invoked
// from every destructive entry point on the dispatcher (archive/uninstall/
// forceDelete). It refuses the op when ANY installed_extension row for the
// package name is currently `locked`. Per-org callers that hold an identity
// SHOULD call `enforceCanonicalManifest` directly for the richer structured
// error; this is the safety net for callers that don't.
// ---------------------------------------------------------------------------
export async function assertNoLockedCanonicalRow(
  packageName: string,
  op: "archive" | "uninstall" | "force_delete" | "purge" | "registry_remove",
): Promise<void> {
  // Fail CLOSED for system extensions even when the canonical store read
  // fails. A system extension must never be
  // archivable/uninstallable just because the manifest table is unreachable.
  const { isSystemExtension } = await import("./system-extension-inventory");
  const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
  let rows: Awaited<ReturnType<typeof readInstalledExtensionsByPackageName>> | null = null;
  try {
    rows = await readInstalledExtensionsByPackageName(packageName);
  } catch {
    // Canonical store not reachable (e.g. canonical table not yet provisioned
    // for this schema). Fall back to the static system-extension inventory so
    // locked system packages stay protected; non-system packages take the
    // legacy path (no manifest row yet → nothing to enforce).
    if (isSystemExtension(packageName)) {
      throw new Error(
        `Cannot ${op} ${packageName} — system extension (locked); manifest unreachable, refusing fail-open.`,
      );
    }
    return;
  }
  const locked = rows.find((r) => r.status === "locked");
  if (locked || isSystemExtension(packageName)) {
    const requiredInProd = locked?.requiredInProd ?? false;
    throw new Error(
      `Cannot ${op} ${packageName} — extension is locked${requiredInProd ? " (required-in-prod)" : ""}. Update is permitted; archive/uninstall is not.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Canonical manifest is wired into the real lifecycle flows. After a
// dispatcher op succeeds, the manifest is synced so
// `installed_extension` stays authoritative (not just seeded by the one-shot
// migration). Identity-agnostic: operates on every row matching the package
// name, since the kind-agnostic dispatcher does not carry org/owner identity
// (that lives at the install-action scope-picker layer).
// ---------------------------------------------------------------------------
// NON-best-effort. The canonical manifest is the only status store, so a
// failed canonical write must surface (no swallow). The per-kind handler's
// status write is removed — this dispatcher sync IS the lifecycle write.
// (assertNoLockedCanonicalRow already ran upstream for destructive ops, so a
// LOCKED_REJECTS_OP here would be a genuine invariant violation worth raising.)
async function syncCanonicalManifestTransition(
  packageName: string,
  op: "archive" | "activate" | "uninstall" | "force_delete",
  actor: Actor,
): Promise<void> {
  const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
  const { transitionExtensionLifecycle } = await import("./lifecycle-primitive");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  if (rows.length === 0) {
    // Data-quality signal: every installed package should have a canonical
    // row. Warn rather than throw so a legacy template without a
    // backfilled row does not hard-fail an archive/uninstall (grandfather).
    // eslint-disable-next-line no-console
    console.warn(
      `[extensions] syncCanonicalManifestTransition('${packageName}', '${op}') — no canonical installed_extension row to ${op}.`,
    );
    return;
  }
  for (const row of rows) {
    await transitionExtensionLifecycle(row.id, op, {
      actor: { source: actor.source ?? "dispatcher", userId: actor.userId },
      reason: `dispatcher ${op}`,
    });
  }
}

// Dependency-closure gate at the dispatcher.
// Refuses archive/uninstall when an ACTIVE canonical dependent requires the
// target. Resilient mid-migration (skips when the store is unreachable).
async function assertCanonicalArchiveClosure(packageName: string): Promise<void> {
  let allRows: Awaited<ReturnType<typeof import("./canonical-store").listInstalledExtensions>>;
  try {
    const { listInstalledExtensions } = await import("./canonical-store");
    allRows = await listInstalledExtensions({});
  } catch {
    return; // manifest unreachable — closure check is opportunistic
  }
  const target = allRows.find((r) => r.packageName === packageName);
  if (!target) return;
  const { assertArchiveDoesNotBreakClosure } = await import("./dependency-closure");
  // assertArchiveDoesNotBreakClosure throws DependencyClosureError naming the
  // blocking dependents; let it propagate as the structured refusal.
  assertArchiveDoesNotBreakClosure(target, allRows);
}

// Dependency-closure gate at the dispatcher for RESTORE.
// A restore re-activates an EXISTING canonical row whose `.dependencies` are
// already materialized (unlike a fresh dispatcher install, whose row starts
// with dependencies:[]), so a FORWARD closure check is meaningful: refuse the
// restore when the restored extension's REQUIRED deps are archived/missing.
// Mirrors assertCanonicalArchiveClosure — same opportunistic try/catch (skips
// when the manifest store is unreachable mid-migration).
async function assertCanonicalRestoreClosure(packageName: string): Promise<void> {
  let allRows: Awaited<ReturnType<typeof import("./canonical-store").listInstalledExtensions>>;
  try {
    const { listInstalledExtensions } = await import("./canonical-store");
    allRows = await listInstalledExtensions({});
  } catch {
    return; // manifest unreachable — closure check is opportunistic
  }
  // Restore re-activates the ARCHIVED rows for this package (a package may have
  // multiple canonical rows across org scopes). Validate the forward closure of
  // EACH row that will be re-activated — not just the first match — so we neither
  // miss a broken archived row nor block a valid restore because of an unrelated
  // same-package row.
  const targets = allRows.filter(
    (r) => r.packageName === packageName && r.status === "archived",
  );
  if (targets.length === 0) return; // nothing being re-activated
  // Each restored row's deps resolve through the SCOPE-AWARE lookup (own org
  // row, then platform row — a foreign org's live row never satisfies the
  // edge); an archived/missing dep is NOT "present" and counts as missing.
  const { assertInstallClosure, makeScopedManifestLookup, optionalMissingBehaviorForKind } =
    await import("./dependency-closure");
  // assertInstallClosure throws DependencyClosureError(REQUIRED_MISSING) naming
  // the missing deps for the first broken row; let it propagate as the refusal.
  // Its returned ClosureResult carries the missing OPTIONAL deps — restore
  // never blocks on those, but each is surfaced with the restored row's
  // per-kind optional-missing behavior so the operator knows what the run
  // layer will do about it (the behavior table in dependency-closure.ts).
  for (const target of targets) {
    const result = assertInstallClosure(
      target,
      makeScopedManifestLookup(allRows, target.organizationId),
    );
    if (result.missingOptional.length > 0) {
      const behavior = optionalMissingBehaviorForKind(target.kind);
      // eslint-disable-next-line no-console
      console.warn(
        `[extensions] restore of ${target.packageName} (kind=${target.kind}): optional ` +
          `dependencies missing/archived [${result.missingOptional
            .map((d) => `${d.packageName} (${d.status})`)
            .join(", ")}] — per-kind optional-missing behavior is "${behavior}".`,
      );
    }
  }
}

// The non-finalized-row predicates (`isNonFinalizedLiveRow` /
// `isNonFinalizedLiveRowAware`) + the placeholder-integrity set live in
// `./non-finalized-row` so the canonical lifecycle primitive can self-enforce its
// rollback-only delete contract against the SAME authoritative signal the
// dispatcher uses, without an import cycle.

type CanonicalInstallEnsure = {
  /** A canonical row now exists and the real-integrity pipeline MUST run for it
   *  (a new install OR a previously-broken non-finalized row being retried). */
  needsPipeline: boolean;
  /** The row id the pipeline targets — present whenever a row was ensured. Used
   *  by the dispatcher to ROLL BACK a never-finalized placeholder row if the
   *  pipeline does not finalize, so nothing is left active-but-non-anchorable. */
  rowId: string | null;
  /** True only when THIS call created a brand-new row (vs. reusing/retrying an
   *  existing non-finalized one OR re-activating an archived row). A rollback on
   *  pipeline failure deletes the row only when this call OWNS it (created it OR
   *  retried a non-finalized one); it never deletes a healthy finalized row. */
  ownsRollback: boolean;
};

// A github/local-sourced install (today: a GitHub or local skill ref) is NOT
// driven by the host's real-integrity verdaccio pipeline — the per-kind handler
// resolves + persists it from its `ref` source. The dispatcher must NOT create a
// `source.type:"verdaccio"`, `integrity:"dispatcher-install"` placeholder
// canonical row for such an install: that row would never be
// finalized by the pipeline (which only runs for verdaccio sources) and would be
// left active-but-non-anchorable forever, breaking the github/local carve-out.
//
// Discriminator mirrors `resolveSkillPackageSource`'s `isVerdaccioPackageRef`:
// a verdaccio target carries an `@<scope>/<pkg>` name OR an explicit version; a
// github/local target is a bare `owner/repo` with no version. Agents / connectors
// / workflows / artifacts are always verdaccio-backed, so they classify verdaccio
// here (scoped name + version), and the carve-out only ever fires for the
// github/local skill path it is meant for.
function isVerdaccioBackedRef(ref: PackageRef): boolean {
  if (typeof ref.packageName === "string" && ref.packageName.startsWith("@")) return true;
  if (typeof ref.version === "string" && ref.version.length > 0) return true;
  return false;
}

// Ensure EXACTLY ONE canonical row (at the actor's org scope) before the native
// handler + the real pipeline run (the host installer owns this ordering). Cases:
//   - archived row(s) only → restore (re-activate the exact archived row); NO
//     pipeline (a restore never re-materializes). needsPipeline:false.
//   - a live row with PLACEHOLDER integrity (a fresh row from a prior call, or a
//     broken/never-finalized prior attempt) → RE-RUN the pipeline against it.
//     needsPipeline:true, ownsRollback:true.
//   - op:"update" + a live FINALIZED row → re-run the pipeline to materialize the
//     new version against the SAME row. needsPipeline:true, ownsRollback:FALSE (a
//     failed update must not delete the previously-working install).
//   - op:"install" + a live FINALIZED row → already installed; NO pipeline re-run.
//     needsPipeline:false.
//   - no row → create the placeholder row (org-scoped, else platform) + RUN the
//     pipeline. needsPipeline:true, ownsRollback:true.
async function syncCanonicalManifestInstall(
  packageName: string,
  kind: string,
  ref: PackageRef,
  actor: Actor,
  orgId: string | null,
  op: "install" | "update",
): Promise<CanonicalInstallEnsure> {
  // Carve-out: a github/local-sourced install (a GitHub/local skill
  // ref) is NOT verdaccio-pipeline-driven — the handler resolves + persists it.
  // Do NOT ensure a verdaccio placeholder canonical row for it (it would never
  // finalize and would strand an active non-anchorable row). No row, no pipeline,
  // no rollback — the handler owns the install entirely.
  if (!isVerdaccioBackedRef(ref)) {
    return { needsPipeline: false, rowId: null, ownsRollback: false };
  }
  // Read the existing rows OUTSIDE the create/transition logic so we can
  // distinguish a genuine store-unreachable read failure (legacy mid-migration —
  // swallow, the legacy path ran) from a real row-creation/provenance failure
  // (must NOT be swallowed into a false `needsPipeline:false`).
  let all: Awaited<ReturnType<typeof import("./canonical-store").readInstalledExtensionsByPackageName>>;
  try {
    const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
    all = await readInstalledExtensionsByPackageName(packageName);
  } catch (err) {
    // Canonical store unreachable (canonical table not yet provisioned for this
    // schema). For a hot-loadable-module kind (connector) this is fatal — a
    // connector install REQUIRES a finalized canonical row + the real-integrity
    // pipeline, so a swallowed read failure here would no-op the dispatcher into a
    // false success (no row, no pipeline, no hot activation). Fail
    // loud. For non-hot-loadable kinds the legacy per-handler path still ran, so
    // skip the manifest sync (grandfather mid-migration).
    if (KINDS_USING_ACTIVATE_HOOK.has(kind)) {
      throw new Error(
        `install of ${packageName} could not ensure its canonical install row ` +
          `(canonical store unreachable: ${err instanceof Error ? err.message : String(err)}) — ` +
          `a kind:"${kind}" install requires a finalized canonical row + the real-integrity ` +
          `pipeline; refusing to report a placeholder success.`,
      );
    }
    return { needsPipeline: false, rowId: null, ownsRollback: false };
  }

  try {
    const { installExtensionManifest, transitionExtensionLifecycle } = await import(
      "./lifecycle-primitive"
    );
    const { isPackageRequiredInProd } = await import("./required-in-prod");
    // Operate on the rows at THIS install's org scope only — the pipeline + the
    // workflow saga both resolve the single (package, org) row via
    // pickSingleActiveRow, so the dispatcher must ensure/retry/roll back the row
    // at the SAME scope (a different org's row is unrelated to this install).
    const existing = all.filter((r) => (r.organizationId ?? null) === orgId);
    if (existing.length > 0) {
      // Re-activate any archived rows (locked rows are left as-is; transition
      // refuses them). Track the re-activated row: archive tore down the package's
      // in-memory register(ctx) registrations, so a RESTORE must RE-REGISTER the
      // package in-process (via the activate hook) — it is NOT enough to flip the
      // status. The activate path is idempotent + does not re-record a new
      // version's provenance (it re-runs the SRI-checked materialize against the
      // already-finalized digest + hot-activates).
      let reactivatedArchivedRow: { id: string; source: unknown } | null = null;
      for (const row of existing) {
        if (row.status === "archived") {
          try {
            await transitionExtensionLifecycle(row.id, "activate", {
              actor: { source: actor.source ?? "dispatcher", userId: actor.userId },
              reason: "dispatcher re-install",
            });
            reactivatedArchivedRow = { id: row.id, source: row.source };
          } catch {
            /* locked / race — ignore */
          }
        }
      }
      // A live row the pipeline never finalized is a broken prior attempt — RE-RUN
      // the pipeline against it. ownsRollback:true: it was never a healthy install,
      // so a failed retry may drop it. JOURNAL-AWARE: catches not only placeholder
      // integrity but also the provenance-before-finalize window (real integrity
      // recorded, journal NOT finalized) — otherwise such a row reads as healthy
      // and the re-install wrongly short-circuits it (leaving it non-anchorable).
      let broken: (typeof existing)[number] | undefined;
      for (const r of existing) {
        if (await isNonFinalizedLiveRowAware(r)) {
          broken = r;
          break;
        }
      }
      if (broken) {
        return { needsPipeline: true, rowId: broken.id, ownsRollback: true };
      }
      // A restored archived row needs the activate hook to RE-REGISTER in-process
      // (Finding 5 — archive torn down its registrations). ownsRollback:FALSE: a
      // non-finalizing re-activate must NEVER delete a healthy prior install (it
      // is restorable). Only a hot-loadable-module kind (connector) actually
      // re-registers; for other kinds the dispatcher's KINDS_USING_ACTIVATE_HOOK
      // gate skips the hook, so this is a harmless needsPipeline:true that no-ops.
      if (reactivatedArchivedRow) {
        return { needsPipeline: true, rowId: reactivatedArchivedRow.id, ownsRollback: false };
      }
      // An UPDATE of a healthy (finalized, real-provenance) live row MUST re-run
      // the pipeline to materialize the NEW version (new digest), record its new
      // provenance against the SAME row, finalize, and hot-activate (GC'ing the
      // superseded digest). ownsRollback:false — a failed update must NEVER delete
      // the previously-working install; the hot-update path leaves the old digest
      // intact on a non-finalizing new digest.
      const live = existing.find((r) => r.status === "active" || r.status === "locked");
      if (op === "update" && live) {
        return { needsPipeline: true, rowId: live.id, ownsRollback: false };
      }
      // INSTALL of an already-finalized live row.
      //
      // Finding 1: a fresh connector install can FINALIZE (the row is real +
      // anchorable) yet FAIL in-process hot-activation this call (anchor-refused /
      // activate-threw / no-host-hook). That throws — but leaves a real active
      // finalized row. Without this branch a RETRY (`install` again) would hit
      // "already installed" and return needsPipeline:false, NEVER re-firing the
      // activate hook → the connector stays anchorable-but-not-loaded in this
      // process until a restart, and "retry re-runs the pipeline / hot-activates"
      // is violated. For a hot-loadable-module kind (connector) an install of a
      // healthy finalized live row therefore RE-FIRES the activate hook (which is
      // idempotent: it re-runs the SRI-checked materialize against the already-
      // finalized digest + replace-in-place re-registers in-process). ownsRollback
      // is FALSE — the row is healthy + finalized, so a re-activation failure must
      // NEVER delete it (it is restorable + the boot loader is the durable path).
      if (live && KINDS_USING_ACTIVATE_HOOK.has(kind)) {
        return { needsPipeline: true, rowId: live.id, ownsRollback: false };
      }
      // INSTALL of an already-finalized live row for a NON-hot-loadable kind —
      // already installed; no runtime module to re-activate. No pipeline re-run (a
      // restore handled archived rows above). ownsRollback:false.
      return { needsPipeline: false, rowId: null, ownsRollback: false };
    }
    // New install — create the placeholder canonical row at the actor's org scope
    // (platform-scoped when the actor has no active org). Required-in-prod implies
    // locked in non-dev mode.
    const requiredInProd = isPackageRequiredInProd(packageName);
    const isDev = process.env.CINATRA_RUNTIME_MODE === "development";
    const { randomUUID } = await import("node:crypto");
    const id = `iext_${randomUUID().slice(0, 12)}`;
    await installExtensionManifest(
      {
        id,
        packageName,
        ownerLevel: orgId ? "organization" : "platform",
        ownerId: orgId,
        organizationId: orgId,
        kind: kind as never,
        source: {
          type: "verdaccio",
          registryUrl: ref.registryUrl || "http://localhost:4873",
          packageName,
          // ref.version is the resolved install version; fall back to 0.0.0
          // (a real, non-placeholder version) so provenance validation passes.
          version: ref.version || "0.0.0",
          integrity: "dispatcher-install",
        },
        requiredInProd,
        // SEED ONLY (#180): the manifest is not readable pre-materialize, so
        // the row starts with no edges. Every MATERIALIZING install path
        // (runtime pipeline, workflow saga, agent installer) persists the
        // manifest's REAL `cinatra.dependencies` edges at its finalize seam
        // via `recordExtensionDependencies` — a finalized install implies
        // persisted edges; this `[]` only ever survives on rows the pipeline
        // never finalized.
        dependencies: [],
        manifestHash: null,
        status: requiredInProd && !isDev ? "locked" : "active",
      },
      {
        actor: { source: actor.source ?? "dispatcher", userId: actor.userId },
        reason: "dispatcher install",
      },
    );
    return { needsPipeline: true, rowId: id, ownsRollback: true };
  } catch (err) {
    // A failure ROW-CREATING / RE-ACTIVATING the canonical row (e.g.
    // installExtensionManifest provenance validation throws, transition throws).
    // For a hot-loadable-module kind (connector) this must NOT be swallowed into a
    // false `needsPipeline:false` — that would no-op the dispatcher into a silent
    // placeholder-as-success with no row, no pipeline, no hot activation
    // (Finding 1). Fail loud so the dispatch reports the truth + rolls nothing
    // back (no row was ensured). For non-hot-loadable kinds the legacy
    // per-handler path still ran, so swallow (grandfather mid-migration).
    if (KINDS_USING_ACTIVATE_HOOK.has(kind)) {
      throw new Error(
        `install of ${packageName} could not ensure its canonical install row ` +
          `(${err instanceof Error ? err.message : String(err)}) — a kind:"${kind}" install ` +
          `requires a finalized canonical row + the real-integrity pipeline; refusing to ` +
          `report a placeholder success.`,
      );
    }
    // canonical store unreachable mid-migration — skip (legacy path ran). No row
    // ensured → no pipeline, no rollback.
    return { needsPipeline: false, rowId: null, ownsRollback: false };
  }
}

// Roll back a never-finalized placeholder canonical row when the real-integrity
// pipeline did NOT finalize — so the dispatch never leaves a live-but-non-
// anchorable row that a later install would skip. Deletes via the internal store
// (bypasses the lifecycle lock guard: this is a rollback of a row the SAME
// install attempt just created/retried and that NEVER became anchorable — never
// a healthy install). Best-effort: a rollback failure is logged, not thrown (the
// row stays non-anchorable; a later install detects the placeholder integrity and
// re-runs the pipeline anyway). Re-reads the row first so a row another path
// finalized concurrently is NEVER dropped.
async function rollbackNonFinalizedCanonicalRow(rowId: string): Promise<void> {
  try {
    const { readInstalledExtensionById } = await import("./canonical-store");
    const { deleteNonFinalizedCanonicalRow } = await import("./lifecycle-primitive");
    const row = await readInstalledExtensionById(rowId);
    if (!row) return;
    // Defense: only drop a row that is STILL non-finalized. JOURNAL-AWARE — a row
    // whose REAL provenance was recorded but whose install-op journal never
    // finalized (the provenance-before-finalize window) is non-anchorable and MUST
    // be rollbackable; the integrity check alone would wrongly skip it as healthy.
    // If something genuinely finalized it (journal `finalized`) between the pipeline
    // result and here, leave it.
    const nonFinalized = await isNonFinalizedLiveRowAware({
      status: row.status,
      source: row.source,
      packageName: row.packageName,
      organizationId: row.organizationId,
    });
    if (!nonFinalized) return;
    await deleteNonFinalizedCanonicalRow(rowId);
  } catch (err) {
    console.warn(
      `[extensions] rollback of non-finalized canonical row '${rowId}' failed (left non-anchorable; a re-install re-runs the pipeline):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// The kinds whose handler ALREADY runs the full real-integrity pipeline
// (materialize → provenance → finalize) itself, so the dispatcher must NOT also
// fire the generic activate hook (that would double-materialize). `workflow`'s
// host-injected saga (handler.install) does materialize+provenance+finalize +
// the per-project dashboard fan-out. The other kinds (agent/skill/artifact) do
// NOT hot-load a `register(ctx)` server module, so the generic package-store
// activate path is skipped for them too — only kinds that ship a hot-loadable
// runtime module need it. Today that is `connector` (model-B / schema-config).
const KINDS_USING_ACTIVATE_HOOK = new Set(["connector"]);

// ---------------------------------------------------------------------------
// Extension type registry
// ---------------------------------------------------------------------------

class ExtensionRegistryImpl {
  private handlers: Map<string, ExtensionTypeHandler> = new Map();

  register(handler: ExtensionTypeHandler): void {
    this.handlers.set(handler.typeId, handler);
  }

  /** True if a handler for this typeId is already registered. */
  has(typeId: string): boolean {
    return this.handlers.has(typeId);
  }

  /** Non-throwing handler lookup — returns null when no handler is registered.
   *  Used by the runtime-discovery dispatcher, which treats an unknown kind in an
   *  active manifest as a skipped/unmigrated kind, never a fatal error. */
  tryResolve(typeId: string): ExtensionTypeHandler | null {
    return this.handlers.get(typeId) ?? null;
  }

  /** Register only if absent — preserves a previously-registered handler (e.g. a
   *  deps-injected one from the app boot path) regardless of module load order. */
  registerIfAbsent(handler: ExtensionTypeHandler): void {
    if (!this.handlers.has(handler.typeId)) this.handlers.set(handler.typeId, handler);
  }

  private resolve(typeId: string): ExtensionTypeHandler {
    const handler = this.handlers.get(typeId);
    if (!handler) {
      throw new Error(
        `No extension handler registered for typeId: "${typeId}"`,
      );
    }
    return handler;
  }

  /** options.destination selects the publish registry ("private" | "public").
   *  Forwarded to the handler; each concrete handler owns its routing. */
  async install(
    typeId: string,
    ref: PackageRef,
    actor: Actor,
    options?: { destination?: "private" | "public" },
  ): Promise<void> {
    await this.runHostInstall(typeId, ref, actor, "install", options);
  }

  async update(typeId: string, ref: PackageRef, actor: Actor): Promise<void> {
    await this.runHostInstall(typeId, ref, actor, "update");
  }

  // ---------------------------------------------------------------------------
  // The host installer OWNS the install/update sequence (NOT a per-handler
  // post-hook). For a verdaccio-source install or update it:
  //   1. ensures EXACTLY ONE canonical row (idempotent; a never-finalized prior
  //      row is RETRIED, not skipped) — at the actor's org scope so the native
  //      handler/saga + the pipeline resolve the SAME row;
  //   2. runs the native per-kind handler (`install`/`update`) — for workflow the
  //      host-injected saga (which itself materializes + records provenance +
  //      finalizes against the row from step 1) runs here; for connector the
  //      handler is a model-B no-op / requires-rebuild gate;
  //   3. for a kind that ships a hot-loadable runtime module (connector), fires
  //      the host activate hook = the REAL-integrity pipeline (materialize →
  //      provenance → finalize → in-process activate); and
  //   4. if the pipeline did NOT finalize the row THIS attempt created/retried,
  //      ROLLS BACK that placeholder row — so nothing is left active-but-non-
  //      anchorable and a re-install re-runs the pipeline. The in-process
  //      activation half stays best-effort (the boot loader is the durable path);
  //      only the FINALIZE gate is authoritative for success.
  //
  // Carve-outs preserved: restore/re-install (archived row re-activated, NO
  // pipeline); add-from-chat (proposal-only, never reaches this dispatch);
  // github/local skill installs (resolved INSIDE the handler from the ref source
  // — the handler runs in step 2, the activate hook then no-ops because the
  // package was never materialized into the verdaccio package store).
  // ---------------------------------------------------------------------------
  private async runHostInstall(
    typeId: string,
    ref: PackageRef,
    actor: Actor,
    op: "install" | "update",
    options?: { destination?: "private" | "public" },
  ): Promise<void> {
    // Serialize the WHOLE direct-install path (ensure-row → native handler →
    // real-integrity pipeline finalize → rollback) under the per-package install
    // lock — the SAME lock the workflow saga + extension-handler hold. Without it
    // two concurrent installs/retries of the same package can interleave: one
    // attempt finalizes the row's install-op journal while the other's rollback
    // reads it as still-non-finalized and hard-deletes the now-healthy row. The
    // lock is re-entrant via ALS, so the workflow saga's nested withInstallLock
    // acquire (same package, same async context) runs inline — no deadlock.
    // Dynamic import: @cinatra-ai/agents → @cinatra-ai/extensions is a static cycle.
    const { withInstallLock } = await import("@cinatra-ai/agents");
    return withInstallLock(ref.packageName, () =>
      this.runHostInstallLocked(typeId, ref, actor, op, options),
    );
  }

  private async runHostInstallLocked(
    typeId: string,
    ref: PackageRef,
    actor: Actor,
    op: "install" | "update",
    options?: { destination?: "private" | "public" },
  ): Promise<void> {
    const handler = this.resolve(typeId);

    // 0. REQUIRED-PIN GATE (the host → extension half of the compatibility
    //    contract). A package PINNED in the host's `cinatra.requiredExtensions`
    //    may only be installed/updated at a CONCRETE version satisfying the
    //    pinned range — so an update can never silently move a required
    //    extension outside the host's declared compatibility intent, on ANY
    //    kind's path (connector pipeline, workflow saga, agent/skill/artifact
    //    handlers — they all dispatch through here). Pure read of the host's
    //    own package.json, BEFORE the row-ensure/handler/pipeline mutations, so
    //    a refused op leaves nothing to roll back. The MCP install/update
    //    handlers already dispatch the registry-RESOLVED concrete version, so a
    //    dist-tag input never reaches a pinned package's gate unresolved.
    {
      const { checkRequiredExtensionVersionPin } = await import("./required-in-prod");
      const pin = checkRequiredExtensionVersionPin({
        packageName: ref.packageName,
        version: ref.version,
        op,
      });
      if (!pin.ok) throw new Error(pin.reason);
    }

    // 1. Ensure exactly one canonical row BEFORE the native handler (so the
    //    workflow saga's recordProvenance + the pipeline both resolve it — the
    //    Finding-4 ordering fix). Scoped to the actor's org so the saga (org-
    //    scoped) and the activate hook (passed the same org) bind the SAME row.
    const orgId = actor.orgId ?? null;
    const ensure = await syncCanonicalManifestInstall(ref.packageName, typeId, ref, actor, orgId, op);

    // 2. Native per-kind handler. For workflow this is the host-injected saga,
    //    which materializes + records provenance + finalizes against the row from
    //    step 1. A handler throw propagates — but first roll back a placeholder
    //    row THIS attempt owns, so a failed handler never leaves a live-but-non-
    //    anchorable row.
    try {
      if (op === "update") {
        await handler.update(ref, actor);
      } else {
        await handler.install(ref, actor, options);
      }
    } catch (err) {
      if (ensure.ownsRollback && ensure.rowId) {
        await rollbackNonFinalizedCanonicalRow(ensure.rowId);
      }
      throw err;
    }

    // 3 + 4. For a hot-loadable-module kind (connector), run the REAL-integrity
    //    pipeline via the host activate hook and gate success on its `finalized`.
    //    Workflow/agent/skill/artifact do NOT use this path (workflow's saga
    //    already finalized in step 2; the others ship no runtime module).
    if (!ensure.needsPipeline || !KINDS_USING_ACTIVATE_HOOK.has(typeId)) return;

    const { fireExtensionActivate } = await import("./activate-hook");
    // Pass `ref.version` as the REQUESTED install/target version. On an UPDATE the
    // canonical row still carries the OLD version (provenance is rewritten only at
    // the tail of the pipeline), so the host hook MUST use the requested version —
    // otherwise the pipeline re-installs the old version and the new one is never
    // materialized. A fresh install already has `row.source.version === ref.version`.
    const result = await fireExtensionActivate(ref.packageName, orgId, ref.version);

    // The activate hook reports two distinct signals from the real pipeline:
    //   - `finalized`: the install committed (real provenance recorded + journal
    //     finalized → the row is trusted-anchorable);
    //   - `activated`: the package was hot-loaded (register(ctx)) in THIS process.
    //
    // For a hot-loadable-module kind (connector) the owner-locked invariant is
    // "install AND update must hot-activate in-process with NO restart". So BOTH
    // signals must be true for the op to report success — a finalized-but-not-
    // activated result is NOT success here (that is the placeholder-as-success
    // regression Findings 1/3 name).
    //
    // finalized === false (a host hook ran but the pipeline did NOT finalize):
    //   the package is NOT anchorable, so the op must report a TRUTHFUL failure
    //   (never a silent success on a non-materialized package). When THIS attempt
    //   owns the row (a fresh install OR a retried broken row), roll it back so a
    //   re-install re-runs the pipeline. For an UPDATE of a previously-healthy row
    //   (ownsRollback:false) we do NOT roll back — the old finalized digest
    //   survives intact (the hot-update path left it in place) — but we still THROW
    //   so update does not report success.
    if (result.finalized === false) {
      if (ensure.ownsRollback && ensure.rowId) {
        await rollbackNonFinalizedCanonicalRow(ensure.rowId);
        throw new Error(
          `${op} of ${ref.packageName} did not finalize the real-integrity pipeline ` +
            `(${result.reason ?? "unknown"}) — the package is not anchorable; the placeholder ` +
            `install row was rolled back so a re-install re-runs the pipeline.`,
        );
      }
      throw new Error(
        `${op} of ${ref.packageName} did not finalize the real-integrity pipeline ` +
          `(${result.reason ?? "unknown"}) — the new digest is not anchorable; the previous ` +
          `install (if any) was left intact.`,
      );
    }

    // finalized === undefined (no host hook ran — e.g. a worker that never wired
    //   the activate hook): for a connector this is the fail-closed regression
    //   Finding 3 names. The dispatcher reached the hot-loadable-module path
    //   (needsPipeline + a connector kind), so a NEW install MUST hot-activate; a
    //   missing host hook means the running process will NOT pick the package up
    //   without a restart, violating the invariant. Roll back a row THIS attempt
    //   owns (a placeholder the trust anchor refuses anyway) and THROW so the op
    //   reports the truth (the placeholder-as-success path is closed).
    if (result.finalized === undefined) {
      if (ensure.ownsRollback && ensure.rowId) {
        await rollbackNonFinalizedCanonicalRow(ensure.rowId);
      }
      throw new Error(
        `${op} of ${ref.packageName} could not hot-activate in-process ` +
          `(${result.reason ?? "no-host-hook"}) — the runtime activate hook is not wired in this ` +
          `worker, so the package would not load without a restart. Run the op through a context ` +
          `that wires the host activate hook (the MCP / app-boot path).`,
      );
    }

    // Design B (ATOMIC HOT-UPDATE WITH DURABLE-ROLLBACK-FIRST): rolledBack === true
    //   means this was an UPDATE whose NEW digest failed live activation and the
    //   install was rolled back to the previous version. THROW so the op reports the
    //   truthful "update did not take" failure (never a silent success).
    //
    //   HIGH 3 — the rollback may be CLEAN or only PARTIAL:
    //     - rollbackComplete === true: EVERY durable restore step (OLD provenance +
    //       journal + grant) succeeded → the previous version is fully retained +
    //       remains anchorable. Calm "previous version retained, re-attempt later".
    //     - rollbackComplete !== true: ≥1 durable restore step FAILED → the durable
    //       state is only PARTIALLY restored. We must NOT calmly claim the previous
    //       version is retained. Throw a LOUD manual-recovery error (the OLD digest
    //       is still quarantined/restorable on disk + boot-recoverable, but the
    //       durable anchor is inconsistent and an operator must reconcile it).
    if (result.rolledBack === true) {
      if (result.rollbackComplete !== true) {
        throw new Error(
          `${op} of ${ref.packageName} FAILED and the durable rollback is INCOMPLETE — ` +
            `manual recovery required (the previous digest is quarantined/restorable on disk and ` +
            `boot-recoverable, but at least one durable restore step did not complete: ` +
            `${result.reason ?? "unknown"}). Reconcile the install's durable anchor (provenance / ` +
            `install-op journal / host-port grant) before re-attempting the update.`,
        );
      }
      throw new Error(
        `${op} of ${ref.packageName} did NOT take — the new digest failed live activation ` +
          `(${result.reason ?? "unknown"}) and the install was durably rolled back to the ` +
          `previous version, which is retained and remains active. Re-attempt the update once ` +
          `the new version is fixed.`,
      );
    }

    // finalized === true but NOT activated: the install COMMITTED (anchorable;
    //   the boot loader is the durable path) but in-process hot-activation did not
    //   register the package this call — which breaks the no-restart invariant for
    //   a connector. Do NOT roll back the committed/finalized install (the row is
    //   real + anchorable; an update left the previous digest intact). THROW so the
    //   op surfaces the truthful "did not hot-activate" failure rather than a
    //   silent finalized-but-not-loaded success.
    if (!result.activated) {
      throw new Error(
        `${op} of ${ref.packageName} finalized the real-integrity pipeline but did NOT ` +
          `hot-activate in-process (${result.reason ?? "unknown"}) — the package is anchorable ` +
          `(it will load on the next boot) but did not load without a restart this call. The ` +
          `committed install was left intact.`,
      );
    }
  }

  // Uninstall branches on predicate + cascade:
  //   1. checkDependents may throw ActiveDependentError (active dep blocks)
  //   2. If archived dep exists → force archive (closure preservation)
  //   3. If extensionHasBeenUsed → archive (preserves run history)
  //   4. Otherwise → hard-delete via handler.uninstall
  async uninstall(typeId: string, ref: PackageRef, actor: Actor): Promise<void> {
    // Locked-row protection is enforced at the dispatcher layer.
    await assertNoLockedCanonicalRow(ref.packageName, "uninstall");
    // Closure: refuse uninstall if an active dependent requires this package.
    await assertCanonicalArchiveClosure(ref.packageName);
    const handler = this.resolve(typeId);
    const cascade = await checkDependents(ref); // throws ActiveDependentError if active dep
    const used = await extensionHasBeenUsed(ref);
    if (used || cascade.archivedDependentExists) {
      await handler.archive(ref, actor);
      await syncCanonicalManifestTransition(ref.packageName, "archive", actor);
      // Process-local deregistration: drop the package's in-memory register(ctx)
      // registrations (MCP tools / capability providers / ctx.ui surfaces /
      // object types) so an archived extension stops being
      // listable/invocable/resolvable in the running process without a restart.
      // DB rows are PRESERVED (archive is restorable) — only in-memory state is
      // cleared. Best-effort + host-injected (no-op in workers).
      const { fireExtensionCapabilityTeardown } = await import("./capability-teardown-hook");
      fireExtensionCapabilityTeardown(ref.packageName);
      return;
    }
    await handler.uninstall(ref, actor);
    await syncCanonicalManifestTransition(ref.packageName, "uninstall", actor);
    // Process-local deregistration of the package's in-memory register(ctx)
    // registrations — same as the archive branch above. Fires for the
    // HARD-DELETE branch too (then the durable teardown below removes DB rows).
    const { fireExtensionCapabilityTeardown } = await import("./capability-teardown-hook");
    fireExtensionCapabilityTeardown(ref.packageName);
    // Durable teardown of this package's org-scoped settings/secrets rows
    // (a forthcoming dev-fixtures contract extends it to fixture rows). Fires
    // ONLY in this HARD-DELETE branch — NOT the archive branch above, which
    // preserves run history and is restorable, so its org-scoped config must
    // survive. Awaited + idempotent + best-effort.
    const { fireExtensionDataTeardown } = await import("./data-teardown-hook");
    await fireExtensionDataTeardown(ref.packageName);
  }

  // Explicit archive (no predicate/cascade — user-initiated)
  async archive(typeId: string, ref: PackageRef, actor: Actor): Promise<void> {
    // Locked-row protection is enforced at the dispatcher layer:
    // reject archive if ANY canonical row for this package is locked.
    // This is a coarse gate at the kind-agnostic boundary; per-org callers
    // that have an identity should call enforceCanonicalManifest directly
    // for the structured-error path.
    await assertNoLockedCanonicalRow(ref.packageName, "archive");
    // Closure: refuse archive if an active dependent requires this package.
    await assertCanonicalArchiveClosure(ref.packageName);
    await this.resolve(typeId).archive(ref, actor);
    await syncCanonicalManifestTransition(ref.packageName, "archive", actor);
    // Process-local deregistration of the package's in-memory register(ctx)
    // registrations so an explicitly-archived extension stops being
    // listable/invocable/resolvable in the running process without a restart.
    // DB rows are PRESERVED (archive is restorable). Best-effort + host-injected.
    const { fireExtensionCapabilityTeardown } = await import("./capability-teardown-hook");
    fireExtensionCapabilityTeardown(ref.packageName);
  }

  // Explicit restore. Re-activates the archived canonical row AND — for a hot-
  // loadable-module kind (connector) — RE-REGISTERS the package in-process via
  // the activate hook (Finding 5). Archive/uninstall tears down the package's
  // in-memory register(ctx) registrations, so flipping the status back to active
  // is NOT enough: without re-registering, a restored connector stays
  // non-listable/non-invocable in the running process until the next boot. The
  // activate path is idempotent (re-materialize is SRI-checked against the already-
  // finalized digest; the in-memory registries replace by id/name) and does NOT
  // re-record a new version's provenance.
  async restore(typeId: string, ref: PackageRef, actor: Actor): Promise<void> {
    // Closure: refuse restore if the restored extension's required deps are
    // archived/missing (a restore operates on a row whose .dependencies are
    // already materialized, so a forward closure check is meaningful).
    await assertCanonicalRestoreClosure(ref.packageName);
    await this.resolve(typeId).restore(ref, actor);
    await syncCanonicalManifestTransition(ref.packageName, "activate", actor);

    // Only a hot-loadable-module kind re-registers in-process; other kinds ship no
    // runtime module (their handler.restore already re-surfaced them).
    if (!KINDS_USING_ACTIVATE_HOOK.has(typeId)) return;
    const orgId = actor.orgId ?? null;
    const { fireExtensionActivate } = await import("./activate-hook");
    // A restore re-activates the EXISTING finalized digest (no version change), so
    // `ref.version` matches the row's recorded version — pass it for consistency
    // with the install/update path (the host hook falls back to the row's version).
    const result = await fireExtensionActivate(ref.packageName, orgId, ref.version);
    // A restore must surface a re-registration failure (so the user is not told
    // "restored" when the package did not load in-process). We never roll the row
    // back — a restored healthy install stays active (the boot loader is the
    // durable path); we THROW so the op reports the truth. `finalized:undefined`
    // (no host hook wired in this worker) is also a failure for a connector — the
    // package would not load without a restart.
    if (result.finalized === false || result.finalized === undefined || !result.activated) {
      throw new Error(
        `restore of ${ref.packageName} re-activated the canonical row but did NOT re-register ` +
          `in-process (${result.reason ?? "unknown"}) — the package will load on the next boot but ` +
          `did not load without a restart this call. The restored install was left active.`,
      );
    }
  }

  // forceDelete: capture snapshot + dangling refs,
  // write audit row BEFORE destructive op (failure aborts destruction),
  // then hard-delete via handler.uninstall (bypasses cascade — by design).
  //
  // The agent_templates table is the target of five RESTRICT
  // FKs (agent_runs, agent_versions, agent_template_versions,
  // agent_registry_entries, agent_forks). The handler.uninstall() path
  // calls deleteAgentTemplate() which would raise 23503 foreign_key_violation
  // for any template that has run history — exactly the rows force_delete is
  // meant to handle. Pre-clean the FK sources here at the dispatcher layer
  // (NOT inside the handler — handlers stay pure mechanics) so the
  // destructive escape hatch actually destructs. Provenance is preserved by
  // the audit row written above (destroyed_row_snapshot + dangling_references).
  async forceDelete(
    typeId: string,
    ref: PackageRef,
    actor: Actor,
    reason?: string,
  ): Promise<{ danglingReferences: DanglingReferences }> {
    // Locked-row protection is enforced at the dispatcher layer.
    await assertNoLockedCanonicalRow(ref.packageName, "force_delete");
    const handler = this.resolve(typeId);
    const { readAgentTemplateByPackageName, removeReferencingRunRows, withInstallLock } =
      await import("@cinatra-ai/agents");
    // Hold the per-package install lock around the WHOLE forceDelete
    // transaction (audit + FK pre-clean + uninstall).
    // The pre-clean must not race a concurrent install of the same package
    // that could recreate referencing rows between pre-clean and the delete
    // inside handler.uninstall. handler.uninstall acquires the same lock
    // re-entrantly via AsyncLocalStorage — no deadlock.
    return withInstallLock(ref.packageName, async () => {
      const snapshot = await readAgentTemplateByPackageName(ref.packageName);
      const { computeDanglingReferences, writeExtensionLifecycleAuditEntry } =
        await import("./audit-log");
      const danglingReferences = await computeDanglingReferences(ref);
      // Audit BEFORE destruction — a write failure aborts the op (no silent destruction).
      await writeExtensionLifecycleAuditEntry({
        actor,
        operation: "force_delete",
        packageRef: ref,
        destroyedRowSnapshot: snapshot ?? null,
        danglingReferences,
        ...(reason !== undefined ? { reason } : {}),
      });
      // Pre-clean the FK source rows so the RESTRICT FKs do not block
      // deleteAgentTemplate() inside handler.uninstall. Skip when no template
      // row exists (snapshot === null) — there is nothing to dereference.
      if (snapshot) {
        await removeReferencingRunRows(snapshot.id);
      }
      await handler.uninstall(ref, actor); // hard-delete; cascade bypassed by design
      // Drop the canonical manifest row(s) for this package.
      await syncCanonicalManifestTransition(ref.packageName, "force_delete", actor);
      // Process-local deregistration of the package's in-memory register(ctx)
      // registrations so a force-deleted extension stops being
      // listable/invocable/resolvable without a restart. Best-effort + host-injected.
      const { fireExtensionCapabilityTeardown } = await import("./capability-teardown-hook");
      fireExtensionCapabilityTeardown(ref.packageName);
      // Durable teardown of org-scoped settings/secrets rows.
      const { fireExtensionDataTeardown } = await import("./data-teardown-hook");
      await fireExtensionDataTeardown(ref.packageName);
      return { danglingReferences };
    });
  }

  async validate(typeId: string, spec: unknown): Promise<ValidationResult> {
    const handler = this.resolve(typeId);
    if (!handler.validate) return { valid: true };
    return handler.validate(spec);
  }

  /** For use in tests only — resets all registered handlers. */
  _resetForTesting(): void {
    this.handlers.clear();
  }
}

export const extensionRegistry = new ExtensionRegistryImpl();

// Cross-kind dependency lifecycle machinery (pure; consumed by install/uninstall
// lifecycle callers and acceptance tests).
export {
  buildCrossKindGraph,
  resolveInstall,
  decideUninstall,
  detectCycles,
  checkAuthoringRecursionBudget,
  DEFAULT_AUTHORING_RECURSION_BUDGET,
} from "./cross-kind-dep-graph";
export type {
  CrossKindNode,
  CrossKindGraph,
  InstallResolution,
  UninstallDecision,
  RecursionCheck,
} from "./cross-kind-dep-graph";

// True-IoC split-brain guard.
// Host-injected in-memory capability teardown hook (purge fires it after the DB
// delete commits) + the effective-status reader used by the StaticBundleLoader
// explicit-retired-row gate.
export {
  setExtensionCapabilityTeardownHook,
  fireExtensionCapabilityTeardown,
} from "./capability-teardown-hook";
export type { ExtensionCapabilityTeardownHook } from "./capability-teardown-hook";
// Hot-activate seam (symmetric to the capability teardown hook above).
// Host-injected in-process activator; the dispatcher fires it after a
// verdaccio-source NEW install commits (no restart needed).
export {
  setExtensionActivateHook,
  fireExtensionActivate,
} from "./activate-hook";
export type {
  ExtensionActivateHook,
  ExtensionActivateResult,
} from "./activate-hook";
// Install-op JOURNAL-phase reader seam. Host-injected; the dispatcher
// consults it so the rollback + re-run decisions catch the provenance-before-
// finalize window (real integrity recorded, journal not yet finalized) — not just
// placeholder integrity.
export {
  setExtensionInstallOpPhaseReader,
  readExtensionInstallOpPhase,
} from "./install-op-phase-hook";
export type { ExtensionInstallOpPhaseReader } from "./install-op-phase-hook";
export {
  setExtensionDataTeardownHook,
  fireExtensionDataTeardown,
} from "./data-teardown-hook";
export type { ExtensionDataTeardownHook } from "./data-teardown-hook";
export { readEffectiveStatusByPackageNames } from "./canonical-store";
