// -----------------------------------------------------------------------------
// LEG 5 — the FIRST ADMINISTRATOR, without a browser.
//
// This is the one setup step that still needed a person at a keyboard. The
// wizard's Account step (`/setup/account`, the FIRST step of its rail) renders
// the shared `SignUpForm` — the same component `/sign-up` uses for every later
// account — and that form posts to the authentication library's own
// `/sign-up/email` endpoint. The step itself writes no user row; it only
// decides whether it is still the bootstrap surface, and records the operator's
// registration answer.
//
// So this wrapper takes that endpoint's IN-PROCESS TWIN, `auth.api.signUpEmail`
// — the same call the development boot already makes to seed its fixture
// account. One call, and everything about an account stays the product's: the
// password hashing, the password policy, the verification flags, and every
// `user.create` hook, the closed-registration gate included.
//
// WHAT KEEPS THIS TO THE FIRST PERSON, precisely. Two things, and the
// closed-registration gate is NOT reliably one of them: with registration OPEN
// it answers "allow" before it ever counts humans. The guards that hold
// unconditionally are
//   - this leg's own probe, the reader the Account step itself asks, which ends
//     the leg before any account call once a real person exists; and
//   - `ensureInitialAdminBootstrap`, which re-reads the HUMAN count itself and
//     promotes only when that count is exactly one.
// On a fresh CLOSED instance the registration gate's first-human exception is
// additionally what lets the account be created at all.
//
// PROMOTION IS NOT PERFORMED HERE. "The first user to register becomes the
// platform administrator" is a decision the product already owns, in
// `ensureInitialAdminBootstrap`: the one-shot that checks the candidate is a
// real person, that exactly one real person exists, and only then writes the
// role, the Default-organization ownership and the assistant bootstrap. A
// browser reaches it through `getAuthSession()` on the first authenticated
// render. A command has no first authenticated render to be carried by — that
// is the ONLY difference between the two paths — so this wrapper calls the same
// function with the new account's id and writes no role, no membership and no
// organization row of its own.
//
// THE SESSION THAT SIGN-UP MINTS IS ENDED, ON EVERY PATH THAT REACHES IT. The
// library signs a new account in as part of registering it, because a browser
// is about to carry that session. A command is not a browser: leaving it alive
// would leave a live platform-administrator session on the instance that nobody
// holds and nothing will ever use. So this leg revokes it through the library's
// own single-session revoke, after the promotion — after, because the promotion
// writes the account's active organization onto its sessions.
//
// INCLUDING WHEN THE PROMOTION THROWS. The bootstrap writes the role, the
// default organization, the membership and the sessions' organization in turn,
// after its own guards, so a throw part-way leaves a state this leg cannot read
// back. That is exactly the run that must not ALSO leave a live session, so the
// promotion is caught, the session is ended either way, and the refusal that
// ends the run says what is known, what is not, and what became of the session.
//
// A SESSION IS EVIDENCED BY EITHER a returned token or a returned session
// cookie. A cookie with no token means a session exists that this leg has no
// handle to end — a refusal, never a quiet skip.
//
// ALREADY SEATED IS A NORMAL OUTCOME, not a failure. A yes ends the leg before
// any account call is made — whether or not the address matches the one on
// file. The leg never says which addresses exist; it reports only the address
// it was handed.
//
// RUNTIME. This leg asks the STRICTER gate its siblings do not: the four writes
// they perform can be undone by an operator, and seating a platform
// administrator on an instance that has nobody on it yet cannot. See
// `./runtime-gate`.
//
// SECRETS. The password arrives as an in-memory argument from the caller, which
// reads it from the stdin document, and is passed on EXACTLY as given — a
// password is bytes, not a name, and trimming one would store a different
// secret than the operator typed. It is never an argv value, never written to a
// file, and never logged. Nothing on any path here — outcome, notice, thrown
// message or error cause — carries a character of it or of the session token,
// and a refusal that came back from the endpoint is NOT repeated: the request
// that produced it carried the password, and a refusal is free to quote what it
// was given.
// -----------------------------------------------------------------------------

import { assertDeclaredDevelopmentRuntime } from "@/lib/dev-instance-provisioning/runtime-gate";

export type ProvisionFirstAdministratorInput = {
  /** An ordinary value — an address is not a secret. */
  email: string;
  /** Optional. Defaults to the address's local part. */
  name?: string;
  /** In-memory only, from stdin. Passed on exactly as given. */
  password: string;
};

