// The ARGUMENT SURFACE of the development instance-provisioning command, kept
// dependency-free so it can be tested without the application graph.
//
// The one property this module exists to hold: there is NO flag that can carry
// a secret. A secret-looking flag is REFUSED rather than ignored, because an
// ignored `--api-key sk-…` is still a key in the shell history, in `ps`, and in
// whatever the shell logs. Secrets arrive on stdin.
//
// A refusal names the FLAG and never the value beside it: these messages are
// printed to the terminal, and a mistyped credential is exactly the thing that
// would otherwise be echoed there.

export const SECRET_TRAVEL_RULE =
  "Secret values (the provider key, the connector-service secret) reach this command " +
  "over stdin only — never as a command-line argument, never through an environment " +
  "file written to disk, never logged.";

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

/** Anything whose NAME suggests it carries a credential. */
const SECRET_FLAG_PATTERN = /(key|secret|token|password|credential|passphrase)/i;

const VALUE_FLAGS = new Map([
  ["--namespace", "namespace"],
  ["--display-name", "displayName"],
  ["--public-origin", "publicOrigin"],
  ["--provider", "provider"],
]);

export function parseProvisionInstanceArgs(argv) {
  const parsed = {
    namespace: undefined,
    displayName: undefined,
    publicOrigin: undefined,
    provider: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
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
    const value = inlineValue ?? argv[(i += 1)];
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

const SECRET_KEYS = Object.freeze([
  "providerApiKey",
  "providerProjectId",
  "providerOrganizationId",
  "connectorServiceSecretKey",
  "connectorServiceUrl",
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
    const value_ = value.trim();
    if (value_.length > 0) out[key] = value_;
  }
  return out;
}

/** PRESENCE, never a value — this is the only thing the command says about a
 *  secret, and it is what the log line is built from. */
export function summarizeSecretsForLog(payload) {
  const present = (value) => (value ? "supplied" : "absent");
  return [
    `provider API key: ${present(payload?.providerApiKey)}`,
    `connector-service secret: ${present(payload?.connectorServiceSecretKey)}`,
  ].join(", ");
}

/** Read a whole readable stream as UTF-8 (stdin, in practice). */
export async function readAllText(stream) {
  if (stream.isTTY) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
