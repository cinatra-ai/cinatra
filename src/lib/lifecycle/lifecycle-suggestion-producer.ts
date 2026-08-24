// ---------------------------------------------------------------------------
// lifecycle-suggestion-producer (cinatra#2570, epic #2564 S6a — the auditor
// suggestion PRODUCER).
//
// The gate-bound successor to the auditor's run-scoped proposal pipeline. The
// old lane asked an LLM for patches over a caller-supplied `data` payload and
// wrote them to `auditor_proposal_snapshots`, a store whose only consumer
// (`/api/auditor/apply`) has since been deleted — so the suggestions the
// reviewer used to act on were being generated, persisted, and read by nobody.
// This module is the PURE core of the replacement: given a pinned review target
// and an AUTHORIZED, DISCLOSED projection of that exact revision, it derives the
// suggestions deterministically and freezes them into a hash-bound snapshot
// payload.
//
// WHY DETERMINISTIC. #2042 fixed the shape of a core lane: it reads only what
// the host disclosed to it, and its provenance proves that. A generative lane
// is a drop-in over the SAME disclosed projection — the provenance contract
// binds either analyser identically (`lifecycle-core-analysis`'s own note) — but
// a deterministic core is fixture-pinnable, so "the producer never invented
// content it was not shown" is a unit-provable property rather than a review
// convention. Every rule below derives its `value` FROM the disclosed text or
// from the empty string; none of them writes prose.
//
// THE THREE RULES, and why they are the whole set:
//
// WHAT A SUGGESTION CARRIES (cinatra#2852). Every rule that has both sides
// records them as a PAIR — `before`, the disclosed text as the lane was shown
// it, and `value`, the text it proposes — frozen into the snapshot together, so
// the surface can draw §VIII's before/after panel from one hash-bound row
// rather than re-reading a document that may have moved since.
//
//   R1 `replace` — a disclosed value that is not its own canonical form (C0
//      control characters, per-line trailing whitespace, surrounding
//      whitespace). The proposed value is the canonicalization of the text the
//      lane was shown. Non-destructive by construction: newlines and interior
//      spacing survive.
//   R2 `remove`  — an indexed collection MEMBER whose every disclosed field is
//      empty. An empty list item is a real defect a reviewer can act on, and
//      removing it needs no invented content. IT FIRES ONLY UNDER FULL
//      DISCLOSURE (`authorized` and nothing withheld): removing a member is
//      destructive, and under a partial projection "every field I was shown is
//      empty" does not mean the member is empty. A lane that cannot see the
//      whole member does not get to delete it.
//   R3 `add`     — an indexed collection member missing a DIRECT key its
//      siblings carry. The value is the empty string: the patch fixes the SHAPE
//      and leaves the content to a human. Never a guess at what the field
//      should say. Depth-1 only, because `applyAuditorPatches` creates no
//      intermediate containers — proposing `/items/1/meta/label` where
//      `items[1].meta` does not exist would be a patch that throws on apply.
//
// A top-level empty field yields NOTHING. The honest patch there would be "put
// something here", and the lane has nothing to put.
//
// THE RULES REACH A FIXPOINT IN ONE APPLICATION — for an UNTRUNCATED snapshot.
// R2 claims a member before R1 and R3 look at it, and R3's added field is a
// collection member whose siblings carry content, so R2 cannot come back for it.
// Re-running the producer over a projection of the applied result yields zero
// suggestions; that is pinned by a test, because a producer that oscillates
// would hand the reviewer the same gate forever. A snapshot that hit
// `MAX_GATE_SUGGESTIONS` says so in `truncated`, and a later pass over the
// applied result legitimately surfaces the remainder — convergent, not
// oscillating.
//
// PURE (no DB, no LLM, no I/O, no server-only import) — the store-writing half
// is `packages/agents/src/lifecycle-suggestion-producer-lane.ts`.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import {
  projectionDigest,
  type CoreAnalysisAuthzDecision,
  type CoreAnalysisProjection,
  type CoreAnalysisProvenance,
  type CoreAnalysisTarget,
} from "./lifecycle-core-analysis";

/**
 * The stable identity of the suggestion producer lane. A SIBLING of
 * `CORE_ANALYSIS_LANE_ID`, not the same lane: both render under the "Audit"
 * chrome (#2042's labelling rule — a core lane is never presented as
 * an agent), but they write to different stores and a provenance row has to say
 * which one produced it. The chrome string itself belongs to the surface that
 * draws it (S6c), not here.
 */
