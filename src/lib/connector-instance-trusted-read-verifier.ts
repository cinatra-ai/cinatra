// Trusted-read verifier (cinatra#2019 S4): the PURE eligibility core that
// decides which descriptor-listed site tools may be NATIVELY injected (handed
// to the model provider to call directly) for an opted-in WordPress instance.
//
// THE TRUST DECISION IS A CONJUNCTION OF POSITIVE PROOFS. A name is eligible
// only when EVERY conjunct is affirmatively proven against the CURRENT catalog
// snapshots: the default server advertises first-class, the exact name is
// advertised there exactly once, the advertised interface fingerprint equals
// the descriptor pin (including output-schema PRESENCE agreement), the site's
// own annotations classify `read`, the cinatra known-destructive floor is
// silent, the enrollment enumeration is complete, and the name appears on NO
// other enrolled server. Every failure mode of every conjunct — absence,
// ambiguity, uninterpretable input, an unprovable enumeration — evaluates to
// NOT PROVEN and removes the name (a typed ejection). Uncertainty can only
// shrink the set toward the empty set; there is no path on which it adds a
// name. On the pinned community stack (triad-only default server) the result
// is [] by construction — the shipped v1 posture.
//
// ANNOTATIONS AND FLOORS ARE SUBTRACTIVE ONLY: the cinatra-shipped descriptor
// entry is the ONLY placer. `readOnlyHint:true` on a tool the descriptor does
// not name places nothing; a write/destructive/unannotated classification or a
// floor hit on a descriptor-named tool subtracts it. Site-advertised state can
// never widen the injectable set (epic security spine #1).
//
// LIVE STACK-VERSION EQUALITY IS DELIBERATELY NOT A CONJUNCT. There is no
// trusted-side source for the live site's plugin versions: the wire snapshot
// carries none, and the only version data cinatra ever receives is
// SITE-DECLARED — an untrusted hint; promoting it to a security conjunct would
// invert the annotations-are-hints spine. It would also add nothing against
// the real threat: an implementation swap needs no version change, and a
// version change under a byte-identical advertised interface IS the disclosed
// implementation-provenance residual (undetectable on ANY tuple — WordPress
// registers schemas separately from executing callbacks). The fingerprint is
// the version binding at the only granularity cinatra can verify: the
// advertised interface. The descriptor set's `pinnedTuple` is capture
// provenance (enforced against the committed capture by the consistency test),
// never a runtime check.
//
// FINGERPRINT SPEC (`tsr1`, strict by construction). Input is the default server's
// advertised wire row as JSON-parsed data. A schema is INELIGIBLE (typed
// failure, never a fingerprint) on ANY of: a non-object schema (boolean
// schemas included), presence of `$id`/`$anchor`/`$dynamicRef`/`$dynamicAnchor`
// anywhere, a `$ref` that is not a same-document `#/…` JSON pointer, a `$ref`
// carrying sibling keys (draft-ambiguous), an unresolvable pointer (which
// includes any percent-escaped or invalidly-`~`-escaped segment — only plain
// unencoded pointers are accepted), a reference cycle, or nesting depth > 64. Internal `#/` refs are resolved by
// inlining before canonicalization. Canonical form = recursive object-key sort
// (arrays order-preserved), compact JSON.stringify serialization. NO unicode
// normalization: both comparands come from the same JSON parse, so
// byte-faithful comparison is the point. A missing `outputSchema` is part of
// the pin (`hasOutputSchema:false`) and fingerprints as the literal `ABSENT`.
//
// This module is PURE (no I/O, no ambient state): the impure builder
// (connector-instance-native-read-injection.ts) feeds it acquired snapshots and owns
// policy/authority/audit. It performs ZERO M1 changes — the governed invoker
// path is untouched by construction, and an ejection here never denies or
// hides a tool anywhere else.

import { createHash } from "node:crypto";
import { classifyAnnotations } from "@cinatra-ai/mcp-server/annotation-classifier";
import type {
  CatalogServerSnapshot,
  CatalogToolEntry,
} from "@/lib/connector-instance-catalog-cache";
import type {
  TrustedReadDescriptorEntry,
  TrustedReadDescriptorSet,
} from "@/lib/connector-instance-trusted-read-descriptors";

