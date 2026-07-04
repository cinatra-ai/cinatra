import "server-only";

// ---------------------------------------------------------------------------
// Owner-aware, grant-following connection resolver (cinatra#952 W2).
//
// Maps (connectorKey, actor) → ONE authorized connection ADDRESS
// (providerConfigKey + connectionId): the actor's OWN connection first
// (existing per-user primary semantics), else the single connection whose
// owner's grant admits the actor. The caller then uses the UNCHANGED
// connection-addressed fetch primitives (`getNangoCredentials` /
// `buildBearerAuthHeaderFromNango`) — the resolver returns NO credentials and
// caches NOTHING (revocation is effective on the next resolution).
//
// OWNER RULING (verbatim, cinatra#952): more than one authorized SHARED
// candidate = HARD-FAIL, fail-closed, with an actionable error. Never "pick
// one". NO connection-pinning or candidate-selection UI/API may be added.
//
// Own-connection choice is NOT the shared-ambiguity case (an actor's own
// records keep the existing per-user primary semantics — first record in
// blob order, mirroring `getPrimarySavedNangoConnection`), and
// connection-ADDRESSED calls (explicit connectionId — instance flows,
// external-MCP rows) bypass candidate selection entirely: they hit
// `enforceConnectionUse` only.
//
// Every resolution produces exactly ONE decision audit row:
//   • the final candidate passes through the audited `enforceConnectionUse`
//     seam immediately before the blob lookup (candidate DISCOVERY uses the
//     same unaudited decision predicate, so a candidate the gate would deny
//     can never inflate the shared count into a spurious ambiguity);
//   • no-candidate / ambiguity DENIES are audited PRE-fetch against the
//     sentinel resourceId `connector:<key>` (no single row UUID exists).
// ---------------------------------------------------------------------------

import { AuthzError } from "@/lib/authz";
import type { ActorContext } from "@/lib/authz";
import { logDeniedAuditEventStrictWithCooldown } from "@/lib/authz/audit";
import {
  listNangoConnectionsByConnector,
  type NangoConnectionIdentity,
} from "@cinatra-ai/extensions/connection-identity-store";
import {
  connectionSubjectUserId,
  decideConnectionUse,
  enforceConnectionUse,
  resolveConnectionAccessDeclaration,
} from "@/lib/connection-use-gate";
import {
  listSavedNangoConnections,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  type NangoConnectorKey,
  type SavedNangoConnection,
} from "@/lib/nango-system";

export class NoUsableConnectionError extends AuthzError {}
export class AmbiguousSharedConnectionError extends AuthzError {}
export class ConnectionRecordMissingError extends Error {}

export type ResolvedConnectionForUse = {
  identity: NangoConnectionIdentity;
  providerConfigKey: string;
  connectionId: string;
  /** True when the actor uses ANOTHER user's connection through a grant. */
  delegated: boolean;
};

/**
 * Scope-BLIND connection-addressed blob-record read: `listSavedNangoConnections`
 * with no options returns every record for the key, so no scope filter is
 * re-implemented here. Token-vault POINTER only — never credentials.
 */
function getSavedNangoConnectionRecord(
  connectorKey: NangoConnectorKey,
  connectionId: string,
): SavedNangoConnection | null {
  return (
    listSavedNangoConnections(connectorKey).find((r) => r.connectionId === connectionId) ?? null
  );
}

/** Resolve the blob address for an AUTHORIZED identity row. A live identity
 * row with no blob record HARD-FAILS (fail-closed) — never a silent skip. */
function blobAddressFor(identity: NangoConnectionIdentity): {
  providerConfigKey: string;
  connectionId: string;
} {
  const key = identity.connectorKey as NangoConnectorKey;
  const record = getSavedNangoConnectionRecord(key, identity.connectionId);
  const providerConfigKey =
    record?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS[key];
  if (!record) {
    throw new ConnectionRecordMissingError(
      `The ${identity.connectorKey} connection ${identity.id} is registered but its ` +
        `saved-connection record is missing — reconnect the connector or remove the ` +
        `stale connection.`,
    );
  }
  if (!providerConfigKey) {
    throw new ConnectionRecordMissingError(
      `No provider config key is known for connector "${identity.connectorKey}".`,
    );
  }
  return { providerConfigKey, connectionId: identity.connectionId };
}

async function auditSentinelDeny(input: {
  connectorKey: string;
  actor: ActorContext;
  subjectUserId: string | undefined;
  runId?: string;
  reason: "no_candidate" | "ambiguous_shared_candidates";
  candidateCount?: number;
}): Promise<void> {
  const { connectorKey, actor, subjectUserId, runId, reason, candidateCount } = input;
  await logDeniedAuditEventStrictWithCooldown({
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    actorPrincipalType: actor.principalType === "HumanUser" ? "human" : "system",
    authSource: actor.authSource,
    impersonatedUserId:
      subjectUserId != null && subjectUserId !== actor.principalId ? subjectUserId : undefined,
    resourceType: "connection",
    resourceId: `connector:${connectorKey}`,
    operation: "use",
    runId,
    metadata: {
      connectorKey,
      reason,
      ...(candidateCount != null ? { candidateCount } : {}),
    },
  });
}

