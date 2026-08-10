import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  readConnectorConfigFromDatabase,
} from "@/lib/database";
import {
  getActiveConnectSiteById,
  type ConnectSiteRow,
} from "@/lib/connect-sites-store";
import { isValidCodeChallenge, verifyPkceS256 } from "@/lib/connect-provisioning";
import {
  validateConnectServerCredential,
  originMatchesSiteUrl,
  type ValidatedConnectCredential,
} from "@/lib/widget-stream-auth";
import { normalizeOriginStrict } from "@/lib/widget-token-broker";
import {
  formatTokenSet,
  grantedExtensionScopesFromScopeColumn,
  isKnownWidgetExtensionScope,
  mintWidgetTokenAudience,
  mintWidgetTokenScope,
  normalizeExtensionScopes,
  tokenAudienceAdmits,
  tokenSetHas,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  widgetUserBaseScope,
  type WidgetExtensionScope,
} from "@/lib/widget-lifecycle-scope";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import {
  runPostgresQueriesSync,
  quotePostgresIdentifier,
} from "@/lib/postgres-sync";

// ---------------------------------------------------------------------------
// cinatra#407 — hosted /widget-auth PKCE login + user-scoped widget token.
//
// This module is the SERVER-SIDE engine for the per-user widget login (Plan B,
// CHILD 2 of EPIC #406). It owns the three short-lived artifacts of the hosted
// authorization-code + PKCE flow and the OPAQUE user-scoped token they yield:
//
//   1. AUTH TRANSACTION (widget_auth_transactions) — created by the
//      site-token-authenticated POST /api/widget-auth/init. The CMS BACKEND
//      (holding the per-site `cnx_` credential) calls init; init PINS the
//      server-verified context {siteId, orgId, siteOrigin, client, agentSlug,
//      instanceId, codeChallenge, state} so the hosted page can never be driven
//      by a query string alone. The widget's PKCE code_challenge + a single-use
//      `state` are carried in (standard PKCE: the verifier stays widget-side).
//
//   2. AUTH CODE (widget_auth_codes) — issued by the hosted /widget-auth page
//      after the logged-in user (a verified MEMBER of the transaction's org)
//      explicitly consents. It carries the FULL user binding {userId, orgId,
//      siteOrigin, agentSlug, instanceId, client, codeChallenge}. The plaintext
//      code is postMessage'd to ONLY the verified opener origin.
//
//   3. USER TOKEN (widget_user_tokens) — minted by the site-token-authenticated
//      POST /api/widget-auth/token when the CMS BACKEND redeems the code (PKCE
//      verifier + the same `cnx_` whose site/org the code is bound to). It is
//      an OPAQUE `cwu_` bearer bound to {userId, orgId, siteOrigin, agentSlug,
//      instanceId, aud, scope, exp, jti, siteId}. NO refresh token — on expiry
//      the widget re-runs the login flow.
//
// DESIGN — OPAQUE server-side-tracked artifacts (NOT JWTs), mirroring the
// site-scoped widget-token-broker.ts: single-issuer/single-verifier, instant
// revocation (row delete / site-revoke re-check), intrinsic jti/replay handling,
// hash-at-rest (only sha256(secret) is stored → a DB/log leak never yields a
// live credential), live consume-time binding re-checks. The plaintext code /
// token strings are the lookup SECRETS; the DB primary key is sha256(secret).
//
// SECURITY BOUNDARIES this module enforces (acceptance for #407):
//   • A code minted for site A cannot be redeemed via site B's `cnx_`: redeem
//     cross-checks the code's {siteId, orgId, siteOrigin, client} against the
//     site resolved from the presented `cnx_`.
//   • The write-target instanceId is SERVER-DERIVED from the verified origin at
//     init (strict canonical resolver; zero/multiple matches → deny). The
//     widget's claimed instanceId may only DISAMBIGUATE, never select another.
//   • The user token re-checks {agent, aud, scope, origin, site-still-active}
//     live at verify time (consumeUserWidgetToken — called by CHILD 3 stream).
//
// What this module does NOT do (separate issues): it does not wire the stream
// route's dual-token validation (CHILD 3) nor enforce per-user connector rights
// at the MCP handler (CHILD 4). It ships the mint + verify surface those issues
// consume, plus the hosted page + the two server-to-server routes.
// ---------------------------------------------------------------------------

// TTLs. The transaction + code are single-leg, short-lived (mirrors the connect
// AUTH_CODE_TTL_MS of 120s). The user token is the browser-held bearer: short
// (15m), NO refresh — re-login on expiry (spec).
const TRANSACTION_TTL_SECONDS = 600; // 10 min — covers the interactive login
const CODE_TTL_SECONDS = 120; // 2 min — code→token redeem window
const USER_TOKEN_TTL_SECONDS = 15 * 60; // 15 min — browser-held bearer

const USER_TOKEN_PREFIX = "cwu_";
const TOKEN_RANDOM_BYTES = 32;

const TXN_TABLE = "widget_auth_transactions";
const CODE_TABLE = "widget_auth_codes";
const USER_TOKEN_TABLE = "widget_user_tokens";