/** The fingerprint algorithm this verifier computes. A descriptor set pinned
 * to any OTHER algorithm is unverifiable here and ejects wholesale. */
export const TRUSTED_READ_FINGERPRINT_ALGORITHM = "tsr1";

/** Maximum nesting depth of the RESOLVED (ref-inlined) schema tree. */
export const SCHEMA_CANONICALIZATION_MAX_DEPTH = 64;

/** Why a schema cannot be canonicalized (⇒ the tool is M1-only). */
export type SchemaCanonicalizationFailureReason =
  | "not_an_object"
  | "reserved_keyword"
  | "external_ref"
  | "ref_sibling_keys"
  | "unresolvable_ref"
  | "ref_cycle"
  | "depth_exceeded";

export type CanonicalizeSchemaForFingerprintResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: SchemaCanonicalizationFailureReason };

/** The `$`-keywords whose PRESENCE anywhere makes a schema ineligible: they
 * change reference resolution semantics (base-URI/anchor indirection) in ways
 * a byte-comparison fingerprint cannot bind. */
const RESERVED_SCHEMA_KEYWORDS = ["$id", "$anchor", "$dynamicRef", "$dynamicAnchor"] as const;

class SchemaCanonicalizationFailure extends Error {
  readonly reason: SchemaCanonicalizationFailureReason;
  constructor(reason: SchemaCanonicalizationFailureReason) {
    super(`schema canonicalization failed: ${reason}`);
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A pointer segment may only use the two RFC 6901 escapes (`~0`, `~1`), and
 * may not contain `%` at all. Any other `~` use (`~2`, a trailing `~`) is an
 * invalid pointer, and a `%` is a URI-fragment percent-escape that a
 * spec-conforming `$ref` consumer would DECODE before pointer evaluation
 * (`a%2Fb` becomes the two segments `a`/`b` there) — resolving either as
 * literal key text would make this verifier fingerprint a different document
 * view than other consumers execute. Both are typed-ineligible instead of
 * guessed: the accepted subset is plain, unencoded `#/` pointers only. */
const VALID_POINTER_SEGMENT = /^(?:[^~%]|~[01])*$/;

/** RFC 6901 pointer segment unescape (`~1` → `/`, `~0` → `~`; validated by
 * `VALID_POINTER_SEGMENT` first, which also refuses percent-escapes). */
function unescapePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Resolve a same-document `#/…` JSON pointer against the raw root schema.
 * Returns the referenced value or the typed failure. */
function resolveInternalPointer(root: Record<string, unknown>, ref: string): unknown {
  // Only the `#/…` form is a same-document JSON pointer; `#`, `#anchor`,
  // relative URIs and absolute URIs are all EXTERNAL for fingerprint purposes.
  if (!ref.startsWith("#/")) throw new SchemaCanonicalizationFailure("external_ref");
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!VALID_POINTER_SEGMENT.test(rawSegment)) {
      throw new SchemaCanonicalizationFailure("unresolvable_ref");
    }
    const segment = unescapePointerSegment(rawSegment);
    if (Array.isArray(current)) {
      // Strict array indexing: canonical non-negative integer only.
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        throw new SchemaCanonicalizationFailure("unresolvable_ref");
      }
      current = current[Number.parseInt(segment, 10)];
    } else if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new SchemaCanonicalizationFailure("unresolvable_ref");
      }
      current = current[segment];
    } else {
      throw new SchemaCanonicalizationFailure("unresolvable_ref");
    }
    if (current === undefined) throw new SchemaCanonicalizationFailure("unresolvable_ref");
  }
  return current;
}

/**
 * Canonicalize one node of the (being-resolved) schema tree.
 *
 * `activeRefs` carries the `$ref` pointers currently being inlined on this
 * path — re-entering one is a cycle. An inlined target continues at the SAME
 * depth as the `$ref` node it replaces (the pointer node is substituted, not
 * nested), so the depth cap measures the RESOLVED tree.
 */
