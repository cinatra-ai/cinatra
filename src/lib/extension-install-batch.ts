import "server-only";

// Dependency-BATCH install saga (#180 PR-2, items 1/2/3/7).
//
// The single entry the install surfaces call for a FRESH extension install:
//
//   1. AUTHORIZE ONCE (gatekept): resolve the root grant + exact-pinned
//      closure via `resolveGatekeptInstallConfig`, then run EVERYTHING below
//      inside the install-grant context — every member read derives from the
//      ROOT grant; per-member authorize is structurally impossible
//      (test-asserted). Dev/non-gatekept: same flow, no grant.
//   2. PLAN under the GLOBAL extension lifecycle lock: the manifest-edge walk
//      filtered by `isAutoInstallableEdge` (peer/optional NEVER auto-install),
//      closure-membership + range cross-checks, installed-version conflicts,
//      topo order dependencies-first/root-last (extension-dependency-plan.ts).
//      Per-member PRE-STATE (present-before-batch?) is captured here, under
//      the same lock — the compensation discriminator.
//   3. INSTALL members in topo order through the REAL dispatcher
//      (`extensionRegistry.install`) — every member gets the full pipeline
//      (materialize → gates → journal → finalize → edges, #161/#180-PR-1
//      included). The root installs LAST. Ledger states advance per member.
//   4. MEMBER FAILURE (anywhere — incl. the built-artifacts serverEntry gate
//      or a migration preflight inside the member's own pipeline): abort the
//      queue, COMPENSATE newly-installed members ONLY (pre-existing members
//      untouched) in INVERSE install order, ledger → compensated, original
//      error rethrown.
//   5. GRANT TTL (P2-5): before each member the root grant's expiry is
//      checked; near-expiry triggers the injectable REFRESH seam (closure
//      must be unchanged). Refresh unavailable/failed → abort + compensate —
//      a batch NEVER proceeds (or resumes) under an expired grant.
//
// BOOT RECOVERY: `sweepStaleInstallBatches` compensates stale ACTIVE batches
// from the LEDGER (the per-op orphan cleanup cannot see them — a crashed
// batch's already-installed members have FINALIZED ops). It runs BEFORE the
// per-op cleanup at boot; the per-op cleanup SKIPS ops owned by still-active
// batches (`collectActiveBatchMemberKeys`). There is no grant at boot, so
// recovery is always compensate-never-resume.
//
// PRECONDITION: callers run where the extension handlers are bootstrapped
// (the actions / MCP dispatch surfaces import handler-bootstrap before
// dispatching here) — the default installer resolves `extensionRegistry`.

import { randomUUID } from "node:crypto";
import type { Actor } from "@cinatra-ai/extension-types";
import type {
  GatekeptInstallResolution,
  GatekeptGrantRefresh,
} from "@/lib/gatekept-install";
import type {
  DependencyInstallPlan,
  DependencyPlanDeps,
} from "@/lib/extension-dependency-plan";
import type {
  InstallBatch,
  InstallBatchMember,
  InstallBatchOpsDeps,
} from "@/lib/extension-install-batch-ops";

export type BatchInstallResult = {
  rootPackage: string;
  rootVersion: string;
  /** Members THIS call installed (dependencies first; the root is last). */
  installed: { packageName: string; version: string }[];
  /** Closure members that were already present and were skipped. */
  alreadyInstalled: string[];
  batchId: string | null; // null = root-only fast path (no ledger row)
};

export class BatchMemberInstallError extends Error {
  constructor(
    message: string,
    public readonly member: string,
    public readonly compensated: string[],
    public readonly compensationFailures: string[],
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BatchMemberInstallError";
  }
}

/** Refresh when the grant expires within this margin (P2-5 short-TTL grants). */
const GRANT_REFRESH_MARGIN_MS = 60_000;

