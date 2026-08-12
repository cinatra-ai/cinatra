// ---------------------------------------------------------------------------
// The `cwu_` SCOPE + AUDIENCE vocabulary (cinatra#2574, epic #2564 S8a).
//
// cinatra#407 minted the per-user widget token with exactly one scope
// (`<agentSlug>.user`) and exactly one audience (the unified assistant chat
// route). Both were single values compared for EQUALITY at consume. That was
// sufficient while a widget session could only do one thing: take a chat turn.
//
// Reading LIFECYCLE work (a review gate, a verification record) is a second,
// materially different thing to grant — it exposes org work the site itself has
// no standing to see — so it needs its own grant, and a session that signed in
// before this grant existed must not silently acquire it.
//
// SIGNING IN IS THE GRANT (owner ruling, 2026-08-10). The hosted widget login
// has no separate consent step: a successful sign-in records the whole granted
// set on the authorization code and the flow returns to the site. There is no
// screen a grant can be "displayed on" independently of the login screen.
//
// Stated exactly, because the short version overstates it: a grant is acquired
// by a NEW authorization code, and codes come only from a run of the hosted
// flow. That flow shows a sign-in screen when there is no Cinatra session and
// uses the existing session when there is one, so "sign in again" describes the
// signed-out case, not a re-authentication the code enforces. What IS enforced
// is AC-1: an already-minted token never acquires a grant.
//
// THE VOCABULARY IS A SET, NOT A VALUE. Scope and audience are now
// space-delimited sets (RFC 6749 §3.3 for scope; the same encoding for `aud` so
// one parser serves both). The single-value rows minted before this slice parse
// as one-element sets, so they keep working at the chat route unchanged and
// carry NO lifecycle grant — which is precisely AC-1: consent that predates the
// extension cannot read lifecycle data until the user consents again.
//
// TWO INDEPENDENT GATES, BOTH FAIL-CLOSED. A lifecycle read requires the
// `lifecycle.read` SCOPE *and* the lifecycle route in the token's AUDIENCE. The
// mint only ever adds the audience alongside the scope, so the two can never
// disagree in a token this codebase produced — and a token altered so they do
// disagree is refused by whichever gate is missing.
//
// UNKNOWN TOKENS GRANT NOTHING. A scope or audience entry this build does not
// recognize is inert: it can never widen authority, and it never invalidates the
// entries around it. That keeps a rolling deploy honest in both directions — an
// older node serving a newer token refuses the grant it cannot evaluate instead
// of either honouring it blindly or killing the whole session.
// ---------------------------------------------------------------------------

import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";

/**
 * The lifecycle READ grant. Named for the capability, not the surface: the same
 * grant governs every widget lifecycle read (card refetch, pull primitive,
 * capture metadata), so a future read surface joins it rather than minting a
 * parallel scope nobody re-checks.
 */
export const WIDGET_LIFECYCLE_READ_SCOPE = "lifecycle.read";

/**
 * The audience a widget lifecycle READ is served at — S1's authoritative
 * refetch endpoint (`src/app/api/lifecycle-views/resolve/route.ts`). That route
 * is COOKIE-SESSION-ONLY today by S1's explicit decision; S8d (#2577) opens the
 * broker-authenticated branch. The audience is minted now so the token a user
 * consents to already carries the binding, and so the binding has exactly one
 * definition when S8d consumes it.
 */
export const WIDGET_LIFECYCLE_READ_ROUTE_PATH = "/api/lifecycle-views/resolve";

/**
 * The lifecycle DECIDE grant (cinatra#2575, epic #2564 S8b; corrected
 * 2026-08-11).
 *
 * WHAT IT IS. Deciding, from the widget, with the rights the person already has
 * in Cinatra. A signed-in widget reviewer presses Approve / Reject / Comment in
 * the SAME review card they would press inside the app, and the decision travels
 * the SAME core decision module with the SAME validation order, the same gate
 * CAS and the same fingerprint/audit contract.
 *
 * WHAT IT IS NOT. It is not a second decision path, and it is not permission the
 * SITE holds. The grant rides the person's own `cwu_`, minted by the hosted PKCE
 * sign-in against their Better-Auth session; every request is re-authorized
 * against their LIVE org standing, and the decision op is checked by the one
 * decision module, not by this scope. The scope's whole job is AC-1: a widget
 * session that signed in before deciding existed carries neither this scope nor
 * its audience, and fails closed at the endpoint.
 *
 * WHY IT IS SEPARATE FROM `lifecycle.read`. Reading shows you work waiting on
 * you; deciding changes org state. Those are different things to consent to, so
 * they are different grants — not because the widget is less trusted than the
 * app, but because consent is per capability everywhere.
 *
 * REMOVED IN THE CORRECTION: an earlier revision of this slice made this scope
 * mean "may ASK for a confirmation", routed decisions through a single-use
 * action capability and a hosted confirmation window, and told the person at
 * sign-in that every decision would prompt again. All of that rested on the
 * invented premise that the embedding site holds the user's token. It is gone.
 */