function canonicalizeNode(
  node: unknown,
  root: Record<string, unknown>,
  depth: number,
  activeRefs: ReadonlySet<string>,
): string {
  if (depth > SCHEMA_CANONICALIZATION_MAX_DEPTH) {
    throw new SchemaCanonicalizationFailure("depth_exceeded");
  }
  if (Array.isArray(node)) {
    // Arrays are order-preserved; JSON.stringify semantics for gaps/undefined.
    return `[${node
      .map((item) => (item === undefined ? "null" : canonicalizeNode(item, root, depth + 1, activeRefs)))
      .join(",")}]`;
  }
  if (isPlainObject(node)) {
    for (const reserved of RESERVED_SCHEMA_KEYWORDS) {
      if (Object.prototype.hasOwnProperty.call(node, reserved)) {
        throw new SchemaCanonicalizationFailure("reserved_keyword");
      }
    }
    const keys = Object.keys(node).filter((key) => node[key] !== undefined);
    if (Object.prototype.hasOwnProperty.call(node, "$ref")) {
      const ref = node["$ref"];
      // A `$ref` with sibling keys is draft-ambiguous (ignore vs merge) —
      // ineligible rather than guessed.
      if (keys.length !== 1) throw new SchemaCanonicalizationFailure("ref_sibling_keys");
      if (typeof ref !== "string") throw new SchemaCanonicalizationFailure("external_ref");
      if (activeRefs.has(ref)) throw new SchemaCanonicalizationFailure("ref_cycle");
      const target = resolveInternalPointer(root, ref);
      const nextActive = new Set(activeRefs);
      nextActive.add(ref);
      // Substitution: the target replaces the `$ref` node at the same depth.
      return canonicalizeNode(target, root, depth, nextActive);
    }
    return `{${keys
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalizeNode(node[key], root, depth + 1, activeRefs)}`,
      )
      .join(",")}}`;
  }
  // Primitives: plain JSON serialization (ECMA-262 number ToString). A bare
  // `undefined` cannot come out of JSON.parse; treat it as unrepresentable.
  const serialized = JSON.stringify(node);
  if (serialized === undefined) throw new SchemaCanonicalizationFailure("not_an_object");
  return serialized;
}

/**
 * Canonicalize an advertised tool schema for fingerprinting: internal-`#/`
 * refs inlined, object keys sorted recursively, arrays order-preserved,
 * compact serialization. The ROOT must be a plain object — boolean schemas,
 * arrays, primitives and null are all ineligible (strict by design: a
 * fingerprint over a schema whose semantics we cannot pin is not a proof).
 */
export function canonicalizeSchemaForFingerprint(
  schema: unknown,
): CanonicalizeSchemaForFingerprintResult {
  if (!isPlainObject(schema)) return { ok: false, reason: "not_an_object" };
  try {
    return { ok: true, canonical: canonicalizeNode(schema, schema, 1, new Set()) };
  } catch (err) {
    if (err instanceof SchemaCanonicalizationFailure) return { ok: false, reason: err.reason };
    throw err;
  }
}

export type TrustedReadFingerprintResult =
  | { ok: true; fingerprint: string; hasOutputSchema: boolean }
  | {
      ok: false;
      schema: "input" | "output";
      reason: SchemaCanonicalizationFailureReason;
    };

/**
 * Compute the versioned `tsr1` interface fingerprint of an advertised tool:
 * `sha256hex("tsr1|in:" + canon(inputSchema) + "|out:" + (canon(outputSchema)
 * ?? "ABSENT"))`. Output-schema ABSENCE is part of the pin — recorded in
 * `hasOutputSchema` and fingerprinted as the literal `ABSENT`, so a tool that
 * later gains or loses its output schema mismatches. A `null`/non-object
 * output schema is ineligible like any other non-object schema (strict).
 */
export function computeTrustedReadFingerprint(input: {
  inputSchema: unknown;
  outputSchema?: unknown;
}): TrustedReadFingerprintResult {
  const canonicalInput = canonicalizeSchemaForFingerprint(input.inputSchema);
  if (!canonicalInput.ok) return { ok: false, schema: "input", reason: canonicalInput.reason };
  const hasOutputSchema = input.outputSchema !== undefined;
  let outputPart = "ABSENT";
  if (hasOutputSchema) {
    const canonicalOutput = canonicalizeSchemaForFingerprint(input.outputSchema);
    if (!canonicalOutput.ok) return { ok: false, schema: "output", reason: canonicalOutput.reason };
    outputPart = canonicalOutput.canonical;
  }
  const fingerprint = createHash("sha256")
    .update(
      `${TRUSTED_READ_FINGERPRINT_ALGORITHM}|in:${canonicalInput.canonical}|out:${outputPart}`,
      "utf8",
    )
    .digest("hex");
  return { ok: true, fingerprint, hasOutputSchema };
}

