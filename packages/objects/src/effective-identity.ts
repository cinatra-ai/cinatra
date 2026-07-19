import { objectTypeRegistry } from "./registry";
import { claimedTypeRegisteringPackage } from "./claims";

// ---------------------------------------------------------------------------
// Effective-identity resolution — the type-driven dependency resolver
// (epic #1785, "retire the generic default-artifact base; types come from
// installed extensions only").
//
// A row's identity is now a pure function of its object TYPE: the namespace-
// defining extension of the type id, but ONLY while that type is installed
// (registered in the in-process object-type registry). There is no per-org
// claim arbitration, no binding/classic precedence, no activation barrier, and
// no default-artifact floor — the whole DB-claim truth table this file used to
// encode (cinatra#1426) is retired here. The `semantic_assertion` /
// `artifact_type_claims` rows survive as inert legacy state until the A6 purge;
// nothing in identity resolution reads them anymore.
//
//   type → namespace-definer → installed?  →  { kind:"extension", extension }
//                                          else NO PRIMARY  { kind:"no-primary" }
//
// "installed" is process-global registry membership (the same signal the A1
// type-driven disposition resolver uses): a live type has a registered
// definition; an uninstalled extension's types are removed on teardown
// (`removeByPackage`), so `resolve() == null` fails closed to no-primary. The
// generic artifact catch-all type has NO defining extension (it is the retired
// host built-in) and always resolves to no-primary.
//
// Zero React / DB / server-only imports — the registry + the namespace helper
// are pure, so this leaf stays safe anywhere in the module graph.
// ---------------------------------------------------------------------------

/** `semantic_assertion.assertion_basis` value set (mirrored by the DDL CHECK
 * `sa_basis_chk` — the migration/bootstrap contract test asserts sync). The
 * `semantic_assertion` table is KEPT legacy plumbing (the context-selection
 * write path still persists rows) until the A6 purge, so its column vocabulary
 * stays declared here. */
export const ASSERTION_BASES = ["binding", "classic"] as const;
export type AssertionBasis = (typeof ASSERTION_BASES)[number];

/** The ONE generic artifact base type. Mirrors
 * `SEMANTIC_ARTIFACT_OBJECT_TYPE` in `@cinatra-ai/artifacts` (this package
 * cannot depend on that one; the graphiti-projector precedent already names
 * the literal). The host-side parity test pins the two constants equal. */
export const GENERIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

/**
 * The resolved identity of an artifact row (epic #1785).
 *   - `extension` — the type's defining extension (its namespace-definer),
 *     installed. This is the ONLY selectable/renderable identity.
 *   - `no-primary` — no installed defining extension: the generic catch-all
 *     type, an uninstalled extension's type, or an unregistered type id. The
 *     row is browsable and openable via the generic floor, but has no primary
 *     extension.
 */
export type EffectiveIdentity =
  | { kind: "extension"; extension: string }
  | { kind: "no-primary" };

/**
 * Resolve one artifact's effective identity from its object type. Total:
 * every type lands on exactly one outcome — the defining extension when the
 * type is installed and namespaced, no-primary otherwise. Never throws.
 *
 * The generic artifact catch-all is special-cased to no-primary: it is
 * registered as a host built-in (so `resolve()` is non-null) and its id
 * namespace (`@cinatra-ai/artifact`) is not an installed extension — it has no
 * defining extension by construction.
 */
export function resolveEffectiveIdentity(baseType: string): EffectiveIdentity {
  if (baseType === GENERIC_ARTIFACT_OBJECT_TYPE) return { kind: "no-primary" };
  // Fail closed: an unregistered / uninstalled definer has no identity.
  if (objectTypeRegistry.resolve(baseType) == null) return { kind: "no-primary" };
  // The namespace-defining extension of the type id (`@scope/pkg:slug` →
  // `@scope/pkg`). Host work-product types (e.g. `@cinatra-ai/email:body`) are
  // registered without provenance, so the registry's `getRegisteringPackage`
  // is null for them — the id NAMESPACE is the durable definer, not the
  // (optional) registration provenance.
  const definer = claimedTypeRegisteringPackage(baseType);
  return definer != null ? { kind: "extension", extension: definer } : { kind: "no-primary" };
}
