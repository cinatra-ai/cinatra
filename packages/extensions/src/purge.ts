import "server-only";
import { createHash } from "node:crypto";
import type { Actor } from "@cinatra-ai/extension-types";
import { deriveTypeId } from "./utils";
import {
  computeDanglingReferences,
  writeExtensionLifecycleAuditEntry,
} from "./audit-log";
import { quarantineExtensionBeforePurge } from "./quarantine";

// ---------------------------------------------------------------------------
// extensions_purge performs full "gone everywhere" removal of an
// extension as ONE fail-closed saga (never half-done), ANY kind.
//
// planExtensionPurge()  — read-only blast radius + digest (the dry-run).
// purgeExtension()      — the destructive saga, runs under the GLOBAL
//   extension-lifecycle lock (serialized against ALL install/update/
//   uninstall/source-write/purge). Ordered: validate → FULL quarantine →
//   audit purge_started → STRICT disk delete (verified reload, rollbackable
//   from quarantine) → FINAL dependents/digest re-scan → atomic DB delete →
//   audit purge_committed.
//
//   Purge deliberately does NOT yank/unpublish versions from the
//   Verdaccio registry. Lifecycle primitives never delete from the registry;
//   Verdaccio version cleanup is a separate, ops-owned operation (deferred).
//   The published versions remain re-installable after a purge.
//
// The destructive path MUST be assistant/MCP-invocable: `extensions_purge_execute`
// (admin-gated MCP) calls this, and the loopback CLI/route stays as an
// alternate path. All safeguards are shared.
//
// Both take injected `deps` so the saga is unit-testable without a live
// registry/DB. `defaultPurgeDeps()` wires the real implementations.
// ---------------------------------------------------------------------------

export type ActiveDependent = {
  packageName: string;
  /** Which edge flagged it. */
  via: "agentDependencies" | "compiledPlan" | "onDiskOas";
};

export type ExtensionPurgePlan = {
  packageName: string;
  kind: string | null;
  typeId: string;
  registryUrl: string;
  registryScope: string;
  originVisibility: string | null;
  originScope: string | null;
  versions: string[];
  distTags: Record<string, string>;
  installedTemplateId: string | null;
  activeDependents: ActiveDependent[];
  /** True when activeDependents is non-empty — purge MUST refuse. */
  blocked: boolean;
  digest: string;
  notes: string[];
};

export type PurgeExtensionResult = {
  packageName: string;
  stopped: boolean;
  reason?: string;
  dbDiskDeleted: boolean;
  quarantineDir: string | null;
  digest: string;
};

type ResolvedVerdaccioConfig = {
  registryUrl: string;
  packageScope: string;
  token?: string | null;
};

