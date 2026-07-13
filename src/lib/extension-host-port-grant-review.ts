import "server-only";

// UNION-AWARE host-port grant RE-APPROVAL backend (cinatra#1391 slice 1).
//
// The side-by-side grant-union choreography records the PER-SCOPE PORT UNION
// through the real `recordRequestedGrant`, so a grown union resets the shared
// per-(package, org) grant to `pending` — correct (fail-closed: no port is
// conveyed until an admin re-approves) but previously INOPERABLE: no surface
// could re-approve a union that no single manifest requests. This module is
// that surface's backend, consumed by the `extension-host-port-grants`
// ApprovalSource (UI page + `approvals_*` MCP tools ride the same registry).
//
// TRUST MODEL:
//  - The union is always RECOMPUTED from the live, journal-gated, digest-bound
//    sibling manifests (`defaultReadSiblingDeclaredHostPorts` — the ONE
//    algorithm the installer and the teardown reconcile use; never a
//    caller-supplied port list).
//  - An approval is refused unless the recomputed union hashes to the row's
//    stored `requested_ports_hash` (the same anti-stale rule `approveGrant`
//    itself enforces) — a sibling install/teardown between view and decide can
//    never be approved blind. On that refusal the fresh union is RE-RECORDED so
//    the next view shows the current request.
//  - Decisions run under `withInstallLock(packageName)`, serializing against
//    every install/teardown of any version of the package (whose grant
//    mutations hold the same lock).
//  - Business refusals are VALUES (`{ ok:false, code, ... }`), never throws —
//    the ApprovalSource decide contract.

import type { HostPortName } from "@cinatra-ai/sdk-extensions";

/** A pending grant enriched with the live recomputed union (the review row). */
export type HostPortGrantReviewRow = {
  packageName: string;
  /** The grant row's exact scope (null = platform/global). */
  orgId: string | null;
  status: "pending" | "approved" | "revoked";
  approvedPorts: string[];
  requestedPortsHash: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The LIVE recomputed per-scope union (journal-gated sibling manifests). */
  currentUnion: string[];
  /** Which live sibling versions declare which ports (display evidence). */
  perVersion: { version: string; isDefault: boolean; ports: string[] }[];
  /** True when the stored request no longer matches the live union — the
   * decide surface will refuse and re-record; the row renders as stale. */
  stale: boolean;
};

export type HostPortGrantDecisionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "not_authorized"
        | "not_found"
        | "not_pending"
        | "version_required"
        | "stale_snapshot"
        | "stale_request";
      message: string;
    };

/** Injected in tests; production omits (real readers). */
export type HostPortGrantReviewDeps = {
  listGrantsForScopes?: typeof import("@/lib/extension-host-port-grants").listGrantsForScopes;
  readGrantForScope?: typeof import("@/lib/extension-host-port-grants").readGrantForScope;
  recordRequestedGrant?: (input: {
    packageName: string;
    orgId: string | null;
    requestedPorts: readonly string[];
  }) => Promise<unknown>;
  approveGrant?: (input: {
    packageName: string;
    orgId: string | null;
    approvedPorts: readonly string[];
    requestedPorts: readonly string[];
    approvedBy: string;
  }) => Promise<unknown>;
  computeRequestedPortsHash?: (ports: readonly string[]) => string;
  /** Journal-gated per-scope union reader (no exclusion). */
  readUnionPorts?: (packageName: string, orgId: string | null) => Promise<string[]>;
  /** Per-version breakdown reader (display evidence). */
  readPerVersionPorts?: (
    packageName: string,
    orgId: string | null,
  ) => Promise<{ version: string; isDefault: boolean; ports: string[] }[]>;
  withInstallLock?: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;
};