export const WIDGET_LIFECYCLE_DECIDE_SCOPE = "lifecycle.decide";

/**
 * Where a widget decision is submitted — the ONE gate-scoped decision entry the
 * first-party review card already posts to (`/api/lifecycle-views/decide`). The
 * widget does not get an endpoint of its own; it gets an auth BRANCH on the
 * endpoint that already exists, exactly as the refetch does.
 */
export const WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH = "/api/lifecycle-views/decide";

// ---------------------------------------------------------------------------
// The CONVERSATION grants (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// S8f made `/chat` and the widget render ONE conversation column. Six of its
// affordances still could not work on the widget, for one reason each time: they
// read or write through a COOKIE-bound path, and the embed frame is same-origin
// to the Cinatra app, so a cookie-borne request from it answers as whoever else
// is signed in on that browser. The column was right; the data paths were
// first-party-only.
//
// These three grants are what the widget session presents instead. They follow
// the lifecycle pair's shape exactly — a (route audience, required scope) pair,
// re-derived at consume, AC-1 by construction — and they are split the way the
// lifecycle pair is split, by WHAT THE PERSON IS CONSENTING TO rather than by
// which endpoint happens to serve it:
//
//   · `conversation.read`  — show me my own conversation and the things around
//     it: my earlier messages, who I can @-mention, the actions parked waiting
//     for my confirmation, and whether a run's changes can still be undone.
//   · `conversation.write` — let me attach files to it and change my own chat
//     settings from here.
//   · `tools.confirm`      — let me confirm or reject a parked destructive tool
//     call. Its OWN grant, and deliberately not folded into `conversation.write`:
//     attaching a file and executing a parked destructive action are not the
//     same thing to consent to, which is the same reason `lifecycle.decide` is
//     not part of `lifecycle.read`.
//
// EVERY ONE OF THEM CARRIES THE PERSON'S OWN STANDING AND NOTHING MORE. The
// server re-resolves the reader's live org role, teams and project grants (the
// S8a full actor) on every request and runs the SAME per-row authorization the
// in-app surface runs. The site holds no credential and gains no reach: a widget
// reader sees and does exactly what they see and do inside Cinatra.
//
// THE AUDIENCE IS PER ROUTE, THE SCOPE IS PER OPERATION. `/api/assistants/autosave`
// is declared by BOTH conversation grants because one route serves the read and
// the write; which of the two a request needs is decided by the METHOD at the
// branch, against `requiredScopes`. That is the same two-gate model the lifecycle
// pair uses, applied to a route that carries two operations.

/** Read the conversation's own surrounding data (history, participants, parked
 *  calls, undo candidate). Never a mutation. */
export const WIDGET_CONVERSATION_READ_SCOPE = "conversation.read";

/** Write the things the composer owns: an attachment, and the caller's own chat
 *  settings. Never another person's row, and never a tool execution. */
export const WIDGET_CONVERSATION_WRITE_SCOPE = "conversation.write";

/** Decide a parked destructive tool call — the highest-stakes thing in this
 *  column, so it is its own grant. */
export const WIDGET_TOOL_CONFIRM_SCOPE = "tools.confirm";

/**
 * The thread-read audience. The route is `/api/assistants/threads/[threadId]`;
 * the audience names the SURFACE (`/api/assistants/threads`) rather than one
 * rendered path, because a token cannot be minted per thread and an audience
 * that had to be is an audience nobody could check. The thread a caller may read
 * is decided by the per-row ownership matrix, never by this string.
 */
export const WIDGET_CHAT_THREADS_ROUTE_PATH = "/api/assistants/threads";

/** The @-mention participant list — the SAME directory reader `/chat` uses. */
export const WIDGET_CHAT_PARTICIPANTS_ROUTE_PATH = "/api/assistants/list";

/** The Skill-autosave account setting — one route, two operations (see above). */
export const WIDGET_CHAT_SETTINGS_ROUTE_PATH = "/api/assistants/autosave";

/** The attachment upload. The artifact it creates is owned by the WIDGET
 *  principal and private to them, exactly as an in-app upload is. */