export type PurgeDeps = {
  loadVerdaccioConfig: () => Promise<ResolvedVerdaccioConfig>;
  /**
   * Authoritative kind: the `cinatra.kind` field from the package.json as
   * stored in the registry packument (NOT the agent.json extractor, which
   * throws for skill/connector packages). Returns null when no explicit kind
   * is declared (legacy agents) or the package is absent.
   */
  resolvePackageKind: (
    packageName: string,
    config: ResolvedVerdaccioConfig,
  ) => Promise<string | null>;
  getAgentPackage: (
    input: { packageName: string },
    config: ResolvedVerdaccioConfig,
  ) => Promise<{
    manifest?: { cinatra?: { kind?: string } } | null;
    payload?: { cinatra?: { kind?: string } } | null;
    origin?: { visibility?: string; scope?: string } | null;
  }>;
  listVersions: (
    packageName: string,
    config: ResolvedVerdaccioConfig,
  ) => Promise<{ versions: string[]; distTags: Record<string, string> }>;
  /** FULL agent_templates row (audit/forensics — NOT used for rollback). */
  readTemplateByPackageName: (
    packageName: string,
  ) => Promise<({ id: string } & Record<string, unknown>) | null>;
  /**
   * Run `fn` under the whole-lifecycle lock for this package
   * (serializes install/update/uninstall/purge; re-entrant via ALS).
   */
  withLifecycleLock: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Atomic single-transaction DB purge (FK sources + polymorphic perms +
   * agent_templates row). Either all gone or none. Returns the full
   * pre-delete row as `snapshot` (audit only).
   */
  dbPurgeAtomic: (packageName: string) => Promise<{
    deleted: boolean;
    snapshot: unknown;
  }>;
  /**
   * Cheap dir-presence check called BEFORE the strict disk delete so
   * dirPresentAtStart is known independently of strictDiskPurge throwing.
   */
  extensionDirPresent: (packageName: string) => boolean;
  /**
   * STRICT disk delete + verified reload — RAISES on any failure (never
   * swallows). `reload` is false for kinds where it's irrelevant.
   */
  strictDiskPurge: (
    packageName: string,
    options: { reload: boolean },
  ) => Promise<{ dirPresentAtStart: boolean }>;
  /** Rollback primitive: re-extract a quarantined tarball back to the dir. */
  restoreDirFromTarball: (input: {
    packageName: string;
    tarballPath: string;
  }) => Promise<void>;
  /** Raw registry packument JSON for the full quarantine snapshot. */
  fetchPackument: (
    packageName: string,
    config: ResolvedVerdaccioConfig,
  ) => Promise<unknown>;
  readTemplatesDependingOn: (
    packageName: string,
  ) => Promise<{ packageName: string }[]>;
  readTemplatesReferencingChild: (
    packageName: string,
  ) => Promise<{ packageName: string }[]>;
  listOnDiskOasDependents: (packageName: string) => Promise<string[]>;
  /**
   * NO LONGER CALLED by purgeExtension. Lifecycle primitives never
   * delete from the registry — Verdaccio version cleanup is a separate,
   * ops-owned operation (deferred). Kept on the deps seam so the host wiring
   * (`defaultPurgeDeps`) and other registry-only ops can still supply it, but
   * the purge saga deliberately leaves the published versions re-installable.
   */
  unpublishAllVersions: (
    input: { packageName: string },
    config: ResolvedVerdaccioConfig,
  ) => Promise<{
    unpublished: string[];
    notFound: string[];
    failed: { version: string; error: string }[];
    remaining: string[];
  }>;
  downloadTarball: (
    input: { packageName: string; packageVersion: string; destPath: string },
    config: ResolvedVerdaccioConfig,
  ) => Promise<boolean>;
};

