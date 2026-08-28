// ---------------------------------------------------------------------------
// The LENT-ACTION GRANT (cinatra#2932, lifecycle-b W5a).
//
// A card reference addresses a row and grants nothing — that is the whole
// doctrine of `lifecycle-card-ref.ts`, and it stays true. This module is the
// OTHER half the plan asks for: the authority that lets the assistant press one
// button of one card, once, on behalf of one person, for one message.
//
// From the plan (PLAN: Agents Lifecycle (B), §4):
//
//   "It can be used only with a grant the server mints when a message is sent
//    with a bound card: signed, single-use, naming the person, the message, the
//    card and the one control it allows, and consumed the moment the tool is
//    called. A card reference by itself grants nothing, and a tool being visible
//    to the model is not permission to use it."
//
// FIVE CLAIMS, ALL OF THEM LOAD-BEARING:
//
//   person   — the grant is minted for the human who typed, and the caller
//              presenting it must BE that human on the request frame.
//   message  — one message, one grant. "The action fires at most once per
//              message" is this claim plus the single-use consume together.
//   card     — the fingerprint of the bound card's ref. A grant minted for one
//              card cannot operate another, and the fingerprint (not the ref)
//              keeps the grant short and stops it from becoming a second,
//              reversible carrier of the ref's contents.
//   control  — the buttons THIS MESSAGE may press: the card's own controls,
//              narrowed on the send path to the ones the person's own words
//              named (cinatra#2853, `typed-decision-words.ts`). "A card that
//              offers no decision lends none" is enforced at mint (no control,
//              no grant); "a grant presented with another control is refused" is
//              enforced at the match, against that menu. Exactly ONE of them is
//              ever pressed, because the ledger spends the grant once.
//   life     — a short expiry, because a grant that outlives its turn is a
//              standing permission and this is deliberately not one.
//
// IT IS NOT THE ACTOR TOKEN. `issueChatMcpActorToken` mints a per-turn
// credential that says WHO is calling; it carries no message and no card, so it
// cannot say WHAT this turn may press. The plan names that difference
// explicitly. The grant rides beside the actor token, never instead of it: both
// must be present and must agree about the person.
//
// AUTHENTICATED-ENCRYPTED, LIKE THE REF, AND FOR A SHARPER REASON. A grant is
// handed to a provider's hosted MCP relay and comes back on a request header.
// AES-256-GCM under a key derived from the app secret makes it unforgeable and
// unreadable; a rotated secret retires every outstanding grant, which is the
// correct behaviour for a ten-minute authority.
//
// THIS MODULE MINTS AND VERIFIES. It does NOT consume: single use is a fact
// about the world, not about a string, so it lives in the store beside the row
// that records it (`lent-action-grant-store.ts`).
// ---------------------------------------------------------------------------

import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

/**
 * The closed vocabulary of controls a card can lend.
 *
 * These are the card's OWN buttons and nothing else — the plan's "its choices
 * are exactly what the card's own buttons offer". A control that no card draws
 * is not in this union, so a grant cannot name one.
 *
 * `fill` is deliberately ABSENT HERE, and stays absent (cinatra#2934,
 * lifecycle-b W5c). Filling a form presses nothing: it places values in the
 * fields in front of the person and the person still presses the button. It is
 * therefore not an authority a grant can SPEND, and putting it in this list
 * would also make "fill, then submit when asked" impossible in a single message
 * — a spend consumes the grant, and the plan requires both halves of that
 * sentence to work in one message. The fill road reads the turn's grant to know
 * the screen was bound (`matchLentActionGrantCard` below) and never spends it.
 */
export const LENT_ACTION_CONTROLS = [
  "comment",
  "approve",
  "reject",
  "submit",
  // The SKILLS card's own two buttons and the SCHEDULE card's (cinatra#2853).
  // Each is a button the card already draws — "no card gains an action its
  // controls do not already have" — and each is added together with the arm that
  // presses it through that card's own server-side entry.
  //
  // `adjust` IS pressable and decides NOTHING: the schedule card's Adjust
  // re-proposes, writing nothing and arming nothing, so it is this card's own
  // equivalent of a fill. It is in this list rather than beside `fill` because
  // it does run through the card's decision entry and must therefore be
  // spendable; what keeps it harmless is the op it runs, not the list it is in.
  "confirm",
  "skip",
  "adjust",
] as const;

