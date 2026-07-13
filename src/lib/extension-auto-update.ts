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
// SCOPE BOUNDS + SAFETY GATES (each is re-checked per cycle, fail-closed;
// slice-1 landed the bounds, #1042 slices 2-3 lifted the org-rows fence, added
// the expected-version CAS, and added the policy knobs — see below):
//   - PLATFORM-SCOPED (NULL-org) rows only. The system actor is built with
//     `orgId: null`, so the dispatcher's lifecycle-target resolver can only
//     ever address NULL-org rows. This bound is structural, not just a
//     filter: even a bug in candidate selection cannot make the dispatch
//     touch an org row.
//   - ROW-SCOPED COMPENSATION (#1042 slice-2; the org-rows fence is now
//     LIFTED). Slice-1 fenced the WHOLE cycle whenever the instance held ANY
//     org-scoped install row, because the batch's mid-batch compensation of a
//     freshly-installed dependency called `extensionRegistry.uninstall`, whose
//     platform-admin hard-delete branch is PACKAGE-GLOBAL (it tears down
//     same-package org rows too). The dispatch now opts into row-scoped
//     compensation (`installExtensionWithDependencies({rowScopedCompensation})`
//     → `uninstallMemberRowScoped` → `deleteScopedCanonicalRow`), which removes
//     ONLY the freshly-installed actor-scope (NULL-org) row and never the
//     package-global backing or another org's rows. With the structural
//     NULL-org actor bound above, an org-multi-tenant instance is provably
//     safe — so the cycle no longer fences on org-scoped presence.
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
//     stays strictly newer than the version the comparator approved. The
//     recheck stays as a cheap early-out; its former lock-window residue (a
//     manual update holding the install lock could advance the package AFTER
//     the recheck, before the dispatch acquired the lock) is now closed by:
//   - EXPECTED-VERSION CAS (#1042 slice-1): the dispatch forwards the selected
//     `fromVersion` as `expectedInstalledVersion`, and the shared registry
//     `update` re-reads the live installed version UNDER the per-package
//     install lock, at the mutation boundary, refusing before any mutation if
//     it has moved (a concurrent manual update, holding the SAME lock, has
//     already committed by then). The stale target LOSES cleanly, recorded as
//     `cas-version-lost` (a benign skip, never a double-apply / failure).
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
// `platformRole` is stamped here so the dispatch has write standing over the
// (NULL-org) platform row on the gatekept direct-`update` path
// (`actorHasWriteStandingOverRow`); combined with `orgId:null` that standing is
// bounded to platform-scoped rows only. (Slice-2 note: a mid-batch compensation
// no longer routes through `extensionRegistry.uninstall`'s package-global
// hard-delete — it uses the row-scoped `deleteScopedCanonicalRow` inverse — so
// the standing requirement is now only about the forward update, not a
// package-global teardown.) Every applied/failed candidate and
// every run writes a durable audit event to the authz audit surface
// (`@/lib/authz/audit`) carrying the system principal id; the batch/dispatch
// path additionally threads the actor through its own provenance records
// exactly as a manual update does.
//
// The loop NEVER publishes, tags, or mutates registry state — it consumes
// already-published versions only.
//
// POLICY KNOBS (#1042 slice-3, env-delivered per-instance by ops tooling —
// tracked outside this repo). These are ADDITIVE SUPPRESSORS layered UNDER the
// master flag; they can only ever make an ENABLED loop do LESS and NEVER turn
// it on (with the flag off the cycle returns before either is read):
//   - MAINTENANCE WINDOW (`CINATRA_EXTENSION_AUTO_UPDATE_WINDOW`, a UTC hour
//     range like "1-5" or wrap "22-6"): outside the window the whole cycle is
//     suppressed (no reads, no dispatch). Unset → no restriction; malformed →
//     FAIL-CLOSED (suppressed). See `isWithinMaintenanceWindowSpec`.
//   - DENY LIST (`CINATRA_EXTENSION_AUTO_UPDATE_DENY`, comma-separated exact
//     package names): a denied package skips selection as `deny-listed`.
//
// READ-MODEL WIRING (#1042 wire-up slice; formerly dormant): the default
// resolver now returns the persistent DB-backed
// `ExtensionUpdateReadModelStore` adapter (#1041, PR #1310 —
// `getExtensionUpdateReadModelStore`), the SAME process-cached store the
// /configuration/extensions indicator reads. The `read-model-unwired`
// path is KEPT fail-honest: a deployment whose injected resolver yields null
// still reports `readModelWired:false` loudly with every scanned row skipped
// as `read-model-unwired` — never a falsely-empty "up to date" run.
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

