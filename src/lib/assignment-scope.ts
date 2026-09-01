// ---------------------------------------------------------------------------
// The EXACT-SCOPE TUPLE rule (cinatra#2813 S1, epic #2812).
//
// Skills and context artifacts are assigned to an agent PER SCOPE. Both stores
// key their rows on the same two columns — `scope_kind` and `scope_id` — and
// the authorization resolver decides on the same pair. Written three times,
// that rule would drift three ways, so it is written HERE once and the three
// consume it: the stores validate through `assertAssignmentScope`, the DDL of
// both tables (in both of their homes) is built from `assignmentScopeCheckSql`,
// and the resolver refuses anything this module refuses.
//
// THE RULE, in one sentence: a `workspace` row carries the sentinel
// `__workspace__` and nothing else; every other kind carries a non-empty real
// id and never the sentinel.
//
// WHY A SENTINEL AT ALL. The workspace is the one scope with no id to point
// at — it is the instance itself. A nullable `scope_id` would express that, but
// it would also make the primary key nullable on one of its columns, which
// Postgres does not allow, and it would make every uniqueness question about
// workspace rows answer "unknown". A sentinel keeps the key total. The cost is
// that the sentinel must never appear under another kind, which is exactly what
// the CHECK and this module both refuse.
//
// This module is a PURE leaf: no imports, no `server-only`. The DDL builders
// are consumed by synchronous schema composition, and the resolver is consumed
// by both server and test code.
// ---------------------------------------------------------------------------

/** The five scopes an assignment can be made at, coarse to fine. */
export const ASSIGNMENT_SCOPE_KINDS = [
  "workspace",
  "organization",
  "team",
  "project",
  "user",
] as const;

export type AssignmentScopeKind = (typeof ASSIGNMENT_SCOPE_KINDS)[number];

/**
 * The `scope_id` a workspace row carries.
 *
 * Double-underscored on both sides so it cannot collide with a generated id:
 * every id this system mints is prefixed and alphanumeric.
 */
export const WORKSPACE_SCOPE_SENTINEL = "__workspace__";

/** One exact scope: the pair both assignment stores key on. */
export type AssignmentScope = {
  scopeKind: AssignmentScopeKind;
  scopeId: string;
};

export type AssignmentScopeRefusal =
  | "unknown-scope-kind"
  | "workspace-requires-sentinel"
  | "sentinel-outside-workspace"
  | "missing-scope-id";

export type AssignmentScopeVerdict =
  | { ok: true; scope: AssignmentScope }
  | { ok: false; reason: AssignmentScopeRefusal };

/** Thrown by `assertAssignmentScope`; carries the refusal so a caller can map
 *  it to its own vocabulary without re-deriving why. */
export class AssignmentScopeError extends Error {
  readonly reason: AssignmentScopeRefusal;

  constructor(reason: AssignmentScopeRefusal) {
    super(`assignment scope refused: ${reason}`);
    this.name = "AssignmentScopeError";
    this.reason = reason;
  }
}

