import "server-only";

// ---------------------------------------------------------------------------
// The ACTION-CAPABILITY LEDGER (cinatra#2575, epic #2564 S8b) — the durable half
// of the widget decision path.
//
// Three writes, and each is the ONLY way its state can be reached:
//
//   requestActionCapability  — INSERT. Records what a confirmation would be
//                              about. Authorizes nothing.
//   confirmActionCapability  — CAS on `confirmed_at IS NULL`. The human act. It
//                              also re-bases the row's `expires_at` onto the
//                              short SPEND window (see below).
//   consumeActionCapability  — CAS on `consumed_at IS NULL`. The burn. A
//                              capability spends exactly once.
//
// THE TWO WINDOWS ARE DELIBERATELY UNRELATED. Before the confirmation, the row's
// expiry bounds how long an UNCONFIRMED request may sit — a person may take a
// moment to read what they are approving, so it is minutes. After it, the expiry
// bounds how long a CONFIRMED decision may be spent — one `fetch` after one
// click, so it is seconds. Stapling the second window to the remainder of the
// first would buy nothing: a confirmation that just happened is exactly as fresh
// whether the request was made ten seconds ago or four minutes ago, because the
// CONFIRMATION is the act that authorizes. So confirm sets `expires_at` from the
// database clock outright rather than shortening what was left.
//
// THE DATABASE CLOCK IS THE AUTHORITY on both windows (`now()` in SQL, never a
// timestamp this process computes and sends). The sealed capability carries its
// own `exp` as well, and the broker endpoint checks that too — but that check is
// a cheap pre-filter against a value minted on one node, while the burn is
// arbitrated by the one clock every node shares. Two independent expiries, both
// fail-closed, is the same belt-and-braces `consumeUserWidgetToken` already uses.
//
// ASYNC POOLED STORE, deliberately (#303). Every caller here is an async route
// handler or an async Server Action, so there is no synchronous context forcing
// the sync bridge, and this slice adds no new `runPostgresQueriesSync` call
// site. The sibling widget stores predate that track and stay where they are.
//
// NO ROW IS EVER UPDATED TWICE. `confirmed_at` and `consumed_at` are written
// once each by their own CAS and never cleared; the DDL's
// `widget_action_capabilities_spend_needs_confirm` CHECK means the database
// itself refuses a spend that skipped the confirmation, so a future refactor
// that drops the confirm step fails loudly rather than silently authorizing.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { getPooledDb } from "@/lib/db/pooled";
import {
  ACTION_CAPABILITY_TTL_SECONDS,
  type ActionCapabilityDisposition,
  type ActionCapabilityPayload,
} from "@/lib/lifecycle/widget-action-capability";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const TABLE = "widget_action_capabilities";

/**
 * How long an UNCONFIRMED request may sit before it stops being confirmable.
 *
 * Long enough to open a window, read a sentence naming the artifact and the act,
 * and press a button; short enough that a request abandoned on a shared machine
 * is not confirmable by the next person to sit down.
 */
export const ACTION_CAPABILITY_REQUEST_TTL_SECONDS = 300;

/** The minimal query surface, injectable so the unit suite needs no database. */
export type ActionCapabilityQuery = <T = Record<string, unknown>>(
  text: string,
  values: unknown[],
) => Promise<{ rows: T[] }>;

let pool: Pool | null = null;
const defaultQuery: ActionCapabilityQuery = async (text, values) => {
  pool ??= getPooledDb({ name: "widget-action-capabilities" });
  const result = await pool.query(text, values);
  return { rows: result.rows as never[] };
};

function qTable(): string {
  return `"${schemaName.replaceAll('"', '""')}"."${TABLE}"`;
}

