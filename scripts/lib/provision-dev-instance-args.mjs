// The ARGUMENT AND OUTCOME SURFACE of the development instance-provisioning
// command — what an operator types at it and the one line it prints back —
// kept dependency-free so both can be tested without the application graph.
//
// The one property this module exists to hold: there is NO flag that can carry
// a secret. A secret-looking flag is REFUSED rather than ignored, because an
// ignored `--api-key sk-…` is still a key in the shell history, in `ps`, and in
// whatever the shell logs. Secrets arrive on stdin.
//
// A refusal names the FLAG and never the value beside it: these messages are
// printed to the terminal, and a mistyped credential is exactly the thing that
// would otherwise be echoed there.

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_TRAVEL_RULE =
  "Secret values (the provider key, the connector-service secret, the first " +
  "administrator's password) reach this command over stdin only — never as a " +
  "command-line argument, never through an environment file written to disk, never " +
  "logged.";

export const PROVISIONABLE_PROVIDERS = Object.freeze(["openai", "anthropic"]);

export class SecretInArgumentsError extends Error {
  constructor(flag) {
    super(
      `"${flag}" is not an argument of this command: ${SECRET_TRAVEL_RULE} ` +
        'Pipe a JSON document in instead, e.g. echo \'{"providerApiKey":"…"}\' | pnpm provision:dev-instance --namespace acme-dev',
    );
    this.name = "SecretInArgumentsError";
  }
}

/** Anything whose NAME suggests it carries a credential. Exported so the suite
 *  can assert the INVARIANT rather than a list of examples: no accepted flag's
 *  name may read as a secret. */
export const SECRET_FLAG_PATTERN = /(key|secret|token|password|credential|passphrase)/i;

// An ADDRESS IS NOT A SECRET, and neither is a display name: both are ordinary
// flags. The administrator's PASSWORD is a secret and therefore has no flag at
// all — `--admin-password` and every other secret-looking spelling of it falls
// through to the refusal below, exactly like `--api-key`.
const VALUE_FLAGS = new Map([
  ["--namespace", "namespace"],
  ["--display-name", "displayName"],
  ["--public-origin", "publicOrigin"],
  ["--provider", "provider"],
  ["--admin-email", "adminEmail"],
  ["--admin-name", "adminName"],
]);

/** Every flag this command accepts a value for. See SECRET_FLAG_PATTERN. */
export const PROVISION_VALUE_FLAGS = Object.freeze([...VALUE_FLAGS.keys()]);

export function parseProvisionInstanceArgs(argv) {
  const parsed = {
    namespace: undefined,
    displayName: undefined,
    publicOrigin: undefined,
    provider: undefined,
    adminEmail: undefined,
    adminName: undefined,
  };

  // A LEADING bare `--` is the package manager's, not the operator's:
  // `pnpm provision:dev-instance -- --namespace acme-dev` is the invocation
  // this command documents, and the pinned pnpm forwards the separator to the
  // script verbatim. It is dropped in the first position and nowhere else, so
  // a `--` the operator typed later is still an unknown argument, and a `--`
  // standing in a VALUE position is still that flag's value.
  const tokens = argv.length > 0 && String(argv[0]) === "--" ? argv.slice(1) : argv;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i]);
    if (!token.startsWith("--")) {
      // The token is NOT echoed: a stray positional is exactly the shape an
      // accidentally-pasted credential takes, and this message is printed.
      throw new Error(
        `a bare argument was given at position ${i + 1} — every argument is a --flag with a value. ` +
          SECRET_TRAVEL_RULE,
      );
    }
    const [flag, inlineValue] = splitFlag(token);
    if (!VALUE_FLAGS.has(flag)) {
      if (SECRET_FLAG_PATTERN.test(flag)) throw new SecretInArgumentsError(flag);
      throw new Error(`unknown argument "${flag}".`);
    }
    const value = inlineValue ?? tokens[(i += 1)];
    if (value === undefined) throw new Error(`"${flag}" needs a value.`);
    parsed[VALUE_FLAGS.get(flag)] = String(value).trim();
  }

  if (parsed.provider !== undefined && !PROVISIONABLE_PROVIDERS.includes(parsed.provider)) {
    // The given value is NOT echoed, for the same reason as above.
    throw new Error(
      `"--provider" must be one of: ${PROVISIONABLE_PROVIDERS.join(", ")}.`,
    );
  }
  return parsed;
}

