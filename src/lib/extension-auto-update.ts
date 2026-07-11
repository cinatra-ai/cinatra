import "server-only";

// ---------------------------------------------------------------------------
// In-app extension auto-update loop — cycle implementation (cinatra#1042,
// slice 1).
//
// WHAT: the work body of the boot-seeded `extension-auto-update` system loop
// (see `src/lib/boot/phases/system-loops.ts` for the seed and
// `src/lib/background-jobs-registry.ts` for the recurring-loop handler + the
// boot-registered runner slot — the extension-store-gc-reap pattern). Each
// cycle reads the cached update read model for the installed extensions (the
// SAME source the /configuration/extensions indicator consumes,
// `readUpdateModelForInstalled`), computes eligible update candidates, and
// executes them through the SAME dispatch a manual update takes — the
// dependency planner/batch with `rootAction:"update"` on the non-gatekept
// path, the direct in-place `extensionRegistry.update` on the gatekept path
// (update-through-batch is fenced there, #1296) — under a defined system
// Actor that is stamped on the durable audit records.
//
// MASTER FLAG (default OFF): `CINATRA_EXTENSION_AUTO_UPDATE=true` is the only
// way this loop does anything. The boot phase does not even SEED the loop job
// while the flag is off; the cycle re-checks the flag as defense in depth (a
// canonical job left over from a previously-enabled boot no-ops — it keeps
// re-delaying, one inert job a day, and is never re-seeded while disabled).
//
// SLICE-1 SCOPE BOUNDS (each is re-checked per cycle, fail-closed):
//   - PLATFORM-SCOPED (NULL-org) rows only. The system actor is built with
//     `orgId: null`, so the dispatcher's lifecycle-target resolver can only
//     ever address NULL-org rows. This bound is structural, not just a
//     filter: even a bug in candidate selection cannot make the dispatch
//     touch an org row.
//   - ORG-ROWS COMPENSATION FENCE: if the instance has ANY org-scoped
//     install row (any package, any status), the cycle executes NOTHING.
//     Rationale (codex round-1 blocker): a mid-batch failure compensates by
//     `extensionRegistry.uninstall` of freshly-installed members, and the
//     platform-admin hard-delete branch of that dispatcher is PACKAGE-GLOBAL
//     (it tears down same-package org rows too). The candidate's dependency
//     closure is not knowable pre-plan, so slice 1 fences the whole cycle on
//     any org-scoped presence; multi-org instances are excluded until a
//     row-scoped compensation primitive exists (follow-up on #1042).
//   - NON-REQUIRED extensions only (`isSystemExtension` scope): the
//     required/image-baked set keeps riding release images + the boot seed.
//   - Verdaccio-sourced live (active|locked) rows only — other source types
//     have no registry update semantics.
//   - EXACTLY ONE NULL-org row per package COUNTING EVERY STATUS: the
//     dispatcher re-activates archived same-scope siblings before updating,
//     and side-by-side installed versions (#1040 S1) make `(package, org)`
//     ambiguous for the package-addressed dispatcher — so any second NULL-org
//     row (live OR archived) skips the package as `ambiguous-install-scope`
//     until a row-scoped update API exists.
//   - PRE-DISPATCH TOCTOU RECHECK (the gc-reaper cinatra#850 "re-verify
//     against FRESH reads immediately before each mutation" discipline): the
//     candidate set is a snapshot, and an operator can archive / uninstall /
//     source-switch / manually advance a package between selection and
//     dispatch — the dispatch itself would resurrect an archived row or
//     overwrite a manual advance (the batch planner exempts the update root
//     from installed-version conflict checks). So EVERY candidate re-runs
//     `evaluateCandidateRecheck` over a FRESH row read immediately before its
//     dispatch; ANY drift (row gone/replaced, no longer live, new sibling or
//     org-scoped rows appeared, source switched, installed version moved in
//     EITHER direction, kind changed) skips as `state-drift`, never executes.
//     Version equality also preserves the selection verdict — the target
//     stays strictly newer than the version the comparator approved. KNOWN
//     LIMIT, on record (codex final-round divergence, reported not hidden):
//     this recheck runs BEFORE the dispatch, not atomically at the mutation
//     boundary — a manual update that already holds the lifecycle lock can
//     advance the package after the recheck, and the queued auto-update then
//     applies its cached (now older) target over it. Closing that residue
//     needs an expected-version CAS threaded through the SHARED registry
//     dispatch (`extensionRegistry.update` / the batch root), which is a
//     cross-surface change deliberately out of this slice — tracked as a
//     follow-up on #1042.
//   - sdkAbiRange compatibility via `evaluateHostSdkCompat` — the loaders'
//     own verdict; an incompatible/malformed declared range skips the
//     candidate (the install pipeline re-checks this gate at execution).
//   - FLEET SIGNATURE-READINESS gate (`assessSignatureReadiness().ready`),
//     evaluated once per cycle after candidate selection and before the first
//     execution: if the fleet would not survive `require-signatures=true`
//     (including the zero-trusted-keys case), ZERO candidates execute. This
//     is deliberately fail-closed — an instance without working signature
//     trust does not silently auto-mutate its extension set. The update
//     pipeline itself still runs its own per-target signature/trust gates
//     exactly as for a manual update.
//
// SYSTEM ACTOR + AUDIT TRAIL: the actor is
//   { actorType:"system", source:"worker", userId:"system:extension-auto-update",
//     platformRole:"platform_admin", orgId:null }.
// `platformRole` is stamped here for one reason: on a mid-batch member
// failure the batch compensates by `extensionRegistry.uninstall` of the
// freshly-installed members with the SAME actor, and that destructive path
// requires write standing over the (NULL-org) row
// (`actorHasWriteStandingOverRow`). Combined with `orgId:null` the standing is
// bounded to platform-scoped rows only. Every applied/failed candidate and
// every run writes a durable audit event to the authz audit surface
// (`@/lib/authz/audit`) carrying the system principal id; the batch/dispatch
// path additionally threads the actor through its own provenance records
// exactly as a manual update does.
//
// The loop NEVER publishes, tags, or mutates registry state — it consumes
// already-published versions only.
//
// READ-MODEL WIRING STATUS: the persistent (DB-backed)
// `ExtensionUpdateReadModelStore` adapter is #1041's own slice (open PR
// #1310). Until it lands and is wired into `defaultResolveUpdateReadModelStore`
// below (a one-line follow-up), the default resolver returns null and every
// cycle reports `readModelWired:false` with all rows skipped as
// `read-model-unwired` — the loop is dormant even when the flag is ON.
// ---------------------------------------------------------------------------

