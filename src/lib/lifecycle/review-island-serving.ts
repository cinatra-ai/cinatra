import "server-only";

// ---------------------------------------------------------------------------
// SERVING an island credential (cinatra#2674 scope addition, 2026-08-12).
//
// The codec (`review-island-credential.ts`) proves a URL was minted by this host
// and has not expired. This module does everything that comes after, in the one
// order that fails closed at every step, and hands the island page a fully
// resolved reader or nothing at all:
//
//   1. THE REF MUST BE THE SEALED GATE. The island is asked for one gate by an
//      opaque ref; the credential names the gate it was minted for. They must be
//      the same gate. This is the "ref-bound" half of the issue's sentence, and
//      it is what makes a credential useless against any other review — even a
//      genuine one, minted seconds ago, for the reader's own other gate.
//   2. THE PRINCIPAL MUST STILL BE LIVE. The `cwu_` row is re-read by its `jti`
//      — the same revocation handle the capture capability uses — and must still
//      be unexpired, still carry the LIFECYCLE grant (audience AND scope, through
//      the one vocabulary, not a second copy of the rule), and still be bound to
//      an active connect site with the same org, origin, client and credential
//      generation. Signing out, revoking the site or rotating its `cnx_` stops
//      the island at the next paint.
//   3. EVERY SEALED BINDING MUST STILL AGREE. Site, client, instance, agent, org
//      and user are compared one by one against the live row. A re-bound or
//      re-pointed site cannot keep painting under the old binding.
//   4. THE STANDING IS RESOLVED LIVE, AND IT IS THE PERSON'S REAL ONE. Org role,
//      teams, project grants and — since this slice removed the floor — the
//      platform tier, all through the same assembly the widget lifecycle actor
//      uses. Not a copy of it: literally that function, so the island and the
//      card can never drift apart.
//
// AND THEN THE ORDINARY ACCESS CHECK STILL RUNS. This module returns an actor;
// the page hands it to `loadReviewGateSurface`, which re-runs the reader's run
// access and reads the pinned set from the frozen gate exactly as it does for a
// cookie session. The credential authenticates. It authorizes nothing.
//
// ONE ANSWER FOR EVERY REFUSAL. `null`, always, with no reason — the island's
// whole contract is that "you may not read this" and "there is nothing here" are
// indistinguishable. Reasons go to the audit trail, never to the frame.
// ---------------------------------------------------------------------------

import { resolveActorGrantsForUserInOrg } from "@/lib/auth-session";
import { readUserIsPlatformAdmin } from "@/lib/better-auth-db";
import { getActiveConnectSiteById } from "@/lib/connect-sites-store";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { normalizeOriginStrict } from "@/lib/widget-token-broker";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
  tokenAudienceAdmits,
  tokenSetHas,
  widgetUserBaseScope,
} from "@/lib/widget-lifecycle-scope";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { quotePostgresIdentifier, runPostgresQueriesSync } from "@/lib/postgres-sync";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { buildWidgetLifecycleRoleHints } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  verifyReviewIslandCredential,
  type VerifiedReviewIslandCredential,
} from "@/lib/lifecycle/review-island-credential";

/** The table the hosted PKCE login mints `cwu_` rows into. */
const USER_TOKEN_TABLE = "widget_user_tokens";

function qTable(table: string): string {
  return `${quotePostgresIdentifier(postgresSchema)}.${quotePostgresIdentifier(table)}`;
}

/** The live facts an island credential is re-checked against. */
type LiveIslandPrincipal = {
  userId: string;
  orgId: string;
  siteId: string;
  client: string;
  instanceId: string;
  agentSlug: string;
  siteOrigin: string;
};

/**
 * Read the LIVE binding of a `cwu_` token by its `jti`, for an island paint.
 *
 * DELIBERATELY STRICTER than the capture probe next door: a capture is a picture
 * a gate already pinned, while the island renders the review target itself, so
 * this requires the token to carry the LIFECYCLE grant — the read scope AND the
 * lifecycle audience — evaluated through the SAME vocabulary helpers
 * `consumeUserWidgetToken` uses. A session whose consent predates the grant
 * paints nothing, which is the same answer it gets at the card.
 *
 * `null` — never a reason — for a row that is gone, expired against the DATABASE
 * clock, missing the grant, or whose site is no longer active with the same org,
 * origin, client and credential generation. NEVER THROWS: a store failure is
 * `null`, because the serving path must answer uniformly.
 */