// ---------------------------------------------------------------------------
// #1042 slice-3 — POLICY KNOBS (maintenance window + deny list). These are
// ADDITIVE SUPPRESSORS layered UNDER the master flag: they can only ever make
// an ENABLED loop do LESS. They NEVER turn the loop on — with
// `CINATRA_EXTENSION_AUTO_UPDATE` unset/off the cycle returns before either is
// read, so "default OFF stays OFF" is structural. Delivered per-instance by ops
// tooling (tracked outside this repo).
// ---------------------------------------------------------------------------

/** Env var: maintenance window as a UTC hour range (see the parser). */
export const EXTENSION_AUTO_UPDATE_WINDOW_ENV = "CINATRA_EXTENSION_AUTO_UPDATE_WINDOW";
/** Env var: per-package deny list (comma-separated exact package names). */
export const EXTENSION_AUTO_UPDATE_DENY_ENV = "CINATRA_EXTENSION_AUTO_UPDATE_DENY";

/**
 * Is `now` inside the maintenance window described by `spec`? Pure + exported
 * for direct testing.
 *
 * `spec` is a UTC hour range `"START-END"`, START inclusive and END EXCLUSIVE,
 * each in 0-23 (e.g. `"1-5"` = 01:00–05:00 → hours 1,2,3,4). START > END wraps
 * past midnight (e.g. `"22-6"` = 22:00–06:00 → hours 22,23,0,1,2,3,4,5).
 *
 * FAIL-CLOSED by design (an operator who SET a window intends to restrict; a
 * bad spec must never open the floodgates):
 *   - unset / empty        → TRUE  (no window configured: no restriction)
 *   - malformed / out-of-range / degenerate START==END → FALSE (closed)
 *   - otherwise            → membership test
 */
export function isWithinMaintenanceWindowSpec(
  spec: string | undefined,
  now: Date,
): boolean {
  const trimmed = (spec ?? "").trim();
  if (trimmed === "") return true; // unset → no restriction
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!m) return false; // malformed → fail-closed
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > 23 ||
    end < 0 ||
    end > 23 ||
    start === end // degenerate (empty or all-day is ambiguous) → fail-closed
  ) {
    return false;
  }
  const hour = now.getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Parse the comma-separated deny list into a set of exact package names
 *  (trim + drop empties). Pure + exported for direct testing. */