import type { Actor } from "@cinatra-ai/extension-types";
import {
  readUpdateModelForInstalled,
  type ExtensionUpdateReadModelStore,
} from "@cinatra-ai/registries/src/update-read-model";
import { comparePluginVersions } from "@cinatra-ai/registries/src/version-compare";
import { evaluateHostSdkCompat } from "@/lib/extension-host-compat";

/** Master flag (default OFF). Same parsing as CINATRA_GATEKEPT_INSTALL /
 *  CINATRA_EXTENSION_REQUIRE_SIGNATURES: only the literal "true" enables. */
export function isExtensionAutoUpdateEnabled(): boolean {
  return process.env.CINATRA_EXTENSION_AUTO_UPDATE === "true";
}

/** The audit principal id every record this loop produces carries. */
export const EXTENSION_AUTO_UPDATE_ACTOR_ID = "system:extension-auto-update";

/**
 * The defined system Actor for every dispatch this loop performs. See the
 * module header for why `platformRole` is stamped and how `orgId:null` bounds
 * it to platform-scoped rows.
 */
export function buildExtensionAutoUpdateActor(): Actor {
  return {
    actorType: "system",
    source: "worker",
    userId: EXTENSION_AUTO_UPDATE_ACTOR_ID,
    platformRole: "platform_admin",
    orgId: null,
  };
}

/**
 * Read-model freshness window. The read model is refreshed per-package by the
 * hourly marketplace catalog-sync loop; an entry older than this reads STALE
 * and the row is skipped (fail-quiet — a neglected/stopped sync never drives
 * an update from an untrusted verdict). Mirrors the indicator slice's TTL.
 */