/** Why a descriptor-named tool was removed from the injectable set. Feeds the
 * `native_injection_empty` audit's reason counts and the explain preview. */
export type TrustedReadEjectionReason =
  | "fingerprint_algorithm_unsupported"
  | "snapshot_set_inconsistent"
  | "exposure_not_first_class"
  | "not_advertised"
  | "ambiguous_on_default_server"
  | "output_schema_presence_mismatch"
  | "schema_ineligible"
  | "fingerprint_mismatch"
  | "not_read_classified"
  | "destructive_floor"
  | "enrollment_incomplete"
  | "duplicate_on_other_server";

export type TrustedReadEjection = {
  name: string;
  reason: TrustedReadEjectionReason;
  /** Optional machine detail (e.g. the canonicalization failure code). Never
   * carries schemas, endpoints or credential material. */
  detail?: string;
};

export type VerifyTrustedReadSetInput = {
  /** The cinatra-shipped descriptor set (the ONLY placer of names). */
  descriptor: Pick<TrustedReadDescriptorSet, "entries" | "fingerprintAlgorithm">;
  /** The acquired snapshot of the DEFAULT adapter server. */
  defaultServerSnapshot: CatalogServerSnapshot;
  /** Acquired snapshots of EVERY OTHER enrolled server (the duplicate rule
   * enumerates them all; entries sharing the default server's id are ignored
   * defensively). */
  otherServerSnapshots: readonly CatalogServerSnapshot[];
  /** TRUE only when every currently-enrolled server produced a snapshot this
   * acquire. FALSE makes the duplicate rule unprovable ⇒ every name ejects. */
  enrollmentComplete: boolean;
  /** The cinatra known-destructive name floor. REQUIRED — the floor module is
   * merged, and an optional excluder would be a fail-open seam (a caller
   * forgetting it would silently weaken the conjunction). Injected rather
   * than imported so the conjunction stays pure and the floor stays a single
   * sibling module, but the type makes omission impossible. */
  isKnownDestructiveToolName: (name: string) => boolean;
};

export type VerifyTrustedReadSetResult = {
  /** The verified injectable names, sorted — possibly empty (the safe
   * degenerate outcome, and the shipped v1 posture on the pinned stack). */
  allowedTools: string[];
  ejected: TrustedReadEjection[];
};

/**
 * The eligibility conjunction, evaluated per descriptor entry in
 * rule order. Pure over its inputs; any unproven conjunct ejects the name with
 * a typed reason. An empty descriptor set verifies to the empty result — no
 * ejections, nothing eligible.
 */
export function verifyTrustedReadSet(input: VerifyTrustedReadSetInput): VerifyTrustedReadSetResult {
  const allowedTools: string[] = [];
  const ejected: TrustedReadEjection[] = [];

  // A descriptor set pinned to an algorithm this verifier does not implement
  // is unverifiable in its entirety (fail closed, typed).
  if (input.descriptor.fingerprintAlgorithm !== TRUSTED_READ_FINGERPRINT_ALGORITHM) {
    for (const entry of input.descriptor.entries) {
      ejected.push({
        name: entry.name,
        reason: "fingerprint_algorithm_unsupported",
        detail: String(input.descriptor.fingerprintAlgorithm),
      });
    }
    return { allowedTools, ejected };
  }

  // The snapshot SET itself must be unambiguous before any name can be
  // proven: an `otherServerSnapshots` entry carrying the default server's id,
  // or two snapshots sharing a server id, means the caller's acquire was
  // inconsistent — the duplicate rule (and the default-server binding) would
  // be evaluated against an ambiguous world. Uncertainty ejects EVERYTHING;
  // it is never resolved by silently ignoring one of the claimants.
  const defaultSnapshot = input.defaultServerSnapshot;
  const seenServerIds = new Set<string>([defaultSnapshot.serverId]);
  let inconsistentServerId: string | null = null;
  for (const snapshot of input.otherServerSnapshots) {
    if (seenServerIds.has(snapshot.serverId)) {
      inconsistentServerId = snapshot.serverId;
      break;
    }
    seenServerIds.add(snapshot.serverId);
  }
  if (inconsistentServerId !== null) {
    for (const entry of input.descriptor.entries) {
      ejected.push({
        name: entry.name,
        reason: "snapshot_set_inconsistent",
        detail: inconsistentServerId,
      });
    }
    return { allowedTools, ejected };
  }

  for (const entry of input.descriptor.entries) {
    const verdict = verifyEntry(entry, defaultSnapshot, input.otherServerSnapshots, input);
    if (verdict === null) allowedTools.push(entry.name);
    else ejected.push(verdict);
  }

  allowedTools.sort();
  return { allowedTools, ejected };
}