export function parseAutoUpdateDenyList(spec: string | undefined): Set<string> {
  if (!spec) return new Set();
  return new Set(
    spec
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
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
  // Retained for back-compat of the union; no longer emitted since slice-2's
  // row-scoped compensation lifted the org-rows fence (the loop now runs on
  // org-multi-tenant instances).
  | "org-rows-compensation-fence"
  | "ambiguous-install-scope"
  | "required-in-prod-scope"
  // #1042 slice-3: the package is on the operator deny list.
  | "deny-listed"
  | "read-model-unwired"
  | "read-model-stale"
  | "no-comparable-latest"
  | "up-to-date"
  | "abi-incompatible"
  | "signature-readiness"
  | "state-drift"
  // #1042 slice-1: the expected-version CAS refused at the mutation boundary —
  // a concurrent update won; the loop's stale target lost cleanly (not a
  // failure).
  | "cas-version-lost";

export type ExtensionAutoUpdateRunSummary = {
  /** False = the master flag was off at cycle time; nothing was read. */
  enabled: boolean;
  /** Whether a persistent read-model store was resolvable this cycle. */
  readModelWired: boolean;
  /**
   * #1042 slice-3: maintenance-window verdict. `null` = not evaluated (flag
   * off). `true` = no window configured OR now is inside it → the cycle ran.
   * `false` = a window is configured and now is outside it (or the spec was
   * malformed → fail-closed) → the cycle did no work.
   */
  maintenanceWindowOpen: boolean | null;
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
   * on this deployment (the default resolves the #1310 DB-backed adapter;
   * null keeps the fail-honest `read-model-unwired` path — see the module
   * header).
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
   * #1042 slice-3 policy: is NOW inside the operator maintenance window?
   * Evaluated once per cycle, right after the master-flag check. Default reads
   * `CINATRA_EXTENSION_AUTO_UPDATE_WINDOW` (unset → always true; malformed →
   * fail-closed false). Never turns the loop ON — a closed window only
   * SUPPRESSES an already-enabled cycle.
   */
  isWithinMaintenanceWindow: () => boolean;
  /**
   * #1042 slice-3 policy: is this package on the operator deny list? Applied
   * per candidate during selection. Default reads
   * `CINATRA_EXTENSION_AUTO_UPDATE_DENY` (comma-separated package names; unset →
   * denies nothing).
   */
  isDenied: (packageName: string) => boolean;
  /**
   * Execute ONE update through the manual-update dispatch (see
   * `defaultExecuteUpdate`). Throws on failure; the cycle isolates it.
   * `fromVersion` is the expected currently-installed version — threaded as the
   * #1042 slice-1 expected-version CAS precondition so a concurrent update that
   * already advanced the package makes THIS stale update lose cleanly.
   */
  executeUpdate: (
    candidate: { packageName: string; kind: string; toVersion: string; fromVersion: string },
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
    isWithinMaintenanceWindow: () =>
      isWithinMaintenanceWindowSpec(
        process.env[EXTENSION_AUTO_UPDATE_WINDOW_ENV],
        new Date(),
      ),
    isDenied: (packageName) =>
      parseAutoUpdateDenyList(process.env[EXTENSION_AUTO_UPDATE_DENY_ENV]).has(
        packageName,
      ),
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
      // #1042 wire-up: the persistent DB-backed adapter (#1041, PR #1310) —
      // the SAME process-cached store the /configuration/extensions indicator
      // reads, so the loop and the UI agree on update availability. Lazy so
      // this module never drags the pooled-DB import graph at load time.
      const { getExtensionUpdateReadModelStore } = await import(
        "@/lib/extension-update-read-model-store"
      );
      return getExtensionUpdateReadModelStore();
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
  // #1042 slice-2: the org-rows fence is LIFTED. Slice-1 refused here whenever
  // ANY org-scoped row was present (the package-global-hard-delete-on-
  // compensation hazard); the loop's dispatch now opts into row-scoped
  // compensation, so a same-package OTHER-scope row is provably untouched and
  // an org row appearing mid-cycle is no longer disqualifying. Every OTHER
  // drift check below still holds (the recheck is package-scoped to NULL-org).
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
  candidate: { packageName: string; kind: string; toVersion: string; fromVersion: string },
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
      // #1042 slice-1: expected-version CAS. The direct in-place update refuses
      // at the mutation boundary (under the per-package install lock) if the
      // installed version already moved off `fromVersion` — the loop's cached
      // target loses cleanly to a concurrent update, never double-applies.
      { expectedInstalledVersion: candidate.fromVersion },
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
    // #1042 slice-1: expected-version CAS on the root update member (see above).
    expectedRootInstalledVersion: candidate.fromVersion,
    // #1042 slice-2: row-scoped compensation — a mid-batch failure tears down
    // ONLY the freshly-installed actor-scope rows, never the package-global
    // hard-delete. This is what makes the loop safe on org-multi-tenant
    // instances (the org-rows fence is lifted).
    rowScopedCompensation: true,
  });
}

/**
 * A selected update candidate: an eligible NULL-org verdaccio-live row carrying
 * a strictly-newer `toVersion`, past EVERY selection gate (scope, exactly-one-
 * row-per-package, non-required, deny list, read-model wiring/staleness,
 * comparability, ABI, and the fleet signature-readiness gate). The pre-dispatch
 * recheck + expected-version CAS may still SHRINK this set at execution.
 *
 * Exported so the on-demand reconcile surface (#1042 lever) can select the SAME
 * set the daily loop does, digest it, and execute EXACTLY it — never a second,
 * divergent selection.
 */
export type SelectedUpdateCandidate = {
  row: AutoUpdateInstalledRow;
  currentVersion: string;
  toVersion: string;
};

/** A fresh, zeroed run summary. Shared so the loop and the on-demand reconcile
 *  surface start from the identical shape. */
export function newExtensionAutoUpdateRunSummary(): ExtensionAutoUpdateRunSummary {
  return {
    enabled: true,
    readModelWired: false,
    maintenanceWindowOpen: null,
    signatureReady: null,
    scanned: 0,
    applied: [],
    failed: [],
    skipped: [],
    auditWriteFailures: 0,
  };
}

/** Wrap `deps.writeAuditEvent` so a durable-audit-write failure is COUNTED on
 *  `summary.auditWriteFailures` and swallowed — an audit-write failure never
 *  flips an update outcome (matching the loop). Shared by the loop and the
 *  reconcile surface so audit semantics never diverge. */
export function makeExtensionAutoUpdateAuditWriter(
  deps: ExtensionAutoUpdateDeps,
  summary: ExtensionAutoUpdateRunSummary,
): (event: AutoUpdateAuditEvent) => Promise<void> {
  return async (event) => {
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

  const summary = newExtensionAutoUpdateRunSummary();

  if (!deps.isEnabled()) {
    // Defense in depth: the boot seed never schedules the loop while the flag
    // is off, but a canonical job from a previously-enabled boot may still
    // fire. Do nothing — no reads, no writes. The policy knobs are NOT even
    // consulted here: "default OFF stays OFF" is structural.
    summary.enabled = false;
    return summary;
  }

  const writeAudit = makeExtensionAutoUpdateAuditWriter(deps, summary);

  // #1042 slice-3: MAINTENANCE WINDOW gate. Evaluated ONLY after the master
  // flag is on (the knob can never turn the loop on). Closed → the cycle does
  // NO work (no reads, no dispatch); the per-run audit still fires here so a
  // suppressed run is observable. A malformed/unset spec is resolved
  // fail-closed / open by the dep (see `isWithinMaintenanceWindowSpec`).
  summary.maintenanceWindowOpen = deps.isWithinMaintenanceWindow();
  if (!summary.maintenanceWindowOpen) {
    console.warn(
      "[extension-auto-update] outside the configured maintenance window — cycle suppressed (no candidates scanned or executed)",
    );
    await writeAudit(buildRunAuditEvent(summary));
    return summary;
  }

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
  // The loop = the SAME selection + execution the on-demand reconcile surface
  // (#1042 lever) uses, composed. Selection is pure (no writes); execution
  // isolates per candidate. Splitting them lets reconcile select ONCE, digest
  // that exact set for its plan-digest CAS, then execute exactly it — never a
  // second, divergent selection.
  const candidates = await selectAutoUpdateCandidates(deps, summary);
  await executeAutoUpdateCandidates(deps, summary, candidates, writeAudit);
}

/**
 * PURE SELECTION — no execution, no writes. Read the install rows + cached
 * update read model and return the eligible candidate set, applying EVERY
 * selection gate (NULL-org scope, exactly-one-row-per-package, verdaccio-live,
 * non-required, deny list, read-model wiring + staleness, comparability, ABI,
 * and the fleet signature-readiness gate). Mutates `summary` (scanned, skipped,
 * readModelWired, signatureReady). Returns [] when the read model is unwired,
 * the fleet signature-readiness gate fences the cycle, or nothing is eligible.
 *
 * Shared by `runEnabledCycle` (the daily loop) and the reconcile surface so
 * both select IDENTICALLY. Safe to run as a dry-run plan — it never mutates and
 * never writes an audit row.
 */
export async function selectAutoUpdateCandidates(
  deps: ExtensionAutoUpdateDeps,
  summary: ExtensionAutoUpdateRunSummary,
): Promise<SelectedUpdateCandidate[]> {
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
    // #1042 slice-3: operator deny list — an explicitly-denied package never
    // auto-updates even when otherwise eligible.
    if (deps.isDenied(packageName)) {
      skip(packageName, "deny-listed");
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

  // ---- #1042 slice-2: the org-rows compensation fence is LIFTED. Slice-1
  // halted the whole cycle whenever the instance held ANY org-scoped install
  // row, because the batch's mid-batch compensation of a freshly-installed
  // dependency could take the platform-admin PACKAGE-GLOBAL hard-delete branch
  // and tear down same-package OTHER-org rows. The loop's dispatch now opts
  // into ROW-SCOPED compensation (`rowScopedCompensation:true` →
  // `uninstallMemberRowScoped` → `deleteScopedCanonicalRow`), which provably
  // removes ONLY the freshly-installed actor-scope (NULL-org) row and never the
  // package-global backing or another org's rows. Combined with the structural
  // NULL-org actor bound (the dispatcher can only address NULL-org rows), an
  // org-multi-tenant instance is safe — so the cycle no longer fences. ----

  // ---- update-availability via the cached read model ----------------------
  const store = await deps.resolveUpdateReadModelStore();
  if (store === null) {
    // Enabled but unwired: loud, and every scoped row records why. The cycle
    // is NOT presented as a successful no-updates run.
    console.warn(
      "[extension-auto-update] enabled but no persistent update read-model store is wired on this deployment — zero candidates (see extension-auto-update.ts header)",
    );
    for (const s of scoped) skip(s.row.packageName, "read-model-unwired");
    return [];
  }
  summary.readModelWired = true;

  const readouts = await readUpdateModelForInstalled(
    store,
    scoped.map((s) => s.row.packageName),
    { now: deps.now(), ttlMs: EXTENSION_AUTO_UPDATE_READ_MODEL_TTL_MS },
  );
  const readoutByPackage = new Map(readouts.map((r) => [r.packageName, r]));

  const candidates: SelectedUpdateCandidate[] = [];
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
      return [];
    }
  }

  return candidates;
}

/**
 * EXECUTE a pre-selected candidate set with per-candidate ISOLATION. The
 * pre-dispatch TOCTOU recheck + expected-version CAS may only SHRINK the set
 * (drift → `state-drift`; a concurrent update winning the CAS →
 * `cas-version-lost`); a per-candidate failure is recorded and never aborts the
 * rest. Mutates `summary` (applied, failed, skipped) and writes durable audit
 * events via `writeAudit`.
 *
 * Shared by `runEnabledCycle` (the daily loop) and the on-demand reconcile
 * surface so the execution semantics — recheck, CAS, isolation, audit — never
 * diverge. The candidate LIST is fixed by the caller's single selection; the
 * recheck can only DROP items, never add, so an operator-pinned plan-digest
 * executes exactly its approved set (shrunk by any fresh drift).
 */
export async function executeAutoUpdateCandidates(
  deps: ExtensionAutoUpdateDeps,
  summary: ExtensionAutoUpdateRunSummary,
  candidates: readonly SelectedUpdateCandidate[],
  writeAudit: (event: AutoUpdateAuditEvent) => Promise<void>,
): Promise<void> {
  const skip = (packageName: string, reason: AutoUpdateSkipReason): void => {
    summary.skipped.push({ packageName, reason });
  };
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
        {
          packageName: c.row.packageName,
          kind: c.row.kind,
          toVersion: c.toVersion,
          // #1042 slice-1: the expected-version CAS precondition — the update
          // applies only if the installed version is still `currentVersion` at
          // the mutation boundary.
          fromVersion: c.currentVersion,
        },
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
      // #1042 slice-1: the expected-version CAS refused at the mutation
      // boundary — a concurrent update advanced the package after selection, so
      // this cached target LOST cleanly. That is NOT a failure (nothing was
      // mutated, the newer version is already serving); record it as a distinct
      // benign SKIP, not in `failed`. Duck-typed on the stable error code so the
      // loop needs no cross-package class import.
      if (
        (err as { code?: unknown } | null | undefined)?.code ===
        "EXPECTED_VERSION_MISMATCH"
      ) {
        console.warn(
          "[extension-auto-update] expected-version CAS lost for %s (%s -> %s): a concurrent update won; not double-applying",
          c.row.packageName,
          c.currentVersion,
          c.toVersion,
        );
        skip(c.row.packageName, "cas-version-lost");
        continue;
      }
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
      maintenanceWindowOpen: summary.maintenanceWindowOpen,
      signatureReady: summary.signatureReady,
      scanned: summary.scanned,
      applied: summary.applied.length,
      failed: summary.failed.length,
      skippedByReason,
    },
  };
}