// ---------------------------------------------------------------------------
// Hash helpers — inputs are ALWAYS high-entropy (32-byte random codes/tokens
// or a 43-char base64url PKCE challenge), never a low-entropy human secret, so
// a fast SHA-256 is correct (a slow KDF would be wrong here).
// ---------------------------------------------------------------------------

/** sha256 → base64url. Used for the code hash (matches connect's code hashing). */
function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

/** sha256 → lowercase hex. Used for the user-token hash + txn-id key. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function qTable(table: string): string {
  return `${quotePostgresIdentifier(postgresSchema)}.${quotePostgresIdentifier(table)}`;
}

// S5 (cinatra#1221) AUDIENCE RE-SCOPE — see widget-token-broker.ts. The `cwu_`
// per-user token's audience is the UNIFIED assistant chat route; it stays
// AGENT-BOUND via its `agent_slug` column + `scope` (`<agentSlug>.user`), only
// the `aud` moves so `/api/assistants/chat` consumes it. The mint site is
// unchanged; a legacy-route consume now fails `aud_mismatch` (designed cutover).
//
// cinatra#2574 (epic #2564 S8a) — `scope` and `aud` are now SETS (see
// widget-lifecycle-scope.ts). The chat route stays in every token's audience and
// the base `<agentSlug>.user` stays in every token's scope, so a token minted
// before this slice is byte-compatible at the chat route; a lifecycle grant is
// an ADDITIONAL member of both sets, present only when the user consented to it.
// The MINT of both sets now lives in the vocabulary module (mintWidgetTokenScope
// / mintWidgetTokenAudience) so a grant and the surface it unlocks have exactly
// one definition between them — which is why the old per-agent `streamRoutePath`
// helper is gone: it computed the audience a second time, and a second
// computation is how the two would eventually disagree.
function userTokenScope(agentSlug: string): string | null {
  return widgetUserBaseScope(agentSlug);
}

// ---------------------------------------------------------------------------
// Strict canonical instance resolver (codex convergence: do NOT reuse
// resolveContentEditorIdentityForInstance — that resolver intentionally falls
// back to a single-tenant identity, which is the wrong posture here). For
// #407's transaction binding the instanceId must be UNAMBIGUOUSLY derived from
// the verified origin; zero or multiple origin-matched rows → DENY.
//
// `instancesConfigKey` is the connector_config key holding `instances[]`
// (the agent's client: "wordpress" | "drupal"). A claimed `instanceId` may
// only DISAMBIGUATE among origin-matched rows, never select a different row.
// ---------------------------------------------------------------------------

type StoredInstanceRow = { id?: unknown; siteUrl?: unknown };

export function resolveCanonicalInstanceForOrigin(input: {
  instancesConfigKey: string;
  origin: string;
  claimedInstanceId?: string | null;
}): string | null {
  const instancesConfigKey = String(input.instancesConfigKey ?? "").trim();
  const origin = normalizeOriginStrict(input.origin);
  if (!instancesConfigKey || !origin) return null;

  const config = readConnectorConfigFromDatabase<{ instances?: unknown }>(
    instancesConfigKey,
    { instances: [] },
  );
  const instances: StoredInstanceRow[] = Array.isArray(config?.instances)
    ? (config.instances.filter((r) => r && typeof r === "object") as StoredInstanceRow[])
    : [];

  const originMatches = instances.filter(
    (r) =>
      typeof r.id === "string" &&
      r.id.trim().length > 0 &&
      originMatchesSiteUrl(origin, typeof r.siteUrl === "string" ? r.siteUrl : ""),
  );

  // Zero origin-matched rows → no binding → deny.
  if (originMatches.length === 0) return null;

  const claimed =
    typeof input.claimedInstanceId === "string" ? input.claimedInstanceId.trim() : "";
  if (claimed) {
    // The claim may only disambiguate AMONG origin-matched rows. A claim that
    // names a row outside the origin set is a forged target → deny (do NOT
    // silently fall back to an unambiguous origin row, since with a claim
    // present the intent is specific and a mismatch is suspicious).
    const exact = originMatches.find(
      (r) => typeof r.id === "string" && r.id.trim() === claimed,
    );
    return exact && typeof exact.id === "string" ? exact.id.trim() : null;
  }

  // No claim → require exactly one origin-matched row (multiple → ambiguous →
  // deny; the transaction must pin ONE canonical instance).
  if (originMatches.length !== 1) return null;
  const only = originMatches[0];
  return typeof only.id === "string" ? only.id.trim() : null;
}

// ---------------------------------------------------------------------------
// state validation
// ---------------------------------------------------------------------------

const STATE_RE = /^[A-Za-z0-9._~-]{8,256}$/;

/** Widget-supplied opaque `state` — base64url-ish, 8..256 chars. */
export function isValidState(value: unknown): value is string {
  return typeof value === "string" && STATE_RE.test(value);
}

// ---------------------------------------------------------------------------
// Site resolution from a presented cnx_ credential (server-to-server).
// Returns the verified, fully-bound site context (or null on any failure).
// ---------------------------------------------------------------------------

export type VerifiedSiteContext = {
  siteId: string;
  client: string;
  orgId: string;
  siteOrigin: string;
  /**
   * The `connect_sites` credential generation. Pinned into the minted user
   * token so a `cnx_` rotation (reconnect bumps this WITHOUT revoking the row)
   * invalidates outstanding `cwu_` tokens immediately — mirroring the
   * site-scoped broker's `token_key_fingerprint` re-check.
   */
  credentialVersion: number;
};