export type InstallBatchSagaDeps = {
  /** Gatekept master switch (per call, like the resolver seam). */
  isGatekeptInstallEnabled: () => boolean;
  /** AUTHORIZE the root — called EXACTLY ONCE per batch (test-asserted). */
  authorizeRoot: (
    packageName: string,
    version?: string,
  ) => Promise<GatekeptInstallResolution>;
  /** The P2-5 grant-refresh seam (default fails closed until the ability ships). */
  refreshGrant: GatekeptGrantRefresh;
  /** Run `fn` inside the install-grant context (root grant + member kinds). */
  withGrantContext: <T>(
    ctx: {
      rootPackageName: string;
      resolution: GatekeptInstallResolution;
      memberKinds: Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">;
    },
    fn: () => Promise<T>,
  ) => Promise<T>;
  /** The ACTIVE grant context, if a caller (e.g. the MCP install surface)
   *  already authorized this root and entered the context — the batch ADOPTS
   *  it instead of authorizing a second time (authorize-once spans the WHOLE
   *  install surface, not just the batch body). */
  getActiveGrantContext: () => {
    rootPackageName: string;
    resolution: GatekeptInstallResolution;
    memberKinds: Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">;
  } | null;
  /** Global lifecycle lock for the PLANNING + ledger-begin phase. */
  withGlobalLifecycleLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The planner (defaults wire the real seams). */
  plan: (input: {
    root: { packageName: string; version: string };
    orgId: string | null;
    closure: GatekeptInstallResolution["authorize"]["closure"] | null;
  }) => Promise<DependencyInstallPlan>;
  /**
   * Run `fn` with the SAGA-OWNED-FAN-OUT context active (#157). The agent
   * extension handler, dispatched per-member by `installMember` inside this
   * scope, installs ONLY the root package it is handed (it does NOT re-run the
   * @cinatra-ai/registries dep-resolver) — the saga owns the dependency
   * fan-out. Defaults to the real `withSagaOwnedFanout` from @cinatra-ai/agents.
   */
  withSagaOwnedFanout: <T>(rootPackageName: string, fn: () => Promise<T>) => Promise<T>;
  /** Install ONE package through the real dispatcher. */
  installMember: (member: { typeId: string; packageName: string; version: string }, actor: Actor) => Promise<void>;
  /** Uninstall ONE package through the real dispatcher (compensation inverse). */
  uninstallMember: (member: { typeId: string; packageName: string; version: string }, actor: Actor) => Promise<void>;
  /**
   * Fire the SINGLE WayFlow agent-runtime reload at the batch SUCCESS boundary
   * (#157). The agent handler no longer reloads per-member (it installs
   * root-only under the saga), and `installAgentFromPackage` never reloads on
   * its own, so the saga is now the canonical single-shot reload trigger when
   * an agent member was installed. Best-effort: a reload failure is logged, not
   * fatal (the durable DB + disk writes already succeeded). Defaults to the
   * real `triggerWayflowReload` from @cinatra-ai/agents.
   */
  triggerAgentRuntimeReload: () => Promise<{ ok: boolean; reason?: string; detail?: string }>;
  /** Pre-state reads (canonical row + install-op journal). */
  readLiveRowVersion: (packageName: string, orgId: string | null) => Promise<{ present: boolean; version?: string }>;
  readInstallOp: (packageName: string, orgId: string | null) => Promise<{ installOpId: string; phase: string } | null>;
  /** Ledger ops (default: the real batch store). */
  ledger: {
    begin: (input: { batchId: string; rootPackage: string; orgId: string | null; members: InstallBatchMember[] }) => Promise<InstallBatch>;
    setPhase: (batchId: string, phase: InstallBatch["phase"]) => Promise<InstallBatch>;
    updateMember: (batchId: string, packageName: string, patch: Partial<Pick<InstallBatchMember, "status" | "installOpId" | "detail">>) => Promise<InstallBatch>;
    listActive: () => Promise<InstallBatch[]>;
  };
  now: () => number;
};