export const SUGGESTION_PRODUCER_LANE_ID = "core-analysis-suggestion-lane";

/** The snapshot payload contract version. Bumping it invalidates no stored row —
 * a reader refuses a version it does not know rather than guessing. */
export const GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION = 1;

/** Hard bound on the suggestions one snapshot may carry. A gate with more
 * findings than this is a projection problem, not a review problem; the payload
 * records the truncation instead of silently shrinking. */
export const MAX_GATE_SUGGESTIONS = 50;

/** Hard bound on a proposed value. A longer canonicalization is SKIPPED, never
 * truncated — half a field is worse than no suggestion. */
export const MAX_SUGGESTION_VALUE_CHARS = 2_000;

/**
 * One produced suggestion. Structurally the legacy `SuggestionPatch` the retired
 * pipeline emitted — same field names, same op vocabulary, same RFC 6901
 * `fieldPath` — so everything downstream that accepted the old shape accepts
 * this one (the parity fixture proves it against the real schema + the real
 * `applyAuditorPatches` transform).
 */
export interface ProducedSuggestion {
  id: string;
  /** An RFC 6901 JSON Pointer into the reviewed document. */
  fieldPath: string;
  op: "replace" | "add" | "remove";
  /** Present for replace/add; absent for remove. Always derived from the
   * disclosed projection or the empty string — never generated text. */
  value?: string;
  /**
   * The CURRENT content of the pointed-at field, captured from the same
   * disclosed projection this suggestion was derived from (cinatra#2852,
   * design §VIII: "the current content beside the suggested content").
   *
   * Captured at DERIVATION TIME and frozen into the snapshot, because that is
   * the only moment the pair is provably about one revision: reconstructing the
   * "before" later would read a document that may have moved, and would print a
   * comparison the producer never made.
   *
   * ABSENT, never invented, in three cases: a `remove` (the member has no one
   * value), an `add` (the field does not exist yet, so there is nothing it
   * currently says), and a disclosed value longer than
   * `MAX_SUGGESTION_VALUE_CHARS` (the same ceiling the proposal obeys — half a
   * field is worse than no field). Absence is not a signal; it means the
   * producer had nothing to show.
   */
  before?: string;
  message: string;
}

/** The immutable payload stored in one `gate_suggestion_snapshots` row. */
export interface GateSuggestionSnapshotPayload {
  schemaVersion: number;
  laneId: string;
  target: CoreAnalysisTarget;
  provenance: CoreAnalysisProvenance;
  suggestions: ProducedSuggestion[];
  /** True when the rule set produced more than `MAX_GATE_SUGGESTIONS`. */
  truncated: boolean;
  /** sha256 over everything above. The row is hash-BOUND: a consumer that
   * re-derives a different hash treats the row as unreadable. */
  snapshotHash: string;
}

export interface BuildGateSuggestionsInput {
  target: CoreAnalysisTarget;
  projection: CoreAnalysisProjection;
  authzDecision: CoreAnalysisAuthzDecision;
  laneId?: string;
}

export interface BuildGateSuggestionsResult {
  suggestions: ProducedSuggestion[];
  provenance: CoreAnalysisProvenance;
  payload: GateSuggestionSnapshotPayload;
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

/**
 * The prototype-mutation keys `applyAuditorPatches` refuses. A projection that
 * discloses one of them is not a suggestion opportunity — the lane drops the
 * field rather than minting a patch the apply transform would throw on.
 */
const FORBIDDEN_SEGMENT = /^(__proto__|constructor|prototype)$/;

/** RFC 6901 reference-token escaping: `~` → `~0`, `/` → `~1`. */
function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Build an RFC 6901 pointer from already-split segments. */
function toPointer(segments: readonly string[]): string {
  return segments.map((s) => `/${escapePointerSegment(s)}`).join("");
}

/** A non-negative decimal integer segment — i.e. a collection index. */
function isIndexSegment(segment: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(segment);
}

/**
 * The projection's field paths are DOT-SEPARATED (the `flattenToFieldMap`
 * convention every lifecycle projector already uses). A segment that itself
 * contains a dot is therefore not expressible — a documented limit of the
 * projection contract, not of this producer.
 */
function splitProjectionPath(path: string): string[] {
  return path.split(".");
}

// ---------------------------------------------------------------------------
// Canonicalization (R1)
// ---------------------------------------------------------------------------

// C0 controls EXCEPT tab (09), line feed (0A) and carriage return (0D), plus
// DEL (7F). Stripping these is always safe; stripping the three we keep would
// destroy structure.
const STRIPPABLE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * The canonical form of a disclosed value: strippable control characters gone,
 * no trailing whitespace on any line, no surrounding whitespace. Deliberately
 * NON-DESTRUCTIVE — newlines and interior spacing are preserved, so a body of
 * prose canonicalizes to itself. Idempotent: `canon(canon(x)) === canon(x)`.
 */
export function canonicalFieldValue(value: string): string {
  return value
    .replace(STRIPPABLE_CONTROL, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/u, ""))
    .join("\n")
    .trim();
}

