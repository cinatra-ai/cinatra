import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

// ---------------------------------------------------------------------------
// The TRIGGER SCHEDULE PROPOSAL token (cinatra#2569, epic #2564 S5).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// §VI: "nothing exists until the reader confirms". The assistant proposes a
// schedule; no run, no trigger row, no server record of any kind is written.
// The whole proposal therefore has to travel INSIDE the turn — and a payload
// the model can see, the transcript persists, and anyone can hand back is only
// safe if it is (a) unforgeable, (b) unreadable, (c) short-lived, and (d)
// spendable exactly once. This module owns (a)–(c); (d) is a DB consume edge
// (`trigger-schedule-proposal-store`), because single-use is a property of a
// unique index, never of a stateless token.
//
// AUTHENTICATED ENCRYPTION, not a readable JWT — the load-bearing difference
// from this repo's other signed tokens.
//
// The other `*-token.ts` families (`widget-chat-resume-token`,
// `connector-instance-pending-call-decision-token`, the MCP actor tokens) are
// compact HS256 JWTs, and a JWT's payload is base64, i.e. PLAINTEXT. Those
// tokens ride an `Authorization` header or a server-action argument — channels
// nothing re-reads. THIS token rides `assistant_turns.content`: it is persisted
// in the transcript and RE-FED TO THE MODEL on every later turn. A readable
// payload would hand the model, and every later reader of that thread, the
// template id, the requesting user id, the org id and the live session id it
// never asked for and cannot otherwise see through a card. So the proposal is
// AES-256-GCM authenticated-encrypted under a key derived from the app secret,
// exactly as S1's lifecycle card refs are (`lifecycle-card-refetch.ts`) — the
// SAME family, the SAME secret, its OWN key-derivation label. GCM's tag gives
// the unforgeability an HMAC would, and the ciphertext gives the opacity a JWT
// cannot.
//
// It also has to FIT. S1 bounds a DATA_PART `ref` at 512 characters
// (`LIFECYCLE_VIEW_REF_MAX_LENGTH`) so a producer envelope stays strictly under
// the runtime's 2,000-character tool-result clip — a truncated envelope must be
// UNPARSEABLE rather than parseable-but-wrong. A JWT carrying this many claims
// does not fit in 512 characters; the encrypted compact form does, with room to
// spare, because it carries no header, no separate signature and no claim
// names. The bound is asserted at mint: a proposal that cannot be expressed
// inside it is REFUSED rather than truncated.
//
// THE TOKEN IS NOT A CAPABILITY. Decrypting one proves only that this server
// minted it. Confirm re-authorizes the reader from scratch — live session, live
// membership, live scope — and the DB consume edge decides whether this
// particular proposal has already been spent. A replayed token buys an attacker
// exactly one thing: a refusal.
//
// BINDINGS, all REQUIRED and all checked at verify:
//   - `sub` (userId)    — only the reader it was proposed to may confirm it.
//   - `org` (orgId)     — and only inside that organization.
//   - `tpl` (templateId)— the agent it proposes. A token minted for agent A can
//                         never arm agent B.
//   - `exp`             — bound AT VERIFY against the mint-time TTL, so a
//                         signed token with a stretched lifetime is still
//                         rejected.
//
// NO SESSION BINDING, deliberately — and the reason is worth stating because
// the sibling `connector-instance-pending-call-decision-token` DOES bind one.
// That token is minted by a server RENDER inside a live cookie session, so it
// can prove a session id and gains real containment from pinning it: a token
// lifted out of that page is useless on another device. THIS token is minted by
// an MCP producer running on a delegated on-behalf-of frame — a frame that
// carries a verified user and org and NO browser session — so a session claim
// would have to be either absent or invented, and an invented binding is worse
// than none. What the binding would have bought is bought elsewhere anyway:
// Confirm runs from a live cookie session and re-derives the user and org from
// it, so a token lifted from a transcript is useless to anyone who cannot
// already authenticate AS that user in that org — and anyone who can could
// simply ask for a fresh proposal. The residual is a same-user replay inside
// the TTL, which the single-use consume edge already reduces to one run.
//
// The module MATCHES the `src/lib/**/*token*.ts` high-risk glob DELIBERATELY:
// it IS a new signed-token surface, so it keeps the honest `*-token.ts` name
// and ships human-gated. Naming it around the glob would be exactly the evasion
// class the gate-suite audit record closed (cinatra#1856, #2493).
//
// No store, no invoker, no DB import — node builtins + `server-only` only.
// ---------------------------------------------------------------------------