/** One entry through the conjunction; `null` = every conjunct proven. */
function verifyEntry(
  entry: TrustedReadDescriptorEntry,
  defaultSnapshot: CatalogServerSnapshot,
  otherSnapshots: readonly CatalogServerSnapshot[],
  input: VerifyTrustedReadSetInput,
): TrustedReadEjection | null {
  // 1. The default server must advertise FIRST-CLASS exposure. A triad-only
  //    snapshot ejects everything — the pinned-stack case: the expanded triad
  //    catalog is a governed-path (M1) surface, never an injection surface.
  if (defaultSnapshot.exposureMode !== "first-class") {
    return { name: entry.name, reason: "exposure_not_first_class" };
  }

  // 2. The exact wire name must be advertised on the default server — exactly
  //    once. Zero rows = not advertised; multiple rows = the advertisement is
  //    ambiguous (which schema would the provider bind?) — not proven.
  const rows = defaultSnapshot.tools.filter((tool: CatalogToolEntry) => tool.name === entry.name);
  if (rows.length === 0) return { name: entry.name, reason: "not_advertised" };
  if (rows.length > 1) return { name: entry.name, reason: "ambiguous_on_default_server" };
  const row = rows[0]!;

  // 3. Output-schema PRESENCE agreement precedes fingerprint equality so a
  //    presence flip reports its own typed reason.
  const rowHasOutputSchema = row.outputSchema !== undefined;
  if (rowHasOutputSchema !== entry.hasOutputSchema) {
    return { name: entry.name, reason: "output_schema_presence_mismatch" };
  }

  // 4. Advertised-interface fingerprint equality (`tsr1`). An uncanonicalizable
  //    schema is ineligible with the canonicalization code as detail.
  const fingerprint = computeTrustedReadFingerprint({
    inputSchema: row.inputSchema,
    ...(rowHasOutputSchema ? { outputSchema: row.outputSchema } : {}),
  });
  if (!fingerprint.ok) {
    return {
      name: entry.name,
      reason: "schema_ineligible",
      detail: `${fingerprint.schema}:${fingerprint.reason}`,
    };
  }
  if (fingerprint.fingerprint !== entry.fingerprint) {
    return { name: entry.name, reason: "fingerprint_mismatch" };
  }

  // 5. The site's own annotations must classify `read` (unannotated defaults
  //    to write-class — subtractive, fail closed).
  if (classifyAnnotations(row.rawAnnotations) !== "read") {
    return { name: entry.name, reason: "not_read_classified" };
  }

  // 6. The cinatra known-destructive floor must be silent.
  if (input.isKnownDestructiveToolName(entry.name)) {
    return { name: entry.name, reason: "destructive_floor" };
  }

  // 7. The duplicate-anywhere rule needs the COMPLETE enrollment enumeration;
  //    an incomplete acquire makes it unprovable — ejected, never assumed.
  if (!input.enrollmentComplete) {
    return { name: entry.name, reason: "enrollment_incomplete" };
  }
  for (const snapshot of otherSnapshots) {
    if (snapshot.tools.some((tool: CatalogToolEntry) => tool.name === entry.name)) {
      return {
        name: entry.name,
        reason: "duplicate_on_other_server",
        detail: snapshot.serverId,
      };
    }
  }

  return null;
}