export async function makeDefaultInstallBatchSagaDeps(): Promise<InstallBatchSagaDeps> {
  const { isGatekeptInstallEnabled, resolveGatekeptInstallConfig, refreshGatekeptInstallGrant } =
    await import("@/lib/gatekept-install");
  const { withInstallGrantContext, getActiveInstallGrantContext } = await import(
    "@/lib/extension-install-grant-context"
  );
  const { planDependencyInstall } = await import("@/lib/extension-dependency-plan");
  const { readInstallOp } = await import("@/lib/extension-install-ops");
  const batchOps = await import("@/lib/extension-install-batch-ops");
  const { parseManifestDependencyEdges } = await import(
    "@cinatra-ai/extensions/manifest-dependencies"
  );
  const { isAutoInstallableEdge } = await import("@cinatra-ai/extensions/dependency-closure");

  const planDeps: DependencyPlanDeps = {
    fetchSummary: async (packageName, versionOrRange) => {
      const {
        getPublishedExtensionSummary,
        resolveExtensionDistIntegrity,
        resolveMaxSatisfyingVersion,
        isExactVersion,
        isValidVersionRange,
      } = await import("@cinatra-ai/registries");
      // Config: gatekept ON → the grant-context-aware resolver (derives the
      // broker config under the root grant inside a batch); OFF → the
      // server read config (legacy direct read).
      let config;
      if (isGatekeptInstallEnabled()) {
        const { config: c } = await resolveGatekeptInstallConfig(packageName, versionOrRange);
        config = c;
      } else {
        const { loadVerdaccioConfigForReads } = await import("@/lib/verdaccio-config");
        config = await loadVerdaccioConfigForReads();
      }
      const isExact = isExactVersion(versionOrRange);
      let exact = isExact ? versionOrRange : undefined;
      if (!isExact && versionOrRange !== "latest" && versionOrRange !== "") {
        if (isValidVersionRange(versionOrRange)) {
          // A RANGE (dev path): pacote resolves exact versions and dist-tags
          // but NOT ranges against Verdaccio — resolve via the packument's
          // version list (highest satisfying; live-verify finding).
          const resolved = await resolveMaxSatisfyingVersion(
            { packageName, range: versionOrRange },
            config,
          );
          if (!resolved) {
            throw new Error(
              `[extension-install-batch] no published version of ${packageName} satisfies "${versionOrRange}"`,
            );
          }
          exact = resolved;
        } else {
          // A DIST-TAG (e.g. "beta"/"next") — keep the original pacote
          // resolution semantics (merge-gate finding: tags are not ranges).
          const resolved = await resolveExtensionDistIntegrity(
            { packageName, packageVersion: versionOrRange },
            config,
          );
          exact = resolved.resolvedVersion ?? undefined;
        }
      }
      const summary = await getPublishedExtensionSummary(
        { packageName, ...(exact ? { packageVersion: exact } : {}) },
        config,
      );
      if (!summary.resolvedVersion) {
        throw new Error(`[extension-install-batch] no resolvable version for ${packageName}@${versionOrRange}`);
      }
      return {
        resolvedVersion: summary.resolvedVersion,
        kind: summary.kind,
        manifest: summary.manifest,
      };
    },
    // The PR-1 dual-read helper (fail-loud on conflict/malformed) + the
    // shared auto-install predicate — the SAME seams the install gates use.
    parseEdges: (manifest, packageName) =>
      parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge: (dep) => isAutoInstallableEdge(dep),
    readInstalledRows: async () => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      return listInstalledExtensions({});
    },
  };

  return {
    isGatekeptInstallEnabled,
    authorizeRoot: (packageName, version) => resolveGatekeptInstallConfig(packageName, version),
    refreshGrant: refreshGatekeptInstallGrant,
    withGrantContext: (ctx, fn) => withInstallGrantContext(ctx, fn),
    getActiveGrantContext: () => {
      const ctx = getActiveInstallGrantContext();
      return ctx
        ? { rootPackageName: ctx.rootPackageName, resolution: ctx.resolution, memberKinds: ctx.memberKinds }
        : null;
    },
    withGlobalLifecycleLock: async (fn) => {
      const { withGlobalExtensionLifecycleLock } = await import("@cinatra-ai/agents");
      return withGlobalExtensionLifecycleLock(fn);
    },
    withSagaOwnedFanout: async (rootPackageName, fn) => {
      const { withSagaOwnedFanout } = await import("@cinatra-ai/agents");
      return withSagaOwnedFanout({ rootPackageName }, fn);
    },
    triggerAgentRuntimeReload: async () => {
      const { triggerWayflowReload } = await import("@cinatra-ai/agents");
      return triggerWayflowReload();
    },
    plan: (input) => planDependencyInstall(input, planDeps),
    installMember: async (member, actor) => {
      const { extensionRegistry } = await import("@cinatra-ai/extensions");
      await extensionRegistry.install(
        member.typeId,
        { registryUrl: "", packageName: member.packageName, version: member.version },
        actor,
      );
    },
    uninstallMember: async (member, actor) => {
      const { extensionRegistry } = await import("@cinatra-ai/extensions");
      await extensionRegistry.uninstall(
        member.typeId,
        { registryUrl: "", packageName: member.packageName, version: member.version },
        actor,
      );
    },
    readLiveRowVersion: async (packageName, orgId) => {
      const { readInstalledExtensionsByPackageName } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const rows = await readInstalledExtensionsByPackageName(packageName);
      const live = rows.filter((r) => r.status === "active" || r.status === "locked");
      const row =
        live.find((r) => (r.organizationId ?? null) === (orgId ?? null)) ??
        live.find((r) => (r.organizationId ?? null) === null) ??
        null;
      if (!row) return { present: false };
      const v = (row.source as { version?: string } | null)?.version;
      return { present: true, ...(v ? { version: v } : {}) };
    },
    readInstallOp: (pkg, orgId) => readInstallOp(pkg, orgId),
    ledger: {
      begin: (i) => batchOps.beginInstallBatch(i),
      setPhase: (id, phase) => batchOps.setInstallBatchPhase(id, phase),
      updateMember: (id, pkg, patch) => batchOps.updateInstallBatchMember(id, pkg, patch),
      listActive: () => batchOps.listActiveInstallBatches(),
    },
    now: () => Date.now(),
  };
}

