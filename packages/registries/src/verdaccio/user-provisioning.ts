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
//   - 409 + "already registered" → typed VerdaccioUserAlreadyRegisteredError
//   - 409 + "user registration disabled" → typed VerdaccioRegistrationDisabledError
//   - 201 + missing/invalid `token` field → VerdaccioUnexpectedResponseError
//   - other non-2xx → generic Error with status code only (NEVER include the
//     response body — it may reflect input back, which leaks the password)
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