/**
 * Resolve ONE authorized connection for `connectorKey` on behalf of `actor`.
 *
 * Throws (all fail-closed, all audited PRE-fetch):
 *   • NoUsableConnectionError — no own connection and no (or an
 *     out-of-ceiling) shared grant admits the actor;
 *   • AmbiguousSharedConnectionError — MORE THAN ONE authorized shared
 *     candidate (owner ruling: hard-fail; never pick; no pinning/selection);
 *   • ConnectionUseDeniedError — the final candidate failed the audited gate
 *     (defense in depth; discovery and decision share one predicate);
 *   • ConnectionRecordMissingError — live identity row without a blob record.
 */
export async function resolveConnectionForUse(input: {
  connectorKey: NangoConnectorKey;
  actor: ActorContext;
  runId?: string;
  /** Attribution tag for the audit row (e.g. "github-api"). */
  source?: string;
}): Promise<ResolvedConnectionForUse> {
  const { connectorKey, actor, runId, source } = input;
  const subjectUserId = connectionSubjectUserId(actor);
  const rows = await listNangoConnectionsByConnector(
    actor.organizationId ?? null,
    connectorKey,
  );

  // 1. OWN connections first (existing per-user primary semantics: first
  // record in blob order). Includes null-org rows — a null-org legacy row
  // resolves for its OWNER only.
  const ownRows =
    subjectUserId != null ? rows.filter((r) => r.ownerUserId === subjectUserId) : [];
  if (ownRows.length > 0) {
    let ownPick = ownRows[0];
    if (ownRows.length > 1) {
      const blobOrder = listSavedNangoConnections(connectorKey);
      const first = blobOrder.find((record) =>
        ownRows.some((r) => r.connectionId === record.connectionId),
      );
      ownPick = first
        ? ownRows.find((r) => r.connectionId === first.connectionId) ?? ownRows[0]
        : ownRows[0];
    }
    await enforceConnectionUse({
      identity: ownPick,
      actor,
      subjectUserId,
      runId,
      source: source ?? "resolver",
    });
    return { identity: ownPick, ...blobAddressFor(ownPick), delegated: false };
  }

  // 2. `only:"user"` connectors NEVER enter shared listings: no own
  // connection ⇒ audited pre-fetch deny + actionable error.
  const declarationProbe = rows[0]
    ? await resolveConnectionAccessDeclaration(rows[0])
    : null;
  const declaration =
    declarationProbe && declarationProbe.kind === "declaration"
      ? declarationProbe.declaration
      : null;
  if (declaration?.mode === "only" && declaration.scope === "user") {
    await auditSentinelDeny({
      connectorKey,
      actor,
      subjectUserId,
      runId,
      reason: "no_candidate",
    });
    throw new NoUsableConnectionError({
      statusCode: 403,
      reason: "forbidden",
      message:
        `${connectorKey} connections are per-user only (the connector declares ` +
        `only:"user") — connect your own ${connectorKey} account to continue.`,
    });
  }

  // 3. Shared candidates: rows owned by OTHERS in the ACTOR's organization.
  // Null-org rows are NEVER shared candidates (no cross-org guard could
  // contain them), and an org-less actor gets no shared candidates at all.
  // Discovery uses the same unaudited decision predicate as the gate.
  const sharedRows =
    actor.organizationId != null
      ? rows.filter(
          (r) =>
            r.ownerUserId !== subjectUserId &&
            r.organizationId != null &&
            r.organizationId === actor.organizationId,
        )
      : [];
  const authorized: NangoConnectionIdentity[] = [];
  for (const candidate of sharedRows) {
    const decision = await decideConnectionUse({ identity: candidate, actor, subjectUserId });
    if (decision.allowed) authorized.push(candidate);
  }

  if (authorized.length === 0) {
    await auditSentinelDeny({
      connectorKey,
      actor,
      subjectUserId,
      runId,
      reason: "no_candidate",
    });
    throw new NoUsableConnectionError({
      statusCode: 403,
      reason: "forbidden",
      message:
        `No ${connectorKey} connection is available to you — connect your own ` +
        `${connectorKey} account, or ask a connection owner to share theirs.`,
    });
  }

  if (authorized.length > 1) {
    // OWNER RULING: hard-fail, fail-closed. NEVER pick one; no pinning or
    // candidate-selection UI/API exists or may be added.
    await auditSentinelDeny({
      connectorKey,
      actor,
      subjectUserId,
      runId,
      reason: "ambiguous_shared_candidates",
      candidateCount: authorized.length,
    });
    throw new AmbiguousSharedConnectionError({
      statusCode: 403,
      reason: "forbidden",
      message:
        `${authorized.length} shared ${connectorKey} connections are granted to you — ` +
        `ambiguous. Ask the connection owners (or an admin) to narrow the grants so ` +
        `exactly one applies, or connect your own ${connectorKey} account.`,
    });
  }

  // 4. Exactly one — the SAME audited gate seam decides, immediately before
  // the blob lookup (the discovery pass above was never the decision).
  const candidate = authorized[0];
  await enforceConnectionUse({
    identity: candidate,
    actor,
    subjectUserId,
    runId,
    source: source ?? "resolver",
  });
  return { identity: candidate, ...blobAddressFor(candidate), delegated: true };
}
