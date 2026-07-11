// The opt-in setup-form hydration read-action contract (owner-ratified;
// cinatra#1082 item 3).
//
// A `schema-config` connector persists its saved configuration under its own
// connector-chosen settings key, so the host has no generic source of saved
// values when it renders the connector's setup form — the form's
// `initialValues` default to `{}` (a blank form). This contract is that
// source: a connector MAY declare, at the ROOT of its `cinatra.configSchema`,
// the id of ONE `ctx.ui`-registered named action the HOST invokes SERVER-SIDE
// while rendering the setup page. The action returns the saved NON-SECRET
// values keyed by declared field key; the host sanitizes them (see
// `sanitizeConfigHydrationValues`) and threads them in as the form's
// `initialValues`.
//
// Contract properties (each one deliberate — the ratified shape):
// - OPT-IN per connector. A connector that declares nothing keeps today's
//   empty-form behavior, unchanged (zero regression).
// - NON-SECRET ONLY. Secret fields are never hydrated: the host drops a
//   secret field's key from the sanitized result REGARDLESS of what the
//   action returns (the sanitizer's `secretKeys` set wins over
//   `hydratableKeys` on collision — defense in depth).
// - FAIL-CLOSED. Action missing, erroring, timing out, or returning a
//   malformed top-level result → the form simply gets `{}`. A well-formed
//   result with SOME invalid entries keeps the valid entries and drops the
//   invalid ones. Hydration failure never blocks or breaks the setup page.
// - SERVER-INVOKED AT RENDER. The hydration FLOW never calls the action from
//   the browser: the setup route resolves values server-side. (This is a
//   call-path property of the host render seam, not a dispatch ban — like
//   every `ctx.ui`-registered action, the id remains addressable through the
//   host's authorized generic action endpoint.)
// - IDEMPOTENT READ. Because the host invokes the action on every setup-page
//   render (and bounds it with a timeout that does NOT cancel the underlying
//   call), the declared action must be a side-effect-free read.
//
// PURE + IO-free: the SDK owns the contract SHAPE; the host owns invocation,
// authorization, and the schema vocabulary that validates the declaration.

/**
 * The `cinatra.configSchema` ROOT key a connector declares to opt in: its
 * value is the id of the connector's `ctx.ui`-registered hydration read-action
 * (same id grammar as every other declared actionId). The host schema-config
 * parser validates the declaration fail-closed against this exact key.
 */
export const CONFIG_HYDRATION_SCHEMA_KEY = "hydrateAction";

/**
 * A value the hydration action may return for one field key. The host
 * normalizes each to the setup form's flat string encoding:
 * string → as-is; boolean → `"true"`/`"false"`; finite number → `String(n)`;
 * `string[]` → JSON (the `free-list` wire encoding). Anything else is dropped.
 */
export type ConfigHydrationValue = string | number | boolean | string[];

/**
 * What a connector's hydration read-action returns: the saved NON-SECRET
 * values keyed by declared field key. Secret values must never be included —
 * and are refused by the host sanitizer even if they are.
 */
export type ConfigHydrationResult = Record<string, ConfigHydrationValue>;

/** The key sets `sanitizeConfigHydrationValues` filters against. */
export type ConfigHydrationKeySets = {
  /** Field keys the setup form can hydrate (non-secret, value-carrying kinds). */
  hydratableKeys: ReadonlySet<string>;
  /** Field keys that are secrets. ALWAYS refused, even if also listed hydratable. */
  secretKeys: ReadonlySet<string>;
};

// Keys whose assignment on a plain object mutates the prototype chain instead
// of (or in addition to) defining an own property. Refused unconditionally —
// the sanitizer must not depend on its caller's key grammar to stay
// pollution-safe (the SDK contract is public; hostile results are assumed).
const FORBIDDEN_RESULT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Exactly a plain object: `Object.prototype`- or `null`-prototyped — not an
 *  array, Date, Map, class instance, or other exotic object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Normalize one hydration value to the form's string encoding, or null to drop. */
function normalizeValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) {
    // Only a homogeneous string[] (the free-list wire encoding). A mixed or
    // nested array is dropped rather than partially serialized.
    return v.every((e) => typeof e === "string") ? JSON.stringify(v) : null;
  }
  return null;
}

/**
 * Sanitize a hydration action's raw result into the setup form's
 * `initialValues: Record<string, string>`. PURE and NEVER-THROWING, fail-closed:
 *
 * - Not exactly a plain object (null / primitive / array / Date / class
 *   instance / …) → `{}`.
 * - A key not in `hydratableKeys` → dropped.
 * - A key in `secretKeys` → dropped UNCONDITIONALLY (secret wins over
 *   hydratable on collision).
 * - `__proto__` / `constructor` / `prototype` keys → dropped unconditionally
 *   (prototype-pollution safety, independent of the caller's key grammar).
 * - A value that is not string | boolean | finite number | string[] → that
 *   entry is dropped; the remaining valid entries are kept.
 * - Hostile reflection anywhere (a Proxy with throwing `ownKeys` /
 *   `getOwnPropertyDescriptor`, a throwing getter, …) → `{}` (never a
 *   partial result, never a throw).
 */
export function sanitizeConfigHydrationValues(
  raw: unknown,
  keys: ConfigHydrationKeySets,
): Record<string, string> {
  try {
    if (!isPlainObject(raw)) return {};
    const out: Record<string, string> = {};
    // Own enumerable STRING keys only (Object.keys walks no prototype and
    // surfaces no symbol keys).
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN_RESULT_KEYS.has(key)) continue;
      if (keys.secretKeys.has(key)) continue; // secret wins — always refused
      if (!keys.hydratableKeys.has(key)) continue;
      const normalized = normalizeValue(raw[key]);
      if (normalized === null) continue;
      // `key` passed the forbidden-key check, so plain assignment defines an
      // own data property.
      out[key] = normalized;
    }
    return out;
  } catch {
    // Hostile reflection (throwing trap/getter) → fail closed to a blank form.
    return {};
  }
}