/** The binding a request records — everything the sealed capability will carry. */
export interface ActionCapabilityRequestInput {
  purpose: string;
  audience: string;
  orgId: string;
  userId: string;
  /** The `cwu_` widget session the request was made inside. */
  widgetJti: string;
  siteId: string;
  client: string;
  instanceId: string;
  agentSlug: string;
  runId: string;
  reviewTaskId: string;
  disposition: ActionCapabilityDisposition;
  /** Digest of the gate's pinned targets as the requester's card showed them. */
  targetsDigest: string;
  /** Digest of the decision payload the confirmation will be about. */
  decisionDigest: string;
  /**
   * WHAT is under review, in the person's own words — derived server-side from
   * the gate's pinned artifacts at request time, by a caller that had already
   * cleared run READ. The confirmation window renders it, and without it that
   * window would say "Approve this review" about a review it cannot name.
   */
  subjectLabel: string;
  /**
   * The WHOLE rationale, for the confirmation screen to render in full.
   *
   * codex round 1, finding 1. An earlier shape stored a 400-character excerpt
   * and told the person how much was hidden. That is not informed confirmation:
   * a benign opening followed by consequential text would be sealed and
   * submitted on a click about the opening. The screen shows everything, so the
   * row has to hold everything. It is capped at the endpoint
   * (`WIDGET_COMMENT_MAX_CHARS`), lives only while the request is confirmable,
   * and dies with the row.
   */
  commentText: string | null;
}

/** A stored capability row, as every reader here sees it. */
export interface ActionCapabilityRow extends ActionCapabilityRequestInput {
  capabilityId: string;
  confirmed: boolean;
  consumed: boolean;
}

/**
 * The row, as the CODEC's binding.
 *
 * ONE mapping, used by the surface that seals a capability and by the surface
 * that burns one, so the confirmation and the redemption can never disagree
 * about what a row binds. (The two shapes differ by one field name: the row
 * calls the widget session `widgetJti`, after its column, and the sealed payload
 * calls it `jti`, after the claim it comes from.)
 */
export function actionCapabilityRowBinding(row: ActionCapabilityRow): ActionCapabilityPayload {
  return {
    capabilityId: row.capabilityId,
    purpose: row.purpose,
    audience: row.audience,
    orgId: row.orgId,
    userId: row.userId,
    jti: row.widgetJti,
    siteId: row.siteId,
    client: row.client,
    instanceId: row.instanceId,
    agentSlug: row.agentSlug,
    runId: row.runId,
    reviewTaskId: row.reviewTaskId,
    disposition: row.disposition,
    targetsDigest: row.targetsDigest,
    decisionDigest: row.decisionDigest,
  };
}

const COLUMNS =
  "capability_id, purpose, audience, org_id, user_id, widget_jti, site_id, client, " +
  "instance_id, agent_slug, run_id, review_task_id, disposition, targets_digest, " +
  "decision_digest, subject_label, comment_text, " +
  "(confirmed_at IS NOT NULL) AS confirmed, (consumed_at IS NOT NULL) AS consumed";

function toRow(raw: Record<string, unknown> | undefined): ActionCapabilityRow | null {
  if (!raw) return null;
  const disposition = String(raw.disposition ?? "");
  if (disposition !== "approve" && disposition !== "reject" && disposition !== "comment") {
    // A row whose act is not one this build has is a corrupted row, and a
    // corrupted row authorizes nothing. (The DDL's CHECK makes this
    // unreachable through this store; it is here so a hand-edited row cannot
    // walk past the type system.)
    return null;
  }
  const row: ActionCapabilityRow = {
    capabilityId: String(raw.capability_id ?? ""),
    purpose: String(raw.purpose ?? ""),
    audience: String(raw.audience ?? ""),
    orgId: String(raw.org_id ?? ""),
    userId: String(raw.user_id ?? ""),
    widgetJti: String(raw.widget_jti ?? ""),
    siteId: String(raw.site_id ?? ""),
    client: String(raw.client ?? ""),
    instanceId: String(raw.instance_id ?? ""),
    agentSlug: String(raw.agent_slug ?? ""),
    runId: String(raw.run_id ?? ""),
    reviewTaskId: String(raw.review_task_id ?? ""),
    disposition,
    targetsDigest: String(raw.targets_digest ?? ""),
    decisionDigest: String(raw.decision_digest ?? ""),
    subjectLabel: String(raw.subject_label ?? ""),
    commentText:
      typeof raw.comment_text === "string" && raw.comment_text.length > 0
        ? raw.comment_text
        : null,
    confirmed: raw.confirmed === true,
    consumed: raw.consumed === true,
  };
  // Defensive: a row missing any binding axis cannot anchor an authorization.
  const required = [
    row.capabilityId,
    row.purpose,
    row.audience,
    row.orgId,
    row.userId,
    row.widgetJti,
    row.siteId,
    row.client,
    row.instanceId,
    row.agentSlug,
    row.runId,
    row.reviewTaskId,
    row.targetsDigest,
    row.decisionDigest,
    row.subjectLabel,
  ];
  return required.every((v) => v.length > 0) ? row : null;
}

