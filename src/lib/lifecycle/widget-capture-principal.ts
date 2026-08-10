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
// SYNC STORE LEAF discipline (matches `widget-user-auth.ts`): the connection and
// schema primitives come from the postgres-config/schema-init pair, never from
// `@/lib/database`.
// ---------------------------------------------------------------------------

import { getActiveConnectSiteById } from "@/lib/connect-sites-store";
import { normalizeOriginStrict } from "@/lib/widget-token-broker";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync, quotePostgresIdentifier } from "@/lib/postgres-sync";

/** The table the hosted-PKCE login mints `cwu_` rows into (`widget-user-auth.ts`). */
const USER_TOKEN_TABLE = "widget_user_tokens";

/** The live facts a capability is re-checked against. */
export interface LiveWidgetCapturePrincipal {
  userId: string;
  orgId: string;
  siteId: string;
  client: string;
  instanceId: string;
  siteOrigin: string;
}

function qTable(table: string): string {
  return `${quotePostgresIdentifier(postgresSchema)}.${quotePostgresIdentifier(table)}`;
}

/**
 * Read the LIVE binding of a `cwu_` user token by its `jti`.
 *
 * Returns `null` — never a reason — when the token row is gone (logout /
 * sweep), has expired against the DATABASE clock, or when its bound connect
 * site is no longer active with the SAME org, origin, client and credential
 * generation. That last clause is the rotation gate `consumeUserWidgetToken`
 * carries: a reconnect bumps `credential_version` on a still-active row, and
 * without the comparison an outstanding capability would survive the rotation.
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
            `credential_version, (expires_at > now()) AS not_expired ` +
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
    const siteOrigin = normalizeOriginStrict(String(row.site_origin ?? ""));
    if (!orgId || !siteId || !client || !userId || !instanceId || !siteOrigin) return null;

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

    return { userId, orgId, siteId, client, instanceId, siteOrigin };
  } catch {
    return null;
  }
}