export type LentActionControl = (typeof LENT_ACTION_CONTROLS)[number];

export function isLentActionControl(value: unknown): value is LentActionControl {
  return (
    typeof value === "string" &&
    (LENT_ACTION_CONTROLS as readonly string[]).includes(value)
  );
}

/**
 * The vocabulary a GRANT may name — the pressable controls above, and `fill`.
 *
 * WHY THE TWO LISTS DIFFER, and why that is the safety property rather than a
 * loophole (cinatra#2934, repaired after the picture leg). A grant answers one
 * question for the fill road: "was this message sent with that card bound?" The
 * SCHEDULER FORM is bound to the schedule screen's window and lends NO press at
 * all — "the person presses the form's own button" — so its grant has no
 * pressable control to name, and naming one it does not lend would be a lie in
 * the ledger that a future reader could act on.
 *
 * A `fill` GRANT CAN NEVER PRESS ANYTHING, and that is enforced THREE times over,
 * each independently sufficient:
 *
 *   1. `lifecycle_bound_card_decide` accepts only `LENT_ACTION_CONTROLS` in its
 *      own input schema, so a call can never even name `fill`;
 *   2. `matchLentActionGrant` below refuses outright when the CLAIM is not a
 *      pressable control, and refuses a CALL naming one that is not on the
 *      grant's menu;
 *   3. `controlsLentBy` gives the scheduler form `["fill"]`, and the lent
 *      action's own gate 5 refuses a control the card does not lend.
 *
 * A FOURTH ONE USED TO BE LISTED HERE AND IS GONE (cinatra#2853, convergence
 * round 2, finding 6): the ledger's spend predicate named the control, so a row
 * minted `fill` matched no spend. The row now names the grant's ANCHOR, which
 * for a fill grant IS `fill` — so that statement would match, and the three
 * checks above are what actually hold. Restoring it means recording the menu
 * beside the row, which is a schema change.
 */
export const LENT_ACTION_GRANT_CONTROLS = [
  ...LENT_ACTION_CONTROLS,
  "fill",
] as const;

export type LentActionGrantControl = (typeof LENT_ACTION_GRANT_CONTROLS)[number];

export function isLentActionGrantControl(
  value: unknown,
): value is LentActionGrantControl {
  return (
    typeof value === "string" &&
    (LENT_ACTION_GRANT_CONTROLS as readonly string[]).includes(value)
  );
}

/** What a grant says. Every field is a claim the verifier re-checks. */
export type LentActionGrantClaims = {
  /** The grant's own identity — the single-use ledger key. */
  readonly jti: string;
  /** The person who typed. */
  readonly userId: string;
  /** The organization the message was typed in. */
  readonly orgId: string;
  /** The message the grant was minted for. */
  readonly messageId: string;
  /** The fingerprint of the bound card's ref. */
  readonly cardRefFingerprint: string;
  /**
   * The grant's ANCHOR control — the first of `controls`, and the one the
   * single-use ledger row records.
   *
   * WHY AN ANCHOR AND A MENU (cinatra#2853). W5a's grant named exactly one
   * control because a send could only ever mint one: which button a sentence
   * asks for is a reading of the person's words, and reading them was #2853's
   * work. Now that the send narrows the card's own buttons by the person's own
   * words, a message can legitimately reach more than one of them — "approve it"
   * may land as the approve the person asked for, or as the comment their words
   * always are — and the ASSISTANT picks between them, which is the plan's "the
   * assistant interprets the words".
   *
   * WHAT IS UNCHANGED: exactly ONE control is ever pressed, once. The menu is
   * what MAY be pressed; the ledger's single atomic spend is what makes it one.
   */
  readonly control: LentActionGrantControl;
  /**
   * The controls THIS MESSAGE may press — the card's own buttons, narrowed to
   * the ones the person's own words named (`typed-decision-words.ts`).
   *
   * NON-EMPTY, and `control` is always its first entry. A grant minted before
   * this slice carries no menu on the wire and reads back as `[control]`, so an
   * in-flight grant behaves exactly as it did.
   */
  readonly controls: readonly LentActionGrantControl[];
  /** Expiry, epoch seconds. */
  readonly expiresAt: number;
};