/**
 * The lazy retention sweep, run on the INSERT path only.
 *
 * Spent and abandoned rows carry no secret (only a burnt id and a binding the
 * database already holds elsewhere), so this is housekeeping, not a security
 * boundary — the CAS predicates are. Deliberately not run on the read paths: a
 * DELETE there would make a read a write, and a burst of probes would then be a
 * write amplifier.
 */
async function sweepExpired(query: ActionCapabilityQuery): Promise<void> {
  // Spent rows are kept for a grace period past their expiry so a
  // response-lost retry meets "already consumed" rather than "never existed" —
  // the two are answered identically on the wire, but the audit trail is only
  // truthful if the row is still there when it is written.
  await query(
    `DELETE FROM ${qTable()} WHERE expires_at < now() - interval '1 hour'`,
    [],
  ).catch(() => ({ rows: [] }));
}

/**
 * Record a capability REQUEST. Returns the minted capability id, or `null` when
 * the store refuses it.
 *
 * The id is a v4 uuid: it is the row key and is sealed INTO the capability, so
 * it must be unguessable — a caller that could guess a pending id could ask the
 * hosted page to render somebody else's confirmation (the page also re-checks
 * the session principal, but a credential's id should never be the only thing
 * between two people).
 */
export async function requestActionCapability(
  input: ActionCapabilityRequestInput,
  deps?: { query?: ActionCapabilityQuery; ttlSeconds?: number },
): Promise<string | null> {
  const query = deps?.query ?? defaultQuery;
  const ttl = deps?.ttlSeconds ?? ACTION_CAPABILITY_REQUEST_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > ACTION_CAPABILITY_REQUEST_TTL_SECONDS) {
    return null;
  }
  const capabilityId = randomUUID();
  try {
    await sweepExpired(query);
    await query(
      `INSERT INTO ${qTable()} (
         capability_id, purpose, audience, org_id, user_id, widget_jti, site_id,
         client, instance_id, agent_slug, run_id, review_task_id, disposition,
         targets_digest, decision_digest, subject_label, comment_text, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(secs => $18::int))`,
      [
        capabilityId,
        input.purpose,
        input.audience,
        input.orgId,
        input.userId,
        input.widgetJti,
        input.siteId,
        input.client,
        input.instanceId,
        input.agentSlug,
        input.runId,
        input.reviewTaskId,
        input.disposition,
        input.targetsDigest,
        input.decisionDigest,
        input.subjectLabel,
        input.commentText,
        ttl,
      ],
    );
    return capabilityId;
  } catch {
    return null;
  }
}

/**
 * Read a request for DISPLAY on the hosted confirmation page.
 *
 * Returns the row whatever state it is in (so the page can say "already used"
 * rather than "not found"), but only while it has not expired — an expired
 * request is indistinguishable from one that never existed, which is what the
 * page's single refusal state renders.
 *
 * READ-ONLY, and it authorizes nothing: the page still re-checks that the signed
 * -in principal is the one the row names before it renders a single detail.
 */