/** What the authentication library's own server-side sign-up hands back. */
export type SignUpEmailResult = {
  /** The session token the sign-up minted, when it minted one. */
  token?: string | null;
  user?: { id?: string } | null;
  /** The response headers it produced — carrying the session cookie a browser
   *  would have been given, which is how the revoke presents that session. */
  headers?: Headers | null;
};

export type SignUpEmailCall = (body: {
  email: string;
  password: string;
  name: string;
}) => Promise<SignUpEmailResult | null>;

export type RevokeSessionCall = (input: {
  token: string;
  headers: Headers | null | undefined;
}) => Promise<void>;

export type ProvisionFirstAdministratorDeps = {
  /** Defaults to the product's own "does a real person exist yet" reader — the
   *  one the Account step asks. Injectable so a unit test needs no database. */
  hasAnyUsers?: () => Promise<boolean>;
  /** Defaults to the authentication library's own server-side sign-up. */
  signUpEmail?: SignUpEmailCall;
  /** Defaults to the library's own single-session revoke. */
  revokeSession?: RevokeSessionCall;
  /** Defaults to the product's own first-user one-shot. */
  promoteInitialAdministrator?: (userId: string) => Promise<boolean>;
  /** Default to the instance's own configured policy. */
  minimumPasswordLength?: number;
  maximumPasswordLength?: number;
};

export type ProvisionFirstAdministratorOutcome = {
  written: boolean;
  /** The address this run was ASKED for. Never another, never a password. */
  email: string;
  /** True when a person already held the instance, so nothing was done. */
  alreadySeated: boolean;
  /** True when the product's own first-user bootstrap promoted the account. */
  administrator: boolean;
};

/**
 * A password this instance's OWN policy refuses. The rule that was broken is
 * named; the value never is, and no cause is attached to carry it out by the
 * side door.
 */
export class AdministratorPasswordRefusedError extends Error {
  readonly rule: "minimum" | "maximum";
  readonly length: number;

  constructor(rule: "minimum" | "maximum", length: number) {
    super(
      "The administrator password was refused by this instance's own password policy: " +
        `it must be ${rule === "minimum" ? "at least" : "at most"} ${length} characters. ` +
        "The password itself is never printed, logged, returned, or attached to this refusal.",
    );
    this.name = "AdministratorPasswordRefusedError";
    this.rule = rule;
    this.length = length;
  }
}

/**
 * The product's own authentication module, imported only when a default is
 * actually needed. Same lazy shape, and the same reason, as the provider leg's
 * writer import: a provisioning run that seeds no administrator has no business
 * evaluating the authentication graph, and a caller that injects its own
 * members never loads it at all.
 */
function authModule(): Promise<typeof import("@/lib/auth")> {
  return import("@/lib/auth");
}

