// Generation-time validation of `cinatra.artifact.objectTypes` claims
// (cinatra#1432). STRUCTURAL RESTATEMENT of the canonical TS rules — the
// generator is plain .mjs and cannot import the TS policy leaf
// (`packages/objects/src/claims.ts`), so the vocabulary is restated here,
// value-identical (the agent-binding-kinds.mjs precedent). Do not change one
// without the other:
//   - entry shape:      artifactObjectTypeClaimManifestSchema (claims.ts)
//   - schema-source:    validateObjectTypeClaimSchemaSources  (claims.ts)
// FAIL-CLOSED at generation: an invalid claim is a generation error, so
// nothing invalid can ever become byte-pinned exempt generated data.

/** Mirrors CLAIMED_OBJECT_TYPE_ID_RE (claims.ts). */
export const CLAIMED_OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

const CLAIM_KINDS = new Set(["dedicated", "default"]);
const PROJECTIONS = new Set(["raw", "artifact-safe", "none"]);
const SNAPSHOT_POLICIES = new Set(["content", "metadata", "none"]);
const SENSITIVITIES = new Set(["normal", "sensitive"]);
// Mirrors ARTIFACT_MUTABILITY_CLASSES (claims.ts, cinatra#1449).
const MUTABILITY_CLASSES = new Set(["draftable", "record", "external"]);
const DISPOSITION_KEYS = new Set([
  "projection",
  "pinnable",
  "snapshotPolicy",
  "redactionPolicyVersion",
  "sensitivity",
  "mutability",
]);
const CLAIM_ENTRY_KEYS = new Set(["type", "claim", "dispositions", "schema"]);

/** The registering package of a claimed type id (`@scope/pkg:slug` → `@scope/pkg`). */
export function claimedTypeRegisteringPackage(objectTypeId) {
  const idx = objectTypeId.indexOf(":");
  if (idx <= 0) return null;
  const pkg = objectTypeId.slice(0, idx);
  return /^@[\w-]+\/[\w-]+$/.test(pkg) ? pkg : null;
}

/**
 * Validate one package's `cinatra.artifact.objectTypes` declaration.
 * @param {string} packageName
 * @param {unknown} cinatra the package's whole `cinatra` manifest block
 * @returns {string[]} errors (empty = valid or no claims declared)
 */
