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
 * INJECTIVE, `__`-free encoding of the FULL package name (scope INCLUDED) into
 * the env-namespace segment used in `CINATRA_EXT_<NAMESPACE>__<KEY>`. Each
 * source character maps to a fixed token: an alphanumeric passes through
 * (uppercased), and each of the four package-name separators becomes `_` + a
 * distinct MARKER LETTER:
 *   `-` -> `_H`   `_` -> `_U`   `.` -> `_D`   `/` -> `_S`
 * (the leading `@` scope sigil is dropped first).
 *
 * Two properties make this a sound per-extension isolation boundary — the two a
 * naive "collapse every non-alphanumeric run to a single `_`" derivation LACKS:
 *
 *  1. INJECTIVE. A collapsing derivation is lossy: `-`, `_`, `.`, and the scope
 *     separator `/` all fold to `_`, so DIFFERENT packages — including packages
 *     in DIFFERENT (independently-owned) scopes — collide. `@acme-foo/bar`,
 *     `@acme/foo-bar`, and `@acme/foo_bar` all collapse to `ACME_FOO_BAR`,
 *     letting an extension in one scope claim an env key namespaced to another.
 *     Distinct tokens per separator make the encoding reversible ⇒ injective ⇒
 *     no two distinct package names share a namespace (`ACME_HFOO_SBAR` /
 *     `ACME_SFOO_HBAR` / `ACME_SFOO_UBAR` — all distinct).
 *
 *  2. `__`-FREE. Every `_` this emits is immediately followed by a marker
 *     LETTER (never another `_`), and a valid npm name neither starts/ends with
 *     a separator nor is empty — so the output never contains a double
 *     underscore. That is what lets the KEY be delimited by `__` (below)
 *     WITHOUT a shorter package's namespace being a string-prefix of a longer
 *     one's (the prefix-escalation `@acme/foo` -> `@acme/foo-bar` hole).
 *
 * Marketplace package names are validated `[a-z0-9._/-]` (+ scope), so the
 * fallback below is unreachable for a real record; it stays injective-safe and
 * `__`-free defensively (marker letter, never a trailing `_`).
 */
const NS_SEPARATOR_MARKERS: Readonly<Record<string, string>> = {
  "-": "_H",
  _: "_U",
  ".": "_D",
  "/": "_S",
};

export function envNamespaceForPackage(packageName: string): string {
  let out = "";
  for (const ch of packageName.replace(/^@/, "")) {
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")) {
      out += ch.toUpperCase();
    } else {
      out += NS_SEPARATOR_MARKERS[ch] ?? `_Q${ch.codePointAt(0)!.toString(16).toUpperCase()}Q`;
    }
  }
  return out;
}

/**
 * The required prefix a namespaced env var must start with for `packageName`.
 * The `__` (DOUBLE underscore) terminator is load-bearing: combined with the
 * `__`-free namespace above it guarantees no package's prefix is a string
 * prefix of another's namespaced key (see `envNamespaceForPackage`).
 */
export function envNamespacePrefixForPackage(packageName: string): string {
  return `CINATRA_EXT_${envNamespaceForPackage(packageName)}__`;
}

/** True iff `envKey` is namespaced to `packageName` (the always-allowed form,
 * regardless of trust/resolution tier). Requires a NON-EMPTY key after the
 * `__` terminator (the prefix alone, with no key, is not a valid claim). */
export function isNamespacedEnvKey(packageName: string, envKey: string): boolean {
  const prefix = envNamespacePrefixForPackage(packageName);
  return envKey.length > prefix.length && envKey.startsWith(prefix);
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
