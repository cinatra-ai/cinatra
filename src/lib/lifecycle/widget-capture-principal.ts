import "server-only";

// ---------------------------------------------------------------------------
// The LIVE PRINCIPAL probe behind a capture capability (cinatra#2576, S8c).
//
// A capture capability is fetched by `<img src>`, so the request cannot present
// the `cwu_` token itself — only the `jti` sealed into the capability. This leaf
// answers the one question that makes the capability revocable: is the user
// token that authorized this picture STILL alive, and is it still bound to the
// same person, org, site, client and canonical instance it was minted for?
//
// WHY THIS IS A SEPARATE LEAF AND NOT A FUNCTION IN `widget-user-auth.ts`.
// That module's verifier (`consumeUserWidgetToken`) is keyed on the RAW TOKEN
// (it hashes the presented bearer). There is no raw token on an image request,
// so no amount of reuse gets this probe out of that module's shape — it needs a
// jti-keyed read. It is deliberately NARROWER than `consumeUserWidgetToken` in
// every direction: it is READ-ONLY (it never deletes an expired row), it grants
// nothing on its own, it returns no reasons, and it cannot be used to
// authenticate a turn. Everything it re-checks, it re-checks the same way and in
// the same order the token verifier does, and a drift test pins the two
// re-checks together so this probe can never become the laxer of the pair.
//
// NO REASONS OUT. `consumeUserWidgetToken` returns a typed reason because its
// callers log it server-side. This probe answers a request whose entire response
// is an image or a 404, so a reason would only ever be an oracle. One boolean
// shape, one answer.
//
// THE ONE RE-CHECK IT CANNOT MAKE, AND WHY THAT IS SOUND. The token verifier
// compares the REQUEST's `Origin` against the token's bound site origin
// (`origin_mismatch`). There is no such comparison to make here and there must
// not be: this capability is fetched SAME-ORIGIN from cinatra's own embed
// iframe, so the request origin is cinatra's, never the CMS site's. The binding
// that clause protects — "this token belongs to THIS registered site" — is
// re-checked here by a different and equally live route: the token row's
// {siteId, client, instanceId, agentSlug} must still agree with the sealed
// capability AND the live `connect_sites` row must still carry the same org,
// origin, client and credential generation. The exemption is recorded as data in
// the drift test (`widget-capture-principal.test.ts`), so a NEW verifier reason
// fails that test until it is either mirrored here or consciously exempted.
//
// SYNC STORE LEAF discipline (matches `widget-user-auth.ts`): the connection and
// schema primitives come from the postgres-config/schema-init pair, never from
// `@/lib/database`.
// ---------------------------------------------------------------------------

import { getActiveConnectSiteById } from "@/lib/connect-sites-store";
import { normalizeOriginStrict } from "@/lib/widget-token-broker";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import { tokenAudienceAdmits, tokenSetHas } from "@/lib/widget-lifecycle-scope";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync, quotePostgresIdentifier } from "@/lib/postgres-sync";
import {
  normalizeWidgetAuthSessionId,
  widgetAuthSessionIsLive,
  WIDGET_AUTH_SESSION_COLUMN,
} from "@/lib/widget-session-binding";

/** The table the hosted-PKCE login mints `cwu_` rows into (`widget-user-auth.ts`). */
const USER_TOKEN_TABLE = "widget_user_tokens";

/** The scope a `cwu_` token carries, mirroring `widget-user-auth.ts`'s
 * `userTokenScope`. A row whose scope is not exactly this is not an interactive
 * per-user widget bearer, whatever else it is. */
function userTokenScope(agentSlug: string): string {
  return `${agentSlug}.user`;
}

/** The live facts a capability is re-checked against. */
export interface LiveWidgetCapturePrincipal {
  userId: string;
  orgId: string;
  siteId: string;
  client: string;
  instanceId: string;
  agentSlug: string;
  siteOrigin: string;
}

function qTable(table: string): string {
  return `${quotePostgresIdentifier(postgresSchema)}.${quotePostgresIdentifier(table)}`;
}