export const EXTENSION_AUTO_UPDATE_READ_MODEL_TTL_MS = 24 * 60 * 60 * 1000;

/** The install statuses the loop treats as live — kept aligned with the
 *  signature-readiness / anchor LIVE set (a `locked` row is updatable). */
const LIVE_STATUSES = new Set(["active", "locked"]);

/** Minimal structural install-row shape the cycle consumes (tests inject
 *  plain objects; the default deps map `listInstalledExtensions` rows). */
export type AutoUpdateInstalledRow = {
  id: string;
  packageName: string;
  kind: string;
  organizationId: string | null;
  status: string;
  source: { type: string; version?: string };
};

export type AutoUpdateSkipReason =
  | "non-verdaccio-source"
  | "org-rows-compensation-fence"
  | "ambiguous-install-scope"
  | "required-in-prod-scope"
  | "read-model-unwired"
  | "read-model-stale"
  | "no-comparable-latest"
  | "up-to-date"
  | "abi-incompatible"
  | "signature-readiness"
  | "state-drift";

export type ExtensionAutoUpdateRunSummary = {
  /** False = the master flag was off at cycle time; nothing was read. */
  enabled: boolean;
  /** Whether a persistent read-model store was resolvable this cycle. */
  readModelWired: boolean;
  /** Fleet signature-readiness verdict (null = not evaluated: no candidates). */
  signatureReady: boolean | null;
  /** Live verdaccio-scope rows considered (pre-filter candidates). */
  scanned: number;
  applied: {
    packageName: string;
    rowId: string;
    organizationId: string | null;
    fromVersion: string;
    toVersion: string;
  }[];
  failed: {
    packageName: string;
    rowId: string;
    organizationId: string | null;
    fromVersion: string;
    toVersion: string;
    error: string;
  }[];
  skipped: { packageName: string; reason: AutoUpdateSkipReason }[];
  /** Durable audit writes that failed (the update outcome is unaffected). */
  auditWriteFailures: number;
};

/** Structural audit-event shape (mirrors `AuditEventInput` in
 *  `@/lib/authz/audit` — kept structural so tests need no host import). */
export type AutoUpdateAuditEvent = {
  actorPrincipalId: string;
  actorPrincipalType: "system";
  authSource: "worker";
  resourceType: "extension";
  resourceId: string;
  operation:
    | "extension_auto_update_applied"
    | "extension_auto_update_failed"
    | "extension_auto_update_run";
  decision?: "allowed";
  metadata?: Record<string, unknown>;
};

export type ExtensionAutoUpdateDeps = {
  /** Master-flag re-check (defense in depth under the boot-seed gate). */
  isEnabled: () => boolean;
  /** ALL canonical install rows (every org scope; the cycle filters). */
  listInstalledRows: () => Promise<AutoUpdateInstalledRow[]>;
  /** Required/image-baked membership — those rows never auto-update. */
  isRequiredInProd: (packageName: string) => boolean | Promise<boolean>;
  /**
   * The persistent update read-model store, or null when no adapter is wired
   * on this deployment (see the module header — PR #1310 follow-up).
   */
  resolveUpdateReadModelStore: () => Promise<ExtensionUpdateReadModelStore | null>;
  /** The loaders' ABI verdict over the candidate's declared range. */
  evaluateAbiCompat: (sdkAbiRange: string | null) => { compatible: boolean };
  /**
   * Fleet signature-readiness gate (see module header). Evaluated at most
   * once per cycle, only when at least one candidate survived selection.
   */
  isSignatureReady: () => Promise<boolean>;
  /**
   * Execute ONE update through the manual-update dispatch (see
   * `defaultExecuteUpdate`). Throws on failure; the cycle isolates it.
   */
  executeUpdate: (
    candidate: { packageName: string; kind: string; toVersion: string },
    actor: Actor,
  ) => Promise<void>;
  /** Durable audit write (default: `logAuditEventStrict`). May throw; the
   *  cycle catches and counts — an audit-write failure never flips an
   *  update outcome. */
  writeAuditEvent: (event: AutoUpdateAuditEvent) => Promise<void>;
  now: () => Date;
};

