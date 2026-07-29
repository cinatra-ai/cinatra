// The generic, KIND-AGNOSTIC `protected` flag of the extension DECLARATION
// (`cinatra/config.json`) — cinatra#1927.
//
// An extension package MAY declare itself PROTECTED:
//
//     { "formatVersion": 1, "protected": true, "assistant": { … } }
//
// `protected` is a TOP-LEVEL declaration domain, deliberately NOT nested inside
// the `assistant` block: protection is a property of the EXTENSION, not of the
// assistant it happens to carry, so a connector / artifact / skill / workflow
// package declares it exactly the same way. The host refuses every
// uninstall/delete of an extension whose declaration carries `protected:true`
// (see `@cinatra-ai/extensions/protected-extension`) — a server-side refusal on
// EVERY removal path, never a hidden UI affordance.
//
// The flag is DECLARED BY THE PACKAGE, never named by the host: core carries no
// list of protected package names (that would be an extension-INSTANCE coupling
// — see scripts/audit/core-extension-instance-coupling-ban.mjs, whose baseline
// is pinned empty). Protection is therefore inverted-control like every other
// capability: the package declares, the host enforces.
//
// FAIL-CLOSED, like the sibling declaration domains (`access` in
// `access-config.ts`, `assistant` in `assistant-declaration.ts`): the key is
// OPTIONAL, but when present it must be a real boolean — a `"true"` string, a
// `1`, or an object is a declaration ERROR, never a silent truthy/falsy
// coercion. Absent ⇒ NOT protected (today's behavior for every package).
//
// This module owns ONLY the `protected` domain. The two file-level parsers
// (`access-config.ts`, `assistant-declaration.ts`) both validate the SAME
// `cinatra/config.json`, so both accept the key structurally via
// {@link extensionProtectedFlagSchema}; neither interprets it.
//
// zod v4 (optional peerDependency — same precedent as `access-config.ts`).

import { z } from "zod";

/** The declaration's top-level protection key. */
export const EXTENSION_PROTECTION_KEY = "protected" as const;

/**
 * The `protected` field schema — a strict boolean. Shared BY REFERENCE with the
 * two file-level declaration schemas so the accepted shape can never drift
 * between the connector parser, the assistant parser, and this domain parser.
 */
export const extensionProtectedFlagSchema = z.boolean();

/** Raised by {@link parseDeclaredProtection} on a malformed `protected` key. */
export class ExtensionProtectionDeclarationError extends Error {
  readonly code = "INVALID_PROTECTION_DECLARATION";
  constructor(message: string) {
    super(`[extension-protection] ${message}`);
    this.name = "ExtensionProtectionDeclarationError";
  }
}

export type ParseDeclaredProtectionResult =
  | { ok: true; protected: boolean }
  | { ok: false; error: string };

/**
 * Resolve the declared protection of a parsed `cinatra/config.json` value (the
 * caller owns file IO). Discriminated-result form so a scan/gate can surface a
 * field-level message without a throw.
 *
 * - a non-object / null `raw` ⇒ `{ ok:true, protected:false }` (this domain
 *   parser never owns the top-level shape — the file parsers do; an absent or
 *   unreadable config simply declares no protection);
 * - `protected` absent or `undefined` ⇒ `{ ok:true, protected:false }`;
 * - `protected` a boolean ⇒ that value;
 * - anything else ⇒ `{ ok:false }` (fail-closed: never coerced).
 */
export function safeParseDeclaredProtection(
  raw: unknown,
  opts: { packageName: string },
): ParseDeclaredProtectionResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: true, protected: false };
  }
  if (!(EXTENSION_PROTECTION_KEY in raw)) return { ok: true, protected: false };
  const value = (raw as Record<string, unknown>)[EXTENSION_PROTECTION_KEY];
  if (value === undefined) return { ok: true, protected: false };
  const parsed = extensionProtectedFlagSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        `invalid cinatra/config.json for ${opts.packageName}: \`${EXTENSION_PROTECTION_KEY}\` ` +
        `must be a boolean (got ${JSON.stringify(value)}) — fail-closed, never coerced`,
    };
  }
  return { ok: true, protected: parsed.data };
}

/**
 * Throwing form of {@link safeParseDeclaredProtection}. This is the entry the
 * host install/removal seams use (fail-closed): a malformed `protected` key is
 * an {@link ExtensionProtectionDeclarationError}, never a silent `false`.
 */
export function parseDeclaredProtection(
  raw: unknown,
  opts: { packageName: string },
): boolean {
  const result = safeParseDeclaredProtection(raw, opts);
  if (!result.ok) throw new ExtensionProtectionDeclarationError(result.error);
  return result.protected;
}

/** Cheap presence probe — does this parsed config declare the key at all?
 *  Does NOT validate it (mirrors `hasAssistantBlock`). */
export function hasProtectionDeclaration(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    EXTENSION_PROTECTION_KEY in raw &&
    (raw as Record<string, unknown>)[EXTENSION_PROTECTION_KEY] !== undefined
  );
}