/**
 * Build the fully-bound, strictly-validated site context from a connect-site
 * binding. Shared by the consume-time live re-read (`ConnectSiteRow`) and the
 * mint-time single-read credential validation (`ValidatedConnectCredential`).
 * A site with no bound org, no resolvable origin, or a non-finite credential
 * generation cannot anchor a per-user authz transaction → null.
 */
function siteContextFromBinding(binding: {
  siteId: string;
  client: string;
  orgId: string | null;
  widgetOrigin: string;
  credentialVersion: number;
} | null): VerifiedSiteContext | null {
  if (!binding) return null;
  const orgId = typeof binding.orgId === "string" ? binding.orgId.trim() : "";
  const siteOrigin = normalizeOriginStrict(binding.widgetOrigin);
  // A site with no bound org cannot anchor a per-user authz transaction.
  if (!orgId || !siteOrigin) return null;
  const credentialVersion = Number(binding.credentialVersion);
  if (!Number.isFinite(credentialVersion)) return null;
  return { siteId: binding.siteId, client: binding.client, orgId, siteOrigin, credentialVersion };
}

function siteContextFromRow(row: ConnectSiteRow | null): VerifiedSiteContext | null {
  return siteContextFromBinding(row);
}

/**
 * Validate a presented `cnx_` site credential (server-to-server, paired to the
 * request Origin and the expected client) and resolve the fully-bound site
 * context. Returns null on any failure (unknown/revoked site, hash mismatch,
 * origin mismatch, client mismatch, or an incompletely-bound site row).
 *
 * ROTATION TOCTOU FIX (codex merge-time finding, #407): the context — and
 * crucially its `credentialVersion` — is derived from the SINGLE row that
 * `validateConnectServerCredential` constant-time hash-checked the presented
 * credential against. There is NO second `getActiveConnectSiteById` read here:
 * a concurrent `cnx_` rotation bumps `credential_version` WITHOUT revoking the
 * row, so a re-read could have handed an OLD (still-passing read #1) credential
 * the NEW version and pinned a stale-but-bumped generation into the minted
 * `cwu_`. Binding the version to the hash-checked credential closes that window;
 * the authoritative live re-check still runs at consume (`consumeUserWidgetToken`).
 */
export function resolveVerifiedSiteFromCredential(input: {
  credential: string;
  requestOrigin: string | null;
  expectedClient: string;
}): VerifiedSiteContext | null {
  const validated: ValidatedConnectCredential | null = validateConnectServerCredential({
    credential: input.credential,
    requestOrigin: input.requestOrigin,
    expectedClient: input.expectedClient,
    // enforcePairedOrigin defaults true — a blank/missing Origin rejects.
  });
  if (!validated) return null;
  // Single authoritative read: the version is the generation of the credential
  // that just authenticated, never a fresher row's.
  return siteContextFromBinding(validated);
}

// ---------------------------------------------------------------------------
// Schema sweep helpers
// ---------------------------------------------------------------------------

function sweepExpired(table: string): void {
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text: `DELETE FROM ${qTable(table)} WHERE expires_at < now()` }],
  });
}

// ---------------------------------------------------------------------------
// 1) AUTH TRANSACTION — created by the site-token-authenticated init route.
// ---------------------------------------------------------------------------

export type CreateTransactionInput = {
  site: VerifiedSiteContext;
  agentSlug: string;
  /** connector_config key for the agent's instances[] ("wordpress" | "drupal"). */
  instancesConfigKey: string;
  /** PKCE S256 code_challenge (widget-generated). */
  codeChallenge: string;
  /** Single-use opaque state (widget-generated). */
  state: string;
  /** Optional claimed instanceId — disambiguation only. */
  claimedInstanceId?: string | null;
};

export type CreateTransactionResult =
  | { ok: true; txnId: string; instanceId: string }
  | { ok: false; reason: TransactionRejectReason };

export type TransactionRejectReason =
  | "invalid_code_challenge"
  | "invalid_state"
  | "instance_unresolved";

/**
 * Pin the verified context to a new auth transaction. The verifier
 * (init route) has ALREADY validated the `cnx_` and resolved `site`. Here we
 * validate the PKCE challenge + state shape and SERVER-DERIVE the canonical
 * instanceId from the verified site origin (strict — zero/multiple → deny).
 */