function splitFlag(token) {
  const equals = token.indexOf("=");
  return equals === -1 ? [token, undefined] : [token.slice(0, equals), token.slice(equals + 1)];
}

/** Secrets stored EXACTLY as given. A password is bytes, not a name. */
const UNTRIMMED_SECRET_KEYS = Object.freeze(["adminPassword"]);

const SECRET_KEYS = Object.freeze([
  "providerApiKey",
  "providerProjectId",
  "providerOrganizationId",
  "connectorServiceSecretKey",
  "connectorServiceUrl",
  // The first administrator's password. The ADDRESS travels as an ordinary
  // flag beside it; only the password comes this way.
  "adminPassword",
]);

/**
 * The stdin document. Empty stdin means "no secrets this run" — a legitimate
 * call (setting only the namespace and the public origin), not a parse error.
 */
export function parseProvisionSecretsPayload(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) return {};

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // The message must never echo the document — it holds the secrets.
    throw new Error(
      "the secrets document on stdin could not be read as JSON. Expected an object with " +
        `these keys: ${SECRET_KEYS.join(", ")}.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the secrets document on stdin must be a JSON object.");
  }
  for (const key of Object.keys(parsed)) {
    if (!SECRET_KEYS.includes(key)) {
      throw new Error(
        `unknown key "${key}" in the secrets document on stdin. Expected: ${SECRET_KEYS.join(", ")}.`,
      );
    }
  }
  const out = {};
  for (const key of SECRET_KEYS) {
    const value = parsed[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new Error(`"${key}" must be a string.`);

    if (UNTRIMMED_SECRET_KEYS.includes(key)) {
      // A PASSWORD IS BYTES, NOT A NAME. Trimming one stores a different secret
      // than the operator typed, and the account then refuses the password they
      // wrote down, with nothing anywhere to say why. A blank one is REFUSED
      // rather than dropped as "absent": "absent" would send the operator
      // hunting for a key that is right there in the document.
      if (value.trim().length === 0) {
        throw new Error(
          `"${key}" on stdin is empty or only whitespace. It is stored exactly as given, so a ` +
            "blank one is refused rather than silently dropped. The value is not echoed.",
        );
      }
      out[key] = value;
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) out[key] = trimmed;
  }
  return out;
}

/**
 * The one line the command closes on, and the code it exits with.
 *
 * THE OUTCOME THAT MUST NOT LOOK LIKE SUCCESS: an account created but not
 * promoted. The instance did write something, so a plain "provisioned" would be
 * literally true and completely misleading — an unattended caller reads the
 * exit code, and would carry on against an instance whose operator has no
 * administrator rights.
 */
export function summarizeRunForExit(report) {
  const seat = report?.firstAdministrator ?? null;
  if (seat && seat.written && !seat.alreadySeated && !seat.administrator) {
    return {
      line:
        "done, but NOT finished — the administrator account was created and this instance " +
        "declined to promote it, so it is not an administrator. Nothing further was assumed.",
      exitCode: 1,
    };
  }
  return {
    line: report?.wrote
      ? "done — the instance was provisioned."
      : "done — nothing to do; the instance already stood.",
    exitCode: 0,
  };
}

/** PRESENCE, never a value — this is the only thing the command says about a
 *  secret, and it is what the log line is built from. */
export function summarizeSecretsForLog(payload) {
  const present = (value) => (value ? "supplied" : "absent");
  return [
    `provider API key: ${present(payload?.providerApiKey)}`,
    `connector-service secret: ${present(payload?.connectorServiceSecretKey)}`,
    `administrator password: ${present(payload?.adminPassword)}`,
  ].join(", ");
}

/** Read a whole readable stream as UTF-8 (stdin, in practice). */
export async function readAllText(stream) {
  if (stream.isTTY) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Is this module file the one the process was STARTED with?
 *
 * The command file is both the command and a module the suite drives, so it
 * must run its own body only when it IS the command. Paths are compared through
 * `realpathSync` in both directions, because a package script names the file
 * relative to the repository root while the loader reports a resolved URL, and
 * a checkout may sit behind a symlink. A path that is not there resolves as
 * itself rather than throwing: an entry point that does not exist is simply not
 * this file.
 */
export function isCommandEntryPoint(entry, moduleUrl) {
  if (typeof entry !== "string" || entry.length === 0) return false;
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  try {
    return real(path.resolve(entry)) === real(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
