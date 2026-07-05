// Manifest-declared env-override layer (cinatra#982) — pure validation.
//
// An extension may declare `cinatra.envOverrides` in its own manifest: a map
// from a process-environment variable NAME to the settings/secrets KEY it
// overrides, e.g. `{"NANGO_SERVER_URL": "settings:serverUrl", "NANGO_SECRET_KEY":
// "secrets:secretKey"}`. The HOST's `settings`/`secrets` port implementation
// (never this module) reads `process.env` and serves env-first-else-DB
// precedence — this module only VALIDATES the declaration; it never touches
// `process.env` itself (host-agnostic + testable without a process).
//
// SECURITY GUARD (the doctrine this module enforces): an extension may only
// claim ownership of an env-var NAME that is either
//   (a) NAMESPACED to itself — `CINATRA_EXT_<PKG>_*` (derived from its own
//       package name, so no extension can claim another's namespace), or
//   (b) a LEGACY (non-namespaced) name, and ONLY when the caller asserts
//       `allowLegacyNames` — reserved for a `resolution: "required"` system
//       extension (the host-locked, signed-in-effect `systemExtensions` set;
//       see `cinatra.systemExtensions` / `ExtensionResolution`). This is what
//       prevents a marketplace extension from mapping arbitrary host env (e.g.
//       `DATABASE_URL`) into itself by simply declaring it in its manifest —
//       the manifest is data, but eligibility for a legacy name is a host-owned
//       verdict, not a self-declaration.
//
// Fail-closed: any entry that fails validation is DROPPED (returned under
// `rejected`, never `overrides`) — a malformed or over-reaching declaration
// never silently activates a mapping.

/** Where an overridden env value is served from. */
export type EnvOverridePort = "settings" | "secrets";

/** A single validated env-override mapping target. */
export type EnvOverrideTarget = {
  port: EnvOverridePort;
  key: string;
};

/** envVarName -> validated target. */
export type EnvOverrideMap = Record<string, EnvOverrideTarget>;

export type EnvOverrideRejection = {
  envKey: string;
  reason: string;
};

export type EnvOverrideValidation = {
  overrides: EnvOverrideMap;
  rejected: EnvOverrideRejection[];
};

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const TARGET_RE = /^(settings|secrets):(.+)$/;

/** Parse a raw `"settings:<key>"` / `"secrets:<key>"` target string. `null` on
 * any other shape (fail-closed — never guesses a port). */
export function parseEnvOverrideTarget(raw: string): EnvOverrideTarget | null {
  if (typeof raw !== "string") return null;
  const m = TARGET_RE.exec(raw);
  if (!m) return null;
  const key = m[2].trim();
  if (!key) return null;
  return { port: m[1] as EnvOverridePort, key };
}

/**
 * The namespace segment a package's env vars must be prefixed with:
 * `CINATRA_EXT_<NAMESPACE>_`. Derived from the FULL package name — scope
 * INCLUDED (e.g. `@acme/acme-crm` -> `ACME_ACME_CRM`) — uppercased with every
 * non-alphanumeric run collapsed to a single underscore.
 *
 * Deliberately NOT derived from just the last path segment: two DIFFERENT
 * scopes can publish a same-named package slug (`@trusted/foo-bar` and
 * `@attacker/foo_bar` both normalize their slug to `FOO_BAR`), which would let
 * one extension's manifest claim a namespaced env key that collides with
 * another's — defeating the "no arbitrary env" guard via a scope-squatted
 * slug. Including the scope makes the derived namespace as unique as the
 * (marketplace-unique) package name itself, so no separate registry lookup is
 * needed here.
 */
export function envNamespaceForPackage(packageName: string): string {
  return packageName
    .replace(/^@/, "") // drop the leading scope sigil so it doesn't produce a stray leading "_"
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
}

/** The required prefix a namespaced env var must start with for `packageName`. */
export function envNamespacePrefixForPackage(packageName: string): string {
  return `CINATRA_EXT_${envNamespaceForPackage(packageName)}_`;
}

/** True iff `envKey` is namespaced to `packageName` (the always-allowed form,
 * regardless of trust/resolution tier). */
export function isNamespacedEnvKey(packageName: string, envKey: string): boolean {
  return envKey.startsWith(envNamespacePrefixForPackage(packageName));
}

/**
 * Validate a raw `cinatra.envOverrides` declaration for `packageName`.
 * Fail-closed per-entry (a bad entry is dropped into `rejected`, never
 * silently coerced) — a caller consumes `overrides` for the effective mapping
 * and MAY surface `rejected` via its own logger.
 *
 * `allowLegacyNames` — pass `true` ONLY for a host-verified eligible extension
 * (today: `resolution === "required"`, the host-locked system-extension set).
 * When `false`, only namespaced (`CINATRA_EXT_<PKG>_*`) env keys validate.
 */
export function validateEnvOverrides(
  packageName: string,
  raw: Record<string, string> | null | undefined,
  opts: { allowLegacyNames: boolean },
): EnvOverrideValidation {
  const overrides: EnvOverrideMap = {};
  const rejected: EnvOverrideRejection[] = [];
  if (!raw || typeof raw !== "object") return { overrides, rejected };

  for (const [envKey, rawTarget] of Object.entries(raw)) {
    if (typeof envKey !== "string" || !ENV_KEY_RE.test(envKey)) {
      rejected.push({
        envKey: String(envKey),
        reason: "not a valid env-var name (must match [A-Z][A-Z0-9_]*)",
      });
      continue;
    }
    const target = parseEnvOverrideTarget(rawTarget);
    if (!target) {
      rejected.push({
        envKey,
        reason: `invalid target ${JSON.stringify(rawTarget)} — expected "settings:<key>" or "secrets:<key>"`,
      });
      continue;
    }
    const namespaced = isNamespacedEnvKey(packageName, envKey);
    if (!namespaced && !opts.allowLegacyNames) {
      rejected.push({
        envKey,
        reason:
          `"${envKey}" is not namespaced (must start with "${envNamespacePrefixForPackage(packageName)}") ` +
          `and this extension is not eligible for legacy-name grandfathering (required system extensions only)`,
      });
      continue;
    }
    overrides[envKey] = target;
  }

  return { overrides, rejected };
}

/** Split a validated `EnvOverrideMap` into per-port reverse lookup maps
 * (settings/secrets KEY -> env var NAME) — what the host settings/secrets port
 * factories consume to check "does this key have an env override?". */
export function splitEnvOverridesByPort(overrides: EnvOverrideMap): {
  settings: Record<string, string>;
  secrets: Record<string, string>;
} {
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [envKey, target] of Object.entries(overrides)) {
    (target.port === "settings" ? settings : secrets)[target.key] = envKey;
  }
  return { settings, secrets };
}