export function createAuthTransaction(input: CreateTransactionInput): CreateTransactionResult {
  if (!isValidCodeChallenge(input.codeChallenge)) {
    return { ok: false, reason: "invalid_code_challenge" };
  }
  if (!isValidState(input.state)) {
    return { ok: false, reason: "invalid_state" };
  }

  const instanceId = resolveCanonicalInstanceForOrigin({
    instancesConfigKey: input.instancesConfigKey,
    origin: input.site.siteOrigin,
    claimedInstanceId: input.claimedInstanceId,
  });
  if (!instanceId) {
    return { ok: false, reason: "instance_unresolved" };
  }

  ensurePostgresSchema();
  const txnId = randomUUID();

  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      { text: `DELETE FROM ${qTable(TXN_TABLE)} WHERE expires_at < now()` },
      {
        text:
          `INSERT INTO ${qTable(TXN_TABLE)} (` +
          `txn_id, site_id, client, org_id, site_origin, agent_slug, instance_id, ` +
          `code_challenge, state, displayed_scopes, expires_at, created_at` +
          `) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(secs => $11), now())`,
        values: [
          txnId,
          input.site.siteId,
          input.site.client,
          input.site.orgId,
          input.site.siteOrigin,
          input.agentSlug,
          instanceId,
          input.codeChallenge,
          input.state,
          // cinatra#2631 — "nothing is known yet about what was displayed for
          // this transaction". NOT the no-screen sentinel: at creation the
          // server cannot know what will render, and stamping "no screen" here
          // would silently absorb a legacy signed-out page rendered by an older
          // node in between (rework round 3, finding 1). It fails CLOSED at the
          // grant, exactly like the pre-column NULL; the two knowable values are
          // written later, by whoever knows them.
          WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
          TRANSACTION_TTL_SECONDS,
        ],
      },
    ],
  });

  return { ok: true, txnId, instanceId };
}

export type LoadedTransaction = {
  txnId: string;
  siteId: string;
  client: string;
  orgId: string;
  siteOrigin: string;
  agentSlug: string;
  instanceId: string;
  codeChallenge: string;
  state: string;
  /**
   * What is KNOWN about what was displayed for this transaction: a real scope
   * set (a sign-in screen rendered and showed it), the NO-SCREEN sentinel (a
   * current node proved none rendered), the UNCLASSIFIED value (nothing is known
   * yet), or null (the transaction predates the column). Only the first two are
   * knowledge; the other two fail closed at the grant. cinatra#2631 — see
   * recordDisplayedScopesForTransaction.
   */
  displayedScopes: string | null;
};

/**
 * Load an UNCONSUMED, UNEXPIRED transaction by id. Returns null if missing,
 * expired, or already consumed. Read-only (the hosted page calls this to
 * render the login context; consumption happens at code issuance).
 */
export function loadActiveTransaction(txnId: string): LoadedTransaction | null {
  if (!txnId || typeof txnId !== "string") return null;
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text:
          `SELECT txn_id, site_id, client, org_id, site_origin, agent_slug, instance_id, ` +
          `code_challenge, state, displayed_scopes ` +
          `FROM ${qTable(TXN_TABLE)} ` +
          `WHERE txn_id = $1 AND consumed_at IS NULL AND expires_at > now() LIMIT 1`,
        values: [txnId],
      },
    ],
  });
  sweepExpired(TXN_TABLE);
  const row = result?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    txnId: String(row.txn_id ?? ""),
    siteId: String(row.site_id ?? ""),
    client: String(row.client ?? ""),
    orgId: String(row.org_id ?? ""),
    siteOrigin: String(row.site_origin ?? ""),
    agentSlug: String(row.agent_slug ?? ""),
    instanceId: String(row.instance_id ?? ""),
    codeChallenge: String(row.code_challenge ?? ""),
    state: String(row.state ?? ""),
    displayedScopes:
      typeof row.displayed_scopes === "string" ? row.displayed_scopes : null,
  };
}

/**
 * Record, ON THE TRANSACTION, what is KNOWN about what was displayed for it —
 * the one authenticated statement about what this person was shown.
 *
 * TWO WRITERS, BOTH SERVER-SIDE, and the value distinguishes them:
 *   • the hosted sign-in screen writes the scope set it is about to DISPLAY;
 *   • a node that PROVED no screen rendered writes WIDGET_NO_SIGNIN_SCREEN (the
 *     observed session already existed when the transaction was created).
 * Everything else the grant may find — the UNCLASSIFIED value this column is
 * created with, or the pre-column NULL — is the absence of knowledge and fails
 * closed there (cinatra#2631, rework round 3, finding 1).
 *
 * cinatra#2631 (codex rework round 1, finding 1). Carrying the displayed set
 * through the sign-in redirect in the URL was not enough: a party that controls
 * the popup's URL can STRIP the marker, and an absent marker used to be
 * admitted. Stripping therefore turned a mismatch back into the admitted case.
 * The server writes it here instead, where nothing in the browser can remove it,
 * and the action reads it off the row and nowhere else.
 *
 * FIRST WRITE WINS: the UPDATE may only replace the UNCLASSIFIED value, so
 * whichever writer knows something first is the record. A transaction is
 * single-use and short-lived, so the first sign-in screen rendered for it is the
 * one the person read; a later render by a build whose granted set differs does
 * not overwrite that, and a no-screen claim can never overwrite a screen that
 * really rendered.
 *
 * RETURNS THE AUTHORITATIVE STORED VALUE, not the value offered (codex rework
 * round 2, finding 1). A caller that assumed its own write had landed could
 * render one list of sentences while a different one stood recorded — the
 * mismatch the whole mechanism exists to prevent, reintroduced by optimism. The
 * caller compares and refuses to render when they differ. Null means the
 * transaction is no longer there to record anything against.
 *
 * Idempotent and NON-CONSUMING: re-rendering the sign-in screen writes nothing
 * new, and this never touches consumed_at. It is safe on a page render for
 * exactly that reason — unlike issuing a code, which is why THAT stays a POST.
 */
