// Connector access-scoping declaration (`cinatra/config.json`) — the SINGLE
// authoritative schema + validator for the connector access-scoping epic
// (cinatra#950, W1 foundation cinatra#951).
//
// A `kind:"connector"` extension ships a package-root `cinatra/config.json`:
//
//     { "formatVersion": 1,
//       "access": { "scope": { "default": "user" } } }   // recommendation
//     // XOR
//     { "formatVersion": 1,
//       "access": { "scope": { "only": "admin" } } }     // exclusive, locked
//
// Vocabulary (full, day one): user | project | team | organization |
// workspace | admin. `default` is a RECOMMENDATION (pre-selected at connect
// time, freely changeable); `only` is EXCLUSIVE (the only scope that may ever
// have access; server-enforced).
//
// FAIL-CLOSED validation contract (cinatra#950):
//   - unknown TOP-LEVEL domains hard-fail (future config domains land as
//     siblings of `access` under a bumped/known `formatVersion`);
//   - unknown keys INSIDE known domains hard-fail (a misspelled `scpoe` never
//     silently falls back);
//   - `default` + `only` both present = error; neither present = error;
//   - a non-vocabulary scope token = error;
//   - `formatVersion` must be EXACTLY 1 (an unknown future version fails
//     closed rather than being half-understood).
//
// ABSENCE semantics (closing wave, cinatra#955): an absent FILE hard-fails at
// EVERY surface — submit and install. The W1 staging leniency (install-surface
// absence resolving `default:"admin"` / the forced protected value) existed
// only so pre-config tarballs stayed installable until the W4 fleet republish;
// the 29-connector fleet now ships `cinatra/config.json`, so absence is a
// refusal, not a default. A PRESENT file that validates but declares no
// `access.scope` still resolves `default:"admin"` (the strictest tier —
// fail-closed by construction; protected slugs must still DECLARE).
//
// PROTECTED SLUGS (validator-forced): `openai`, `anthropic`, `gemini` MUST
// declare `only:"admin"` — a declaration with anything else hard-fails at
// every surface.
//
// This module is the shared source for the host (install pipeline +
// registration/materialize reader) and the marketplace submit gate. The
// self-contained per-repo `extension-kind-gate.mjs` MIRRORS these rules (it
// must stay zero-dependency); `scripts/audit/connector-access-config-gate.mjs`
// mirrors them too and a proof-fixture test pins the mirrors in agreement.
//
// zod v4 (optional peerDependency — same precedent as `objects-contract.ts`):
// `.strict()` objects give the fail-closed unknown-key behavior at every
// nesting level.

import { z } from "zod";

/** The full platform scope vocabulary, day one (cinatra#950). */
export const CONNECTOR_ACCESS_SCOPES = [
  "user",
  "project",
  "team",
  "organization",
  "workspace",
  "admin",
] as const;
export type ConnectorAccessScope = (typeof CONNECTOR_ACCESS_SCOPES)[number];

/** The only `formatVersion` this validator understands. Unknown = hard-fail. */
export const CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION = 1;

/**
 * Protected slugs, validator-forced (cinatra#950): the LLM-key connectors are
 * `only:"admin"` — a submission/declaration with anything else fails.
 * (gmail's `default:"user"` is the W4 fleet-final value, deliberately NOT
 * validator-forced in W1 — codex round-0 finding 1.)
 */
export const PROTECTED_CONNECTOR_SLUGS: Readonly<
  Record<string, { readonly mode: "only"; readonly scope: ConnectorAccessScope }>
> = Object.freeze({
  openai: { mode: "only", scope: "admin" },
  anthropic: { mode: "only", scope: "admin" },
  gemini: { mode: "only", scope: "admin" },
});

const scopeToken = z.enum(CONNECTOR_ACCESS_SCOPES);

// `.strict()` at EVERY level — unknown keys hard-fail (fail-closed contract).
const scopeObjectSchema = z
  .object({
    default: scopeToken.optional(),
    only: scopeToken.optional(),
  })
  .strict();

