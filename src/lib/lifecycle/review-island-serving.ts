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
//      the one vocabulary, not a second copy of the rule), still have a LIVE
//      PARENT SIGN-IN (cinatra#2684's binding, the same predicate the capture
//      probe consults), and still be bound to an active connect site with the
//      same org, origin, client and credential generation. Signing out, revoking
//      the site or rotating its `cnx_` stops the island at the next paint.
//
//      THE SIGN-OUT HALF OF THAT SENTENCE IS NEW, and it is the correction of a
//      residual this slice originally disclosed rather than fixed. S8e was
//      written against a tree where a `cwu_` row outlived an ordinary sign-out,
//      so a copied island URL stayed usable for the remainder of its life. The
//      binding that closes it landed separately (#2684); this module adopts it
//      at the 2026-08-13 rebase, which is why the residual no longer appears
//      below and must not be re-stated as though it still held.
//   3. EVERY SEALED BINDING MUST STILL AGREE. Site, client, instance, agent, org
//      and user are compared one by one against the live row. A re-bound or
//      re-pointed site cannot keep painting under the old binding.
//   4. THE STANDING IS RESOLVED LIVE, AND IT IS THE PERSON'S REAL ONE. Org role,
//      teams, project grants and — since this slice removed the floor — the
//      platform tier, all through the same assembly the widget lifecycle actor
//      uses. Not a copy of it: literally that function, so the island and the
//      card can never drift apart.
//
//   5. AND ONLY THEN IS THE GRANT SPENT (cinatra#2754). The address is worth one
//      paint, and this is where it is paid for: one atomic
//      `DELETE ... RETURNING` against the ledger the mint wrote, keyed by the
//      SHA-256 of the credential the browser presented. THE ORDER IS THE WHOLE
//      GUARANTEE — a refusal at any rung above returns before reaching this, so
//      it never burns a grant the reader's retry still needs, and a success
//      always spends exactly one, so a replay of the same address (a reload, a
//      copied link, a line lifted out of a log) finds nothing and draws the
//      empty island. Keyed by the credential HASH and never by `jti`: one
//      transcript can frame several review cards off one `cwu_`, and a
//      per-token slot would let the second card kill the first.
//
//      AND IT IS THE LAST RUNG OF *THIS FUNCTION*, WHICH IS NOT THE LAST THING
//      THE REQUEST DOES. The page still hands the actor to
//      `loadReviewGateSurface`, and that can answer `not-authorized`, `blocked`
//      or fail — after the grant is already spent. That is the accepted shape,
//      not an oversight: the ruling put the consume here, the two refusing
//      answers are not answers a retry of the SAME address would change, and a
//      transient failure costs the reader nothing because the card's retry
//      re-resolves and re-mints (`onRetryResolve`). The alternative — carrying
//      an unspent grant out of the resolver and spending it in the page — would
//      put the security decision two modules away from the checks it depends on.
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
// cinatra#2684 — the parent-sign-in binding. A `cwu_` row belongs to the Better
// Auth session that authorized it, and anything reading such a row TO AUTHORIZE
// something must consult that binding. This is the THIRD reader the #2684
// structural bar was written for, and it is named in that test by anticipation:
// a surface that cannot present the bearer seals the `jti` instead. Adopting the
// predicate here is what closes the residual S8e disclosed — that an ordinary
// Cinatra sign-out left a copied island URL usable for the rest of its life.
import {
  normalizeWidgetAuthSessionId,
  widgetAuthSessionIsLive,
  WIDGET_AUTH_SESSION_COLUMN,
} from "@/lib/widget-session-binding";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { buildWidgetLifecycleRoleHints } from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  verifyReviewIslandCredential,
  type VerifiedReviewIslandCredential,
} from "@/lib/lifecycle/review-island-credential";
// cinatra#2754 — the single-use ledger. The LAST rung below spends the grant the
// mint recorded, so the second presentation of the same address finds nothing.
import { consumeIslandCredentialGrant } from "@/lib/lifecycle/review-island-grant-store";

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
            `${quotePostgresIdentifier(WIDGET_AUTH_SESSION_COLUMN)}, ` +
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

    // THE PARENT SIGN-IN, still there (cinatra#2684). A credential derived from
    // a sign-in must not outlive it, and this is the same predicate, from the
    // same leaf, in the same position in the order as the capture probe next
    // door. A row naming no session cannot prove a live parent and is refused
    // too. READ-ONLY, like the rest of this probe: the token verifier deletes a
    // dead row, this one only declines to paint from it.
    //
    // IT IS WHAT MAKES THE ONE-MINUTE WINDOW HONEST. Without it a copied island
    // URL stayed usable for its whole life after the person signed out — the
    // residual S8e wrote down and could not fix, because the binding did not
    // exist yet. #2684 landed it; the island adopts it here rather than being
    // the one reader that kept the old behaviour.
    if (
      !widgetAuthSessionIsLive(
        normalizeWidgetAuthSessionId(row[WIDGET_AUTH_SESSION_COLUMN]),
      )
    ) {
      return null;
    }

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

  // 5. THE LAST RUNG: SPEND THE GRANT (cinatra#2754). Everything that can
  //    refuse has refused by now, so this consume is the point of no return in
  //    both directions — it is never reached by a refusal, and it always runs on
  //    a success. `false` means the address was already spent (a replay), was
  //    never granted, or has outlived its sealed minute against the DATABASE
  //    clock; all three draw the same empty island as every other refusal here.
  const spent = consumeIslandCredentialGrant({
    credential: encoded,
    jti: verified.jti,
    runId: verified.runId,
    reviewTaskId: verified.reviewTaskId,
  });
  if (!spent) {
    emitWidgetAuthAudit("widget_lifecycle_read_rejected", {
      actor: live.userId,
      orgId: live.orgId,
      agentSlug: live.agentSlug,
      reason: "island_credential_spent",
    });
    return null;
  }

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