export function recordDisplayedScopesForTransaction(
  txnId: string,
  displayedScopes: string,
): string | null {
  if (!txnId || typeof txnId !== "string" || typeof displayedScopes !== "string") {
    return null;
  }
  ensurePostgresSchema();
  const [, read] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text:
          `UPDATE ${qTable(TXN_TABLE)} SET displayed_scopes = $2 ` +
          `WHERE txn_id = $1 AND consumed_at IS NULL AND expires_at > now() ` +
          `AND displayed_scopes = $3`,
        values: [txnId, displayedScopes, WIDGET_SIGNIN_SCREEN_UNCLASSIFIED],
      },
      {
        text:
          `SELECT displayed_scopes FROM ${qTable(TXN_TABLE)} ` +
          `WHERE txn_id = $1 AND consumed_at IS NULL AND expires_at > now() LIMIT 1`,
        values: [txnId],
      },
    ],
  });
  const row = read?.rows?.[0] as Record<string, unknown> | undefined;
  return row && typeof row.displayed_scopes === "string" ? row.displayed_scopes : null;
}

/**
 * A stable, non-reversible name for ONE session row, for the no-screen token to
 * carry (cinatra#2631, rework round 5, finding 1). The token says "no screen
 * rendered for THIS arrival", so it has to name the arrival; it is hashed for
 * the same reason every other identifier this module persists is — the row is
 * read by more eyes than the flow that wrote it, and a session id is nobody
 * else's business. Empty for anything unusable, which every consumer reads as
 * "no token": a caller that cannot identify its session may not write one.
 */
export function widgetSessionFingerprint(sessionId: unknown): string {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return "";
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

/**
 * Better Auth's session table, and the app-owned column that records when the
 * DATABASE inserted each row. Same database, `public` schema — the same place
 * `teamMemberRoleColumnExists()` probes (src/lib/better-auth-db.ts). The column
 * is provisioned by the schema SSOT at every boot (src/lib/drizzle-store.ts).
 */
const AUTH_SESSION_TABLE = `"public"."session"`;
const AUTH_SESSION_DB_CREATED_AT = "cinatra_db_created_at";

/**
 * Was the SESSION row already in the database when the TRANSACTION row was
 * inserted? THE PROOF behind a no-screen token (cinatra#2631).
 *
 * WHY THIS QUESTION. The hosted flow renders a sign-in screen only when there is
 * no session, and signing in through one MINTS the session it lands with. So a
 * session that predates the transaction is one no screen of this flow produced —
 * which means no screen rendered for this transaction, including a legacy screen
 * on an older node that would have recorded nothing. A session that came AFTER
 * means a screen did render somewhere, and the transaction's own record is then
 * the only thing that may speak for it.
 *
 * ONE CLOCK, AND IT IS THE DATABASE'S (codex rework round 4, finding 1). Both
 * sides are stamped by Postgres DEFAULTs at INSERT: the transaction's
 * `created_at`, and the session's `cinatra_db_created_at`. Better Auth's own
 * `createdAt` is deliberately NOT used — it is written by whichever NODE minted
 * the session, with that node's own clock, and the node whose clock matters most
 * here is precisely the one we do not control: an OLD one still serving the
 * legacy sign-in screen. If its clock lagged the database by longer than the
 * sign-in takes, a session minted AFTER that screen would read as older than the
 * transaction and the sentinel would be written over a screen that really
 * rendered. A database default cannot lag: an old node inserts the row without
 * naming the column, and Postgres fills it.
 *
 * INSERT-TIME, AND IT STAYS THAT WAY (round 6). Better Auth UPDATEs a session
 * row on its `updateAge` refresh and on an org switch. Neither touches this
 * column — which is exactly why it is a column and not the row's `xmin`, whose
 * whole value a single refresh replaces. Reading a refreshed row's write id
 * would have failed the ORDINARY already-signed-in path, once per person per
 * day, for a session that genuinely predated everything.
 *
 * THE DATABASE DOES THE COMPARING, in one statement, so the two reads cannot
 * disagree and nothing is re-derived in JS. FAILS CLOSED, ALWAYS: a missing
 * session row, a missing transaction, a NULL either side, or any error at all
 * (a deployment whose auth tables are not in `public` would raise one) proves
 * nothing — and "proves nothing" must never write a value that grants.
 */
export function sessionRowPredatesTransaction(
  sessionId: string,
  txnId: string,
): boolean {
  if (!sessionId || typeof sessionId !== "string") return false;
  if (!txnId || typeof txnId !== "string") return false;
  ensurePostgresSchema();
  let result;
  try {
    [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text:
            `SELECT (` +
            `(SELECT ${quotePostgresIdentifier(AUTH_SESSION_DB_CREATED_AT)} ` +
            `FROM ${AUTH_SESSION_TABLE} WHERE id = $1) ` +
            `< ` +
            `(SELECT created_at FROM ${qTable(TXN_TABLE)} WHERE txn_id = $2)` +
            `) AS session_predates`,
          values: [sessionId, txnId],
        },
      ],
    });
  } catch {
    return false;
  }
  const row = result?.rows?.[0] as Record<string, unknown> | undefined;
  return row?.session_predates === true;
}