/** What a caller asks for. The mint derives `jti`, the fingerprint and the life. */
export type MintLentActionGrantInput = {
  readonly userId: string;
  readonly orgId: string;
  readonly messageId: string;
  readonly cardRef: string;
  readonly control: LentActionGrantControl;
  /**
   * The menu (cinatra#2853). Omitted means `[control]` — the W5a shape, which
   * every caller that mints for a single-button card keeps.
   */
  readonly controls?: readonly LentActionGrantControl[];
  /** Injectable clock — tests never wall-clock an expiry. */
  readonly now?: () => Date;
};

/**
 * How long a grant lives — TWO MINUTES, the same containment the widget's own
 * on-behalf-of token uses, and for the same reason.
 *
 * IT IS A BEARER AUTHORITY FOR ITS LIFE, and this comment says so plainly
 * because an earlier draft did not (convergence round 1, finding 3). What the grant
 * pins is WHO may spend it (the frame's own identity must equal the grant's
 * person and organization), WHAT it may press (one card, and one control off the
 * MENU the person's own words produced — cinatra#2853) and HOW OFTEN (once, by
 * an atomic ledger spend). What it does NOT pin is which TURN
 * of that person spends it: the delegated frame carries no turn identity the
 * handler could match the `messageId` claim against, so a party who already
 * holds a valid delegated token for the SAME person and organization — i.e. who
 * can already act as them across the whole delegated surface — could present a
 * captured, unspent grant on a different turn of theirs within its life.
 *
 * THAT IS AN ESCALATION, and calling it anything else would be wrong
 * (convergence round 2): the delegated token ALONE cannot press a card's
 * control, so a
 * captured grant adds authority its holder did not have. What bounds it is the
 * two-minute life, the single use, and that the added authority is one control
 * of one card the person themselves had bound. It is a disclosed residual of the
 * bearer design, not a property that makes the design safe. Sealing the grant to its turn needs a turn
 * claim on the chat actor token, which does not exist today and is its own
 * change; `messageId` remains the MINT-TIME uniqueness key (one grant per
 * message, enforced by the ledger's own uniqueness constraint), and is
 * deliberately not described as a call-time check anywhere.
 */
export const LENT_ACTION_GRANT_TTL_SECONDS = 120;

/** Bounds — a grant travels on an HTTP header, so it must stay small. */
const FIELD_MAX = 128;
const GRANT_MAX = 512;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Key-derivation label. Disjoint from every ref family by construction. */
const GRANT_KEY_INFO = "cinatra:lifecycle-lent-action-grant:v1";

function grantKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(GRANT_KEY_INFO).digest();
}

/**
 * The card ref's fingerprint.
 *
 * A DIGEST, NOT THE REF. The grant is compared against the ref the tool call
 * names, so a digest answers the only question the grant has to answer — "is
 * this the same card?" — without carrying a second copy of an opaque payload
 * that already persists in a transcript. Keyed with the same app secret, so a
 * fingerprint computed outside the app cannot be matched against one inside it.
 */
export function lentActionCardFingerprint(cardRef: string): string | null {
  if (typeof cardRef !== "string" || cardRef.length === 0) return null;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update("cinatra:lent-action-card:v1")
    .update(cardRef)
    .digest("base64url")
    .slice(0, 43);
}

function isBounded(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= FIELD_MAX;
}

/**
 * Mint a grant.
 *
 * Returns `null` — never a partial grant — when the app secret is unavailable,
 * an id does not fit the bounds, the control is not one a card lends, or the
 * encoded grant would exceed the header bound. A send that cannot express its
 * grant lends nothing, which is the correct fail-closed outcome: the assistant
 * simply has no authority that turn and says so when asked to act.
 */