export async function provisionFirstAdministrator(
  input: ProvisionFirstAdministratorInput,
  deps?: ProvisionFirstAdministratorDeps,
): Promise<ProvisionFirstAdministratorOutcome> {
  assertDeclaredDevelopmentRuntime("provisionFirstAdministrator");

  const email = input.email.trim();
  if (email.length === 0) {
    throw new Error(
      "No administrator address reached the command. The address is an ordinary " +
        "argument — pass --admin-email.",
    );
  }
  // The address is NOT shape-checked here. The product has no account-address
  // validator of its own to reuse, and the sign-up endpoint this leg calls is
  // the authority that refuses a malformed one — inventing a second rule beside
  // it is precisely the drift this whole directory exists to avoid.
  if (input.password.length === 0) {
    throw new Error(
      "No administrator password reached the command. The password travels over stdin, " +
        'as the "adminPassword" field of the secrets document; it is never an argument.',
    );
  }

  // BEFORE anything is created. The Account step asks exactly this question,
  // through exactly this reader, to decide whether it is still the bootstrap
  // surface at all — so the two paths can never disagree about when the seat is
  // taken. It counts REAL PEOPLE only, which is what makes a development boot's
  // machine fixture unable to look like an operator and consume the one-shot.
  const hasAnyUsers = deps?.hasAnyUsers ?? (await authModule()).hasAnyBetterAuthUsers;
  if (await hasAnyUsers()) {
    // Nothing written, nothing called, nothing disclosed — not even whether the
    // address that was asked for is the one on file.
    return { written: false, email, alreadySeated: true, administrator: false };
  }

  // The instance's OWN configured bounds, read from where the authentication
  // options declare them, so these refusals can name the rule without
  // restating it. Both ends: the library refuses an over-long password too.
  const minimumPasswordLength =
    deps?.minimumPasswordLength ?? (await authModule()).MINIMUM_PASSWORD_LENGTH;
  if (input.password.length < minimumPasswordLength) {
    throw new AdministratorPasswordRefusedError("minimum", minimumPasswordLength);
  }
  const maximumPasswordLength =
    deps?.maximumPasswordLength ?? (await authModule()).MAXIMUM_PASSWORD_LENGTH;
  if (input.password.length > maximumPasswordLength) {
    throw new AdministratorPasswordRefusedError("maximum", maximumPasswordLength);
  }

  // The wizard's form asks a person for a display name. A command should not
  // demand one for a development instance, and the product already has a
  // default for an account it creates with nobody to ask: the local part.
  const name = input.name?.trim() || email.split("@")[0] || email;

  const signUpEmail: SignUpEmailCall =
    deps?.signUpEmail ??
    (async (body) => {
      const { auth } = await authModule();
      const { headers, response } = await auth.api.signUpEmail({ body, returnHeaders: true });
      return { token: response?.token, user: response?.user, headers };
    });

  let created: Awaited<ReturnType<SignUpEmailCall>>;
  try {
    created = await signUpEmail({ email, password: input.password, name });
  } catch (error) {
    throw new Error(
      `This instance refused to create the administrator account for ${email}. ` +
        "The refusal itself is not repeated here — the request that produced it carried " +
        `the password. Machine detail: ${describeRefusal(error, [input.password])}.`,
    );
  }

  const userId = created?.user?.id;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error(
      `The administrator account for ${email} was not created: the sign-up returned no account.`,
    );
  }

  // Everything a message on any path below must never repeat.
  const secrets = [input.password, typeof created?.token === "string" ? created.token : ""];

  const revokeSession: RevokeSessionCall =
    deps?.revokeSession ??
    (async ({ token: sessionToken, headers }) => {
      const cookie = requestCookieFromResponse(headers);
      if (cookie.length === 0) throw new InternalProvisioningRefusal(NO_SESSION_COOKIE);
      const { auth } = await authModule();
      await auth.api.revokeSession({
        body: { token: sessionToken },
        headers: new Headers({ cookie }),
      });
    });

  // THE PRODUCT'S OWN ONE-SHOT. Not a role update of this command's: this leg
  // has written no row and will write none. Its own guards still apply, so a
  // false here means the product declined to promote and the operator has an
  // account that is not an administrator — which the caller reports as such.
  //
  // CAUGHT, not allowed to escape: whatever happened to the account, the
  // session below has to be dealt with before this run ends.
  const promoteInitialAdministrator =
    deps?.promoteInitialAdministrator ?? (await authModule()).ensureInitialAdminBootstrap;
  let administrator = false;
  let promotionFailure: unknown = null;
  try {
    administrator = await promoteInitialAdministrator(userId);
  } catch (error) {
    promotionFailure = error;
  }

  // AFTER the promotion, on every one of its outcomes. The promotion writes the
  // account's active organization onto its sessions, so ending the session
  // before it would undo work the browser path does in the other order — and a
  // session left behind is the hazard whether or not the promotion landed.
  const session = await endMintedSession({
    token: created?.token,
    headers: created?.headers ?? null,
    revokeSession,
    secrets,
  });

  if (promotionFailure !== null) {
    throw new Error(
      `The administrator account for ${email} was created, but this instance's own first-user ` +
        "bootstrap did not complete. It writes the role, the default organization, the " +
        "membership and the sessions' organization in turn, so whether that account ended up an " +
        "administrator is UNKNOWN — read it on the instance before anything else runs. " +
        `${sessionSentence(session)} ` +
        `Machine detail: ${describeRefusal(promotionFailure, secrets)}.`,
    );
  }

  if (session.kind === "failed") {
    throw new Error(
      `The administrator account for ${email} was created${administrator ? " and promoted" : ""}, ` +
        "but the session its registration opened could NOT be ended, and it is STILL LIVE. " +
        "End it from the instance's own sessions surface, or restart the instance and end it " +
        `there. Machine detail: ${session.detail}.`,
    );
  }

  return { written: true, email, alreadySeated: false, administrator };
}