// ---------------------------------------------------------------------------
// 2) AUTH CODE — issued by the hosted page once the sign-in has authorized it.
// ---------------------------------------------------------------------------

export type IssueCodeResult =
  | { ok: true; code: string; state: string; siteOrigin: string }
  | { ok: false; reason: "txn_not_found" };

/**
 * Atomically CONSUME the transaction (single-use) and issue a user auth code
 * bound to the now-known userId + the transaction's verified context. The
 * caller MUST have already verified there is a session and that the user is a
 * member of `txn.orgId`. Only the sha256 hash of the code is stored; the
 * plaintext is returned once (to be postMessage'd to the opener origin).
 *
 * The transaction consume is the single-use gate: a second concurrent issue for
 * the same transaction finds consumed_at already set → txn_not_found.
 *
 * cinatra#2574 — `grantedScopes` records WHAT THE SIGN-IN GRANTED on the code
 * itself, so the grant travels with the authorization rather than being
 * re-decided at redeem time. Unknown entries are dropped here (a code can only
 * ever carry a scope this build understands), and the column is nullable: a code
 * issued before this slice carries none, which is how an older authorization
 * fails closed on every lifecycle read (AC-1).
 */
export function issueUserAuthCode(input: {
  txnId: string;
  userId: string;
  grantedScopes?: readonly WidgetExtensionScope[];
}): IssueCodeResult {
  ensurePostgresSchema();

  // Atomic single-use consume of the transaction → returns its bound context.
  const [consumed] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text:
          `UPDATE ${qTable(TXN_TABLE)} SET consumed_at = now() ` +
          `WHERE txn_id = $1 AND consumed_at IS NULL AND expires_at > now() ` +
          `RETURNING site_id, client, org_id, site_origin, agent_slug, instance_id, ` +
          `code_challenge, state`,
        values: [input.txnId],
      },
    ],
  });
  const txn = consumed?.rows?.[0] as Record<string, unknown> | undefined;
  if (!txn) return { ok: false, reason: "txn_not_found" };

  const code = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const codeHash = sha256Base64Url(code);
  const siteOrigin = String(txn.site_origin ?? "");
  const state = String(txn.state ?? "");

  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      { text: `DELETE FROM ${qTable(CODE_TABLE)} WHERE expires_at < now()` },
      {
        text:
          `INSERT INTO ${qTable(CODE_TABLE)} (` +
          `code_hash, user_id, site_id, client, org_id, site_origin, agent_slug, ` +
          `instance_id, code_challenge, granted_scopes, expires_at, created_at` +
          `) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(secs => $11), now())`,
        values: [
          codeHash,
          input.userId,
          String(txn.site_id ?? ""),
          String(txn.client ?? ""),
          String(txn.org_id ?? ""),
          siteOrigin,
          String(txn.agent_slug ?? ""),
          String(txn.instance_id ?? ""),
          String(txn.code_challenge ?? ""),
          formatTokenSet(normalizeExtensionScopes(input.grantedScopes)),
          CODE_TTL_SECONDS,
        ],
      },
    ],
  });

  return { ok: true, code, state, siteOrigin };
}

// ---------------------------------------------------------------------------
// 3) USER TOKEN — minted when the CMS backend redeems the code (server-to-server).
// ---------------------------------------------------------------------------

export type RedeemUserTokenResult =
  | {
      ok: true;
      token: string;
      tokenType: "Bearer";
      expiresIn: number;
      scope: string;
    }
  | { ok: false; reason: RedeemRejectReason };

export type RedeemRejectReason =
  | "invalid_grant" // generic — covers not-found/expired/replayed/bad-verifier/site-mismatch
  | "site_mismatch";

/**
 * Redeem an auth code for an opaque short-lived user token. The caller (token
 * route) has ALREADY validated the presenting `cnx_` and resolved `site` from
 * it. Here we atomically consume the code (single-use), verify the PKCE
 * code_verifier against the stored challenge, and CROSS-CHECK that the code was
 * minted for the SAME site as the presenting credential (a code minted for site
 * A cannot be redeemed through site B's cnx_). Then mint + persist the token
 * (hash-at-rest) and return the plaintext once.
 *
 * Generic `invalid_grant` on every failure — no oracle leaks which check failed.
 */