function isEmptyValue(value: string): boolean {
  return value.trim() === "";
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, so the hash never depends on the
 * order a field happened to be built in. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The snapshot hash over everything the payload carries except the hash. */
export function gateSuggestionSnapshotHash(
  payload: Omit<GateSuggestionSnapshotPayload, "snapshotHash">,
): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** A stable suggestion id: same lane + same projection + same patch ⇒ same id,
 * so a re-run over an unchanged revision produces a byte-identical snapshot and
 * the write is idempotent rather than duplicative. */
function suggestionId(
  laneId: string,
  digest: string,
  op: ProducedSuggestion["op"],
  pointer: string,
): string {
  const material = [laneId, digest, op, pointer].join("\u0000");
  return `sug_${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// The rule engine
// ---------------------------------------------------------------------------

interface DisclosedField {
  path: string;
  segments: string[];
  pointer: string;
  value: string;
  /** Set when the path sits inside an indexed collection member. */
  member?: { prefixKey: string; prefixSegments: string[]; index: number; restKey: string };
}

/** Split a path at its FIRST index segment, when one exists with a key after it. */
function classifyMember(segments: readonly string[]): DisclosedField["member"] {
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (!isIndexSegment(seg)) continue;
    const prefixSegments = segments.slice(0, i);
    // A bare leading index (`0.title`) has no collection name; the member key is
    // still well-defined (the empty prefix), which keeps arrays-at-root working.
    return {
      prefixKey: prefixSegments.join("\u0000"),
      prefixSegments: [...prefixSegments],
      index: Number(seg),
      restKey: segments.slice(i + 1).join("\u0000"),
    };
  }
  return undefined;
}

const MESSAGE_REPLACE =
  "This field carries stray control characters or trailing whitespace; the normalized text is proposed.";
const MESSAGE_REMOVE = "Every disclosed field on this list item is empty.";
const MESSAGE_ADD = "Sibling items in this list carry this field; this one does not.";

/**
 * Build the gate-bound suggestions over an authorized projection.
 *
 * A `denied` authorization decision yields ZERO suggestions: the lane read
 * nothing, so it proposes nothing. The provenance still records the denial —
 * that a lane was asked and refused is exactly the kind of fact the gate should
 * keep.
 */
export function buildGateSuggestions(
  input: BuildGateSuggestionsInput,
): BuildGateSuggestionsResult {
  const laneId = input.laneId ?? SUGGESTION_PRODUCER_LANE_ID;
  const included = input.projection.includedFields;
  const includedFields = Object.keys(included).sort();
  const excludedFields = [...input.projection.excludedFields].sort();
  const digest = projectionDigest(included);

  const provenance: CoreAnalysisProvenance = {
    laneId,
    targetArtifactId: input.target.artifactId,
    targetRevisionId: input.target.representationRevisionId,
    projectionDigest: digest,
    includedFields,
    excludedFields,
    authzDecision: input.authzDecision,
  };

  // R2 removes a whole list member, so it needs the WHOLE member in view. Full
  // disclosure means the host authorized the projection outright and withheld
  // nothing; anything less and the lane may be looking at an "empty" member that
  // carries content it was never shown.
  const fullyDisclosed = input.authzDecision === "authorized" && excludedFields.length === 0;

  const suggestions =
    input.authzDecision === "denied"
      ? []
      : deriveSuggestions(included, includedFields, laneId, digest, fullyDisclosed);

  const truncated = suggestions.length > MAX_GATE_SUGGESTIONS;
  const kept = truncated ? suggestions.slice(0, MAX_GATE_SUGGESTIONS) : suggestions;

  const unhashed: Omit<GateSuggestionSnapshotPayload, "snapshotHash"> = {
    schemaVersion: GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION,
    laneId,
    target: {
      artifactId: input.target.artifactId,
      representationRevisionId: input.target.representationRevisionId,
    },
    provenance,
    suggestions: kept,
    truncated,
  };

  return {
    suggestions: kept,
    provenance,
    payload: { ...unhashed, snapshotHash: gateSuggestionSnapshotHash(unhashed) },
  };
}

function deriveSuggestions(
  included: Readonly<Record<string, string>>,
  includedFields: readonly string[],
  laneId: string,
  digest: string,
  fullyDisclosed: boolean,
): ProducedSuggestion[] {
  // 1. Parse every disclosed path once, dropping the ones no patch may address.
  const fields: DisclosedField[] = [];
  for (const path of includedFields) {
    if (path === "") continue;
    const segments = splitProjectionPath(path);
    if (segments.some((s) => s === "" || FORBIDDEN_SEGMENT.test(s))) continue;
    fields.push({
      path,
      segments,
      pointer: toPointer(segments),
      value: included[path] ?? "",
      member: classifyMember(segments),
    });
  }

  // 2. Collection shape: which members exist, which keys their siblings carry.
  //    `carriers` counts only NON-EMPTY values — a key every sibling leaves
  //    blank is not a shape the lane should propagate.
  const memberFields = new Map<string, DisclosedField[]>();
  const prefixMembers = new Map<string, { segments: string[]; indices: Set<number> }>();
  const carriers = new Map<string, Set<number>>();
  for (const f of fields) {
    if (!f.member) continue;
    const memberKey = `${f.member.prefixKey}\u0001${f.member.index}`;
    const bucket = memberFields.get(memberKey);
    if (bucket) bucket.push(f);
    else memberFields.set(memberKey, [f]);

    const prefix = prefixMembers.get(f.member.prefixKey);
    if (prefix) prefix.indices.add(f.member.index);
    else
      prefixMembers.set(f.member.prefixKey, {
        segments: f.member.prefixSegments,
        indices: new Set([f.member.index]),
      });

    if (!isEmptyValue(f.value)) {
      const carrierKey = `${f.member.prefixKey}\u0001${f.member.restKey}`;
      const set = carriers.get(carrierKey);
      if (set) set.add(f.member.index);
      else carriers.set(carrierKey, new Set([f.member.index]));
    }
  }

  // 3. R2 — a member whose every disclosed field is empty is dropped whole. It
  //    is claimed BEFORE R1/R3 look at it, which is what makes the rule set
  //    reach a fixpoint after one application.
  const droppedMembers = new Set<string>();
  const removes: ProducedSuggestion[] = [];
  for (const [memberKey, group] of memberFields) {
    if (!fullyDisclosed) break; // partial disclosure never deletes.
    if (group.length === 0) continue;
    if (!group.every((f) => isEmptyValue(f.value))) continue;
    droppedMembers.add(memberKey);
    const member = group[0]!.member!;
    const pointer = toPointer([...member.prefixSegments, String(member.index)]);
    removes.push({
      id: suggestionId(laneId, digest, "remove", pointer),
      fieldPath: pointer,
      op: "remove",
      message: MESSAGE_REMOVE,
    });
  }

  // 4. R3 — a surviving member missing a key its siblings carry.
  const adds: ProducedSuggestion[] = [];
  for (const [prefixKey, prefix] of prefixMembers) {
    const restKeysHere = new Set<string>();
    for (const [carrierKey] of carriers) {
      const [ck, rest] = splitCarrierKey(carrierKey);
      if (ck === prefixKey) restKeysHere.add(rest);
    }
    for (const index of [...prefix.indices].sort((a, b) => a - b)) {
      const memberKey = `${prefixKey}\u0001${index}`;
      if (droppedMembers.has(memberKey)) continue;
      const present = new Set((memberFields.get(memberKey) ?? []).map((f) => f.member!.restKey));
      for (const restKey of [...restKeysHere].sort()) {
        if (present.has(restKey)) continue;
        const restSegments = restKey.split("\u0000");
        // DEPTH 1 ONLY. `applyAuditorPatches` walks to the parent and refuses to
        // traverse what is not there, so an add at `/items/1/meta/label` throws
        // whenever `items[1].meta` is absent — which is precisely the case a
        // missing-sibling rule finds. Proposing only a DIRECT key keeps every
        // emitted patch applicable.
        if (restSegments.length !== 1) continue;
        if (restSegments.some((s) => s === "" || FORBIDDEN_SEGMENT.test(s))) continue;
        const pointer = toPointer([...prefix.segments, String(index), ...restSegments]);
        adds.push({
          id: suggestionId(laneId, digest, "add", pointer),
          fieldPath: pointer,
          op: "add",
          value: "",
          message: MESSAGE_ADD,
        });
      }
    }
  }

  // 5. R1 — normalization on every surviving disclosed field.
  const replaces: ProducedSuggestion[] = [];
  for (const f of fields) {
    if (f.member && droppedMembers.has(`${f.member.prefixKey}\u0001${f.member.index}`)) continue;
    const canonical = canonicalFieldValue(f.value);
    if (canonical === f.value) continue;
    if (canonical.length > MAX_SUGGESTION_VALUE_CHARS) continue;
    replaces.push({
      id: suggestionId(laneId, digest, "replace", f.pointer),
      fieldPath: f.pointer,
      op: "replace",
      value: canonical,
      // §VIII's BEFORE — the disclosed text exactly as the lane was shown it,
      // beside the canonicalization it proposes. Dropped rather than truncated
      // past the shared ceiling; the suggestion still stands, it just shows no
      // panel.
      ...(f.value.length <= MAX_SUGGESTION_VALUE_CHARS ? { before: f.value } : {}),
      message: MESSAGE_REPLACE,
    });
  }

  // 6. ORDER IS LOAD-BEARING, because the patches apply sequentially against one
  //    document. Replaces and adds address members by index, so they run while
  //    every index is still valid; the removes run LAST and in DESCENDING index
  //    order, so splicing one member out never shifts an index a later remove is
  //    still pointing at.
  //
  //    THE COMPARISON IS NUMERIC, not lexicographic. Sorting `/items/10` and
  //    `/items/2` as strings puts `/items/2` first, and removing member 2
  //    shifts member 10 down — the second patch would then delete the wrong row
  //    or throw. Segment-wise numeric comparison is the only ordering that keeps
  //    a multi-member removal correct.
  replaces.sort(comparePointers);
  adds.sort(comparePointers);
  removes.sort((a, b) => -comparePointers(a, b));
  return [...replaces, ...adds, ...removes];
}

/**
 * Compare two RFC 6901 pointers SEGMENT-WISE, with numeric segments ordered
 * numerically. This is what makes descending removal order actually descending:
 * `/items/10` sorts after `/items/2`, so the reversed order removes member 10
 * first and member 2's index is still valid when its turn comes.
 */
function comparePointers(a: ProducedSuggestion, b: ProducedSuggestion): number {
  const sa = a.fieldPath.split("/");
  const sb = b.fieldPath.split("/");
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const xa = sa[i]!;
    const xb = sb[i]!;
    if (xa === xb) continue;
    const na = isIndexSegment(xa);
    const nb = isIndexSegment(xb);
    if (na && nb) return Number(xa) - Number(xb);
    return xa < xb ? -1 : 1;
  }
  return sa.length - sb.length;
}

function splitCarrierKey(carrierKey: string): [string, string] {
  const at = carrierKey.indexOf("\u0001");
  return [carrierKey.slice(0, at), carrierKey.slice(at + 1)];
}

// ---------------------------------------------------------------------------
// Reading a stored snapshot back
// ---------------------------------------------------------------------------

/**
 * Parse + HASH-VERIFY a stored snapshot payload. Returns `null` for anything
 * that is not a payload this build understands OR whose recomputed hash differs
 * from the stored one — a row edited underneath the store reads as unreadable,
 * never as a smaller or larger surfaced set. Every consumer (the decision
 * partition in S6b, the chips in S6c) goes through here, so "accepted ⊆
 * surfaced" is checked against bytes that provably have not moved.
 */
export function verifyGateSuggestionSnapshotPayload(
  raw: unknown,
): GateSuggestionSnapshotPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.schemaVersion !== GATE_SUGGESTION_SNAPSHOT_SCHEMA_VERSION) return null;
  if (typeof p.laneId !== "string" || p.laneId === "") return null;
  if (typeof p.snapshotHash !== "string" || p.snapshotHash === "") return null;
  if (typeof p.truncated !== "boolean") return null;
  if (!isTarget(p.target) || !isProvenance(p.provenance)) return null;
  if (!Array.isArray(p.suggestions) || p.suggestions.length > MAX_GATE_SUGGESTIONS) return null;
  if (!p.suggestions.every(isProducedSuggestion)) return null;

  // Suggestion ids must be unique: the whole downstream contract is "accepted is
  // a subset of surfaced", and a duplicated id makes "which one was accepted"
  // unanswerable.
  const ids = new Set((p.suggestions as ProducedSuggestion[]).map((x) => x.id));
  if (ids.size !== p.suggestions.length) return null;

  // INTERNAL BINDINGS. The hash proves the bytes did not move; it does not prove
  // they were CONSISTENT when they were written. A payload whose provenance
  // names a different revision or a different lane than its own target would
  // pass a gate-membership check on `target` while the audit record underneath
  // said something else — so the two must agree here, before anything stores or
  // trusts the row.
  if (p.laneId !== p.provenance.laneId) return null;
  if (p.target.artifactId !== p.provenance.targetArtifactId) return null;
  if (p.target.representationRevisionId !== p.provenance.targetRevisionId) return null;

  const { snapshotHash, ...unhashed } = p as unknown as GateSuggestionSnapshotPayload;
  if (gateSuggestionSnapshotHash(unhashed) !== snapshotHash) return null;
  return p as unknown as GateSuggestionSnapshotPayload;
}

function isTarget(v: unknown): v is CoreAnalysisTarget {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.artifactId === "string" && typeof t.representationRevisionId === "string";
}

function isProvenance(v: unknown): v is CoreAnalysisProvenance {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.laneId === "string" &&
    typeof p.targetArtifactId === "string" &&
    typeof p.targetRevisionId === "string" &&
    typeof p.projectionDigest === "string" &&
    Array.isArray(p.includedFields) &&
    p.includedFields.every((f) => typeof f === "string") &&
    Array.isArray(p.excludedFields) &&
    p.excludedFields.every((f) => typeof f === "string") &&
    (p.authzDecision === "authorized" ||
      p.authzDecision === "partial" ||
      p.authzDecision === "denied")
  );
}

/**
 * A suggestion is well-formed only if it is APPLICABLE. The hash binds bytes,
 * not meaning, so this is where "the stored set is a set of patches the apply
 * transform accepts" is actually enforced: a real pointer whose decoded segments
 * are addressable, a value present exactly when the op needs one, and a bounded
 * size.
 */
function isProducedSuggestion(v: unknown): v is ProducedSuggestion {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id === "") return false;
  if (typeof s.message !== "string") return false;
  if (s.op !== "replace" && s.op !== "add" && s.op !== "remove") return false;
  if (typeof s.fieldPath !== "string" || !s.fieldPath.startsWith("/")) return false;
  if (s.fieldPath.length > 1_024) return false;
  // Decoded segments must be addressable and must not be prototype-mutation
  // keys — the same guard the apply transform applies, checked before the row is
  // ever stored rather than at apply time.
  const segments = s.fieldPath
    .slice(1)
    .split("/")
    .map((seg) => seg.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments.length === 0) return false;
  if (segments.some((seg) => seg === "" || FORBIDDEN_SEGMENT.test(seg))) return false;
  // §VIII's before (cinatra#2852) is OPTIONAL on every op — a snapshot written
  // before the pair existed carries none, and a `remove` never carries one —
  // but when present it obeys the same ceiling the proposal does.
  if (s.before !== undefined) {
    if (typeof s.before !== "string") return false;
    if (s.before.length > MAX_SUGGESTION_VALUE_CHARS) return false;
  }
  // replace/add carry the value the reviewer would apply; remove carries none.
  if (s.op === "remove") return s.value === undefined;
  if (typeof s.value !== "string") return false;
  return s.value.length <= MAX_SUGGESTION_VALUE_CHARS;
}