const accessDomainSchema = z
  .object({
    scope: scopeObjectSchema.optional(),
  })
  .strict();

const configFileSchema = z
  .object({
    formatVersion: z.literal(CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION),
    access: accessDomainSchema.optional(),
  })
  .strict();

/** The parsed, declared file shape (post-validation). */
export type ConnectorAccessConfig = z.infer<typeof configFileSchema>;

/**
 * The RESOLVED declaration the host caches on the registration record
 * (`installed_extension.access_declaration`) at registration/materialize.
 * `source` records HOW it resolved: `"declared"` from a shipped file,
 * `"absent"` from the pre-cutover absence rule (only on rows cached before
 * cinatra#955 — the absence rule now refuses instead of resolving).
 */
export type ResolvedConnectorAccessDeclaration = {
  formatVersion: typeof CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION;
  mode: "default" | "only";
  scope: ConnectorAccessScope;
  source: "declared" | "absent";
};

export class ConnectorAccessConfigError extends Error {
  constructor(message: string) {
    super(`[connector-access-config] ${message}`);
    this.name = "ConnectorAccessConfigError";
  }
}

/**
 * Canonical package-name → access-slug normalizer (codex round-0 finding 3):
 * `@cinatra-ai/openai-connector` → `openai`, `openai-connector` → `openai`,
 * `openai` → `openai`. Every enforcement surface (host, generator, gates)
 * derives the protected-slug key through THIS function so the rule cannot be
 * dodged by passing a differently-shaped name.
 */
export function connectorAccessSlugFromPackageName(packageName: string): string {
  const base = packageName.startsWith("@")
    ? packageName.split("/")[1] ?? packageName
    : packageName;
  return base.endsWith("-connector") ? base.slice(0, -"-connector".length) : base;
}

function assertProtectedSlugRule(
  slug: string,
  declared: { mode: "default" | "only"; scope: ConnectorAccessScope },
): void {
  const forced = PROTECTED_CONNECTOR_SLUGS[slug];
  if (!forced) return;
  if (declared.mode !== forced.mode || declared.scope !== forced.scope) {
    throw new ConnectorAccessConfigError(
      `protected slug "${slug}" must declare access.scope.${forced.mode}:"${forced.scope}" ` +
        `(got ${declared.mode}:"${declared.scope}").`,
    );
  }
}

/**
 * Validate a parsed `cinatra/config.json` value (the caller owns file IO) and
 * resolve it to the declaration. Fail-LOUD: throws
 * `ConnectorAccessConfigError` on ANY structural violation — unknown keys at
 * any level, wrong `formatVersion`, both/neither of `default`/`only`, a
 * non-vocabulary scope token, or a protected-slug violation.
 *
 * An object that VALIDATES but declares no `access.scope` (absent `access`
 * or absent `scope`) resolves via the absence rule for the slug
 * (`resolveAbsentConnectorAccessConfig` with `surface:"install"` semantics
 * does NOT apply here — a PRESENT file with an absent scope resolves
 * `default:"admin"`, then the protected-slug rule still applies, so a
 * protected slug cannot ship a scope-less file).
 */