/**
 * The dependency-batch install entry. See the module doc for the saga shape.
 */
export async function installExtensionWithDependencies(
  input: { packageName: string; version?: string; actor: Actor },
  depsOverride?: InstallBatchSagaDeps,
): Promise<BatchInstallResult> {
  // Tests inject COMPLETE deps; production callers take the default factory
  // (building it eagerly under injected deps would drag the whole dispatcher
  // import graph into unit tests for nothing).
  const deps = depsOverride ?? (await makeDefaultInstallBatchSagaDeps());
  const orgId = input.actor.orgId ?? null;

  // 1. AUTHORIZE ONCE (gatekept) — the single authorize of the whole install
  //    surface. If the CALLER already authorized this root and entered the
  //    grant context (the MCP surface does, so its lifecycle/visibility
  //    resolution derives instead of re-authorizing), the batch ADOPTS that
  //    context; otherwise it authorizes here and enters its own.
  const gatekept = deps.isGatekeptInstallEnabled();
  const adoptedCtx = gatekept ? deps.getActiveGrantContext() : null;
  const adopted = adoptedCtx?.rootPackageName === input.packageName ? adoptedCtx : null;
  const resolution = gatekept
    ? adopted
      ? adopted.resolution
      : await deps.authorizeRoot(input.packageName, input.version)
    : null;
  const rootVersion = resolution
    ? resolution.authorize.resolvedVersion
    : (input.version ?? "latest");

  const runBatch = async (): Promise<BatchInstallResult> => {
    // #157: fire the SINGLE agent-runtime reload iff at least one agent member
    // was installed this run. Best-effort — a reload failure is logged, never
    // fatal (the durable DB + disk writes already succeeded). Called once at the
    // batch success boundary; replaces the per-tree reload that
    // installAgentPackageWithDependencies used to fire (the agent handler now
    // installs root-only under the saga and never reloads on its own).
    const maybeReloadAgentRuntime = async (
      installed: { typeId: string; packageName: string }[],
    ): Promise<void> => {
      if (!installed.some((m) => m.typeId === "agent")) return;
      // STRICTLY best-effort: the durable DB + disk writes already landed and
      // the batch is finalized. A reload that returns ok:false OR THROWS (a
      // rejected dynamic import, a network error) must NOT fail the completed
      // install — both are logged identically and swallowed.
      try {
        const reload = await deps.triggerAgentRuntimeReload();
        if (!reload.ok) {
          // Dynamic values (package name, broker-derived reason/detail) are
          // passed as console SUBSTITUTION ARGUMENTS, never spliced into the
          // format-string position — a format string built from
          // externally-influenced input is a CodeQL js/tainted-format-string
          // hazard, and these values are not trusted to be %-clean.
          console.warn(
            "[extension-install-batch] agent runtime reload returned ok:false " +
              "reason=%s detail=%s (root %s is installed but the runtime may need " +
              "a restart or another reload trigger)",
            reload.reason ?? "—",
            reload.detail ?? "—",
            input.packageName,
          );
        }
      } catch (err) {
        console.warn(
          "[extension-install-batch] agent runtime reload threw (best-effort, " +
            "swallowed): root %s is installed but the runtime may need a restart " +
            "or another reload trigger:",
          input.packageName,
          err instanceof Error ? err.message : err,
        );
      }
    };

    // 2. PLAN (+ pre-state capture + overlap guard + ledger begin) under the
    //    GLOBAL lifecycle lock — then release it before installing members
    //    (each member install takes its own per-package lock; holding the
    //    global lock across full installs would serialize every unrelated
    //    lifecycle op behind the batch).
    const planned = await deps.withGlobalLifecycleLock(async () => {
      const plan = await deps.plan({
        root: { packageName: input.packageName, version: rootVersion },
        orgId,
        closure: resolution ? resolution.authorize.closure : null,
      });

      const toInstall = plan.ordered.filter((m) => !m.alreadyInstalled);
      const alreadyInstalled = plan.ordered
        .filter((m) => m.alreadyInstalled)
        .map((m) => m.packageName);

      // CONCURRENCY CONTRACT: refuse when ANY active batch (same org scope)
      // overlaps this plan's member set — `beginInstallOp`'s reset-on-begin
      // would otherwise let two installs fight over one (package, org)
      // journal row. Checked BEFORE the root-only fast path below: a direct
      // single-package install of a package that is a MEMBER of an in-flight
      // batch is exactly the reset-on-begin hazard this contract closes.
      // The DB's partial unique index backstops root-level uniqueness.
      const active = await deps.ledger.listActive();
      const plannedNames = new Set(plan.ordered.map((m) => m.packageName));
      for (const b of active) {
        if ((b.orgId ?? null) !== orgId) continue;
        const overlap = [b.rootPackage, ...b.members.map((m) => m.packageName)].filter((n) =>
          plannedNames.has(n),
        );
        if (overlap.length > 0) {
          throw new Error(
            `[extension-install-batch] another install batch (${b.batchId}, root ${b.rootPackage}) ` +
              `is in flight and overlaps this install on: ${[...new Set(overlap)].join(", ")} — ` +
              `retry after it completes.`,
          );
        }
      }

      // ROOT-ONLY FAST PATH: nothing to auto-install → no ledger row, the
      // root installs exactly as before (one canonical row, one journal op).
      if (toInstall.length === 1 && toInstall[0]!.packageName === input.packageName) {
        return { plan, batch: null as InstallBatch | null, toInstall, alreadyInstalled };
      }

      // PRE-STATE per member (under the same lock — precise compensation basis).
      const members: InstallBatchMember[] = [];
      for (const m of plan.ordered) {
        const row = await deps.readLiveRowVersion(m.packageName, orgId);
        const op = await deps.readInstallOp(m.packageName, orgId);
        members.push({
          packageName: m.packageName,
          version: m.version,
          typeId: m.typeId,
          status: m.alreadyInstalled ? "already-installed" : "planned",
          preState: {
            present: row.present,
            ...(row.version ? { version: row.version } : {}),
            ...(op ? { installOpId: op.installOpId, installOpPhase: op.phase } : {}),
          },
        });
      }
      const batch = await deps.ledger.begin({
        batchId: randomUUID(),
        rootPackage: input.packageName,
        orgId,
        members,
      });
      await deps.ledger.setPhase(batch.batchId, "installing");
      return { plan, batch, toInstall, alreadyInstalled };
    });

    const { batch, toInstall, alreadyInstalled } = planned;
    void planned.plan; // (plan retained on `planned` for the result's resolved root version)

    // ROOT-ONLY FAST PATH (no ledger). Still runs inside the saga-owned-fan-out
    // context (#157): even a depless root must install root-only so the agent
    // handler does not re-fan-out via the second registries resolver. The
    // single agent reload fires here at the success boundary when the root is
    // an agent (installAgentFromPackage does not reload on its own).
    if (batch === null) {
      const root = toInstall[0]!;
      await deps.withSagaOwnedFanout(input.packageName, () =>
        deps.installMember(root, input.actor),
      );
      await maybeReloadAgentRuntime([root]);
      return {
        rootPackage: input.packageName,
        // The PLANNED root version (dev "latest" already resolved concrete).
        rootVersion: root.version,
        installed: [{ packageName: root.packageName, version: root.version }],
        alreadyInstalled,
        batchId: null,
      };
    }

    // 3. INSTALL members in topo order (dependencies first, root last).
    //    EVERY failure in the per-member sequence — the TTL/refresh check,
    //    the ledger transitions, the install itself — routes into ONE abort +
    //    compensation path: the batch either returns success with the ledger
    //    `finalized`, or it compensates and throws. A ledger write failing
    //    after members installed must not strand them outside the
    //    compensation contract.
    //
    //    REQUIRES_REBUILD is a REFUSAL on every kind that throws it (the
    //    dispatcher rolled back the placeholder row — nothing durable
    //    installed), so it aborts + compensates like any failure; the RAW
    //    error is rethrown (not wrapped) so the MCP surface keeps returning
    //    its structured { requiresRebuild: true } outcome.
    const installedThisBatch: { packageName: string; version: string; typeId: string }[] = [];
    for (const member of toInstall) {
      try {
        // P2-5 GRANT TTL: refresh near expiry; refusal/unavailability aborts.
        if (resolution) {
          const expiresAt = Date.parse(resolution.authorize.expiresAt);
          if (Number.isFinite(expiresAt) && expiresAt - deps.now() < GRANT_REFRESH_MARGIN_MS) {
            const { computeClosureHash } = await import("@/lib/gatekept-install");
            const refreshed = await deps.refreshGrant(resolution, {
              packageName: input.packageName,
              version: rootVersion,
              closureHash: computeClosureHash(resolution.authorize.closure),
            });
            // The refresh must NOT change the authorization set (closure-hash
            // binding) — a drifted closure is a refused refresh.
            const same =
              refreshed.authorize.closure.length === resolution.authorize.closure.length &&
              refreshed.authorize.closure.every((c) =>
                resolution.authorize.closure.some(
                  (o) => o.name === c.name && o.version === c.version,
                ),
              );
            if (!same) {
              throw new Error(
                `[extension-install-batch] grant refresh returned a DIFFERENT closure for ` +
                  `${input.packageName}@${rootVersion} — refusing to continue the batch.`,
              );
            }
            // Mutate in place: the grant context holds this object by
            // reference, so derived member reads pick up the new grant token.
            resolution.config = refreshed.config;
            resolution.authorize = refreshed.authorize;
          }
        }

        await deps.ledger.updateMember(batch.batchId, member.packageName, { status: "installing" });
        // #157: the agent handler dispatched here installs ROOT-ONLY under the
        // saga-owned-fan-out context — the saga (this loop) owns the dependency
        // fan-out, so no second registries dep-resolver runs per member.
        await deps.withSagaOwnedFanout(input.packageName, () =>
          deps.installMember(member, input.actor),
        );
        // Track the durable install IMMEDIATELY — before the ledger write —
        // so a ledger failure right after a successful member install still
        // compensates that member (it IS installed, whatever the ledger says).
        installedThisBatch.push(member);
        const op = await deps.readInstallOp(member.packageName, orgId).catch(() => null);
        await deps.ledger.updateMember(batch.batchId, member.packageName, {
          status: "installed",
          ...(op ? { installOpId: op.installOpId } : {}),
        });
      } catch (err) {
        await abortAndCompensate(member.packageName, err);
        throw err; // unreachable (abortAndCompensate throws) — defensive.
      }
    }

    try {
      await deps.ledger.setPhase(batch.batchId, "finalized");
    } catch (err) {
      // The batch is success IFF the ledger says `finalized` — a batch left
      // ACTIVE would be compensated by the boot sweeper later anyway, so
      // compensate NOW, deterministically, with the loud error.
      await abortAndCompensate(input.packageName, err);
      throw err; // unreachable — defensive.
    }
    // #157: SINGLE agent-runtime reload at the batch success boundary. The
    // agent handler installed root-only per member (no per-member reload) and
    // installAgentFromPackage never reloads on its own, so the saga is now the
    // canonical single-shot reload. Fires ONCE for the whole batch iff an agent
    // member was installed this run; best-effort (durable writes already
    // landed). After `finalized` so a reload failure never un-finalizes a batch.
    await maybeReloadAgentRuntime(installedThisBatch);
    return {
      rootPackage: input.packageName,
      // The PLANNED root version — concrete on both paths (gatekept authorize
      // pin, or the dev registry resolution).
      rootVersion:
        planned.plan.ordered.find((m) => m.packageName === input.packageName)?.version ??
        rootVersion,
      installed: installedThisBatch.map(({ packageName, version }) => ({ packageName, version })),
      alreadyInstalled,
      batchId: batch.batchId,
    };

    // -- 4. abort + inverse-order compensation -----------------------------
    async function abortAndCompensate(failedMember: string, cause: unknown): Promise<never> {
      await deps.ledger
        .updateMember(batch!.batchId, failedMember, {
          status: "failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        })
        .catch(() => undefined);
      await deps.ledger.setPhase(batch!.batchId, "failed").catch(() => undefined);

      const compensated: string[] = [];
      const failures: string[] = [];
      // NEWLY-INSTALLED members only (pre-state absent), INVERSE install order.
      for (const m of [...installedThisBatch].reverse()) {
        const ledgerMember = batch!.members.find((x) => x.packageName === m.packageName);
        if (ledgerMember?.preState.present) continue; // never remove a pre-existing install
        try {
          await deps.uninstallMember(m, input.actor);
          await deps.ledger.updateMember(batch!.batchId, m.packageName, { status: "compensated" });
          compensated.push(m.packageName);
        } catch (err) {
          failures.push(m.packageName);
          await deps.ledger
            .updateMember(batch!.batchId, m.packageName, {
              status: "compensation-failed",
              detail: err instanceof Error ? err.message : String(err),
            })
            .catch(() => undefined);
          console.error(
            `[extension-install-batch] compensation uninstall of ${m.packageName} failed (batch ${batch!.batchId}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      await deps.ledger
        .setPhase(batch!.batchId, failures.length === 0 ? "compensated" : "failed")
        .catch(() => undefined);
      // REQUIRES_REBUILD: the refusing kind needs a host rebuild before this
      // install can proceed — compensation has run; rethrow the RAW error so
      // the structured { requiresRebuild } surface contract is preserved.
      if ((cause as { code?: unknown } | null)?.code === "REQUIRES_REBUILD") {
        throw cause;
      }
      throw new BatchMemberInstallError(
        `Installing ${input.packageName}@${rootVersion} failed at dependency ${failedMember}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. ` +
          (compensated.length > 0
            ? `Rolled back the dependencies this install had added (${compensated.join(", ")}); `
            : `No dependencies needed rollback; `) +
          (failures.length > 0
            ? `ROLLBACK INCOMPLETE for ${failures.join(", ")} — these may need manual removal. `
            : ``) +
          `Previously-installed extensions were not touched.`,
        failedMember,
        compensated,
        failures,
        cause,
      );
    }
  };

  // The WHOLE batch (planning + member installs) runs inside the grant
  // context on the gatekept path — `resolveGatekeptInstallConfig` derives
  // every read from the root grant; authorize ran exactly once (here or in
  // the adopting caller).
  if (resolution) {
    // memberKinds are only known after planning; the context map is filled by
    // the planner via this wrapper (reads happen during/after planning).
    const targetKinds = adopted
      ? adopted.memberKinds
      : new Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">();
    const innerPlan = deps.plan;
    deps.plan = async (i) => {
      const p = await innerPlan(i);
      for (const [k, v] of p.memberKinds) targetKinds.set(k, v);
      return p;
    };
    if (adopted) {
      // Already INSIDE the caller's context — run directly (re-entering with
      // the same object would be a harmless nest; skipping it keeps the
      // adopted context the single source of truth).
      return runBatch();
    }
    return deps.withGrantContext(
      { rootPackageName: input.packageName, resolution, memberKinds: targetKinds },
      runBatch,
    );
  }
  return runBatch();
}

// ---------------------------------------------------------------------------
// Boot recovery — the batch sweeper
// ---------------------------------------------------------------------------

/**
 * Compensate STALE active batches from the ledger (compensate-never-resume:
 * there is no root grant at boot, and P2-5 forbids continuing without one).
 * Members this batch newly installed (pre-state absent) whose install reached
 * `installed`/`installing` are uninstalled in inverse order; pre-existing
 * members are untouched. Idempotent + best-effort per member.
 */
export async function sweepStaleInstallBatches(
  opts?: { olderThanMs?: number },
  depsOverride?: {
    listStale?: (olderThanMs: number) => Promise<InstallBatch[]>;
    setPhase?: (batchId: string, phase: InstallBatch["phase"]) => Promise<InstallBatch>;
    updateMember?: (
      batchId: string,
      packageName: string,
      patch: Partial<Pick<InstallBatchMember, "status" | "installOpId" | "detail">>,
    ) => Promise<InstallBatch>;
    uninstallMember?: (member: { typeId: string; packageName: string; version: string }) => Promise<void>;
  },
  batchOpsDeps?: InstallBatchOpsDeps,
): Promise<{ swept: number }> {
  const olderThanMs = opts?.olderThanMs ?? 5 * 60 * 1000;
  const batchOps = await import("@/lib/extension-install-batch-ops");
  const listStale =
    depsOverride?.listStale ?? ((ms: number) => batchOps.listStaleInstallBatches(ms, batchOpsDeps));
  const setPhase =
    depsOverride?.setPhase ??
    ((id: string, phase: InstallBatch["phase"]) => batchOps.setInstallBatchPhase(id, phase, batchOpsDeps));
  const updateMember =
    depsOverride?.updateMember ??
    ((
      id: string,
      pkg: string,
      patch: Partial<Pick<InstallBatchMember, "status" | "installOpId" | "detail">>,
    ) => batchOps.updateInstallBatchMember(id, pkg, patch, batchOpsDeps));
  const sweeperActor: Actor = { actorType: "system", source: "worker" };
  const uninstallMember =
    depsOverride?.uninstallMember ??
    (async (member: { typeId: string; packageName: string; version: string }) => {
      const { extensionRegistry } = await import("@cinatra-ai/extensions");
      await extensionRegistry.uninstall(
        member.typeId,
        { registryUrl: "", packageName: member.packageName, version: member.version },
        sweeperActor,
      );
    });

  const stale = await listStale(olderThanMs);
  let swept = 0;
  for (const batch of stale) {
    // Inverse install order = reverse ledger order (the ledger is topo-ordered).
    const candidates = [...batch.members]
      .reverse()
      .filter(
        (m) =>
          !m.preState.present && (m.status === "installed" || m.status === "installing"),
      );
    let failures = 0;
    for (const m of candidates) {
      try {
        await uninstallMember({ typeId: m.typeId, packageName: m.packageName, version: m.version });
        await updateMember(batch.batchId, m.packageName, { status: "compensated" });
      } catch (err) {
        failures += 1;
        await updateMember(batch.batchId, m.packageName, {
          status: "compensation-failed",
          detail: err instanceof Error ? err.message : String(err),
        }).catch(() => undefined);
        console.error(
          `[extension-install-batch] boot sweep: compensation uninstall of ${m.packageName} failed (batch ${batch.batchId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await setPhase(batch.batchId, failures === 0 ? "compensated" : "failed").catch(() => undefined);
    swept += 1;
  }
  return { swept };
}

/**
 * (package, org) keys owned by STILL-ACTIVE batches — the per-op boot-orphan
 * cleanup must SKIP these (the batch sweeper owns batch-member ops; sweeping
 * them per-op would compensate a batch another worker is actively driving).
 */
export async function collectActiveBatchMemberKeys(
  batchOpsDeps?: InstallBatchOpsDeps,
): Promise<Set<string>> {
  const { listActiveInstallBatches } = await import("@/lib/extension-install-batch-ops");
  const active = await listActiveInstallBatches(batchOpsDeps);
  const keys = new Set<string>();
  for (const b of active) {
    for (const m of b.members) keys.add(`${m.packageName}::${b.orgId ?? "(global)"}`);
  }
  return keys;
}