export function mintLentActionGrant(
  input: MintLentActionGrantInput,
): { grant: string; claims: LentActionGrantClaims } | null {
  const { userId, orgId, messageId, cardRef, control } = input;
  if (!isBounded(userId) || !isBounded(orgId) || !isBounded(messageId)) return null;
  if (!isLentActionGrantControl(control)) return null;
  // THE MENU, AND ITS TWO INVARIANTS (cinatra#2853). It is never empty — a card
  // that lends nothing gets no grant at all — and its FIRST entry is the anchor,
  // because that anchor is what the ledger row records and what the spend
  // predicates on. A caller that disagrees with itself about which control is
  // the anchor mints nothing rather than a row the spend could never match.
  const controls: readonly LentActionGrantControl[] = input.controls ?? [control];
  if (controls.length === 0 || controls.length > LENT_ACTION_GRANT_CONTROLS.length) return null;
  if (!controls.every((c) => isLentActionGrantControl(c))) return null;
  if (controls[0] !== control) return null;
  if (new Set(controls).size !== controls.length) return null;
  const cardRefFingerprint = lentActionCardFingerprint(cardRef);
  if (!cardRefFingerprint) return null;
  const key = grantKey();
  if (!key) return null;
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const claims: LentActionGrantClaims = {
    jti: randomUUID(),
    userId,
    orgId,
    messageId,
    cardRefFingerprint,
    control,
    controls,
    expiresAt: Math.floor(nowMs / 1000) + LENT_ACTION_GRANT_TTL_SECONDS,
  };
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(
        JSON.stringify({
          j: claims.jti,
          u: claims.userId,
          o: claims.orgId,
          m: claims.messageId,
          r: claims.cardRefFingerprint,
          c: claims.control,
          // ON THE WIRE ONLY WHEN IT SAYS SOMETHING. A single-control menu is
          // the anchor repeated, so it is left off — which keeps every grant
          // this product minted before #2853 byte-identical.
          ...(claims.controls.length > 1 ? { cs: claims.controls } : {}),
          e: claims.expiresAt,
        }),
        "utf8",
      ),
      cipher.final(),
    ]);
    const grant = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    if (grant.length > GRANT_MAX) return null;
    return { grant, claims };
  } catch {
    return null;
  }
}

/**
 * Verify a grant's SIGNATURE, SHAPE and LIFE.
 *
 * `null` for everything that is not one of ours and for one that has expired —
 * a forged grant, a grant minted under a rotated secret and an expired grant are
 * one observable, because distinguishing them would tell a prober which of their
 * strings was nearly right.
 *
 * It does NOT check the person, the message, the card or the control: those are
 * a comparison against the CALL, which only the caller holds. See
 * `matchLentActionGrant`.
 */