export function buildDefaultExtensionAutoUpdateDeps(): ExtensionAutoUpdateDeps {
  return {
    isEnabled: isExtensionAutoUpdateEnabled,
    listInstalledRows: async () => {
      const { listInstalledExtensions } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const rows = await listInstalledExtensions({});
      return rows.map((r) => ({
        id: r.id,
        packageName: r.packageName,
        kind: r.kind,
        organizationId: r.organizationId,
        status: r.status,
        source: r.source as { type: string; version?: string },
      }));
    },
    isRequiredInProd: async (packageName) => {
      // Lazy: the inventory module reads the host package.json declaration at
      // MODULE LOAD (fail-loud) — keep that off this module's import time.
      // isSystemExtension keys on host-declared membership (SYSTEM_EXTENSIONS).
      const { isSystemExtension } = await import(
        "@cinatra-ai/extensions/system-extension-inventory"
      );
      return isSystemExtension(packageName);
    },
    resolveUpdateReadModelStore: async () => {
      // The persistent adapter is #1041's slice (open PR #1310). Wire it here
      // once it lands; until then the loop is dormant (read-model-unwired).
      return null;
    },
    evaluateAbiCompat: (sdkAbiRange) => evaluateHostSdkCompat(sdkAbiRange),
    isSignatureReady: async () => {
      const { assessSignatureReadiness } = await import(
        "@/lib/extension-signature-readiness"
      );
      return (await assessSignatureReadiness()).ready;
    },
    executeUpdate: defaultExecuteUpdate,
    writeAuditEvent: async (event) => {
      const { logAuditEventStrict } = await import("@/lib/authz/audit");
      await logAuditEventStrict(event);
    },
    now: () => new Date(),
  };
}

/**
 * Pure pre-dispatch drift verdict over a FRESH row read (exported for direct
 * testing; the execution loop feeds it a fresh `listInstalledRows()` result
 * immediately before each dispatch — the TOCTOU guard, see the module
 * header). FAIL-CLOSED: anything that no longer looks EXACTLY like the
 * selected candidate refuses with a structured detail.
 */
export function evaluateCandidateRecheck(
  freshRows: AutoUpdateInstalledRow[],
  selected: {
    rowId: string;
    packageName: string;
    kind: string;
    expectedVersion: string;
  },
): { ok: true } | { ok: false; detail: string } {
  // The org-rows compensation fence holds at DISPATCH time too — an org row
  // created mid-cycle re-arms the package-global hard-delete hazard.
  if (freshRows.some((r) => (r.organizationId ?? null) !== null)) {
    return { ok: false, detail: "org-scoped install rows appeared since selection" };
  }
  const nullOrgRows = freshRows.filter(
    (r) =>
      r.packageName === selected.packageName && (r.organizationId ?? null) === null,
  );
  if (nullOrgRows.length === 0) {
    return { ok: false, detail: "row removed since selection" };
  }
  if (nullOrgRows.length > 1) {
    return { ok: false, detail: "scope became ambiguous since selection (new sibling row)" };
  }
  const fresh = nullOrgRows[0];
  if (fresh.id !== selected.rowId) {
    return { ok: false, detail: "row replaced since selection (different rowId)" };
  }
  if (!LIVE_STATUSES.has(fresh.status)) {
    return { ok: false, detail: `row no longer live since selection (status=${fresh.status})` };
  }
  if (fresh.kind !== selected.kind) {
    return { ok: false, detail: "kind changed since selection" };
  }
  if (fresh.source.type !== "verdaccio") {
    return { ok: false, detail: "source switched off verdaccio since selection" };
  }
  if ((fresh.source.version ?? null) !== selected.expectedVersion) {
    return {
      ok: false,
      detail:
        `installed version moved ${selected.expectedVersion} -> ` +
        `${fresh.source.version ?? "(none)"} since selection`,
    };
  }
  return { ok: true };
}

