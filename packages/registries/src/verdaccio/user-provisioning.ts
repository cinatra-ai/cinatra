// -----------------------------------------------------------------------------
// Verdaccio npm user-provisioning helper.
//
// Issues `PUT <registryUrl>/-/user/org.couchdb.user:<instanceNamespace>`.
// Anonymous (no Authorization header) — Verdaccio's adduser endpoint is
// anonymous when registration is enabled. Caller is responsible for password
// generation and email derivation.
//
// On 201 with a non-conforming body shape, throws
// `VerdaccioUnexpectedResponseError`. The live registry response must match the
// documented `{ token: string }` form; this typed error surfaces divergence loud
// rather than silently corrupting state.
//
// Error handling philosophy:
//   - 401 → typed VerdaccioUserCredentialConflictError (cinatra#2500)
//   - 409 + "already registered" → typed VerdaccioUserAlreadyRegisteredError
//   - 409 + "user registration disabled" → typed VerdaccioRegistrationDisabledError
//   - 201 + missing/invalid `token` field → VerdaccioUnexpectedResponseError
//   - other non-2xx → generic Error with status code only (NEVER include the
//     response body — it may reflect input back, which leaks the password)
//
// cinatra#2500 — WHY 401 IS ITS OWN CLASS. Verdaccio's adduser endpoint answers
// 401 (not 409) when the namespace ALREADY EXISTS in its htpasswd store under a
// DIFFERENT password: the PUT is read as a login attempt for an existing user
// and the password does not match. That is the routine outcome of a
// `reset --purge-app-data`, which wipes the app-side registry credentials (so
// the app mints a FRESH password) but leaves the Verdaccio user store intact.
// Folding it into the generic "HTTP <status>" throw surfaced the opaque
// "Could not provision registry user. Operator: see server logs." flash, which
// tells a brand-new operator nothing they can act on. Classified here, both
// call sites can route it to an ACTIONABLE message ("pick another name, or
// clear the stale registry user"). The response body is still never read on
// this path — the status alone is the discriminator, so nothing can reflect the
// submitted password back into an error message.
// -----------------------------------------------------------------------------

import { VerdaccioUnexpectedResponseError } from "./errors";

// -----------------------------------------------------------------------------
// Typed errors (mirrors InstanceNamespaceNotConfiguredError shape from errors.ts)
// -----------------------------------------------------------------------------

export class VerdaccioUserAlreadyRegisteredError extends Error {
  readonly code = "USER_ALREADY_REGISTERED" as const;

  constructor(message?: string) {
    super(message ?? "Verdaccio user is already registered.");
    this.name = "VerdaccioUserAlreadyRegisteredError";
  }
}

export class VerdaccioRegistrationDisabledError extends Error {
  readonly code = "REGISTRATION_DISABLED" as const;

  constructor(message?: string) {
    super(message ?? "Verdaccio user registration is disabled.");
    this.name = "VerdaccioRegistrationDisabledError";
  }
}

/**
 * The namespace already exists on the registry under DIFFERENT credentials
 * (cinatra#2500) — Verdaccio answers the adduser PUT with 401 because it reads
 * it as a login for an existing htpasswd user whose password does not match.
 *
 * Distinct from {@link VerdaccioUserAlreadyRegisteredError} (the 409 "already
 * registered" case) because the operator remedy differs: a 409 means the name
 * is genuinely taken, while a 401 is typically a STALE local registry user left
 * behind by an app-data reset — the operator can either pick a different name
 * or clear that one user from the registry and retry.
 */
export class VerdaccioUserCredentialConflictError extends Error {
  readonly code = "USER_CREDENTIAL_CONFLICT" as const;

  constructor(message?: string) {
    super(
      message ??
        "Verdaccio rejected the credentials for an existing user with this namespace.",
    );
    this.name = "VerdaccioUserCredentialConflictError";
  }
}

// -----------------------------------------------------------------------------
// createNpmUser
// -----------------------------------------------------------------------------

export type CreateNpmUserOptions = {
  /** Instance namespace used as the npm user name. */
  instanceNamespace: string;
  password: string;
  email: string;
  registryUrl: string;
};

/**
 * Provision a new npm user on the given Verdaccio registry.
 *
 * Issues `PUT <registryUrl>/-/user/org.couchdb.user:<instanceNamespace>` with the
 * documented CouchDB-compatible body shape. Returns the issued auth token on
 * success.
 *
 * @throws VerdaccioUserCredentialConflictError on 401 (existing user, other password)
 * @throws VerdaccioUserAlreadyRegisteredError on 409 + "already registered"
 * @throws VerdaccioRegistrationDisabledError on 409 + "user registration disabled"
 * @throws VerdaccioUnexpectedResponseError when 201 response body lacks a
 *   string `token` field
 * @throws Error on other non-2xx with the status code (NOT the body)
 */
export async function createNpmUser(opts: CreateNpmUserOptions): Promise<{ token: string }> {
  const baseUrl = opts.registryUrl.replace(/\/$/, "");
  const url = `${baseUrl}/-/user/org.couchdb.user:${encodeURIComponent(opts.instanceNamespace)}`;

  const body = {
    _id: `org.couchdb.user:${opts.instanceNamespace}`,
    name: opts.instanceNamespace,
    password: opts.password,
    email: opts.email,
    type: "user",
    roles: [],
    date: new Date().toISOString(),
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  // cinatra#2500 — checked BEFORE the generic non-2xx throw so the stale-user
  // case stops being an opaque "see server logs". No body read: the status is
  // the whole discriminator, so the submitted password can never be reflected.
  if (response.status === 401) {
    // Discard the unread body so undici releases the connection promptly.
    await response.body?.cancel().catch(() => {});
    throw new VerdaccioUserCredentialConflictError();
  }

  if (response.status === 409) {
    // Read body for discrimination only — never re-emitted in error messages.
    let conflictBody = "";
    try {
      conflictBody = await response.text();
    } catch {
      // Ignore — fall through to generic 409.
    }
    if (conflictBody.includes("already registered")) {
      throw new VerdaccioUserAlreadyRegisteredError(
        "That instance namespace is already registered on the registry.",
      );
    }
    if (conflictBody.includes("user registration disabled")) {
      throw new VerdaccioRegistrationDisabledError(
        "Registry user registration is disabled. Contact your registry admin.",
      );
    }
    throw new Error("Verdaccio adduser failed with HTTP 409.");
  }

  if (!response.ok) {
    // NEVER include body — it may reflect inputs (password, email) back.
    throw new Error(`Verdaccio adduser failed with HTTP ${response.status}.`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new VerdaccioUnexpectedResponseError(
      "Verdaccio adduser returned a non-JSON response. Update the createNpmUser response parser.",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { token?: unknown }).token !== "string" ||
    (parsed as { token: string }).token.length === 0
  ) {
    throw new VerdaccioUnexpectedResponseError(
      "Verdaccio adduser returned an unexpected response shape (no token field). Update the createNpmUser response parser.",
    );
  }

  return { token: (parsed as { token: string }).token };
}
