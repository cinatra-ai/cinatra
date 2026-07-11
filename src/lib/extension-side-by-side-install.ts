import "server-only";

// SIDE-BY-SIDE version installer (cinatra#1040 S3).
//
// Realizes an `action:"install-side-by-side"` dependency-plan member: the
// disjoint-dependents conflict class on the NON-GATEKEPT path (the
// admissible-range intersection is empty — the installed default is older and
// at least one live dependent's edge refuses the pin), where neither
// dedupe-upward nor the hard refusal can serve every dependent. The new
// version installs as its own NON-DEFAULT canonical row THROUGH THE REAL
// INSTALL PIPELINE (materialize → gates → version-scoped journal → provenance
// → finalize → resolved edges), STORAGE-LEVEL ONLY:
//
//   - the canonical row is created `isDefault:false` — the DEFAULT row keeps
//     every global-name surface (registries, mounts, MCP names, the `current`
//     digest mirror, the trust-gate anchor);
//   - the journal ops live in the (package, org, VERSION) namespace
//     (core__0022), so the finalize supersession can never demote the default
//     install's anchor;
//   - NO in-process activation and NO native-handler run-surface projection
//     run — versioned runtime activation ((packageName, version) loader
//     anchors + default re-election) is the S4 slice. Until S4, the row
//     serves storage/closure semantics only: the write-time edge resolver
//     binds new dependents' edges to it and the closure gates validate them.
//
// SHARED-STATE DISCIPLINE (codex-converged): this path mutates NOTHING that
// the default install owns. Host-port grants: an empty request is a no-op, a
// request already covered by the scope's APPROVED grant is a no-op, anything
// else REFUSES (the grant-union + hash-reset choreography is S4/S5).
// Capability-ownership grants and host migrations REFUSE outright in S3. The
// compensation inverse (`uninstallExtensionVersionSideBySide`) is therefore a
// pure version-scoped teardown: delete the non-default row (lifecycle
// primitive, dependent-bound-edge + default-row guards), terminalize its
// version-scoped journal op. Store digest dirs are left to the retention GC.
//
// GATEKEPT FENCE: the planner emits side-by-side ONLY when `closure === null`;
// this module additionally REFUSES when gatekept install is enabled at
// execution time, so an environment flip between planning and execution can
// never route a side-by-side member through the gatekept world (ratified
// Option-B contract; #1296 untouched).

import { randomUUID } from "node:crypto";
import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";

export class SideBySideInstallError extends Error {
  constructor(
    public readonly code:
      | "GATEKEPT_PATH"
      | "UNSUPPORTED_KIND"
      | "REQUIRED_IN_PROD"
      | "INVALID_VERSION"
      | "NO_DEFAULT_SIBLING"
      | "DEFAULT_NOT_ANCHORED"
      | "HOST_PIN_VIOLATION"
      | "DECLARES_MIGRATIONS"
      | "DECLARES_OWNERSHIP_KEYS"
      | "PORTS_NOT_COVERED",
    message: string,
  ) {
    super(message);
    this.name = "SideBySideInstallError";
  }
}

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["agent", "skill", "connector", "artifact"]);

/**
 * Install `packageName@version` SIDE BY SIDE as a non-default canonical row.
 * Idempotent: an existing finalized non-default row at the exact (scope,
 * version) returns immediately; a broken (non-finalized) prior attempt is
 * retried through the pipeline against the same row. Runs under the
 * per-package install lock.
 */
export async function installExtensionVersionSideBySide(input: {
  packageName: string;
  /** Exact pin (never a range/dist-tag — the planner resolved it). */
  version: string;
  /** Planner-resolved kind (dispatch typeId). */
  typeId: string;
  orgId: string | null;
  actorUserId?: string | null;
}): Promise<{ rowId: string }> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(input.packageName, () => runLocked(input));
}