export async function readActionCapabilityRequest(
  capabilityId: string,
  deps?: { query?: ActionCapabilityQuery },
): Promise<ActionCapabilityRow | null> {
  const query = deps?.query ?? defaultQuery;
  if (typeof capabilityId !== "string" || capabilityId.length === 0 || capabilityId.length > 128) {
    return null;
  }
  try {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${qTable()} WHERE capability_id = $1 AND expires_at > now() LIMIT 1`,
      [capabilityId],
    );
    return toRow(rows[0]);
  } catch {
    return null;
  }
}

/**
 * The CONFIRMATION CAS — the human act, exactly once.
 *
 * `confirmed_at IS NULL` makes it single-shot; `user_id = $2` binds it to the
 * principal that is actually standing there, so a request minted for one person
 * can never be confirmed by another even if they hold its id; `expires_at >
 * now()` is the confirmation window. The same statement re-bases `expires_at`
 * onto the spend window (see the module header).
 *
 * Returns the row on success and `null` on every refusal — expired, already
 * confirmed, already consumed, wrong principal or absent. The caller renders one
 * state for all of them: which one it was is not the confirmer's business, and
 * telling them would make this a probe for other people's pending decisions.
 */
export async function confirmActionCapability(
  capabilityId: string,
  userId: string,
  deps?: { query?: ActionCapabilityQuery; spendTtlSeconds?: number },
): Promise<ActionCapabilityRow | null> {
  const query = deps?.query ?? defaultQuery;
  const ttl = deps?.spendTtlSeconds ?? ACTION_CAPABILITY_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > ACTION_CAPABILITY_TTL_SECONDS) return null;
  if (typeof capabilityId !== "string" || capabilityId.length === 0 || capabilityId.length > 128) {
    return null;
  }
  if (typeof userId !== "string" || userId.length === 0) return null;
  try {
    const { rows } = await query<Record<string, unknown>>(
      `UPDATE ${qTable()}
          SET confirmed_at = now(),
              expires_at   = now() + make_interval(secs => $3::int)
        WHERE capability_id = $1
          AND user_id       = $2
          AND confirmed_at IS NULL
          AND consumed_at  IS NULL
          AND expires_at    > now()
        RETURNING ${COLUMNS}`,
      [capabilityId, userId, ttl],
    );
    return toRow(rows[0]);
  } catch {
    return null;
  }
}

/**
 * The BURN — the single-use consume edge the slice exists for.
 *
 * `consumed_at IS NULL` is the whole replay defence: two concurrent redemptions
 * of the same sealed capability contend on one row and exactly one wins, whatever
 * the decision core then decides. `confirmed_at IS NOT NULL` refuses a capability
 * that somehow reached the endpoint without a confirmation (the DDL CHECK makes
 * that unreachable, and this predicate makes it unreachable one layer earlier).
 *
 * BURNED BEFORE THE DECISION RUNS, deliberately. A credential is spent by being
 * PRESENTED, not by succeeding: if the decision then conflicts, is refused, or
 * throws, the capability is still gone and the person confirms again. The
 * alternative — burn on success — would leave a live decision credential in the
 * hands of whoever provoked the failure, which is precisely the position an
 * attacker wants to be in.
 *
 * Returns the row on the winning call and `null` on every other outcome.
 */
export async function consumeActionCapability(
  capabilityId: string,
  deps?: { query?: ActionCapabilityQuery },
): Promise<ActionCapabilityRow | null> {
  const query = deps?.query ?? defaultQuery;
  if (typeof capabilityId !== "string" || capabilityId.length === 0 || capabilityId.length > 128) {
    return null;
  }
  try {
    const { rows } = await query<Record<string, unknown>>(
      `UPDATE ${qTable()}
          SET consumed_at = now()
        WHERE capability_id  = $1
          AND consumed_at   IS NULL
          AND confirmed_at IS NOT NULL
          AND expires_at     > now()
        RETURNING ${COLUMNS}`,
      [capabilityId],
    );
    return toRow(rows[0]);
  } catch {
    return null;
  }
}