export function parseConnectorAccessConfig(
  raw: unknown,
  opts: { packageName: string },
): ResolvedConnectorAccessDeclaration {
  const slug = connectorAccessSlugFromPackageName(opts.packageName);
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConnectorAccessConfigError(
      `invalid cinatra/config.json for ${opts.packageName}: ${detail}`,
    );
  }
  const scope = parsed.data.access?.scope;
  if (!scope) {
    // Present file, absent access.scope → the absence rule (default:"admin");
    // the protected-slug rule still applies (a protected slug must DECLARE).
    const resolved: ResolvedConnectorAccessDeclaration = {
      formatVersion: CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION,
      mode: "default",
      scope: "admin",
      source: "declared",
    };
    assertProtectedSlugRule(slug, resolved);
    return resolved;
  }
  const hasDefault = scope.default !== undefined;
  const hasOnly = scope.only !== undefined;
  if (hasDefault && hasOnly) {
    throw new ConnectorAccessConfigError(
      `access.scope must declare EXACTLY ONE of "default" / "only" for ${opts.packageName} (both present).`,
    );
  }
  if (!hasDefault && !hasOnly) {
    throw new ConnectorAccessConfigError(
      `access.scope must declare EXACTLY ONE of "default" / "only" for ${opts.packageName} (neither present).`,
    );
  }
  const resolved: ResolvedConnectorAccessDeclaration = hasOnly
    ? {
        formatVersion: CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION,
        mode: "only",
        scope: scope.only as ConnectorAccessScope,
        source: "declared",
      }
    : {
        formatVersion: CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION,
        mode: "default",
        scope: scope.default as ConnectorAccessScope,
        source: "declared",
      };
  assertProtectedSlugRule(slug, resolved);
  return resolved;
}

/**
 * The absence rule, post-cutover (closing wave, cinatra#955): a
 * `kind:"connector"` package that ships NO `cinatra/config.json` is REFUSED at
 * every surface — submit (marketplace/kind gates) and install
 * (host install/registration) alike. The W1 install-surface leniency
 * (absence resolving `default:"admin"` / the forced protected value so
 * pre-config tarballs stayed installable) is deliberately deleted now that the
 * W4 fleet republish ships a declared config on all 29 finals.
 *
 * The function is kept (rather than deleted) so every surface keeps routing
 * absence through the ONE authoritative rule — and so the per-repo gate
 * mirrors keep a single upstream to mirror.
 */
export function resolveAbsentConnectorAccessConfig(
  opts: { packageName: string; surface: "submit" | "install" },
): never {
  const slug = connectorAccessSlugFromPackageName(opts.packageName);
  const forced = PROTECTED_CONNECTOR_SLUGS[slug];
  const declareHint = forced
    ? `declaring ${forced.mode}:"${forced.scope}" (protected slug "${slug}")`
    : `declaring an access.scope`;
  throw new ConnectorAccessConfigError(
    `${opts.packageName} ships no cinatra/config.json — absence is not accepted at ` +
      `${opts.surface} (connector-scoping closing wave, cinatra#955); ship a config ${declareHint}.`,
  );
}

/**
 * 2-tier projection of a resolved declaration onto the connector-card
 * visibility axis the host policy gate and install defaults use: the `admin`
 * scope stays admin-only; every non-admin scope projects to the `workspace`
 * tier (the scope token itself still governs connect-time pre-selection and
 * the connection `only` ceiling — this projection never widens it).
 */
export function connectorAccessVisibilityTier(
  declaration: Pick<ResolvedConnectorAccessDeclaration, "scope">,
): "admin" | "workspace" {
  return declaration.scope === "admin" ? "admin" : "workspace";
}

/**
 * Structural guard for a PERSISTED resolved declaration (the cached value on
 * the registration record round-trips through jsonb) — used by the canonical
 * writer so a malformed cached value can never reach the row.
 *
 * `source:"absent"` stays ACCEPTED here even though the absence rule now
 * refuses (cinatra#955): rows cached before the cutover legitimately carry it,
 * and rejecting them would turn every pre-cutover cache into a corrupt-cache
 * deny. New caches are always `source:"declared"`.
 */
export function isResolvedConnectorAccessDeclaration(
  value: unknown,
): value is ResolvedConnectorAccessDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.formatVersion === CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION &&
    (v.mode === "default" || v.mode === "only") &&
    typeof v.scope === "string" &&
    (CONNECTOR_ACCESS_SCOPES as readonly string[]).includes(v.scope) &&
    (v.source === "declared" || v.source === "absent") &&
    Object.keys(v).length === 4
  );
}