function canonicalDigest(parts: Record<string, unknown>): string {
  // Stable key order — JSON.stringify with sorted keys.
  const sortedKeys = Object.keys(parts).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = parts[k];
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export async function planExtensionPurge(
  input: { packageName: string },
  deps: PurgeDeps,
): Promise<ExtensionPurgePlan> {
  const { packageName } = input;
  const config = await deps.loadVerdaccioConfig();

  const notes: string[] = [];
  let originVisibility: string | null = null;
  let originScope: string | null = null;

  // (1) AUTHORITATIVE kind — the package.json `cinatra.kind` field as stored
  //     in the registry packument manifest. This is the ONLY trustworthy
  //     kind source: getAgentPackage extracts agent.json and THROWS for
  //     skill/connector packages (no agent payload). Relying on it would
  //     mis-resolve a connector/skill as a legacy null->"agent" agent, so
  //     resolvePackageKind reads package.json directly.
  let explicitKind: string | null = null;
  try {
    explicitKind = await deps.resolvePackageKind(packageName, config);
  } catch {
    explicitKind = null;
  }

  // (2) Best-effort agent-payload evidence + origin (NOT used for kind unless
  //     there is no explicit kind AND positive agent evidence exists).
  let agentPayloadResolved = false;
  try {
    const detail = await deps.getAgentPackage({ packageName }, config);
    agentPayloadResolved = true;
    originVisibility = detail.origin?.visibility ?? null;
    originScope = detail.origin?.scope ?? null;
  } catch {
    notes.push(
      "No agent payload in the registry (skill/connector, or already absent) — kind taken from package.json cinatra.kind.",
    );
  }

  const { versions, distTags } = await deps.listVersions(packageName, config);
  if (versions.length === 0) {
    notes.push("No published versions in the registry (idempotent — nothing to unpublish).");
  }

  const template = await deps.readTemplateByPackageName(packageName);
  const installedTemplateId = template?.id ?? null;

  // (3) Resolve kind with a STRICT precedence; NO generic null->"agent"
  //     fallback on the destructive path. "agent" is only chosen when there
  //     is positive agent evidence (an agent payload or an agent_templates
  //     row) — this safely covers legacy no-`cinatra.kind` agents (e.g.
  //     url-title-fetcher) without mis-classifying a kind-less connector.
  const kind: string | null =
    explicitKind ??
    (agentPayloadResolved || installedTemplateId ? "agent" : null);

  let typeId: string;
  if (!kind) {
    typeId = "";
    notes.push(
      "Could not authoritatively resolve the extension kind (no package.json cinatra.kind, no agent payload, no installed row) — purge will REFUSE.",
    );
  } else {
    try {
      typeId = deriveTypeId(kind);
    } catch (e) {
      // No fail-open. Unsupported/unknown kind => empty => purge refuses.
      typeId = "";
      notes.push(
        `Cannot resolve a supported extension kind (kind=${String(kind)}: ${
          e instanceof Error ? e.message : String(e)
        }) — purge will REFUSE.`,
      );
    }
  }
  if (typeId === "connector") {
    notes.push(
      "Connector kind: purge removes Verdaccio versions + DB row + audit + quarantine, but NOT runtime/filesystem unload — connectors are bundle-compiled; source removal is a PR + redeploy concern.",
    );
  }
  if (typeId === "workflow") {
    notes.push(
      "Workflow kind: purge removes Verdaccio versions + audit + quarantine; workflow_template rows are owned by release-workflows lifecycle ops, not the agent-only DB saga. No agent_templates DB/disk cleanup.",
    );
  }

  const dependentSet = new Map<string, ActiveDependent>();
  for (const r of await deps.readTemplatesDependingOn(packageName)) {
    if (r.packageName && r.packageName !== packageName)
      dependentSet.set(`agentDependencies:${r.packageName}`, {
        packageName: r.packageName,
        via: "agentDependencies",
      });
  }
  for (const r of await deps.readTemplatesReferencingChild(packageName)) {
    if (r.packageName && r.packageName !== packageName)
      dependentSet.set(`compiledPlan:${r.packageName}`, {
        packageName: r.packageName,
        via: "compiledPlan",
      });
  }
  for (const dep of await deps.listOnDiskOasDependents(packageName)) {
    if (dep && dep !== packageName)
      dependentSet.set(`onDiskOas:${dep}`, {
        packageName: dep,
        via: "onDiskOas",
      });
  }
  const activeDependents = [...dependentSet.values()].sort((a, b) =>
    (a.packageName + a.via).localeCompare(b.packageName + b.via),
  );

  const digest = canonicalDigest({
    registryUrl: config.registryUrl,
    registryScope: config.packageScope,
    originVisibility,
    originScope,
    packageName,
    kind,
    typeId,
    versions: [...versions].sort(),
    distTags,
    installedTemplateId,
    activeDependents: activeDependents.map((d) => `${d.via}:${d.packageName}`),
  });

  return {
    packageName,
    kind,
    typeId,
    registryUrl: config.registryUrl,
    registryScope: config.packageScope,
    originVisibility,
    originScope,
    versions,
    distTags,
    installedTemplateId,
    activeDependents,
    blocked: activeDependents.length > 0,
    digest,
    notes,
  };
}

export class ExtensionPurgeRefused extends Error {}

export async function purgeExtension(
  input: {
    packageName: string;
    expectedDigest?: string;
    reason?: string;
    actor: Actor;
  },
  deps: PurgeDeps,
): Promise<PurgeExtensionResult> {
  const { packageName, expectedDigest, reason, actor } = input;

  // The WHOLE saga runs under the lifecycle lock so no
  // concurrent install/update/uninstall/purge of this package can race the
  // ordered steps. Re-entrant via ALS.
  return await deps.withLifecycleLock(packageName, async () => {
    // Locked canonical rows reject purge BEFORE any planning/mutation. Fail-closed
    // for system extensions even if the canonical store is unreachable
    // (assertNoLockedCanonicalRow handles both).
    const { assertNoLockedCanonicalRow } = await import("./index");
    await assertNoLockedCanonicalRow(packageName, "purge");

    // 1. Re-plan against current ground truth.
    const plan = await planExtensionPurge({ packageName }, deps);
    const config = await deps.loadVerdaccioConfig();

    // 2. Production-host refusal (fail-closed).
    const dbUrlEnv = process.env.SUPABASE_DB_URL;
    const prodHostsEnv = process.env.CINATRA_DB_PROD_HOSTS;
    if (dbUrlEnv && prodHostsEnv) {
      const host = new URL(dbUrlEnv).hostname;
      const prodHosts = prodHostsEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (prodHosts.some((h) => host.endsWith(h))) {
        throw new ExtensionPurgeRefused(
          `extensions_purge refused: DB host ${host} matches production pattern ` +
            `(CINATRA_DB_PROD_HOSTS=${prodHostsEnv}). Purge is dev/local only.`,
        );
      }
    }

    // 3. Mandatory dry-run digest handshake + match.
    if (!expectedDigest) {
      throw new ExtensionPurgeRefused(
        "extensions_purge refused: a digest from the extensions_purge dry-run plan is REQUIRED.",
      );
    }
    if (expectedDigest !== plan.digest) {
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: state changed since planning ` +
          `(expected digest ${expectedDigest}, current ${plan.digest}). Re-plan and retry.`,
      );
    }

    // 4. Kind must resolve to a supported handler-backed typeId (no fail-open).
    if (
      plan.typeId !== "agent" &&
      plan.typeId !== "skill" &&
      plan.typeId !== "connector" &&
      // `artifact` is a handler-backed kind whose uninstall is a clean no-op
      // (descriptor owned by the object-registry bridge). It takes the same
      // connector-like path through this saga (no DB/disk; Verdaccio +
      // quarantine + audit only).
      plan.typeId !== "artifact" &&
      // `workflow` is a handler-backed kind whose mutators are guarded no-ops
      // (workflow template lifecycle is owned by release-workflows store).
      // Takes the connector-like path (no agent_templates DB/disk; Verdaccio +
      // quarantine + audit only).
      plan.typeId !== "workflow"
    ) {
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: could not resolve a supported extension kind for ${packageName} ` +
          `(typeId=${JSON.stringify(plan.typeId)}). ${plan.notes.join(" ")}`,
      );
    }
    // 4b. Connector-with-DB-row invariant (connector skips DB/disk by design).
    if (plan.typeId === "connector" && plan.installedTemplateId) {
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: connector ${packageName} unexpectedly has an installed ` +
          `agent_templates row (${plan.installedTemplateId}). Refusing rather than half-purging.`,
      );
    }

    // 5. Active-dependents hard block — BEFORE any mutation.
    if (plan.blocked) {
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: ${plan.activeDependents.length} active dependent(s) still reference ${packageName}: ` +
          plan.activeDependents
            .map((d) => `${d.packageName} (${d.via})`)
            .join(", ") +
          ". Purge or detach the dependents first.",
      );
    }

    // Only AGENT does DB+disk via this saga. The
    // real wiring (purgeAgentTemplateAtomic + agent install-dir delete) is
    // agent-specific; a skill has its own DB/disk state (skill_packages,
    // skill rows/matches, data/skills) the agent path would NOT clean,
    // leaving a half-purge while Verdaccio is removed. Refuse skill here
    // pending a skill-specific strict purge (routed follow-up). connector
    // is registry+audit+quarantine only (no DB/disk) by design. `artifact`
    // is handler-backed but its uninstall
    // is a clean no-op (descriptor owned by object-registry bridge), so
    // it takes the same connector-like path: no DB/disk, just Verdaccio +
    // quarantine + audit.
    if (plan.typeId === "skill") {
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: skill purge via extensions_purge_execute is not ` +
          `yet supported — skill DB/disk cleanup (skill_packages / skill_matches / ` +
          `data/skills) differs from agents and the agent-only saga would half-purge ` +
          `it. Use extensions_uninstall for skills. agent + connector + artifact are supported.`,
      );
    }
    const removesDiskDb = plan.typeId === "agent";
    const ref = {
      registryUrl: plan.registryUrl,
      packageName,
      version: plan.versions[plan.versions.length - 1],
    };
    const fullRow = await deps.readTemplateByPackageName(packageName);
    // The version pinned in the DB row is STRICT and row-only.
    // If the row pins a version, ONLY that exact tarball is a valid rollback
    // target; a miss is INCONSISTENT (restoring a different version while DB
    // is pinned to vX), NOT a latest/last "success". When the row carries no
    // version (legacy / no row), a best-effort latest/last guess is fine.
    const installedVersionFromRow: string | null =
      typeof fullRow?.packageVersion === "string"
        ? (fullRow.packageVersion as string)
        : null;
    const bestEffortVersion: string | null =
      plan.distTags.latest ??
      plan.versions[plan.versions.length - 1] ??
      null;

    // 6. FULL quarantine BEFORE any destruction (packument + every tarball +
    //    full agent_templates row). Abort if any tarball can't be snapshotted
    //    — an incomplete recovery snapshot must fail closed.
    let quarantineDir: string | null = null;
    let primaryTarball: string | null = null;
    // If the DB row pins a version but its exact tarball is NOT
    // in quarantine → rollback must NOT restore a different version and
    // claim success; treat as INCONSISTENT / manual recovery.
    let rollbackVersionUncertain = false;
    if (plan.versions.length > 0 || plan.installedTemplateId) {
      let packument: unknown = null;
      try {
        packument = await deps.fetchPackument(packageName, config);
      } catch {
        packument = null; // registry absent — tarballs/row still snapshotted
      }
      const q = await quarantineExtensionBeforePurge({
        packageName,
        versions: plan.versions,
        distTags: plan.distTags,
        templateSnapshot: fullRow,
        packument,
        downloadTarball: (version, destPath) =>
          deps.downloadTarball(
            { packageName, packageVersion: version, destPath },
            config,
          ),
      });
      quarantineDir = q.quarantineDir;
      if (q.missingTarballs.length > 0) {
        throw new ExtensionPurgeRefused(
          `extensions_purge refused: quarantine incomplete — could not snapshot ` +
            `version(s) ${q.missingTarballs.join(", ")} of ${packageName}. ` +
            `Refusing without a complete recovery snapshot. Quarantine: ${quarantineDir}`,
        );
      }
      // If the DB row pins a version, ONLY its exact tarball
      // is a valid rollback (a miss => INCONSISTENT, no wrong-version
      // "success"). Otherwise (legacy/no row) best-effort latest/last.
      if (installedVersionFromRow) {
        primaryTarball =
          q.tarballs.find((t) =>
            t.endsWith(`-${installedVersionFromRow}.tgz`),
          ) ?? null;
        if (!primaryTarball) rollbackVersionUncertain = true;
      } else {
        primaryTarball =
          (bestEffortVersion &&
            q.tarballs.find((t) =>
              t.endsWith(`-${bestEffortVersion}.tgz`),
            )) ||
          q.tarballs[q.tarballs.length - 1] ||
          null;
      }
    }

    // 7. Audit `purge_started` BEFORE any mutation (append-only intent record;
    //    write failure aborts — no silent destruction).
    const danglingReferences = await computeDanglingReferences(ref);
    await writeExtensionLifecycleAuditEntry({
      actor,
      operation: "purge_started",
      packageRef: ref,
      destroyedRowSnapshot: fullRow,
      danglingReferences,
      ...(reason !== undefined ? { reason } : {}),
    });

    // dirPresentAtStart is determined BEFORE the rm so it is
    // known even if strictDiskPurge throws (rm OR reload failure).
    const dirPresentAtStart = removesDiskDb
      ? deps.extensionDirPresent(packageName)
      : false;

    // Rollback helper is TRUTHFUL: never claims "restored"
    // unless it genuinely restored the CORRECT version. Inconsistent
    // states (disk gone + DB intact) are reported as such with a manual-
    // recovery pointer. Defined BEFORE the disk step so a disk-delete/
    // reload failure rolls back too.
    const rollbackDiskAndThrow = async (why: string): Promise<never> => {
      let diskState: string;
      if (!dirPresentAtStart) {
        diskState = "was absent at start (nothing to restore)";
      } else if (rollbackVersionUncertain) {
        diskState =
          `NOT restored: DB row pins version ${installedVersionFromRow} but ` +
          `its tarball is not in quarantine — restoring a different version ` +
          `would mismatch. INCONSISTENT: disk gone, DB intact. MANUAL ` +
          `RECOVERY from ${quarantineDir}`;
      } else if (!primaryTarball) {
        diskState =
          `NOT restored (no quarantined tarball) — INCONSISTENT: disk gone, ` +
          `DB intact. MANUAL RECOVERY from ${quarantineDir}`;
      } else {
        try {
          await deps.restoreDirFromTarball({
            packageName,
            tarballPath: primaryTarball,
          });
          diskState = "restored from quarantine";
        } catch (restoreErr) {
          diskState =
            `NOT restored (${
              restoreErr instanceof Error
                ? restoreErr.message
                : String(restoreErr)
            }) — INCONSISTENT: disk gone, DB intact. MANUAL RECOVERY from ${quarantineDir}`;
        }
      }
      await writeExtensionLifecycleAuditEntry({
        actor,
        operation: "purge_rolled_back",
        packageRef: ref,
        destroyedRowSnapshot: fullRow,
        danglingReferences,
        reason: `${why}. Disk ${diskState}. Verdaccio untouched.`,
      });
      throw new ExtensionPurgeRefused(
        `extensions_purge rolled back: ${why}. Disk ${diskState}. ` +
          `Verdaccio untouched.${
            diskState.startsWith("NOT restored")
              ? " MANUAL RECOVERY REQUIRED."
              : " Consistent — re-plan and retry."
          }`,
      );
    };

    // 8. Disk delete FIRST (strict, RAISES on rm OR reload failure; the
    //    ONLY rollbackable destructive step). A throw here (rm failed, or
    //    dir removed but reload failed) → rollback + truthful audit, never
    //    a silent disk-gone half-state. Connector skips.
    if (removesDiskDb) {
      try {
        await deps.strictDiskPurge(packageName, { reload: true });
      } catch (diskErr) {
        await rollbackDiskAndThrow(
          `disk delete/reload failed (${
            diskErr instanceof Error ? diskErr.message : String(diskErr)
          })`,
        );
      }
    }

    // 9. FINAL dependents + digest re-scan — AFTER the (rollbackable) disk
    //    delete, immediately BEFORE the atomic DB delete (as late
    //    as possible; a check failing after DB delete would need an
    //    impossible DB re-insert). A dependent/state change detected here
    //    aborts WITH disk rollback. The install/source-write race is
    //    CLOSED: the whole saga holds the GLOBAL extension-lifecycle lock,
    //    and every dependent-edge creator (install/materialize via
    //    withInstallLock→global; createAgentTemplate/updateAgentTemplate when
    //    writing agentDependencies/compiledPlan/approvalPolicy; the
    //    agent_source_* on-disk oas.json writers) acquires that same global
    //    lock — so no dependent can appear between this re-scan and the DB
    //    delete; a concurrent creator either committed before this scan
    //    (detected → abort) or runs strictly after the saga completes
    //    (resolves against the purged state as a normal missing dependency).
    const fresh = await planExtensionPurge({ packageName }, deps);
    if (fresh.blocked) {
      if (removesDiskDb) {
        await rollbackDiskAndThrow(
          `an active dependent appeared before DB delete (${fresh.activeDependents
            .map((d) => `${d.packageName} (${d.via})`)
            .join(", ")})`,
        );
      }
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: an active dependent appeared (${fresh.activeDependents
          .map((d) => `${d.packageName} (${d.via})`)
          .join(", ")}). Nothing destroyed.`,
      );
    }
    if (fresh.digest !== plan.digest) {
      if (removesDiskDb) {
        await rollbackDiskAndThrow(
          `state changed before DB delete (digest ${plan.digest} -> ${fresh.digest})`,
        );
      }
      throw new ExtensionPurgeRefused(
        `extensions_purge refused: state changed (digest ${plan.digest} -> ` +
          `${fresh.digest}). Nothing destroyed. Re-plan.`,
      );
    }

    // 10. Atomic DB delete (one transaction). On failure → disk rollback +
    //     truthful purge_rolled_back + throw. The DB row was NOT deleted
    //     (its tx failed) so no DB re-insert is ever required.
    let dbDeleted = false;
    if (removesDiskDb) {
      try {
        const r = await deps.dbPurgeAtomic(packageName);
        dbDeleted = r.deleted;
      } catch (dbErr) {
        await rollbackDiskAndThrow(
          `DB delete failed (${
            dbErr instanceof Error ? dbErr.message : String(dbErr)
          })`,
        );
      }
    }

    // Split-brain guard: tear down the package's in-memory
    // register(ctx) registrations (MCP tool registry + authz effective-set +
    // capability providers + ctx.ui surfaces) in the CURRENT process so the
    // package stops being listable/invocable/resolvable without a restart.
    // Fires for EVERY purged kind that committed its destructive steps:
    //   - agents (removesDiskDb) ONLY after a committed DB delete (`dbDeleted`;
    //     a failed delete rolled back + threw above, so we never reach here);
    //   - DB/disk-less kinds (connector / artifact — `!removesDiskDb`) which
    //     reach here past quarantine and have no DB/disk row to delete. Without
    //     this branch a purged connector's `register(ctx)` capability providers
    //     (e.g. the resend `email-send` provider) would linger in-memory.
    // Best-effort + host-injected — see `fireExtensionCapabilityTeardown`.
    if (dbDeleted || !removesDiskDb) {
      const { fireExtensionCapabilityTeardown } = await import("./capability-teardown-hook");
      fireExtensionCapabilityTeardown(packageName);
      // Durable teardown — physically delete the package's org-scoped
      // settings/secrets rows. This is the ONLY teardown path for
      // connectors (their per-kind handler.uninstall throws — workspace-compiled).
      // Awaited (durable, cross-process), idempotent, best-effort.
      const { fireExtensionDataTeardown } = await import("./data-teardown-hook");
      await fireExtensionDataTeardown(packageName);
    }

    // 11. NO Verdaccio unpublish. Lifecycle primitives never delete
    //     from the registry — the published versions stay re-installable. The
    //     destructive saga is complete after the DB-row + on-disk + quarantine
    //     teardown above. Cleaning up registry versions is a separate,
    //     ops-owned operation (deferred); deps.unpublishAllVersions is left
    //     wired on the seam but intentionally NOT invoked here.

    // 12. Final audit (always purge_committed — there is no registry step to
    //     leave partial).
    await writeExtensionLifecycleAuditEntry({
      actor,
      operation: "purge_committed",
      packageRef: ref,
      destroyedRowSnapshot: fullRow,
      danglingReferences,
      reason:
        reason ??
        "Verdaccio unpublish deliberately NOT called " +
          "(lifecycle primitives never delete from the registry; version " +
          "cleanup is ops-owned).",
    });

    return {
      packageName,
      stopped: false,
      dbDiskDeleted: dbDeleted,
      quarantineDir,
      digest: plan.digest,
    };
  });
}