/**
 * Read the LIVE binding of a `cwu_` user token by its `jti`.
 *
 * Returns `null` — never a reason — when the token row is gone (logout /
 * sweep), has expired against the DATABASE clock, is not an interactive
 * per-user widget bearer (its `aud` is not the broker audience, or its `scope`
 * is not `<agentSlug>.user`), when the BETTER AUTH SESSION it was minted out of
 * is no longer signed in (cinatra#2684 — a sign-out or revoke ends the
 * capability at the next fetch, not at the end of its 300-second life), or when
 * its bound connect site is no longer active
 * with the SAME org, origin, client and credential generation. That last clause
 * is the rotation gate `consumeUserWidgetToken` carries: a reconnect bumps
 * `credential_version` on a still-active row, and without the comparison an
 * outstanding capability would survive the rotation.
 *
 * NEVER THROWS: a store failure is `null`, because the serving path must answer
 * a uniform 404 for "no" and an exception would surface as a distinguishable
 * 500.
 */
export function readLiveWidgetCapturePrincipal(
  jti: string,
): LiveWidgetCapturePrincipal | null {
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
            `${WIDGET_AUTH_SESSION_COLUMN}, ` +
            `(expires_at > now()) AS not_expired ` +
            `FROM ${qTable(USER_TOKEN_TABLE)} WHERE jti = $1 LIMIT 1`,
          values: [jti],
        },
      ],
    });
    const row = result?.rows?.[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    // Expiry against the DB clock (the same authority the token verifier uses),
    // not this process's clock.
    if (row.not_expired !== true) return null;

    const orgId = String(row.org_id ?? "");
    const siteId = String(row.site_id ?? "");
    const client = String(row.client ?? "");
    const userId = String(row.user_id ?? "");
    const instanceId = String(row.instance_id ?? "");
    const agentSlug = String(row.agent_slug ?? "");
    const siteOrigin = normalizeOriginStrict(String(row.site_origin ?? ""));
    if (!orgId || !siteId || !client || !userId || !instanceId || !agentSlug || !siteOrigin) {
      return null;
    }

    // The row must be an INTERACTIVE per-user widget bearer, exactly as
    // `consumeUserWidgetToken` requires: bound to the broker audience and
    // carrying this agent's own user scope. Without these two, a token minted
    // for some other audience or scope could authorize capture bytes that the
    // canonical verifier would have rejected outright.
    //
    // SET MEMBERSHIP, NOT EQUALITY (cinatra#2577, folding #2575's fix). This
    // probe was written while `aud` and `scope` still held exactly one value
    // each, and compared them with `!==`. cinatra#2574 (S8a) made both columns
    // SPACE-DELIMITED SETS, so a token minted since then carries
    // `"<slug>.user lifecycle.read …"` / `"/api/assistants/chat
    // /api/lifecycle-views/resolve …"` and the equality test refuses EVERY
    // genuine bearer — which would silently break the S8c capture path the
    // moment a widget review card actually asks for a capture. The canonical
    // verifier already moved to membership; this is the same move, through the
    // same parser, so the pair a drift test pins together cannot disagree about
    // what a column means. It is not a relaxation: `tokenAudienceAdmits`
    // RE-DERIVES the admissible audience from the token's own known scopes and
    // then requires it to be present in the stored set, so an audience this
    // build cannot justify is still refused.
    if (!tokenAudienceAdmits(row.scope, row.aud, WIDGET_BROKER_ROUTE_PATH)) return null;
    if (!tokenSetHas(row.scope, userTokenScope(agentSlug))) return null;

    // Live PARENT-SESSION re-check (cinatra#2684) — the capability is a picture
    // authorized by one person's sign-in, so when that sign-in ends the picture
    // stops being served. `consumeUserWidgetToken` refuses `session_revoked`
    // here; this is the same predicate, from the same leaf, in the same position
    // in the order. A row naming no session cannot prove a live parent and is
    // refused too. READ-ONLY, like everything else in this probe: the token
    // verifier deletes the dead row, this one only declines to use it.
    if (!widgetAuthSessionIsLive(normalizeWidgetAuthSessionId(row[WIDGET_AUTH_SESSION_COLUMN]))) {
      return null;
    }

    // Live site re-check — revoke / re-bind / rotate kills the capability at the
    // next fetch, exactly as it kills the token at the next turn.
    const site = getActiveConnectSiteById(siteId);
    if (!site) return null;
    const liveOrigin = normalizeOriginStrict(site.widgetOrigin);
    const tokenCredentialVersion = Number(row.credential_version);
    if (
      String(site.orgId ?? "") !== orgId ||
      site.client !== client ||
      liveOrigin !== siteOrigin ||
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