export function validateArtifactObjectTypeClaims(packageName, cinatra) {
  const errors = [];
  const artifact =
    cinatra && typeof cinatra === "object" ? cinatra.artifact : undefined;
  const claims =
    artifact && typeof artifact === "object" ? artifact.objectTypes : undefined;
  if (claims === undefined) return errors;
  const p = (msg) => `${packageName}: ${msg}`;
  if (!Array.isArray(claims) || claims.length === 0) {
    return [p("cinatra.artifact.objectTypes must be a non-empty array of claim entries")];
  }
  const rawDeps = cinatra && typeof cinatra === "object" ? cinatra.dependencies : undefined;
  const declaredDeps = new Set(
    Array.isArray(rawDeps)
      ? rawDeps
          .map((d) =>
            d && typeof d === "object" && typeof d.packageName === "string"
              ? d.packageName
              : null,
          )
          .filter((n) => n != null)
      : [],
  );
  const seen = new Set();
  for (const entry of claims) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(p("objectTypes entry must be an object"));
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!CLAIM_ENTRY_KEYS.has(key)) {
        errors.push(p(`objectTypes entry has unknown key '${key}'`));
      }
    }
    if (typeof entry.type !== "string" || !CLAIMED_OBJECT_TYPE_ID_RE.test(entry.type)) {
      errors.push(
        p(`objectTypes entry 'type' must be a namespaced id (@scope/package:local-id), got ${JSON.stringify(entry.type)}`),
      );
      continue;
    }
    if (seen.has(entry.type)) {
      errors.push(p(`duplicate objectTypes claim for '${entry.type}'`));
    }
    seen.add(entry.type);
    if (!CLAIM_KINDS.has(entry.claim)) {
      errors.push(
        p(`objectTypes claim '${entry.type}': 'claim' must be 'dedicated' or 'default'`),
      );
    }
    if (entry.dispositions !== undefined) {
      const d = entry.dispositions;
      if (d == null || typeof d !== "object" || Array.isArray(d)) {
        errors.push(p(`objectTypes claim '${entry.type}': dispositions must be an object`));
      } else {
        for (const key of Object.keys(d)) {
          if (!DISPOSITION_KEYS.has(key)) {
            errors.push(p(`objectTypes claim '${entry.type}': dispositions has unknown key '${key}'`));
          }
        }
        if (!PROJECTIONS.has(d.projection)) {
          errors.push(
            p(`objectTypes claim '${entry.type}': dispositions.projection must be raw | artifact-safe | none`),
          );
        }
        if (d.pinnable !== undefined && typeof d.pinnable !== "boolean") {
          errors.push(p(`objectTypes claim '${entry.type}': dispositions.pinnable must be a boolean`));
        }
        if (d.projection === "none" && d.pinnable === true) {
          // Never-projected rows cannot be pinned (claims.ts union rule).
          errors.push(
            p(`objectTypes claim '${entry.type}': a never-projected claim (projection 'none') cannot be pinnable`),
          );
        }
        if (d.snapshotPolicy !== undefined && !SNAPSHOT_POLICIES.has(d.snapshotPolicy)) {
          errors.push(
            p(`objectTypes claim '${entry.type}': dispositions.snapshotPolicy must be content | metadata | none`),
          );
        }
        if (d.sensitivity !== undefined && !SENSITIVITIES.has(d.sensitivity)) {
          errors.push(
            p(`objectTypes claim '${entry.type}': dispositions.sensitivity must be normal | sensitive`),
          );
        }
        if (
          d.redactionPolicyVersion !== undefined &&
          (typeof d.redactionPolicyVersion !== "string" || d.redactionPolicyVersion.length === 0)
        ) {
          errors.push(
            p(`objectTypes claim '${entry.type}': dispositions.redactionPolicyVersion must be a non-empty string`),
          );
        }
        // Per-claim mutability class (cinatra#1449). Optional; the enum mirrors
        // ARTIFACT_MUTABILITY_CLASSES (claims.ts). One cross-field invariant on
        // the union: an `external` claim points at live third-party-canonical
        // content and is never pinnable — pin the immutable snapshot record
        // instead. (projection:'none' already forces pinnable:false; this closes
        // the raw / artifact-safe external case, matching the TS superRefine.)
        if (d.mutability !== undefined && !MUTABILITY_CLASSES.has(d.mutability)) {
          errors.push(
            p(`objectTypes claim '${entry.type}': dispositions.mutability must be draftable | record | external`),
          );
        }
        if (d.mutability === "external" && d.pinnable === true) {
          errors.push(
            p(`objectTypes claim '${entry.type}': external mutability requires pinnable:false — pin the snapshot record, not the live pointer`),
          );
        }
      }
    }
    if (entry.schema !== undefined) {
      if (entry.schema == null || typeof entry.schema !== "object" || Array.isArray(entry.schema)) {
        errors.push(p(`objectTypes claim '${entry.type}': schema must be a JSON Schema object`));
      }
      continue; // inline schema satisfies the schema-source rule
    }
    // Schema-source rule (AC-4): no inline schema → self-registered or a
    // declared dependency on the registering extension.
    const registrant = claimedTypeRegisteringPackage(entry.type);
    if (registrant !== packageName && !declaredDeps.has(registrant)) {
      errors.push(
        p(
          `objectTypes claim '${entry.type}' has no schema source: ship a JSON Schema in the claim ` +
            `or declare a cinatra.dependencies entry on the type-registering extension '${registrant}'`,
        ),
      );
    }
  }
  return errors;
}