export function redeemUserAuthCode(input: {
  code: string;
  codeVerifier: string;
  site: VerifiedSiteContext;
  issuerBaseUrl: string;
}): RedeemUserTokenResult {
  if (!input.code || typeof input.code !== "string") {
    return { ok: false, reason: "invalid_grant" };
  }
  ensurePostgresSchema();
  const codeHash = sha256Base64Url(input.code);

  // Atomic single-use consume: DELETE...RETURNING so a replay finds nothing.
  const [consumed] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text:
          `DELETE FROM ${qTable(CODE_TABLE)} WHERE code_hash = $1 AND expires_at > now() ` +
          `RETURNING user_id, site_id, client, org_id, site_origin, agent_slug, ` +
          `instance_id, code_challenge, granted_scopes`,
        values: [codeHash],
      },
    ],
  });
  sweepExpired(CODE_TABLE);
  const row = consumed?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return { ok: false, reason: "invalid_grant" };

  const storedChallenge = String(row.code_challenge ?? "");
  if (!verifyPkceS256(input.codeVerifier, storedChallenge)) {
    return { ok: false, reason: "invalid_grant" };
  }

  // Cross-site binding: the code's site MUST be the credential's site. This is
  // the "code minted for site A cannot be redeemed by site B" gate. We compare
  // siteId (primary) AND the bound org/origin/client (defense in depth).
  const codeSiteId = String(row.site_id ?? "");
  const codeOrgId = String(row.org_id ?? "");
  const codeOrigin = normalizeOriginStrict(String(row.site_origin ?? ""));
  const codeClient = String(row.client ?? "");
  if (
    codeSiteId !== input.site.siteId ||
    codeOrgId !== input.site.orgId ||
    codeOrigin !== input.site.siteOrigin ||
    codeClient !== input.site.client
  ) {
    return { ok: false, reason: "site_mismatch" };
  }

  const userId = String(row.user_id ?? "");
  const agentSlug = String(row.agent_slug ?? "");
  const instanceId = String(row.instance_id ?? "");
  if (!userId || !agentSlug) return { ok: false, reason: "invalid_grant" };

  const rawToken = USER_TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const tokenHash = sha256Hex(rawToken);
  const jti = randomUUID();
  // cinatra#2574 — the token inherits EXACTLY the grant the consent recorded on
  // the code, re-narrowed to the scopes this build knows. The audience set is
  // DERIVED from that same grant (never stored independently), so a scope and
  // the surface it unlocks cannot drift apart. A code with no recorded grant —
  // every code issued before this slice — mints the pre-#2574 pair: the base
  // scope and the chat audience, and nothing else.
  const grantedScopes = grantedExtensionScopesFromScopeColumn(
    String(row.granted_scopes ?? ""),
  );
  // An agent slug that cannot be expressed as ONE scope-set member would encode
  // a scope column meaning something other than what it says (codex round 0,
  // finding 3), so the mint refuses instead — generically, like every other
  // redeem failure.
  const scope = mintWidgetTokenScope(agentSlug, grantedScopes);
  if (!scope) return { ok: false, reason: "invalid_grant" };
  const aud = mintWidgetTokenAudience(grantedScopes);

  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      { text: `DELETE FROM ${qTable(USER_TOKEN_TABLE)} WHERE expires_at < now()` },
      {
        text:
          `INSERT INTO ${qTable(USER_TOKEN_TABLE)} (` +
          `token_hash, jti, user_id, site_id, client, org_id, site_origin, agent_slug, ` +
          `instance_id, credential_version, aud, iss, scope, expires_at, created_at` +
          `) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(secs => $14), now())`,
        values: [
          tokenHash,
          jti,
          userId,
          input.site.siteId,
          codeClient,
          codeOrgId,
          input.site.siteOrigin,
          agentSlug,
          instanceId,
          // Pin the credential generation that authenticated this redeem; a later
          // `cnx_` rotation (reconnect) makes this token's version stale → dead at
          // consume even though the site row stays active with the same org/origin.
          input.site.credentialVersion,
          aud,
          input.issuerBaseUrl,
          scope,
          USER_TOKEN_TTL_SECONDS,
        ],
      },
    ],
  });

  return {
    ok: true,
    token: rawToken,
    tokenType: "Bearer",
    expiresIn: USER_TOKEN_TTL_SECONDS,
    scope,
  };
}

// ---------------------------------------------------------------------------
// USER TOKEN VERIFY — consumed by CHILD 3 (stream dual-token validation).
// Multi-use within TTL. Re-checks every binding against the STORED row + live
// site state, mirroring consumeWidgetStreamToken. CORS plays no part.
// ---------------------------------------------------------------------------

export type UserTokenClaims = {
  userId: string;
  orgId: string;
  siteId: string;
  client: string;
  siteOrigin: string;
  agentSlug: string;
  instanceId: string;
  jti: string;
  /**
   * The extension scopes this token actually carries (cinatra#2574) — known
   * entries only, so a caller can audit what was consented to without re-parsing
   * the column. Empty for every token minted before the vocabulary existed.
   */
  grantedScopes: WidgetExtensionScope[];
};

export type ConsumeUserTokenResult =
  | { ok: true; claims: UserTokenClaims }
  | { ok: false; reason: ConsumeUserTokenReason };

export type ConsumeUserTokenReason =
  | "not_cwu_token"
  | "not_found"
  | "expired"
  | "agent_mismatch"
  | "aud_mismatch"
  | "scope_mismatch"
  | "origin_mismatch"
  | "site_revoked";

/**
 * Validate a presented opaque user widget token for the stream route. Returns
 * the bound user claims on success. Re-checks, against the STORED row and live
 * state: not-expired (DB clock), agent_slug, aud (route path), scope, the
 * request Origin == bound siteOrigin, and that the bound connect-site is STILL
 * ACTIVE with the SAME org/origin (instant revoke: revoking/rotating the site,
 * or its org/origin re-binding, kills the token immediately).
 *
 * cinatra#2574 — `aud` and `scope` are SETS and both are checked by exact
 * MEMBERSHIP, never by equality: the presented `routePath` must be in the
 * token's audience, the base `<agentSlug>.user` must be in its scope, and every
 * scope in `requiredScopes` must be in its scope too. This is the ONE place the
 * lifecycle grant is evaluated — a caller asks for the capability it needs and
 * the single verifier decides, so no surface can grow a second copy of the rule.
 * A token whose consent predates a required scope fails `scope_mismatch` here
 * (and, for the lifecycle audience, `aud_mismatch` before it).
 */