/**
 * The proposed schedule, in the SELECTION vocabulary §VI fixes. Structurally
 * identical to the protocol's `ProposedSchedule`; re-declared here because this
 * module is dependency-free by contract (see the header) and pinned to it by a
 * drift test.
 */
export type ProposalSchedule =
  | { kind: "immediate" }
  | { kind: "scheduled"; runAt: string; timezone: string }
  | {
      kind: "recurring";
      timezone: string;
      selection: {
        frequency: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
        interval: number;
        weekdays: number[];
        dayOfMonth: number;
        monthlyMode: "date" | "weekday";
        nthWeek: 1 | 2 | 3 | 4;
        monthlyWeekday: number;
        quarterAnchor: "start" | "end";
        yearlyMonth: number;
        hour: number;
        minute: number;
      };
    };

/** Everything a proposal binds. Self-contained: nothing else is stored. */
export type TriggerScheduleProposal = {
  templateId: string;
  userId: string;
  orgId: string;
  schedule: ProposalSchedule;
  /** Per-mint nonce. Its HASH is the DB consume edge's unique key. */
  nonce: string;
  /** Absolute expiry, epoch seconds. */
  expiresAt: number;
};

export type TriggerScheduleProposalMintInput = Omit<
  TriggerScheduleProposal,
  "nonce" | "expiresAt"
>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TTL, seconds. A proposal is a question asked in a conversation; 30 minutes
 * comfortably covers reading the rows, adjusting, and pressing Confirm, while
 * bounding how long a lifted transcript stays interesting. An expired proposal
 * is not an error state — the card says so and Adjust re-proposes for free.
 */
export const PROPOSAL_TTL_SECONDS = 1800;

/** Key-derivation label. Changing it retires every outstanding proposal. */
const PROPOSAL_KEY_INFO = "cinatra:trigger-schedule-proposal:v1";

/**
 * Version byte inside the plaintext. Distinct from the key label: a bump here
 * REJECTS old tokens under the same key (fail-closed), where a label change
 * makes them undecryptable. Both are one-way; this one is the cheap one.
 */
const PROPOSAL_VERSION = 1;

/** Mirrors `LIFECYCLE_VIEW_REF_MAX_LENGTH` — a ref longer than this is dropped
 *  downstream, so a proposal that does not fit must refuse at mint. */
export const PROPOSAL_REF_MAX_LENGTH = 512;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const NONCE_BYTES = 16;
const ID_FIELD_MAX = 128;
const TIMEZONE_MAX = 64;

// ---------------------------------------------------------------------------
// Key + codec
// ---------------------------------------------------------------------------

function proposalKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(PROPOSAL_KEY_INFO).digest();
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= ID_FIELD_MAX
  );
}

function isInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Is this a REAL wall clock, not merely a well-shaped one?
 *
 * The regex alone accepts `2026-99-99T99:99`, which is not a date. That matters
 * beyond tidiness: the model supplies this string, so a shape-only check lets
 * the assistant mint a card a person can press Confirm on for a moment that
 * cannot exist — the failure then surfaces at INSTALL time, after the run has
 * been created, as a parked intent rather than as "I misread you, say it
 * again". Round-tripping through `Date` rejects it at PROPOSE time instead.
 */
function isRealWallClock(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return false;
  const padded = value.length === 16 ? `${value}:00` : value;
  const ms = Date.parse(`${padded}Z`);
  if (Number.isNaN(ms)) return false;
  // `Date` normalises out-of-range components rather than rejecting them
  // (month 13 rolls into the next year), so a round-trip comparison is what
  // actually rejects them.
  return new Date(ms).toISOString().slice(0, 19) === padded;
}

/**
 * Is this an IANA zone this runtime can actually resolve?
 *
 * Same reasoning: an unknown zone is accepted by every string check and only
 * fails when something tries to compute an instant in it. `Intl` is the
 * authority the trigger service itself uses, so asking it here means the
 * proposal and the install agree about which zones exist.
 */
function isUsableTimezone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > TIMEZONE_MAX) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an untrusted schedule shape. Returns the schedule or `null`.
 *
 * Every bound is one the scheduling step's own controls impose, so a proposal
 * can never express a schedule the reader could not have built themselves —
 * which is what makes pressing Confirm on it an honest act rather than a
 * signature on something the form would have refused.
 */