export const WIDGET_CHAT_UPLOAD_ROUTE_PATH = "/api/artifacts/upload";

/**
 * The parked destructive tool calls — list AND decide, on one route with one
 * auth branch per credential, mirroring `/api/lifecycle-views/decide`. Declared
 * by `conversation.read` (the list) and by `tools.confirm` (the decision), so a
 * token holding only the read reaches the surface and is refused the operation.
 */
export const WIDGET_CHAT_PENDING_CALLS_ROUTE_PATH = "/api/chat/pending-tool-calls";

/** The undo chip's read — "did this run leave a change set I could still undo?".
 *  The UNDO ITSELF is not here: it happens on the first-party restore surface the
 *  chip deep-links to, under the reader's own session. */
export const WIDGET_CHAT_UNDO_ROUTE_PATH = "/api/chat/undo-candidate";

/**
 * The grammar of a single set member. Deliberately strict and whitespace-free:
 * the set encoding IS the whitespace, so a value carrying any is not one member
 * but several, and a member assembled from an attacker-influenced string could
 * otherwise smuggle a capability in beside itself (an agent slug of
 * `"x lifecycle.read y"` would mint a base scope whose SECOND member is the
 * lifecycle grant). Validated at the mint, which refuses rather than encodes.
 */
const SCOPE_ATOM_RE = /^[A-Za-z0-9._:/-]+$/;

export function isValidTokenSetAtom(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && SCOPE_ATOM_RE.test(value);
}

/**
 * The base scope every `cwu_` carries — cinatra#407's, unchanged in shape.
 * Returns null for an agent slug that cannot be expressed as ONE set member;
 * the caller refuses the mint rather than writing a scope column that says
 * something other than what it means.
 */
export function widgetUserBaseScope(agentSlug: string): string | null {
  // The SLUG is validated, not just the assembled atom: an empty slug would
  // assemble the perfectly well-formed `.user`, which is a scope belonging to no
  // agent and must never be minted.
  if (!isValidTokenSetAtom(agentSlug)) return null;
  const atom = `${agentSlug}.user`;
  return isValidTokenSetAtom(atom) ? atom : null;
}

/**
 * The value a transaction carries from the moment it is created until something
 * KNOWN is recorded about what was displayed for it — "nobody has said yet".
 *
 * cinatra#2631 (codex rework round 3, finding 1). It is not the same statement
 * as "no screen rendered", and conflating the two was the hole: at creation the
 * server cannot know what will render, so a sentinel meaning "no screen" written
 * at creation is a claim about the future. During a rolling deploy that claim is
 * simply false — a NEW node creates the transaction, an OLD node renders its
 * LEGACY signed-out page (recording nothing, naming none of the new grants), and
 * after the login a NEW node reads a sentinel it wrote itself and grants a set
 * the person never read. So creation writes THIS value, which asserts nothing,
 * and the two things that can be known are written later by whoever knows them:
 * a rendered screen writes its displayed set; a current node that can PROVE no
 * screen rendered writes a {@link widgetNoSignInScreenToken}.
 *
 * FAILS CLOSED at the grant, exactly like the legacy NULL: a transaction still
 * carrying it reached the grant without any current node accounting for what was
 * displayed, which is precisely the mixed-version case above.
 *
 * Deliberately NOT a well-formed set member (the parentheses are outside the
 * atom grammar), so it can never collide with a real displayed set.
 */
export const WIDGET_SIGNIN_SCREEN_UNCLASSIFIED = "(unclassified)";