/**
 * The manual-update dispatch, minus the cookie-session admin gate (this is a
 * worker; the explicit system Actor is the identity). MUST stay behaviorally
 * aligned with `updateExtensionPackage` in `packages/extensions/src/actions.ts`
 * (#1039 Option B): non-gatekept routes through the dependency planner/batch
 * as a committed in-place root update; gatekept keeps the direct in-place
 * `extensionRegistry.update` (update-through-batch is fenced there, #1296).
 *
 * `@/lib/extensions` is imported FIRST: it registers all five extension-kind
 * handlers + the workflow saga hook (the bare `@cinatra-ai/extensions`
 * registry can be empty in a worker process — see handler-bootstrap.ts).
 *
 * typeId: `deriveTypeId(kind)` is the identity mapping for all five
 * registered kinds, and the candidate's kind comes from its own canonical
 * install row, so the row kind IS the typeId (kind is stable across versions
 * of a package; a manual update resolves the same value via the packument /
 * authorize metadata).
 */
export async function defaultExecuteUpdate(
  candidate: { packageName: string; kind: string; toVersion: string },
  actor: Actor,
): Promise<void> {
  // Host handler wiring (idempotent side-effect module) — never dispatch
  // against a bare, possibly-empty registry in a worker process.
  await import("@/lib/extensions");
  const { isGatekeptInstallEnabled } = await import("@/lib/gatekept-install");
  if (isGatekeptInstallEnabled()) {
    const { extensionRegistry } = await import("@cinatra-ai/extensions");
    await extensionRegistry.update(
      candidate.kind,
      {
        registryUrl: "",
        packageName: candidate.packageName,
        version: candidate.toVersion,
      },
      actor,
    );
    return;
  }
  const { installExtensionWithDependencies } = await import(
    "@/lib/extension-install-batch"
  );
  await installExtensionWithDependencies({
    packageName: candidate.packageName,
    version: candidate.toVersion,
    actor,
    rootAction: "update",
  });
}

/**
 * One auto-update cycle. Never throws for per-candidate failures (each is
 * isolated + recorded; the batch's own compensation already leaves the prior
 * version anchored on failure). A THROW out of this function (e.g. the
 * install-row read failing) propagates to `runRecurringLoop`, which reports
 * it and always re-delays — the loop never dies.
 */
export async function runExtensionAutoUpdateCycle(
  depsOverride?: ExtensionAutoUpdateDeps,
): Promise<ExtensionAutoUpdateRunSummary> {
  const deps = depsOverride ?? buildDefaultExtensionAutoUpdateDeps();

  const summary: ExtensionAutoUpdateRunSummary = {
    enabled: true,
    readModelWired: false,
    signatureReady: null,
    scanned: 0,
    applied: [],
    failed: [],
    skipped: [],
    auditWriteFailures: 0,
  };

  if (!deps.isEnabled()) {
    // Defense in depth: the boot seed never schedules the loop while the flag
    // is off, but a canonical job from a previously-enabled boot may still
    // fire. Do nothing — no reads, no writes.
    summary.enabled = false;
    return summary;
  }

  const writeAudit = async (event: AutoUpdateAuditEvent): Promise<void> => {
    try {
      await deps.writeAuditEvent(event);
    } catch (err) {
      summary.auditWriteFailures++;
      console.warn(
        "[extension-auto-update] durable audit write failed (outcome unaffected):",
        err,
      );
    }
  };

  // Everything after the flag check writes the per-run audit event on the way
  // out — INCLUDING a thrown enumeration/read failure (the throw still
  // propagates to runRecurringLoop, which reports it and re-delays).
  try {
    await runEnabledCycle(deps, summary, writeAudit);
  } finally {
    await writeAudit(buildRunAuditEvent(summary));
  }
  return summary;
}