export function readProposalSchedule(value: unknown): ProposalSchedule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "immediate") {
    return Object.keys(raw).length === 1 ? { kind: "immediate" } : null;
  }
  if (raw.kind === "scheduled") {
    const { runAt, timezone } = raw;
    if (!isRealWallClock(runAt)) return null;
    if (!isUsableTimezone(timezone)) return null;
    return { kind: "scheduled", runAt, timezone };
  }
  if (raw.kind === "recurring") {
    const { timezone, selection } = raw;
    if (!isUsableTimezone(timezone)) return null;
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
      return null;
    }
    const s = selection as Record<string, unknown>;
    const frequency = s.frequency;
    if (
      frequency !== "daily" &&
      frequency !== "weekly" &&
      frequency !== "monthly" &&
      frequency !== "quarterly" &&
      frequency !== "yearly"
    ) {
      return null;
    }
    if (!isInt(s.interval, 1, 52)) return null;
    if (!isInt(s.dayOfMonth, 1, 31)) return null;
    if (!isInt(s.nthWeek, 1, 4)) return null;
    if (!isInt(s.monthlyWeekday, 0, 6)) return null;
    if (!isInt(s.yearlyMonth, 1, 12)) return null;
    if (!isInt(s.hour, 0, 23)) return null;
    if (!isInt(s.minute, 0, 59)) return null;
    if (s.monthlyMode !== "date" && s.monthlyMode !== "weekday") return null;
    if (s.quarterAnchor !== "start" && s.quarterAnchor !== "end") return null;
    if (!Array.isArray(s.weekdays)) return null;
    const weekdays: number[] = [];
    for (const day of s.weekdays) {
      if (!isInt(day, 0, 6)) return null;
      if (weekdays.includes(day)) return null;
      weekdays.push(day);
    }
    if (frequency === "weekly" && weekdays.length === 0) return null;
    return {
      kind: "recurring",
      timezone,
      selection: {
        frequency,
        interval: s.interval,
        weekdays: weekdays.sort((a, b) => a - b),
        dayOfMonth: s.dayOfMonth,
        monthlyMode: s.monthlyMode,
        nthWeek: s.nthWeek as 1 | 2 | 3 | 4,
        monthlyWeekday: s.monthlyWeekday,
        quarterAnchor: s.quarterAnchor,
        yearlyMonth: s.yearlyMonth,
        hour: s.hour,
        minute: s.minute,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The COMPACT wire encoding
// ---------------------------------------------------------------------------
//
// The whole proposal has to fit in a 512-character ref (S1's
// `LIFECYCLE_VIEW_REF_MAX_LENGTH`, which exists so a producer envelope stays
// strictly under the runtime's 2,000-character tool-result clip). Encrypted
// bytes are ~4/3 their plaintext size in base64url, so every plaintext byte
// costs about 1.33 characters of the budget — and a readable JSON object
// carrying eleven named recurrence fields spends roughly 230 of those bytes on
// KEY NAMES alone, which is enough on its own to overflow the budget for a
// perfectly ordinary "every weekday at 9" proposal.
//
// So the plaintext is POSITIONAL: a fixed-length array whose slots are the
// claims, and a fixed-length tuple whose slots are the schedule. Nothing is
// lost — the payload is already opaque, so field names were never serving a
// reader — and an ordinary recurring proposal lands around 300 characters with
// room for long organization ids and the longest IANA zone names.
//
// STRICT ON THE WAY BACK IN. `decodeSchedule` rebuilds the named shape and then
// hands it to `readProposalSchedule`, so a tampered or forward-version tuple
// faces exactly the same bounds a fresh proposal does. The compaction is a
// transport detail; the validation is not.

const FREQUENCIES = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

/** Weekdays as a 7-bit mask (bit 0 = Sunday). Order-free and 1–3 characters. */
function weekdaysToMask(days: number[]): number {
  return days.reduce((mask, day) => mask | (1 << day), 0);
}

function maskToWeekdays(mask: number): number[] {
  const days: number[] = [];
  for (let day = 0; day <= 6; day += 1) if (mask & (1 << day)) days.push(day);
  return days;
}

type EncodedSchedule = (string | number)[];

function encodeSchedule(schedule: ProposalSchedule): EncodedSchedule {
  if (schedule.kind === "immediate") return [0];
  if (schedule.kind === "scheduled") return [1, schedule.runAt, schedule.timezone];
  const s = schedule.selection;
  return [
    2,
    schedule.timezone,
    FREQUENCIES.indexOf(s.frequency),
    s.interval,
    weekdaysToMask(s.weekdays),
    s.dayOfMonth,
    s.monthlyMode === "weekday" ? 1 : 0,
    s.nthWeek,
    s.monthlyWeekday,
    s.quarterAnchor === "end" ? 1 : 0,
    s.yearlyMonth,
    s.hour,
    s.minute,
  ];
}

function decodeSchedule(value: unknown): ProposalSchedule | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const [kind] = value;
  if (kind === 0) {
    return value.length === 1 ? readProposalSchedule({ kind: "immediate" }) : null;
  }
  if (kind === 1) {
    if (value.length !== 3) return null;
    return readProposalSchedule({
      kind: "scheduled",
      runAt: value[1],
      timezone: value[2],
    });
  }
  if (kind === 2) {
    if (value.length !== 13) return null;
    const frequency = FREQUENCIES[value[2] as number];
    if (!frequency) return null;
    const mask = value[4];
    if (typeof mask !== "number" || !Number.isInteger(mask) || mask < 0 || mask > 127) {
      return null;
    }
    return readProposalSchedule({
      kind: "recurring",
      timezone: value[1],
      selection: {
        frequency,
        interval: value[3],
        weekdays: maskToWeekdays(mask),
        dayOfMonth: value[5],
        monthlyMode: value[6] === 1 ? "weekday" : "date",
        nthWeek: value[7],
        monthlyWeekday: value[8],
        quarterAnchor: value[9] === 1 ? "end" : "start",
        yearlyMonth: value[10],
        hour: value[11],
        minute: value[12],
      },
    });
  }
  return null;
}

/**
 * Mint a proposal token. Returns the token and the CONSUME KEY the Confirm path
 * spends — the caller never has to re-derive it, and the token stays the only
 * thing that travels.
 *
 * `null` on any refusal: a missing secret, an id outside its bound, a schedule
 * the form could not have produced, or a token that would exceed the ref bound.
 * A producer that cannot mint REFUSES; it never emits a proposal the wire would
 * silently mutilate.
 */
export function mintTriggerScheduleProposalToken(
  input: TriggerScheduleProposalMintInput,
  opts?: { nowSeconds?: number },
): { token: string; consumeKey: string; expiresAt: number } | null {
  const { templateId, userId, orgId } = input;
  if (!isBoundedId(templateId)) return null;
  if (!isBoundedId(userId)) return null;
  if (!isBoundedId(orgId)) return null;
  const schedule = readProposalSchedule(input.schedule);
  if (!schedule) return null;

  const key = proposalKey();
  if (!key) return null;

  const now = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const expiresAt = now + PROPOSAL_TTL_SECONDS;

  const plaintext = JSON.stringify([
    PROPOSAL_VERSION,
    templateId,
    userId,
    orgId,
    encodeSchedule(schedule),
    nonce,
    now,
    expiresAt,
  ]);

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const token = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    if (token.length > PROPOSAL_REF_MAX_LENGTH) return null;
    return { token, consumeKey: proposalConsumeKey(nonce), expiresAt };
  } catch {
    return null;
  }
}