/**
 * "No sign-in screen rendered for this transaction, and that is PROVEN, not
 * assumed" — written as `(no-screen:<session fingerprint>)`.
 *
 * cinatra#2631 (codex rework round 3, finding 1). Written at exactly ONE point:
 * a node running THIS build observes a session whose ROW WAS ALREADY IN THE
 * DATABASE when the transaction row was inserted (see
 * `sessionRowPredatesTransaction` in `@/lib/widget-user-auth`). That is the only
 * moment "no screen rendered" is a fact rather than a hope — the hosted flow
 * shows a sign-in screen only when there is no session, and signing in through
 * one MINTS the session it lands with, so a session older than the transaction
 * is one no screen of this flow produced, on this build or on any older node
 * still serving traffic. Written at creation instead (as it was), the value
 * silently absorbed the mixed-version window where an OLD node had rendered the
 * legacy screen in between.
 *
 * THE ORDERING IS THE DATABASE'S OWN (round 4, finding 1), never a clock: the
 * transaction row is stamped by Postgres while a session row's `createdAt` is
 * written by whichever NODE minted it — including an old node whose clock we do
 * not control, and whose lag would otherwise make a session minted after its
 * legacy screen look older than the transaction.
 *
 * IT NAMES THE SESSION IT PROVED (round 5, finding 1). "No screen rendered" is
 * not a property of the transaction, it is a property of ONE person's arrival at
 * it: a member holding a session can make a bare GET and stamp the sentinel
 * while the transaction stays unconsumed, and a DIFFERENT person could then be
 * sent through an older node's legacy sign-in screen for the same transaction
 * and redeem against a sentinel that says nothing about them. So the token
 * carries a fingerprint of the session that earned it, and the grant admits it
 * only for that same session — for anyone else it reads as a value they cannot
 * account for, and refuses.
 *
 * ADMITTED at the grant: a person who never saw a screen never read the grant
 * copy, which is the stated, owner-approved gap of "signing in is the grant",
 * not a mismatch this check can close.
 *
 * Nothing in a browser can produce it: the server writes it, from a session it
 * resolved itself, and only over {@link WIDGET_SIGNIN_SCREEN_UNCLASSIFIED}
 * (write-once). Like the unclassified value it is deliberately outside the atom
 * grammar, so it can never collide with a real displayed set.
 */
export const WIDGET_NO_SIGNIN_SCREEN_PREFIX = "(no-screen:";

/**
 * The no-screen token for ONE session AND ONE GRANTED SET. Empty fingerprint →
 * empty token, which every consumer treats as "no token": a caller that could
 * not identify the session it is looking at may neither write the sentinel nor
 * match one.
 *
 * IT NAMES THE SET IT WAS WRITTEN FOR (cinatra#2683, codex round 1, finding 1).
 * The no-screen claim used to say only "no screen rendered for this session",
 * which is a statement that outlives the set it was made under — so during the
 * one rolling deploy that ADDS a grant, an old node could stamp the sentinel and
 * a new node would admit it and record the larger set. Whoever signed in that
 * way was shown nothing and granted more than the build they met would have
 * granted. That was tolerable while the added grants only READ; S8f adds one
 * that CONFIRMS A DESTRUCTIVE ACTION, and a silent widening of that is not.
 *
 * Binding the set makes the mixed-version window fail closed in both directions,
 * exactly as `(unclassified)` and the pre-column NULL already do: an old node's
 * bare token is not equal to this build's, so it is refused, and the person
 * opens the assistant login again — which, on a current node, writes the token
 * this build admits. It costs one extra round trip during a rollout and closes a
 * silent escalation.
 *
 * IT IS STILL NEVER A SOURCE. Nothing is granted because this token says so; the
 * recorded set is always the server constant. The token can only cause a
 * REFUSAL.
 *
 * The set is REQUIRED, not optional. An optional argument is one a call site can
 * forget, and a forgotten one here reopens exactly the window it closes.
 */