async function resolveDeps(deps?: HostPortGrantReviewDeps): Promise<Required<HostPortGrantReviewDeps>> {
  const grants = await import("@/lib/extension-host-port-grants");
  return {
    listGrantsForScopes: deps?.listGrantsForScopes ?? grants.listGrantsForScopes,
    readGrantForScope: deps?.readGrantForScope ?? grants.readGrantForScope,
    recordRequestedGrant:
      deps?.recordRequestedGrant ??
      ((i) =>
        grants.recordRequestedGrant({
          packageName: i.packageName,
          orgId: i.orgId,
          requestedPorts: i.requestedPorts as readonly HostPortName[],
        })),
    approveGrant:
      deps?.approveGrant ??
      ((i) =>
        grants.approveGrant({
          packageName: i.packageName,
          orgId: i.orgId,
          approvedPorts: i.approvedPorts as readonly HostPortName[],
          requestedPorts: i.requestedPorts as readonly HostPortName[],
          approvedBy: i.approvedBy,
        })),
    computeRequestedPortsHash: deps?.computeRequestedPortsHash ?? grants.computeRequestedPortsHash,
    readUnionPorts:
      deps?.readUnionPorts ??
      (async (packageName, orgId) => {
        const { defaultReadSiblingDeclaredHostPorts } = await import(
          "@/lib/extension-side-by-side-install"
        );
        return defaultReadSiblingDeclaredHostPorts(packageName, orgId, null);
      }),
    readPerVersionPorts: deps?.readPerVersionPorts ?? defaultReadPerVersionPorts,
    withInstallLock:
      deps?.withInstallLock ??
      (async (packageName, fn) => {
        const { withInstallLock } = await import("@cinatra-ai/agents");
        return withInstallLock(packageName, fn);
      }),
  };
}

/**
 * Per-version declared-port breakdown at the exact scope — display evidence
 * only (the decide path never consumes it). Same journal-gated digest rule as
 * the union reader, per row.
 */
async function defaultReadPerVersionPorts(
  packageName: string,
  orgId: string | null,
): Promise<{ version: string; isDefault: boolean; ports: string[] }[]> {
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { defaultReadSiblingDeclaredHostPorts } = await import(
    "@/lib/extension-side-by-side-install"
  );
  const { readInstallOp, readInstallOpForVersion } = await import(
    "@/lib/extension-install-ops"
  );
  const { selectActiveDigest } = await import("@/lib/extension-install-anchor");
  const { readRequestedHostPortsFromStore } = await import("@/lib/extension-host-port-grants");
  const { storeDigestDirV2 } = await import("@/lib/extension-package-store-core");
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const rows = await readInstalledExtensionsByPackageName(packageName);
  const live = rows.filter(
    (r) =>
      (r.status === "active" || r.status === "locked") && (r.organizationId ?? null) === orgId,
  );
  const dataRoot = resolveExtensionDataRoot();
  const out: { version: string; isDefault: boolean; ports: string[] }[] = [];
  for (const r of live) {
    const entry = {
      version: r.version ?? "(unversioned)",
      isDefault: r.isDefault !== false,
      ports: [] as string[],
    };
    out.push(entry);
    try {
      const op =
        r.isDefault !== false
          ? await readInstallOp(packageName, orgId)
          : r.version
            ? await readInstallOpForVersion(packageName, orgId, r.version)
            : null;
      if (op?.phase !== "finalized") continue;
      const sel = selectActiveDigest({
        activeDigest: (r.source as { activeDigest?: string } | null)?.activeDigest ?? null,
        journalDigest: (op as { digest?: string | null }).digest ?? null,
      });
      if (!sel.ok || !sel.digest) continue;
      const dir = storeDigestDirV2(
        dataRoot,
        r.kind as import("@/lib/extension-package-store-core").ExtensionStoreKind,
        packageName,
        sel.digest,
      );
      entry.ports = (await readRequestedHostPortsFromStore(dir)).sort();
    } catch {
      // unreadable → no attributed ports for this version (fail closed)
    }
  }
  return out;
}

/**
 * The review inbox: PENDING grant rows at the caller-named exact scopes
 * (`[viewer.orgId, null]` for a platform-admin reviewer), each enriched with
 * the live recomputed union + per-version evidence. Read-only.
 */