export function consumeUserWidgetToken(input: {
  token: string;
  agentSlug: string;
  routePath: string;
  requestOrigin: string | null;
  /** Extension scopes the CALLING surface requires. Default: none (chat turn). */
  requiredScopes?: readonly WidgetExtensionScope[];
}): ConsumeUserTokenResult {
  if (!input.token || !input.token.startsWith(USER_TOKEN_PREFIX)) {
    return { ok: false, reason: "not_cwu_token" };
  }
  ensurePostgresSchema();
  const tokenHash = sha256Hex(input.token);

  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text:
          `SELECT jti, user_id, site_id, client, org_id, site_origin, agent_slug, ` +
          `instance_id, credential_version, aud, scope, (expires_at > now()) AS not_expired ` +
          `FROM ${qTable(USER_TOKEN_TABLE)} WHERE token_hash = $1 LIMIT 1`,
        values: [tokenHash],
      },
    ],
  });
  sweepExpired(USER_TOKEN_TABLE);

  const row = result?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return { ok: false, reason: "not_found" };

  if (row.not_expired !== true) {
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        { text: `DELETE FROM ${qTable(USER_TOKEN_TABLE)} WHERE token_hash = $1`, values: [tokenHash] },
      ],
    });
    return { ok: false, reason: "expired" };
  }

  if (String(row.agent_slug ?? "") !== input.agentSlug) {
    return { ok: false, reason: "agent_mismatch" };
  }
  // Audience. Not raw membership: the route must be in the stored set AND be a
  // route this build can justify from the token's own scopes (the chat route
  // always; anything else only via a KNOWN scope the token carries). A token
  // minted before #2574 holds the single chat route and parses as a one-element
  // set, so the chat branch is unchanged.
  if (!tokenAudienceAdmits(row.scope, row.aud, input.routePath)) {
    return { ok: false, reason: "aud_mismatch" };
  }
  // Scope: the agent-bound base scope ALWAYS. An unknown entry in the column is
  // inert — it neither grants anything nor invalidates the entries beside it.
  const baseScope = userTokenScope(input.agentSlug);
  if (!baseScope || !tokenSetHas(row.scope, baseScope)) {
    return { ok: false, reason: "scope_mismatch" };
  }
  // Required scopes. A capability the CALLER names must be one this build
  // actually defines — an unrecognized requirement is refused rather than
  // matched against a raw column, so a stale caller and a tampered row cannot
  // meet in the middle on a name neither side understands.
  for (const required of input.requiredScopes ?? []) {
    if (!isKnownWidgetExtensionScope(required) || !tokenSetHas(row.scope, required)) {
      return { ok: false, reason: "scope_mismatch" };
    }
  }

  const storedOrigin = normalizeOriginStrict(String(row.site_origin ?? ""));
  const requestOriginNorm = normalizeOriginStrict(input.requestOrigin);
  if (!requestOriginNorm || requestOriginNorm !== storedOrigin) {
    return { ok: false, reason: "origin_mismatch" };
  }

  // Live site re-check: the bound connect-site must still be active AND still
  // carry the SAME org + origin + credential GENERATION the token was minted
  // against. A revoked / rotated / re-bound site kills outstanding user tokens
  // immediately. The credential_version comparison is the rotation gate: a
  // reconnect bumps the version on the still-active row (same org/origin), so
  // without this check an outstanding `cwu_` would survive the rotation for its
  // full TTL — this mirrors the site-scoped broker's token_key_fingerprint
  // re-check (widget-token-broker.ts:384).
  const siteId = String(row.site_id ?? "");
  const siteRow = siteId ? getActiveConnectSiteById(siteId) : null;
  const liveCtx = siteContextFromRow(siteRow);
  const tokenCredentialVersion = Number(row.credential_version);
  if (
    !liveCtx ||
    liveCtx.orgId !== String(row.org_id ?? "") ||
    liveCtx.siteOrigin !== storedOrigin ||
    liveCtx.client !== String(row.client ?? "") ||
    !Number.isFinite(tokenCredentialVersion) ||
    liveCtx.credentialVersion !== tokenCredentialVersion
  ) {
    return { ok: false, reason: "site_revoked" };
  }

  return {
    ok: true,
    claims: {
      userId: String(row.user_id ?? ""),
      orgId: String(row.org_id ?? ""),
      siteId,
      client: String(row.client ?? ""),
      siteOrigin: storedOrigin,
      agentSlug: String(row.agent_slug ?? ""),
      instanceId: String(row.instance_id ?? ""),
      jti: String(row.jti ?? ""),
      grantedScopes: grantedExtensionScopesFromScopeColumn(row.scope),
    },
  };
}

export const __testing = {
  sha256Base64Url,
  sha256Hex,
  USER_TOKEN_PREFIX,
  USER_TOKEN_TTL_SECONDS,
  CODE_TTL_SECONDS,
  TRANSACTION_TTL_SECONDS,
  userTokenScope,
};