export function verifyLentActionGrant(
  grant: string,
  opts: { now?: () => Date } = {},
): LentActionGrantClaims | null {
  if (typeof grant !== "string" || grant.length === 0 || grant.length > GRANT_MAX) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(grant)) return null;
  const key = grantKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(grant, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { j, u, o, m, r, c, cs, e } = parsed as Record<string, unknown>;
    if (!isBounded(j) || !isBounded(u) || !isBounded(o) || !isBounded(m)) return null;
    if (!isBounded(r) || !isLentActionGrantControl(c)) return null;
    if (typeof e !== "number" || !Number.isFinite(e)) return null;
    // THE MENU, RE-CHECKED AS A CLAIM (cinatra#2853). A grant with no `cs` is a
    // W5a grant and reads back as its one control; a `cs` that is not a
    // non-empty, duplicate-free list of real controls anchored on `c` is not one
    // of ours, and is refused exactly like a bad signature.
    let controls: readonly LentActionGrantControl[];
    if (cs === undefined) {
      controls = [c];
    } else {
      if (!Array.isArray(cs) || cs.length === 0) return null;
      if (cs.length > LENT_ACTION_GRANT_CONTROLS.length) return null;
      if (!cs.every((x) => isLentActionGrantControl(x))) return null;
      if (cs[0] !== c) return null;
      if (new Set(cs as string[]).size !== cs.length) return null;
      controls = cs as readonly LentActionGrantControl[];
    }
    const nowSec = Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000);
    if (nowSec >= e) return null;
    return {
      jti: j,
      userId: u,
      orgId: o,
      messageId: m,
      cardRefFingerprint: r,
      control: c,
      controls,
      expiresAt: e,
    };
  } catch {
    return null;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Does a verified grant authorize THIS call?
 *
 * The four claims are compared against the four facts of the call: the frame's
 * person and organization, the ref the tool names, and the control the tool was
 * asked to press. Any disagreement is `false` — there is one answer for "not
 * yours", "not this card" and "not this button", because a caller learning WHICH
 * claim failed learns something about a grant they do not hold.
 *
 * THE MESSAGE CLAIM IS NOT COMPARED HERE, and that is stated rather than implied
 * (convergence round 1, finding 3): a delegated frame carries no turn identity to
 * compare it against. It is the mint-time uniqueness key — see the TTL note
 * above for exactly what the grant does and does not pin.
 *
 * The card comparison is against the fingerprint of the ref the CALL names, so a
 * grant can only ever operate the card it was minted for, whatever ref string
 * the model produces.
 */
export function matchLentActionGrant(
  claims: LentActionGrantClaims,
  call: {
    readonly userId: string;
    readonly orgId: string;
    readonly cardRef: string;
    readonly control: string;
  },
): boolean {
  if (!isBounded(call.userId) || !isBounded(call.orgId)) return false;
  // A GRANT THAT NAMES NO PRESSABLE CONTROL AUTHORIZES NO PRESS, said here
  // rather than left to the string comparison below (cinatra#2934). A `fill`
  // grant is minted for a card whose button is the person's; it must not become
  // a press because some future caller passed `control: "fill"` through.
  //
  // WITH A MENU (cinatra#2853) the same rule is applied to the CALL: the control
  // the call names must be a pressable one AND must be on the menu this
  // message's own words produced. A menu that holds only `fill` therefore still
  // authorizes nothing, whatever the call names.
  if (!isLentActionControl(claims.control)) return false;
  if (!isLentActionControl(call.control)) return false;
  if (!constantTimeEquals(claims.userId, call.userId)) return false;
  if (!constantTimeEquals(claims.orgId, call.orgId)) return false;
  if (!claims.controls.includes(call.control as LentActionGrantControl)) return false;
  const fingerprint = lentActionCardFingerprint(call.cardRef);
  if (!fingerprint) return false;
  return constantTimeEquals(claims.cardRefFingerprint, fingerprint);
}

/**
 * Does this grant belong to this person and THIS CARD — ignoring the control?
 *
 * THE ONE CALLER IS THE FILL ROAD (cinatra#2934), and the narrowing is
 * deliberate rather than a convenience: a fill presses nothing, so the question
 * it has to answer is "was this message sent with that screen bound", not "may
 * this message press that button". It is a strictly WEAKER check than
 * `matchLentActionGrant` and it is never used to authorize an effect on a card:
 * the caller must not spend the grant, and the only thing it may do with a true
 * answer is place values on a screen the person is looking at.
 */
export function matchLentActionGrantCard(
  claims: LentActionGrantClaims,
  call: {
    readonly userId: string;
    readonly orgId: string;
    readonly cardRef: string;
  },
): boolean {
  if (!isBounded(call.userId) || !isBounded(call.orgId)) return false;
  if (!constantTimeEquals(claims.userId, call.userId)) return false;
  if (!constantTimeEquals(claims.orgId, call.orgId)) return false;
  const fingerprint = lentActionCardFingerprint(call.cardRef);
  if (!fingerprint) return false;
  return constantTimeEquals(claims.cardRefFingerprint, fingerprint);
}

/**
 * A stable digest of a grant string, for logs and audit rows.
 *
 * Never the grant itself: a grant is a bearer authority for its ten minutes, and
 * an audit row is read by more people than hold it.
 */
export function lentActionGrantDigest(grant: string): string {
  return createHash("sha256").update(grant).digest("base64url").slice(0, 16);
}