export function widgetNoSignInScreenToken(
  sessionFingerprint: string,
  grantedScopes: readonly string[],
): string {
  const fingerprint = String(sessionFingerprint ?? "").trim();
  if (!/^[a-f0-9]{16,128}$/.test(fingerprint)) return "";
  const canonical = [...grantedScopes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${WIDGET_NO_SIGNIN_SCREEN_PREFIX}${fingerprint}:${formatTokenSet(canonical)})`;
}

/** Is this recorded value a no-screen claim (whoever it names)? */
export function isNoSignInScreenToken(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(WIDGET_NO_SIGNIN_SCREEN_PREFIX) &&
    value.endsWith(")")
  );
}

/**
 * The wrapper every displayed-set record is written inside — `(screen:<set>)`,
 * the mirror of `(no-screen:<fp>)`.
 *
 * IT IS THE CROSS-VERSION FAIL-CLOSED (codex rework round 8, finding 1). A
 * record is only as good as its ARRIVAL binding, and that binding is enforced by
 * the build doing the reading. A build that knows `displayed_scopes` but not
 * `screen_nonce_hash` would read a bare `lifecycle.read` written here, find it
 * agreeable, and admit whoever turned up — the round-7 exploit, reopened by the
 * one deploy that closes it. So the record this build writes is one that build
 * does NOT recognize: it compares for exact equality against its own bare token,
 * and `(screen:lifecycle.read)` is not that. Both directions of this change's
 * own rollout therefore refuse — a nonce-unaware node cannot redeem a record
 * written here, and a bare record written there carries no arrival and is
 * refused here — which is the same discipline `(unclassified)` and the
 * pre-column NULL already carry.
 *
 * Deliberately outside the atom grammar, like its two siblings, so it can never
 * collide with a set member; and distinct from `(no-screen:` so neither prefix
 * is a prefix of the other.
 */
export const WIDGET_DISPLAYED_SCREEN_PREFIX = "(screen:";

/**
 * The token a hosted SIGN-IN SCREEN carries forward describing the scope set it
 * DISPLAYED — the canonical (sorted, deduplicated) set, wrapped in
 * {@link WIDGET_DISPLAYED_SCREEN_PREFIX}.
 *
 * cinatra#2631 (codex rework round 0, finding 1). Removing the consent screen
 * did NOT remove the gap the screen's signed CSRF binding used to close; it
 * moved the display one request earlier. The sign-in screen is rendered by one
 * node and the grant is recorded by another request that could be served by a
 * DIFFERENT BUILD mid-rollout, so a person can read the old list of sentences
 * and have the new set recorded. Writing this token onto the transaction when
 * the screen renders means the two can be COMPARED: the action refuses when they
 * disagree, and the person opens the assistant login again on a screen that
 * names what they are actually granting.
 *
 * IT IS NEVER A SOURCE. Nothing is granted because this token says so — the
 * recorded set is always the server constant; the token can only cause a
 * REFUSAL. It lives on the transaction rather than in the popup's URL because a
 * URL marker can be stripped by whoever opens the popup, and an absent marker
 * has to be admitted (round 1, finding 1). Sorted, because this is a set:
 * reordering the constant must not invalidate a screen someone is looking at;
 * only a change of MEMBERSHIP does.
 */
export function widgetDisplayedScopesToken(
  displayedScopes: readonly string[],
): string {
  const canonical = [...displayedScopes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${WIDGET_DISPLAYED_SCREEN_PREFIX}${formatTokenSet(canonical)})`;
}

/**
 * The stored shape of a screen nonce: the lowercase SHA-256 hex of the
 * single-use nonce a current node minted for ONE arrival. The plaintext nonce
 * never reaches the database; only this hash does, exactly as every other
 * browser-held secret in the widget login is stored (the authorization code, the
 * `cwu_` token).
 */
const SCREEN_NONCE_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Does the nonce this arrival PRESENTED hash to the one stored on the
 * transaction? (cinatra#2631, rework round 7, finding 1.)
 *
 * WHY A NONCE AT ALL. A real displayed-scope record used to be a property of the
 * TRANSACTION, and it has to be a property of the ARRIVAL that redeems it. The
 * exploit is one transaction id driven by two people during a rolling deploy:
 * person A opens it sessionless on a current node — which records the current
 * scope set — and abandons it; person B opens the same still-unconsumed
 * transaction on a legacy node, reads the LEGACY copy, signs in there and
 * returns to a current node, which admitted A's record and granted B a set B
 * never read. The `(no-screen)` half of that class was already closed by naming
 * the session (round 5); this closes the half where a screen really did render,
 * for somebody else.
 *
 * THE CARRIER IS THE BROWSER'S OWN FLOW. A current node mints the nonce at the
 * moment it renders the sign-in screen (or proves no screen will render), stores
 * only its hash beside the displayed-set record — write-once, in the same
 * statement, so the record and the arrival it belongs to are one fact — and
 * hands the plaintext back to that browser in the sign-in redirect URL. It is
 * the URL and not a cookie because a Next server component may not set one
 * during a `GET` render, and it is safe there in a way the DISPLAYED SET was not
 * (round 1, finding 1): stripping this marker cannot turn a mismatch into an
 * admission, because a missing nonce is REFUSED. It says nothing and proves one
 * thing.
 *
 * FAILS CLOSED ON EVERYTHING. An absent stored hash — a legacy row written
 * before this mechanism, or a transaction that never earned a record — refuses
 * exactly like {@link WIDGET_SIGNIN_SCREEN_UNCLASSIFIED}. A malformed value on
 * either side refuses. The comparison is constant-time over the full hash so the
 * store cannot be probed a character at a time.
 */
export function widgetScreenNonceMatches(
  storedHash: string | null | undefined,
  presentedHash: string | null | undefined,
): boolean {
  // Compared as stored and as computed — no trimming, no case folding. A stored
  // value that is not exactly a hash is a corrupted row, and a corrupted row
  // proves nothing.
  const stored = typeof storedHash === "string" ? storedHash : "";
  const presented = typeof presentedHash === "string" ? presentedHash : "";
  if (!SCREEN_NONCE_HASH_RE.test(stored)) return false;
  if (!SCREEN_NONCE_HASH_RE.test(presented)) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i += 1) {
    diff |= stored.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * What a transaction records about the sign-in screen: WHAT was displayed, and
 * WHOSE arrival it was displayed to. The two travel together because either one
 * alone admits somebody it should not.
 */
export type WidgetScreenRecord = {
  displayedScopes: string | null;
  screenNonceHash: string | null;
};

/**
 * THE ONE ADMISSION TEST, used by both ends of the flow — the page before it
 * hands control to the return step, and the server action before it issues the
 * code. One function so the two can never drift into disagreeing about what a
 * record means.
 *
 * A record is admitted only when BOTH halves hold: this arrival presents the
 * nonce the record was written with (round 7, finding 1), AND the recorded set
 * is one this build would grant ({@link displayedScopesAgree}). An arrival that
 * cannot present the nonce of the arrival that recorded the set is refused, even
 * when the set itself is exactly right.
 */
export function screenRecordAdmitsArrival(
  record: WidgetScreenRecord | null | undefined,
  granted: readonly string[],
  arrival: { presentedNonceHash: string; expectedNoScreenToken?: string },
): boolean {
  if (!record) return false;
  if (!widgetScreenNonceMatches(record.screenNonceHash, arrival.presentedNonceHash)) {
    return false;
  }
  return displayedScopesAgree(
    record.displayedScopes,
    granted,
    arrival.expectedNoScreenToken,
  );
}

/**
 * Does what was displayed for this transaction agree with what this build would
 * record, FOR THIS CALLER? Four distinct answers, and the distinctions are the
 * point:
 *
 *   • a NO-SCREEN token naming this caller's own session — a node running this
 *     build PROVED that no sign-in screen rendered for it (the session row
 *     predated the transaction). ADMITTED: the person went straight to the
 *     return step, which is the stated gap of the owner's ruling, not a
 *     mismatch. Nothing in a browser can produce this value.
 *   • a NO-SCREEN token naming SOMEONE ELSE'S session — proof about a different
 *     arrival than this one. REFUSED (round 5, finding 1): whoever is here now
 *     may have come through a screen that recorded nothing.
 *   • UNCLASSIFIED, or NULL — the transaction reached the grant with nothing
 *     known about what was displayed. REFUSED: during a rolling deploy this is
 *     the transaction whose signed-out page was rendered by an OLDER node, which
 *     named none of the grants this build would record (round 3, finding 1);
 *     NULL is the same absence on a transaction that predates the column
 *     entirely (round 2, finding 2). In-flight transactions across the one
 *     deploy that introduces this fail closed and the person opens the assistant
 *     login again.
 *   • anything else — compared EXACTLY against the `(screen:<set>)` record this
 *     build writes. A screen that named no extra grants is `(screen:)`, a real
 *     value and not one of the two absences (round 2, finding 3). A BARE set —
 *     the form a build that does not enforce the arrival binding wrote — is not
 *     equal to it and is refused, which is what keeps this change's own rollout
 *     closed in both directions (round 8, finding 1).
 *
 * `expectedNoScreenToken` is the ONLY channel through which a no-screen claim
 * can be admitted; a caller that omits it (or cannot build one) admits none.
 *
 * THIS IS HALF OF THE ADMISSION, never all of it. It answers "is this set one
 * this build would grant"; it cannot answer "was it displayed to the person
 * standing here", which is a fact about the ARRIVAL and is carried by the screen
 * nonce (round 7, finding 1). Call {@link screenRecordAdmitsArrival}, which asks
 * both — this export stays separate only because the two questions are separate.
 */
export function displayedScopesAgree(
  displayedToken: string | null | undefined,
  granted: readonly string[],
  expectedNoScreenToken?: string,
): boolean {
  if (displayedToken === null || displayedToken === undefined) return false;
  if (displayedToken === WIDGET_SIGNIN_SCREEN_UNCLASSIFIED) return false;
  if (isNoSignInScreenToken(displayedToken)) {
    const expected = String(expectedNoScreenToken ?? "");
    return expected.length > 0 && displayedToken === expected;
  }
  return String(displayedToken).trim() === widgetDisplayedScopesToken(granted);
}

/**
 * Every extension scope this build understands, with the audiences it adds.
 * The map is the SINGLE definition of "what does this grant let the token
 * reach": mint, consume and the consent copy all read it, so a grant cannot
 * gain a surface without gaining consent copy at the same time.
 */
export const WIDGET_EXTENSION_SCOPES = {
  [WIDGET_LIFECYCLE_READ_SCOPE]: {
    audiences: [WIDGET_LIFECYCLE_READ_ROUTE_PATH] as readonly string[],
    /**
     * The sentence the hosted SIGN-IN screen shows for this grant. It states
     * what is read and by whose permission — the grant carries the USER's
     * standing, never a widened one (the site cannot see more through the
     * widget than the person signing in can see in Cinatra).
     *
     * Since signing in IS the grant, this is the copy a signed-OUT visitor reads
     * before they enter their credentials; it is generated from this map, so a
     * grant cannot join the set without gaining a sentence at the same time.
     */
    consentCopy:
      "Show you work items that are waiting on you — reviews and their outcomes — using the same permissions you have in Cinatra.",
  },
  [WIDGET_LIFECYCLE_DECIDE_SCOPE]: {
    audiences: [WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH] as readonly string[],
    /**
     * The sentence the hosted SIGN-IN screen shows for this grant.
     *
     * It promises exactly what ships: deciding here IS deciding in Cinatra —
     * same card, same rights, same one decision. It names no extra step, because
     * there is none.
     */
    consentCopy:
      "Let you approve, reject or comment on those work items from this site — the same decision, with the same permissions, as inside Cinatra.",
  },
  [WIDGET_CONVERSATION_READ_SCOPE]: {
    audiences: [
      WIDGET_CHAT_THREADS_ROUTE_PATH,
      WIDGET_CHAT_PARTICIPANTS_ROUTE_PATH,
      WIDGET_CHAT_SETTINGS_ROUTE_PATH,
      WIDGET_CHAT_PENDING_CALLS_ROUTE_PATH,
      WIDGET_CHAT_UNDO_ROUTE_PATH,
    ] as readonly string[],
    /**
     * The sentence the hosted SIGN-IN screen shows for this grant.
     *
     * It names every surface the grant reaches, because the map is what the
     * screen is generated from — a grant cannot gain an audience without the
     * sentence that admits to it changing in the same edit.
     */
    consentCopy:
      "Show your own conversation with this assistant — your earlier messages, the people and assistants you can mention, the actions waiting for your confirmation, and whether a run can still be undone — using the same permissions you have in Cinatra.",
  },
  [WIDGET_CONVERSATION_WRITE_SCOPE]: {
    audiences: [
      WIDGET_CHAT_UPLOAD_ROUTE_PATH,
      WIDGET_CHAT_SETTINGS_ROUTE_PATH,
    ] as readonly string[],
    /**
     * The sentence the hosted SIGN-IN screen shows for this grant. It says whose
     * account the write lands in, because that is the question a reader on
     * somebody else's website is actually asking.
     */
    consentCopy:
      "Let you attach files to that conversation and change your own chat settings from this site. Files are saved to your Cinatra account and stay private to you.",
  },
  [WIDGET_TOOL_CONFIRM_SCOPE]: {
    audiences: [WIDGET_CHAT_PENDING_CALLS_ROUTE_PATH] as readonly string[],
    /**
     * The sentence the hosted SIGN-IN screen shows for this grant. It is a
     * separate grant because it is a separate thing to agree to: the others show
     * you your conversation, this one runs an action that changes something.
     */
    consentCopy:
      "Let you confirm or reject an action the assistant paused for your approval — the same decision, with the same permissions, as inside Cinatra.",
  },
} as const satisfies Record<
  string,
  { audiences: readonly string[]; consentCopy: string }
>;

export type WidgetExtensionScope = keyof typeof WIDGET_EXTENSION_SCOPES;

/**
 * The extension scopes a SIGN-IN grants. The server action reads this constant
 * and nothing else — there is no request field, no form value and no caller
 * argument through which a scope could enter — so the grant recorded on the
 * authorization code is always exactly the set this build defines here.
 *
 * Whether it is also the set the person READ is a separate question, and a
 * separate mechanism answers it: the sign-in screen's render records what it
 * displayed on the transaction, and the action refuses when that disagrees. When
 * no screen was rendered at all (an existing session) there is nothing to
 * compare — the honest gap this design carries.
 */
export const WIDGET_SIGNIN_GRANTED_SCOPES: readonly WidgetExtensionScope[] = [
  WIDGET_LIFECYCLE_READ_SCOPE,
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
  // cinatra#2683 (epic #2564 S8f) — the conversation column's own data paths.
  // A session minted before this slice carries none of them and its widget keeps
  // behaving exactly as it did (AC-1): the affordances stay absent until the
  // person opens the assistant login again. That is the designed cutover, not a
  // regression — an already-minted token never acquires a grant.
  WIDGET_CONVERSATION_READ_SCOPE,
  WIDGET_CONVERSATION_WRITE_SCOPE,
  WIDGET_TOOL_CONFIRM_SCOPE,
];

export function isKnownWidgetExtensionScope(
  value: unknown,
): value is WidgetExtensionScope {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WIDGET_EXTENSION_SCOPES, value)
  );
}

// ---------------------------------------------------------------------------
// The set codec. One parser for scope and audience alike.
// ---------------------------------------------------------------------------

/**
 * Parse a space-delimited token set. Tolerates any run of whitespace and an
 * empty/absent value (→ `[]`). Never throws: a malformed column yields an empty
 * set, which grants nothing.
 */
export function parseTokenSet(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(/\s+/).filter((t) => t.length > 0);
}

/** Format a token set for storage — deduplicated, order-stable. */
export function formatTokenSet(values: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = String(v ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(" ");
}

/** Exact membership. The ONLY admission test — no prefix, no substring. */
export function tokenSetHas(raw: unknown, value: string): boolean {
  if (!value) return false;
  return parseTokenSet(raw).includes(value);
}

/**
 * Narrow an arbitrary list to the extension scopes this build knows, sorted and
 * deduplicated. Applied at BOTH ends of the code→token hop: an unknown entry can
 * never be stored, and a stored entry that stopped being known (a rollback, a
 * tampered row) can never be honoured.
 */
export function normalizeExtensionScopes(
  values: readonly unknown[] | null | undefined,
): WidgetExtensionScope[] {
  if (!Array.isArray(values)) return [];
  const kept = new Set<WidgetExtensionScope>();
  for (const v of values) {
    if (isKnownWidgetExtensionScope(v)) kept.add(v);
  }
  return [...kept].sort();
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * The `scope` column for a freshly minted token: the base scope plus every
 * consented extension scope this build knows. Returns null when the agent slug
 * cannot be expressed as one set member — the caller refuses the whole mint.
 */
export function mintWidgetTokenScope(
  agentSlug: string,
  grantedExtensionScopes: readonly unknown[] | null | undefined,
): string | null {
  const base = widgetUserBaseScope(agentSlug);
  if (!base) return null;
  return formatTokenSet([base, ...normalizeExtensionScopes(grantedExtensionScopes)]);
}

/**
 * The `aud` column for a freshly minted token: the chat route (always — every
 * widget session takes turns) plus the audiences each consented scope unlocks.
 * A scope with no audience of its own adds none.
 */
export function mintWidgetTokenAudience(
  grantedExtensionScopes: readonly unknown[] | null | undefined,
): string {
  const audiences: string[] = [WIDGET_BROKER_ROUTE_PATH];
  for (const scope of normalizeExtensionScopes(grantedExtensionScopes)) {
    audiences.push(...WIDGET_EXTENSION_SCOPES[scope].audiences);
  }
  return formatTokenSet(audiences);
}

// ---------------------------------------------------------------------------
// Read back
// ---------------------------------------------------------------------------

/**
 * The extension scopes a stored `scope` column actually grants — known entries
 * only. Used for the token's claims (audit) and by the lifecycle gate.
 */
export function grantedExtensionScopesFromScopeColumn(
  raw: unknown,
): WidgetExtensionScope[] {
  return normalizeExtensionScopes(parseTokenSet(raw));
}

/**
 * Does this token's stored (scope, aud) pair admit a request AT `routePath`?
 *
 * cinatra#2574 (codex round 0, finding 4): membership in the raw `aud` column
 * alone is not enough. Trusting an arbitrary audience string would let a
 * newer issuer's — or a tampered row's — audience confer a surface this build
 * cannot reason about, and it would make the two gates one gate. So the
 * audience is RE-DERIVED here from what the token demonstrably carries:
 *
 *   • the chat route is always admissible (it is every `cwu_`'s reason to
 *     exist, and pre-#2574 tokens hold nothing else);
 *   • any other route is admissible only if it is DECLARED by a KNOWN extension
 *     scope that this token's own scope column also carries.
 *
 * An audience that survives that derivation must additionally be present in the
 * stored column, so the check is the INTERSECTION of what was minted and what
 * this build recognizes — never the union.
 */
export function tokenAudienceAdmits(
  scopeRaw: unknown,
  audRaw: unknown,
  routePath: string,
): boolean {
  if (!routePath || !tokenSetHas(audRaw, routePath)) return false;
  if (routePath === WIDGET_BROKER_ROUTE_PATH) return true;
  for (const scope of grantedExtensionScopesFromScopeColumn(scopeRaw)) {
    if (WIDGET_EXTENSION_SCOPES[scope].audiences.includes(routePath)) return true;
  }
  return false;
}