export async function listHostPortGrantReviewRows(
  input: { orgIds: readonly (string | null)[] },
  depsOverride?: HostPortGrantReviewDeps,
): Promise<HostPortGrantReviewRow[]> {
  const deps = await resolveDeps(depsOverride);
  const pending = await deps.listGrantsForScopes({ orgIds: input.orgIds, status: "pending" });
  const out: HostPortGrantReviewRow[] = [];
  for (const g of pending) {
    const currentUnion = await deps.readUnionPorts(g.packageName, g.orgId);
    const perVersion = await deps.readPerVersionPorts(g.packageName, g.orgId);
    out.push({
      packageName: g.packageName,
      orgId: g.orgId,
      status: g.status,
      approvedPorts: g.approvedPorts,
      requestedPortsHash: g.requestedPortsHash,
      approvedBy: g.approvedBy,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      currentUnion,
      perVersion,
      stale: deps.computeRequestedPortsHash(currentUnion) !== g.requestedPortsHash,
    });
  }
  return out;
}

/**
 * Approve the FULL recomputed union for a pending grant (v1: all-or-nothing —
 * an admin who wants less uninstalls the declaring version instead; a partial
 * approval surface can extend later without changing this contract).
 *
 * `expectedRequestedPortsHash` is the edit-after-view token (the row's
 * `requestedPortsHash` captured at render/`approvals_get`): REQUIRED, and a
 * mismatch refuses `stale_snapshot` — the admin decided on a different request
 * than the row now carries. The recomputed-union-vs-stored-hash check then
 * refuses `stale_request` (and re-records the fresh union) when the live world
 * moved past the stored request itself.
 */
export async function approveHostPortGrantUnion(
  input: {
    packageName: string;
    orgId: string | null;
    approvedBy: string;
    expectedRequestedPortsHash: string | undefined;
  },
  depsOverride?: HostPortGrantReviewDeps,
): Promise<HostPortGrantDecisionResult> {
  const deps = await resolveDeps(depsOverride);
  if (!input.expectedRequestedPortsHash) {
    return {
      ok: false,
      code: "version_required",
      message:
        "This decision needs the request token captured at view time (expectedVersion) — " +
        "re-read the approval and decide again.",
    };
  }
  return deps.withInstallLock(input.packageName, async (): Promise<HostPortGrantDecisionResult> => {
    const row = await deps.readGrantForScope({
      packageName: input.packageName,
      orgId: input.orgId,
    });
    if (!row) {
      return {
        ok: false,
        code: "not_found",
        message: `No host-port grant exists for ${input.packageName} at this scope.`,
      };
    }
    if (row.status !== "pending") {
      return {
        ok: false,
        code: "not_pending",
        message: `The ${input.packageName} host-port grant is '${row.status}', not pending — nothing to re-approve.`,
      };
    }
    if (row.requestedPortsHash !== input.expectedRequestedPortsHash) {
      return {
        ok: false,
        code: "stale_snapshot",
        message:
          `The ${input.packageName} host-port request changed after you viewed it — ` +
          "re-read the approval and decide against the current request.",
      };
    }
    const union = await deps.readUnionPorts(input.packageName, input.orgId);
    if (deps.computeRequestedPortsHash(union) !== row.requestedPortsHash) {
      // The live world moved past the stored request (a sibling installed or
      // was torn down since it was recorded). Re-record the fresh union so the
      // next view shows the current request, then refuse.
      await deps.recordRequestedGrant({
        packageName: input.packageName,
        orgId: input.orgId,
        requestedPorts: union,
      });
      return {
        ok: false,
        code: "stale_request",
        message:
          `The live port union for ${input.packageName} no longer matches the recorded request; ` +
          "the request has been refreshed — re-read the approval and decide again.",
      };
    }
    await deps.approveGrant({
      packageName: input.packageName,
      orgId: input.orgId,
      approvedPorts: union,
      requestedPorts: union,
      approvedBy: input.approvedBy,
    });
    return { ok: true };
  });
}

/** Count of pending grant rows at the given scopes (the nav badge read). */
export async function countPendingHostPortGrants(
  input: { orgIds: readonly (string | null)[] },
  depsOverride?: HostPortGrantReviewDeps,
): Promise<number> {
  const deps = await resolveDeps(depsOverride);
  const pending = await deps.listGrantsForScopes({ orgIds: input.orgIds, status: "pending" });
  return pending.length;
}