/**
 * What a proposal token READS as, for one reader.
 *
 * `live` is the only reading Confirm may act on. `expired` is a reading the
 * CARD needs and Confirm does not: an expired proposal is not an error state —
 * it stays on screen saying so, and Adjust re-proposes it for free — so the
 * resolver has to be able to tell "yours, and the window closed" from "not
 * yours", which `verifyTriggerScheduleProposalToken` deliberately cannot.
 */
export type ProposalTokenReading = {
  status: "live" | "expired";
  proposal: TriggerScheduleProposal;
};

/**
 * Read a proposal token AGAINST a reader: the authenticated proposal and
 * whether its window is still open, or `null`.
 *
 * ENTITLEMENT IS DECIDED BEFORE EXPIRY, and that order is the whole security
 * argument. Every structural, cryptographic and BINDING check runs first, so a
 * token that is tampered, foreign, forged, wrongly-versioned, future-dated or
 * lifetime-stretched answers one indistinguishable `null` whether or not it has
 * also expired. Only a token this exact reader was minted — one that decrypted
 * under our key and names them in this org — can reach the expiry test, so
 * `expired` is a fact about the reader's OWN proposal and never an oracle about
 * anyone else's. That is the constraint §VI's expired card is built on: the
 * refusal for an unauthorized token is unchanged, down to which branch it
 * takes.
 *
 * Passing this is NOT authorization, exactly as verifying is not: it says
 * nothing about whether the reader may still dispatch that agent, and nothing
 * about whether the proposal has already been spent.
 */