/**
 * A refusal this module raises ITSELF. Its reason is a fixed, value-free
 * string, so the machine detail below quotes it verbatim — unlike a refusal that
 * came back from an endpoint, whose message is free to quote the request that
 * produced it and is therefore never repeated.
 */
export class InternalProvisioningRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "InternalProvisioningRefusal";
    this.reason = reason;
  }
}

const NO_SESSION_COOKIE = "no session cookie came back from the sign-up";
const NO_TOKEN_FOR_A_MINTED_SESSION =
  "a session cookie came back but no token to end that session by";

/** What became of the session the registration opened. */
type SessionEnding =
  | { kind: "none" }
  | { kind: "ended" }
  | { kind: "failed"; detail: string };

/**
 * End the session the sign-up minted, if it minted one.
 *
 * EITHER piece of evidence counts. A token is the handle the revoke needs; a
 * cookie on its own still proves a session exists, and returning quietly on it
 * would leave exactly what this function is for.
 */
async function endMintedSession(input: {
  token: unknown;
  headers: Headers | null | undefined;
  revokeSession: RevokeSessionCall;
  secrets: readonly string[];
}): Promise<SessionEnding> {
  const token = typeof input.token === "string" && input.token.length > 0 ? input.token : null;
  const mintedCookie = requestCookieFromResponse(input.headers).length > 0;

  if (token === null && !mintedCookie) return { kind: "none" };
  if (token === null) return { kind: "failed", detail: NO_TOKEN_FOR_A_MINTED_SESSION };

  try {
    await input.revokeSession({ token, headers: input.headers });
    return { kind: "ended" };
  } catch (error) {
    return { kind: "failed", detail: describeRefusal(error, input.secrets) };
  }
}

/** The sentence a refusal on another subject adds about the session. */
function sessionSentence(ending: SessionEnding): string {
  if (ending.kind === "none") return "That registration opened no session.";
  if (ending.kind === "ended") return "The session that registration opened WAS ended.";
  return (
    "The session that registration opened could NOT be ended either, and it is STILL LIVE — " +
    "end it from the instance's own sessions surface, or restart the instance and end it there " +
    `(session detail: ${ending.detail}).`
  );
}

/** A machine identifier, and nothing that could be prose. */
const MACHINE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * What may be said about a refusal an authentication endpoint returned: its
 * status and its machine code, when those are identifier-shaped constants.
 * NEVER its message and never the error itself as a cause — the request it
 * refused carried a secret, and an error is free to quote the request it
 * refused.
 *
 * Belt and braces on top of the shape check: a code is a constant, but this
 * message is printed to a terminal and the value beside it is a secret, so a
 * fragment that contains that secret is dropped whatever it claims to be.
 */
function describeRefusal(error: unknown, secrets: readonly string[]): string {
  const carries = (text: string) =>
    secrets.some((secret) => secret.length > 0 && text.includes(secret));

  // A refusal this module raised itself: its reason is a constant of this file,
  // so it is said rather than reduced to "none carried" for want of a status.
  if (error instanceof InternalProvisioningRefusal) {
    return carries(error.reason) ? "none carried" : error.reason;
  }

  const carrier = error as
    | { status?: unknown; statusCode?: unknown; body?: { code?: unknown } | null }
    | null
    | undefined;
  const parts: string[] = [];

  const status = carrier?.statusCode ?? carrier?.status;
  if (typeof status === "number" && Number.isInteger(status)) parts.push(String(status));
  else if (typeof status === "string" && MACHINE_IDENTIFIER.test(status)) parts.push(status);

  const code = carrier?.body?.code;
  if (typeof code === "string" && MACHINE_IDENTIFIER.test(code)) parts.push(code);

  const safe = parts.filter((part) => !carries(part));
  return safe.length > 0 ? safe.join(" ") : "none carried";
}

/**
 * The `Cookie` a browser would send back, built from the `Set-Cookie` the
 * sign-up produced. Each cookie's `name=value` pair is everything before the
 * first `;`; the attributes are the browser's business. Nothing here knows the
 * cookie's name or how it is signed — it hands the library's own bytes back to
 * the library.
 */
function requestCookieFromResponse(headers: Headers | null | undefined): string {
  if (!headers) return "";
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=[^;,]+?=)/);
  return setCookies
    .map((line) => String(line).split(";", 1)[0].trim())
    .filter((pair) => pair.length > 0)
    .join("; ");
}