async function runEnabledCycle(
  deps: ExtensionAutoUpdateDeps,
  summary: ExtensionAutoUpdateRunSummary,
  writeAudit: (event: AutoUpdateAuditEvent) => Promise<void>,
): Promise<void> {
  const allRows = await deps.listInstalledRows();

  // ---- candidate-scope selection (slice-1 bounds; see module header) ------
  type Scoped = { row: AutoUpdateInstalledRow; currentVersion: string };
  const scoped: Scoped[] = [];
  const skip = (packageName: string, reason: AutoUpdateSkipReason): void => {
    summary.skipped.push({ packageName, reason });
  };

  // Group ALL NULL-org rows (EVERY status) by package: an archived same-scope
  // sibling is disqualifying too — the dispatcher re-activates archived rows
  // at the actor's scope before updating, so "one live + one archived" could
  // end as two live rows after a failed update (codex round-1 finding 2).
  const nullOrgByPackage = new Map<string, AutoUpdateInstalledRow[]>();
  for (const row of allRows) {
    if ((row.organizationId ?? null) !== null) continue;
    const bucket = nullOrgByPackage.get(row.packageName) ?? [];
    bucket.push(row);
    nullOrgByPackage.set(row.packageName, bucket);
  }

  for (const [packageName, rows] of nullOrgByPackage) {
    if (rows.length > 1) {
      // Side-by-side versions (#1040 S1) or an archived sibling: the
      // package-addressed dispatcher cannot safely target ONE row — skip
      // until a row-scoped update API exists.
      skip(packageName, "ambiguous-install-scope");
      continue;
    }
    const row = rows[0];
    if (!LIVE_STATUSES.has(row.status)) continue; // a lone archived row is simply not scanned
    if (row.source.type !== "verdaccio") {
      skip(packageName, "non-verdaccio-source");
      continue;
    }
    if (await deps.isRequiredInProd(packageName)) {
      skip(packageName, "required-in-prod-scope");
      continue;
    }
    const currentVersion = row.source.version;
    if (!currentVersion) {
      // A verdaccio source always carries a version; treat a missing one as
      // an undatable row (cannot compare) rather than guessing.
      skip(packageName, "no-comparable-latest");
      continue;
    }
    scoped.push({ row, currentVersion });
  }
  summary.scanned = scoped.length;

  // ---- org-rows compensation fence (see module header; codex round-1
  // blocker): ANY org-scoped row on the instance halts execution — a
  // mid-batch compensation uninstall of a freshly-installed dependency can
  // take the platform-admin PACKAGE-GLOBAL hard-delete branch, and the
  // dependency closure is unknowable before planning.
  if (allRows.some((r) => (r.organizationId ?? null) !== null)) {
    console.warn(
      "[extension-auto-update] org-scoped install rows present on this instance — auto-update fenced off (compensation is not row-scoped yet; see extension-auto-update.ts header)",
    );
    for (const s of scoped) skip(s.row.packageName, "org-rows-compensation-fence");
    return;
  }

  // ---- update-availability via the cached read model ----------------------
  const store = await deps.resolveUpdateReadModelStore();
  if (store === null) {
    // Enabled but unwired: loud, and every scoped row records why. The cycle
    // is NOT presented as a successful no-updates run.
    console.warn(
      "[extension-auto-update] enabled but no persistent update read-model store is wired on this deployment — zero candidates (see extension-auto-update.ts header)",
    );
    for (const s of scoped) skip(s.row.packageName, "read-model-unwired");
    return;
  }
  summary.readModelWired = true;

  const readouts = await readUpdateModelForInstalled(
    store,
    scoped.map((s) => s.row.packageName),
    { now: deps.now(), ttlMs: EXTENSION_AUTO_UPDATE_READ_MODEL_TTL_MS },
  );
  const readoutByPackage = new Map(readouts.map((r) => [r.packageName, r]));

  type Candidate = Scoped & { toVersion: string };
  const candidates: Candidate[] = [];
  for (const s of scoped) {
    const readout = readoutByPackage.get(s.row.packageName);
    if (!readout || readout.stale || readout.entry === null) {
      // Missing, never-synced, expired, or undatable — all read as stale
      // (the read model's own fail-safe contract).
      skip(s.row.packageName, "read-model-stale");
      continue;
    }
    const latest = readout.entry.latestVersion;
    if (latest === null) {
      skip(s.row.packageName, "no-comparable-latest");
      continue;
    }
    if (comparePluginVersions(s.currentVersion, latest) !== "update-available") {
      skip(s.row.packageName, "up-to-date");
      continue;
    }
    if (!deps.evaluateAbiCompat(readout.entry.latestSdkAbiRange).compatible) {
      skip(s.row.packageName, "abi-incompatible");
      continue;
    }
    candidates.push({ ...s, toVersion: latest });
  }

  // ---- fleet signature-readiness gate (once, before the first execution) --
  if (candidates.length > 0) {
    summary.signatureReady = await deps.isSignatureReady();
    if (!summary.signatureReady) {
      console.warn(
        "[extension-auto-update] fleet signature-readiness predicate is NOT-READY — zero candidates executed this cycle (fail-closed)",
      );
      for (const c of candidates) skip(c.row.packageName, "signature-readiness");
      return;
    }
  }

  // ---- execution (per-candidate isolation) ---------------------------------
  const actor = buildExtensionAutoUpdateActor();
  for (const c of candidates) {
    try {
      // PRE-DISPATCH TOCTOU RECHECK (see module header): re-verify against a
      // FRESH row read immediately before the dispatch. Drift ⇒ structured
      // `state-drift` skip, never an execution; a re-read THROW lands in the
      // catch below as a per-candidate failure (fail closed).
      const recheck = evaluateCandidateRecheck(await deps.listInstalledRows(), {
        rowId: c.row.id,
        packageName: c.row.packageName,
        kind: c.row.kind,
        expectedVersion: c.currentVersion,
      });
      if (!recheck.ok) {
        console.warn(
          "[extension-auto-update] pre-dispatch recheck refused %s: %s",
          c.row.packageName,
          recheck.detail,
        );
        skip(c.row.packageName, "state-drift");
        continue;
      }
      await deps.executeUpdate(
        { packageName: c.row.packageName, kind: c.row.kind, toVersion: c.toVersion },
        actor,
      );
      summary.applied.push({
        packageName: c.row.packageName,
        rowId: c.row.id,
        organizationId: c.row.organizationId,
        fromVersion: c.currentVersion,
        toVersion: c.toVersion,
      });
      await writeAudit({
        actorPrincipalId: EXTENSION_AUTO_UPDATE_ACTOR_ID,
        actorPrincipalType: "system",
        authSource: "worker",
        resourceType: "extension",
        resourceId: c.row.packageName,
        operation: "extension_auto_update_applied",
        decision: "allowed",
        metadata: {
          rowId: c.row.id,
          organizationId: c.row.organizationId,
          fromVersion: c.currentVersion,
          toVersion: c.toVersion,
        },
      });
    } catch (err) {
      // One candidate's failure never aborts the rest. The batch/dispatch
      // path has already compensated (newly-installed members removed, the
      // prior version still anchored + serving) before the throw reaches us.
      const message = err instanceof Error ? err.message : String(err);
      summary.failed.push({
        packageName: c.row.packageName,
        rowId: c.row.id,
        organizationId: c.row.organizationId,
        fromVersion: c.currentVersion,
        toVersion: c.toVersion,
        error: message,
      });
      console.error(
        "[extension-auto-update] update of %s %s -> %s failed (prior version stays anchored):",
        c.row.packageName,
        c.currentVersion,
        c.toVersion,
        err,
      );
      await writeAudit({
        actorPrincipalId: EXTENSION_AUTO_UPDATE_ACTOR_ID,
        actorPrincipalType: "system",
        authSource: "worker",
        resourceType: "extension",
        resourceId: c.row.packageName,
        operation: "extension_auto_update_failed",
        metadata: {
          rowId: c.row.id,
          organizationId: c.row.organizationId,
          fromVersion: c.currentVersion,
          toVersion: c.toVersion,
          error: message,
        },
      });
    }
  }
}

function buildRunAuditEvent(
  summary: ExtensionAutoUpdateRunSummary,
): AutoUpdateAuditEvent {
  const skippedByReason: Record<string, number> = {};
  for (const s of summary.skipped) {
    skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  }
  return {
    actorPrincipalId: EXTENSION_AUTO_UPDATE_ACTOR_ID,
    actorPrincipalType: "system",
    authSource: "worker",
    resourceType: "extension",
    resourceId: "extension-auto-update-run",
    operation: "extension_auto_update_run",
    metadata: {
      readModelWired: summary.readModelWired,
      signatureReady: summary.signatureReady,
      scanned: summary.scanned,
      applied: summary.applied.length,
      failed: summary.failed.length,
      skippedByReason,
    },
  };
}