export function readTriggerScheduleProposalToken(input: {
  token: string | null | undefined;
  expectedUserId: string;
  expectedOrgId: string;
  nowSeconds?: number;
}): ProposalTokenReading | null {
  try {
    const { token, expectedUserId, expectedOrgId } = input;
    if (typeof token !== "string" || token.length === 0) return null;
    if (token.length > PROPOSAL_REF_MAX_LENGTH) return null;
    // base64url alphabet only — a lenient decode would accept non-canonical
    // re-encodings of the same bytes.
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

    const key = proposalKey();
    if (!key) return null;

    const raw = Buffer.from(token, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 8) return null;
    const [version, templateId, userId, orgId, encoded, nonce, iat, exp] = parsed;
    if (version !== PROPOSAL_VERSION) return null;
    if (!isBoundedId(templateId)) return null;
    if (!isBoundedId(userId)) return null;
    if (!isBoundedId(orgId)) return null;
    if (!isBoundedId(nonce)) return null;
    if (typeof iat !== "number" || !Number.isInteger(iat)) return null;
    if (typeof exp !== "number" || !Number.isInteger(exp)) return null;
    const schedule = decodeSchedule(encoded);
    if (!schedule) return null;

    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    // Never accept a future-dated proposal — the minter never emits one.
    if (iat > now) return null;
    // Bind the TTL AT VERIFY rather than trusting the stamped expiry: a token
    // whose lifetime is not exactly the proposal TTL is rejected even under a
    // valid tag. This never rejects a legitimately-minted proposal.
    if (exp - iat !== PROPOSAL_TTL_SECONDS) return null;

    // BINDINGS — this proposal must have been minted for exactly this reader,
    // in this org. BEFORE the expiry read, so an expired token belonging to
    // someone else refuses exactly as an unexpired one does.
    if (userId !== expectedUserId) return null;
    if (orgId !== expectedOrgId) return null;

    // Expired AT or after `exp` (RFC 7519: current time MUST be BEFORE exp).
    const status = exp <= now ? "expired" : "live";
    return {
      status,
      proposal: { templateId, userId, orgId, schedule, nonce, expiresAt: exp },
    };
  } catch {
    // Wrong key, tampered bytes, non-JSON plaintext — all "not one of ours".
    return null;
  }
}

/**
 * Verify a proposal token and BIND it to the reader confirming it.
 *
 * Returns the proposal, or `null` on ANY failure — a tampered or foreign token,
 * a wrong key, a forward version, an expired proposal, a stretched lifetime, or
 * a binding that does not match the caller. Fail-closed and NEVER throws: every
 * refusal is one indistinguishable `null`, so a caller cannot use this function
 * to tell "expired" from "not yours" from "never existed".
 *
 * Still the ONLY reading Confirm and the producer are allowed: collapsing the
 * expired reading back into `null` here is what keeps the new state a CARD
 * affordance rather than a second, softer path to arming a schedule.
 *
 * Passing this is NOT authorization. It proves the server minted this proposal
 * for this reader in this org; it says nothing about whether the reader may
 * still dispatch that agent, and nothing about whether the proposal has already
 * been spent. Confirm re-checks both.
 */
export function verifyTriggerScheduleProposalToken(input: {
  token: string | null | undefined;
  expectedUserId: string;
  expectedOrgId: string;
  nowSeconds?: number;
}): TriggerScheduleProposal | null {
  const reading = readTriggerScheduleProposalToken(input);
  return reading?.status === "live" ? reading.proposal : null;
}

/**
 * The CONSUME KEY for a proposal — the unique identity the DB consume edge
 * spends. A SHA-256 of the per-mint nonce, so the durable table never holds the
 * nonce itself: a dump of the consume ledger reveals which proposals were
 * confirmed, never a token anyone could replay.
 *
 * Derived from the NONCE and not from the whole token, deliberately: the token
 * is a fresh ciphertext under a fresh IV every mint, so hashing it would make
 * every re-encryption of the same proposal a different identity and single-use
 * would guard nothing. The nonce is the proposal's identity; the ciphertext is
 * merely its envelope.
 */
export function proposalConsumeKey(nonce: string): string {
  return createHash("sha256").update(`${PROPOSAL_KEY_INFO}|${nonce}`).digest("hex");
}