function isAssignmentScopeKind(value: unknown): value is AssignmentScopeKind {
  return (
    typeof value === "string" &&
    (ASSIGNMENT_SCOPE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The rule, as a decision. Trims the id (a scope id arriving from a form must
 * not become a different row because of a trailing space) and never throws.
 */
export function evaluateAssignmentScope(input: {
  scopeKind: string | null | undefined;
  scopeId: string | null | undefined;
}): AssignmentScopeVerdict {
  const scopeKind = input.scopeKind;
  if (!isAssignmentScopeKind(scopeKind)) return { ok: false, reason: "unknown-scope-kind" };

  const scopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";

  if (scopeKind === "workspace") {
    // Anything but the sentinel — a real org id, an empty string — is a caller
    // that has not decided whether this row is the workspace's or someone's.
    if (scopeId !== WORKSPACE_SCOPE_SENTINEL) {
      return { ok: false, reason: "workspace-requires-sentinel" };
    }
    return { ok: true, scope: { scopeKind, scopeId } };
  }

  if (scopeId === WORKSPACE_SCOPE_SENTINEL) {
    return { ok: false, reason: "sentinel-outside-workspace" };
  }
  if (scopeId.length === 0) return { ok: false, reason: "missing-scope-id" };
  return { ok: true, scope: { scopeKind, scopeId } };
}

/** The rule, as a precondition. Store writers call this so an invalid tuple
 *  can never reach a statement. */
export function assertAssignmentScope(input: {
  scopeKind: string | null | undefined;
  scopeId: string | null | undefined;
}): AssignmentScope {
  const verdict = evaluateAssignmentScope(input);
  if (!verdict.ok) throw new AssignmentScopeError(verdict.reason);
  return verdict.scope;
}

/**
 * The advisory-lock key for one (namespace, package, exact scope).
 *
 * Serializing per PACKAGE alone would make an organization's assignment write
 * wait behind an unrelated person's, and — worse for correctness — the cap is
 * per exact scope, so a lock any wider than the scope is both slower and no
 * safer. The parts are joined with a separator that cannot occur in a package
 * name, a scope kind or an id, so two different tuples cannot collide into one
 * key. It is a printable byte on purpose: the key is passed to
 * `hashtextextended` as a text parameter, and Postgres refuses a NUL in text.
 */
export function assignmentScopeLockKey(
  namespace: string,
  agentPackageName: string,
  scope: AssignmentScope,
): string {
  return [namespace, agentPackageName, scope.scopeKind, scope.scopeId].join("|");
}

/** A stable, human-readable key for one scope — for map keys and log lines. */
export function assignmentScopeKey(scope: AssignmentScope): string {
  return `${scope.scopeKind}:${scope.scopeId}`;
}

// ---------------------------------------------------------------------------
// The SQL half of the same rule.
//
// Both assignment tables carry these two CHECK constraints, in BOTH of their
// homes (the fresh-install bootstrap and the operator migration). They are
// built here rather than written out per table so a widening of the vocabulary
// is one edit and the parity suites compare identical strings.
// ---------------------------------------------------------------------------

/** `scope_kind IN (...)` over exactly the five kinds. */
export function assignmentScopeKindCheckSql(column = "scope_kind"): string {
  return `${column} IN (${ASSIGNMENT_SCOPE_KINDS.map((k) => `'${k}'`).join(", ")})`;
}

/** The sentinel rule: workspace iff the sentinel, real non-empty id otherwise. */
export function assignmentScopeCheckSql(): string {
  return (
    `((scope_kind = 'workspace' AND scope_id = '${WORKSPACE_SCOPE_SENTINEL}')` +
    ` OR (scope_kind <> 'workspace' AND scope_id <> '${WORKSPACE_SCOPE_SENTINEL}'` +
    // `btrim` mirrors the TypeScript validator's `.trim()`: it rejects an id
    // that is only whitespace AND one that is merely padded, so a writer that
    // bypasses the store cannot land a row the store's own (normalized) reads
    // could never address again.
    ` AND scope_id = btrim(scope_id) AND length(scope_id) > 0))`
  );
}

/** The two constraints, named, ready to splice into a CREATE TABLE body. */
export function assignmentScopeConstraintsSql(tablePrefix: string): string {
  return (
    `CONSTRAINT ${tablePrefix}_scope_kind_chk CHECK (${assignmentScopeKindCheckSql()}),\n` +
    `    CONSTRAINT ${tablePrefix}_scope_tuple_chk CHECK ${assignmentScopeCheckSql()}`
  );
}

/** How an assignment row came to exist. `manual` is a person's choice;
 *  `recommended` is an accepted in-run recommendation. */
export const ASSIGNMENT_SOURCES = ["manual", "recommended"] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

export function assignmentSourceCheckSql(column = "source"): string {
  return `${column} IN (${ASSIGNMENT_SOURCES.map((s) => `'${s}'`).join(", ")})`;
}
