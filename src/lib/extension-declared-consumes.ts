// The run-time half of `cinatra.consumes` (cinatra#4894): a pack may call, through
// `ctx.mcp.callPrimitive`, only the host primitives its manifest declares.
//
// The declared set is read from the pack's raw `cinatra.consumes` value, carried
// as a `ConsumesDeclaration` (`{ consumes?: <raw> }`, the manifest's own shape),
// and parsed at call time by `parseConsumedPrimitives` — the same reader the CI
// check (`scripts/audit/extension-produces-deps-gate.mjs`) follows — so the run
// time and the check read one declaration the same way. Both a "required" and an
// "optional" entry count as declared.
//
// Where the declaration comes from (the production image has no `extensions/`
// folder, so it is never read from pack sources here):
//   - a compiled-in pack: the generated map `GENERATED_EXTENSION_CONSUMES_DECLARATIONS`
//     (src/lib/generated/extensions.server.ts), written by the manifest generator;
//   - a pack loaded from the runtime package store: the store record's
//     `consumesDeclaration`, read from the materialized manifest at discovery
//     (`src/lib/extension-store-io.ts`) and handed to the host context by its loader.
//
// Fail closed: a pack with no `consumes` declares nothing and every call is
// refused; a declaration that cannot be determined (no generated entry, a store
// record without the reading, a malformed list) refuses every call with a
// message that says so. This module names no pack and no primitive.

/** A pack's raw `cinatra.consumes` value, in the manifest's own shape. An absent
 *  `consumes` key means the pack declares nothing. */
export type ConsumesDeclaration = { readonly consumes?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `ConsumesDeclaration` of one manifest's text (the store road). Returns
 * `null` when the text is not a JSON object with a `cinatra` block — the caller
 * then has no declaration and every call is refused.
 */
export function consumesDeclarationOfManifestText(manifestText: string): ConsumesDeclaration | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (!isPlainObject(pkg) || !isPlainObject(pkg.cinatra)) return null;
  return Object.prototype.hasOwnProperty.call(pkg.cinatra, "consumes") ? { consumes: pkg.cinatra.consumes } : {};
}

/**
 * The `ConsumesDeclaration` a runtime-store record carries (set by
 * `discoverStoreRecordsV2`), or `null` when the record carries none — the host
 * context then refuses every call of that pack.
 */
export function consumesDeclarationOfStoreRecord(record: object): ConsumesDeclaration | null {
  const value = (record as { consumesDeclaration?: unknown }).consumesDeclaration;
  return isPlainObject(value) ? (value as ConsumesDeclaration) : null;
}

/**
 * Refuse a primitive call the calling pack does not declare.
 *
 * `declaration`:
 *   - a `ConsumesDeclaration` — the loader handed the pack's own declaration over;
 *   - `null` — the loader knows the pack but could not read its declaration;
 *   - `undefined` — no declaration was handed over: the compiled-in generated map
 *     is consulted by package name, and a pack absent from it is refused.
 *
 * Resolves when the primitive is declared; rejects with a stated reason otherwise.
 */
export async function assertPrimitiveDeclared(
  packageName: string,
  primitiveName: unknown,
  declaration: ConsumesDeclaration | null | undefined,
): Promise<void> {
  const shown = typeof primitiveName === "string" ? primitiveName : String(primitiveName);
  const refusedBecause = (reason: string) =>
    new Error(`[ExtensionHostContext] ${packageName}: ctx.mcp.callPrimitive("${shown}") refused — ${reason}`);

  let resolved: ConsumesDeclaration | null;
  if (declaration === undefined) {
    const { GENERATED_EXTENSION_CONSUMES_DECLARATIONS } = await import("@/lib/generated/extensions.server");
    resolved = Object.prototype.hasOwnProperty.call(GENERATED_EXTENSION_CONSUMES_DECLARATIONS, packageName)
      ? GENERATED_EXTENSION_CONSUMES_DECLARATIONS[packageName]
      : null;
  } else {
    resolved = declaration;
  }
  if (resolved === null) {
    throw refusedBecause(
      `the package's declared host primitives (cinatra.consumes) cannot be determined: ` +
        `no declaration reached the host for this package.`,
    );
  }

  const { parseConsumedPrimitives } = await import("@cinatra-ai/sdk-extensions/consumes");
  let declared: ReadonlyArray<{ primitive: string }>;
  try {
    declared = parseConsumedPrimitives({ cinatra: resolved }, { packageName });
  } catch (err) {
    throw refusedBecause(
      `the package's declared host primitives (cinatra.consumes) cannot be determined: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof primitiveName === "string" && declared.some((entry) => entry.primitive === primitiveName)) return;
  throw refusedBecause(
    `the primitive is not declared in the package's cinatra.consumes. ` +
      `A pack may call only the host primitives it declares there ` +
      `(add { "primitive": "${shown}", "requirement": "required" | "optional" } to its manifest).`,
  );
}