async function runLocked(input: {
  packageName: string;
  version: string;
  typeId: string;
  orgId: string | null;
  actorUserId?: string | null;
}): Promise<{ rowId: string }> {
  const { packageName, version, typeId, orgId } = input;

  // ---- MUTATION-FREE PREFLIGHT --------------------------------------------
  const { isGatekeptInstallEnabled } = await import("@/lib/gatekept-install");
  if (isGatekeptInstallEnabled()) {
    throw new SideBySideInstallError(
      "GATEKEPT_PATH",
      `side-by-side install of ${packageName}@${version} refused — gatekept install is enabled ` +
        `and the gatekept path keeps the hard installed-version-conflict refusal (ratified ` +
        `Option-B contract). The planner only emits side-by-side members on the non-gatekept ` +
        `path; reaching this refusal means the environment flipped between planning and execution.`,
    );
  }
  if (!SUPPORTED_KINDS.has(typeId)) {
    throw new SideBySideInstallError(
      "UNSUPPORTED_KIND",
      `side-by-side install of ${packageName}@${version} refused — kind "${typeId}" is not ` +
        `supported for storage-level side-by-side in this slice (the workflow kind's install is ` +
        `saga-owned and creates workflow-native state).`,
    );
  }
  const { isExactVersion } = await import("@cinatra-ai/registries");
  if (version === "0.0.0" || !isExactVersion(version)) {
    // '0.0.0' is the legacy/default journal namespace (core__0022 backfill
    // floor) — a side-by-side install there would collide with the default
    // install's anchor supersession.
    throw new SideBySideInstallError(
      "INVALID_VERSION",
      `side-by-side install of ${packageName}@"${version}" refused — the version must be a ` +
        `concrete exact version (and never the '0.0.0' legacy journal namespace).`,
    );
  }
  const { isPackageRequiredInProd, checkRequiredExtensionVersionPin } = await import(
    "@cinatra-ai/extensions/required-in-prod"
  );
  if (isPackageRequiredInProd(packageName)) {
    throw new SideBySideInstallError(
      "REQUIRED_IN_PROD",
      `side-by-side install of ${packageName}@${version} refused — required-in-prod packages ` +
        `are host-lock-pinned (a second live version is out of scope for this slice).`,
    );
  }
  const pin = checkRequiredExtensionVersionPin({ packageName, version, op: "install" });
  if (!pin.ok) throw new SideBySideInstallError("HOST_PIN_VIOLATION", pin.reason);

  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const scopeRows = rows.filter(
    (r) =>
      (r.status === "active" || r.status === "locked") && (r.organizationId ?? null) === orgId,
  );
  const defaults = scopeRows.filter((r) => r.isDefault !== false);
  if (defaults.length !== 1) {
    throw new SideBySideInstallError(
      "NO_DEFAULT_SIBLING",
      `side-by-side install of ${packageName}@${version} refused — expected exactly one live ` +
        `DEFAULT row in scope (found ${defaults.length}); a side-by-side version only exists ` +
        `NEXT TO a healthy default install.`,
    );
  }
  // The default must be journal-anchored (finalized) — a broken default is a
  // retry/repair concern for the package-scoped path, not a side-by-side base.
  const { readInstallOp, readInstallOpForVersion, advanceInstallOpPhase } = await import(
    "@/lib/extension-install-ops"
  );
  const defaultOp = await readInstallOp(packageName, orgId);
  if (defaultOp?.phase !== "finalized") {
    throw new SideBySideInstallError(
      "DEFAULT_NOT_ANCHORED",
      `side-by-side install of ${packageName}@${version} refused — the default install's ` +
        `journal is not finalized (${defaultOp?.phase ?? "no journal row"}); repair or re-install ` +
        `the default first.`,
    );
  }

  // ---- IDEMPOTENCE / BROKEN-ATTEMPT RETRY ---------------------------------
  const existing = scopeRows.find(
    (r) => r.isDefault === false && (r.version ?? null) === version,
  );
  const existingOp = existing
    ? await readInstallOpForVersion(packageName, orgId, version)
    : null;
  if (existing && existingOp?.phase === "finalized") {
    return { rowId: existing.id }; // already installed side-by-side at this pin
  }

  // ---- PLACEHOLDER ROW (non-default; retried broken attempts reuse theirs) -
  const { installExtensionManifest, deleteSideBySideVersionRow } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  let rowId: string;
  let createdThisAttempt = false;
  if (existing) {
    rowId = existing.id;
  } else {
    rowId = `iext_${randomUUID().slice(0, 12)}`;
    createdThisAttempt = true;
    await installExtensionManifest(
      {
        id: rowId,
        packageName,
        ownerLevel: orgId ? "organization" : "platform",
        ownerId: orgId,
        organizationId: orgId,
        kind: typeId as never,
        source: {
          type: "verdaccio",
          registryUrl: "http://localhost:4873",
          packageName,
          version,
          integrity: "dispatcher-install",
        },
        requiredInProd: false,
        // SEED ONLY: the real manifest edges land at the pipeline's finalize
        // seam (row-bound persistDependencyEdges) with write-time resolution.
        dependencies: [],
        manifestHash: null,
        status: "active",
        version,
        isDefault: false,
      },
      {
        actor: { source: "runtime-installer", ...(input.actorUserId ? { userId: input.actorUserId } : {}) },
        reason: `side-by-side install @ ${version} (cinatra#1040 S3)`,
      },
    );
  }

  // ---- REAL PIPELINE, ROW-BOUND + VERSION-SCOPED --------------------------
  try {
    const { installExtensionFromRegistry, makeDefaultInstallPipelineDeps } = await import(
      "@/lib/extension-install-pipeline"
    );
    const { makeCanonicalRowInstallDeps } = await import(
      "@/lib/extension-install-canonical-row-deps"
    );
    const { beginInstallOp } = await import("@/lib/extension-install-ops");
    const base = await makeDefaultInstallPipelineDeps();
    const deps: typeof base = {
      ...base,
      // Canonical-row reads/writes bound to THE NEW ROW; the package-scoped
      // `current` digest mirror stays owned by the default version.
      ...makeCanonicalRowInstallDeps({
        provenanceRegistryUrl: (requestUrl) => requestUrl,
        boundRowId: rowId,
        mirrorCurrentDigest: false,
      }),
      // Version-scoped journal namespace (core__0022): begin writes the real
      // pin; the finalize supersession demotes only ops of the SAME version;
      // the prior-op read observes only this version's namespace (fresh-install
      // semantics — never the default's anchor).
      beginInstallOp: (b) => beginInstallOp({ ...b, version }).then(() => undefined),
      readInstallOp: (pkg, oid) => readInstallOpForVersion(pkg, oid, version),
      // SHARED-STATE DISCIPLINE: host-port grants are per (package, org) and
      // owned by the default install. Empty request → no-op; request covered
      // by the scope's APPROVED grant → no-op; anything else → refuse (the
      // grant-union + reset-on-change choreography is the S4/S5 slice).
      recordRequestedGrant: async (g) => {
        if (g.requestedPorts.length === 0) return;
        const grant = await base.readGrantForScope(g.packageName, g.orgId);
        const approved =
          grant && grant.status === "approved" ? new Set(grant.approvedPorts) : null;
        if (approved && g.requestedPorts.every((p) => approved.has(p))) return;
        throw new SideBySideInstallError(
          "PORTS_NOT_COVERED",
          `side-by-side install of ${g.packageName}@${version} refused — it requests host ` +
            `ports [${g.requestedPorts.join(", ")}] not covered by the scope's approved ` +
            `grant; the per-scope grant union is a later slice. Approve the ports on the ` +
            `default install first, then retry.`,
        );
      },
      approveGrant: async () => undefined,
      // Capability-ownership grants are shared per (package, org) — refuse in
      // S3 rather than mutate them from a non-default install.
      recordRequestedOwnershipGrant: async (g) => {
        throw new SideBySideInstallError(
          "DECLARES_OWNERSHIP_KEYS",
          `side-by-side install of ${g.packageName}@${version} refused — it declares ` +
            `widget-auth token ownership ("${g.tokenConfigKey}"), which is package-scoped ` +
            `shared state; side-by-side for ownership-declaring packages is a later slice.`,
        );
      },
      // Host migrations are irreversible shared DDL — refuse in S3 (the
      // per-package append-only union policy is the S5 slice).
      preflightMigrations: async (i) => {
        const declares = await base.preflightMigrations?.(i);
        if (declares) {
          throw new SideBySideInstallError(
            "DECLARES_MIGRATIONS",
            `side-by-side install of ${i.packageName}@${version} refused — it declares host ` +
              `migrations (cinatra.migrationsDir); the cross-version migration-union policy is ` +
              `a later slice.`,
          );
        }
        return false;
      },
      // NO-OP, not a throw (codex round-1): the pipeline calls this hook for
      // EVERY trusted-signed install, including packages that declare no
      // migrations — the declaration refusal is already enforced (fail-closed
      // throw) by the preflight override above, so nothing can reach here with
      // migrations to apply.
      applyMigrations: async () => undefined,
      // NO in-process activation — versioned runtime activation is S4. The
      // finalized row is durable; the S4 loader slice makes it addressable.
      activateInProcess: async () => ({
        activated: false,
        reason: "side-by-side version — activation deferred to versioned loader anchors (cinatra#1040 S4)",
      }),
    };
    await installExtensionFromRegistry(
      {
        packageName,
        version,
        orgId,
        actorUserId: input.actorUserId ?? null,
        // Stable per-(package, version, scope) op id: a retry of the SAME
        // side-by-side attempt resumes/reset its own journal row.
        installOpId: `sbs:${packageName}@${version}:${orgId ?? "(global)"}`,
        expectedKind: typeId as ExtensionStoreKind,
      },
      deps,
    );
    return { rowId };
  } catch (err) {
    // Roll back the placeholder THIS attempt created when the pipeline did not
    // finalize (version-scoped check — the versionless journal signal would see
    // the DEFAULT's finalized op and wrongly protect the placeholder).
    if (createdThisAttempt) {
      try {
        const op = await readInstallOpForVersion(packageName, orgId, version);
        if (op?.phase !== "finalized") {
          await deleteSideBySideVersionRow(rowId);
          if (op) await advanceInstallOpPhase({ installOpId: op.installOpId, phase: "rolled_back" });
        }
      } catch (rollbackErr) {
        console.warn(
          `[side-by-side-install] rollback of non-finalized side-by-side row '${rowId}' failed ` +
            `(left non-anchorable; a retry re-runs the pipeline):`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }
    }
    throw err;
  }
}

/**
 * The COMPENSATION INVERSE (and boot-sweeper teardown) for a side-by-side
 * member: version-scoped, never touches the default install. Idempotent — a
 * missing row is a no-op. Runs under the per-package install lock.
 */
export async function uninstallExtensionVersionSideBySide(input: {
  packageName: string;
  version: string;
  orgId: string | null;
}): Promise<{ removed: boolean }> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(input.packageName, async () => {
    const { packageName, version, orgId } = input;
    if (version === "0.0.0") {
      throw new SideBySideInstallError(
        "INVALID_VERSION",
        `side-by-side teardown of ${packageName}@"${version}" refused — '0.0.0' is the ` +
          `legacy/default namespace, never a side-by-side row.`,
      );
    }
    const { readInstalledExtensionsByPackageName } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const rows = await readInstalledExtensionsByPackageName(packageName);
    const row = rows.find(
      (r) =>
        (r.organizationId ?? null) === orgId &&
        r.isDefault === false &&
        (r.version ?? null) === version &&
        (r.status === "active" || r.status === "locked"),
    );
    const { readInstallOpForVersion, advanceInstallOpPhase } = await import(
      "@/lib/extension-install-ops"
    );
    if (row) {
      const { deleteSideBySideVersionRow } = await import(
        "@cinatra-ai/extensions/lifecycle-primitive"
      );
      await deleteSideBySideVersionRow(row.id);
    }
    // Terminalize the version-scoped journal op so it can never be mistaken
    // for an anchor (best-effort; the versionless default anchor is untouched).
    try {
      const op = await readInstallOpForVersion(packageName, orgId, version);
      if (op && op.phase !== "rolled_back") {
        await advanceInstallOpPhase({ installOpId: op.installOpId, phase: "rolled_back" });
      }
    } catch (err) {
      console.warn(
        `[side-by-side-install] terminalizing the journal op for ${packageName}@${version} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    return { removed: Boolean(row) };
  });
}