function readLiveIslandPrincipal(jti: string): LiveIslandPrincipal | null {
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 128) return null;
  try {
    ensurePostgresSchema();
    const [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text:
            `SELECT user_id, org_id, site_id, client, instance_id, site_origin, ` +
            `agent_slug, aud, scope, credential_version, ` +
            `(expires_at > now()) AS not_expired ` +
            `FROM ${qTable(USER_TOKEN_TABLE)} WHERE jti = $1 LIMIT 1`,
          values: [jti],
        },
      ],
    });
    const row = result?.rows?.[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.not_expired !== true) return null;

    const userId = String(row.user_id ?? "");
    const orgId = String(row.org_id ?? "");
    const siteId = String(row.site_id ?? "");
    const client = String(row.client ?? "");
    const instanceId = String(row.instance_id ?? "");
    const agentSlug = String(row.agent_slug ?? "");
    const siteOrigin = normalizeOriginStrict(String(row.site_origin ?? ""));
    if (!userId || !orgId || !siteId || !client || !instanceId || !agentSlug || !siteOrigin) {
      return null;
    }

    // The LIFECYCLE grant, both halves, through the one vocabulary.
    if (!tokenAudienceAdmits(row.scope, row.aud, WIDGET_LIFECYCLE_READ_ROUTE_PATH)) {
      return null;
    }
    if (!tokenSetHas(row.scope, WIDGET_LIFECYCLE_READ_SCOPE)) return null;
    const baseScope = widgetUserBaseScope(agentSlug);
    if (!baseScope || !tokenSetHas(row.scope, baseScope)) return null;

    // Live site re-check — revoke / re-bind / rotate kills the island at the
    // next paint, exactly as it kills the token at the next turn.
    const site = getActiveConnectSiteById(siteId);
    if (!site) return null;
    const tokenCredentialVersion = Number(row.credential_version);
    if (
      String(site.orgId ?? "") !== orgId ||
      site.client !== client ||
      normalizeOriginStrict(site.widgetOrigin) !== siteOrigin ||
      !Number.isFinite(tokenCredentialVersion) ||
      Number(site.credentialVersion) !== tokenCredentialVersion
    ) {
      return null;
    }

    return { userId, orgId, siteId, client, instanceId, agentSlug, siteOrigin };
  } catch {
    return null;
  }
}

export type IslandCredentialReader = {
  actorCtx: ReviewActorContext;
  /** The gate the credential is bound to — the caller loads THIS, never the
   *  ref's own decode, so a mismatch cannot survive by being re-read later. */
  runId: string;
  reviewTaskId: string;
};

/**
 * Resolve the island's reader from a presented credential and the ref the frame
 * was asked to paint. `null` for every refusal.
 */
export async function resolveIslandCredentialReader(input: {
  credential: string | null | undefined;
  ref: string | null | undefined;
}): Promise<IslandCredentialReader | null> {
  const encoded = typeof input.credential === "string" ? input.credential : "";
  if (!encoded) return null;

  const verified: VerifiedReviewIslandCredential | null =
    verifyReviewIslandCredential(encoded);
  if (!verified) return null;

  // 1. REF BINDING. The ref must decode, and must decode to the sealed gate.
  const ref = typeof input.ref === "string" ? input.ref : "";
  const payload = ref ? decodeLifecycleGateRef(ref) : null;
  if (
    !payload ||
    payload.runId !== verified.runId ||
    payload.reviewTaskId !== verified.reviewTaskId
  ) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      agentSlug: verified.agentSlug,
      reason: "island_ref_mismatch",
    });
    return null;
  }

  // 2. LIVE PRINCIPAL, by the token's own revocation handle.
  const live = readLiveIslandPrincipal(verified.jti);
  if (!live) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      agentSlug: verified.agentSlug,
      reason: "island_principal_dead",
    });
    return null;
  }

  // 3. EVERY SEALED BINDING, one by one. A single disagreement refuses the whole
  //    paint — a credential whose bindings have drifted is not a narrower
  //    credential, it is a wrong one.
  if (
    live.userId !== verified.userId ||
    live.orgId !== verified.orgId ||
    live.siteId !== verified.siteId ||
    live.client !== verified.client ||
    live.instanceId !== verified.instanceId ||
    live.agentSlug !== verified.agentSlug
  ) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      actor: verified.userId,
      orgId: verified.orgId,
      agentSlug: verified.agentSlug,
      reason: "island_binding_mismatch",
    });
    return null;
  }

  // 4. LIVE STANDING, in the TOKEN's org. `orgRole` IS the membership: absent
  //    means not a member any more, and there is nothing to fall back to.
  const grants = await resolveActorGrantsForUserInOrg(live.userId, live.orgId);
  if (!grants.orgRole) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      actor: live.userId,
      orgId: live.orgId,
      agentSlug: live.agentSlug,
      reason: "not_org_member",
    });
    return null;
  }
  // The platform tier, live and unfloored (cinatra#2674) — fail-closed to
  // `member` on any read trouble.
  const platformRole = (await readUserIsPlatformAdmin(live.userId))
    ? ("platform_admin" as const)
    : ("member" as const);

  const actorCtx: ReviewActorContext = {
    actor: {
      actorType: "human",
      source: "a2a",
      userId: live.userId,
      orgId: live.orgId,
    },
    orgId: live.orgId,
    // The SAME assembly the widget lifecycle actor uses — not a copy. The island
    // and the card above it must resolve one reader, or they will eventually
    // disagree about what that reader may see.
    roleHints: buildWidgetLifecycleRoleHints({
      orgId: live.orgId,
      platformRole,
      orgRole: grants.orgRole,
      teamIds: grants.teamIds,
      teamRoles: grants.teamRoles,
      projectGrants: grants.projectGrants,
    }),
  };

  emitWidgetAuthAudit("widget_lifecycle_read_authorized", {
    actor: live.userId,
    orgId: live.orgId,
    siteId: live.siteId,
    client: live.client,
    agentSlug: live.agentSlug,
    siteOrigin: live.siteOrigin,
    instanceId: live.instanceId,
    reason: "island",
  });

  return { actorCtx, runId: verified.runId, reviewTaskId: verified.reviewTaskId };
}
