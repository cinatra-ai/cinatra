// ---------------------------------------------------------------------------
// Access-picker containment algebra (cinatra#1607 §VI — parentScope &
// allowedScopes). Pure (server- and client-safe): no DOM, no fetch, no session
// reads. Lives beside access-scope.ts — the picker already imports that pure
// module — so it adds no reachable first-party route module to the picker's
// transitive graph.
//
// Spec: the app-permissions design spec, §VI (ratified @645516f3).
//   §6.1 parentScope = STRICT DESCENDANTS + Personal always.
//   §6.2 containment never drops Personal.
//   §6.3 unknown / stale parent → fail closed to Personal-only.
//   §6.4 allowedScopes = a lower-level set/predicate for arbitrary policies
//        (the agent-run 3-field intersection maps onto allowedScopes, NOT onto
//        a single parentScope); parentScope ∩ allowedScopes when both given.
//   §6.5 precedence: containment filters org/team/project/workspace but never
//        removes Personal (within the caller's included-scope-kinds allow-list —
//        it does NOT resurrect a Personal the caller explicitly hid).
//   §6.6 reconciliation: an out-of-scope selection is CLEARED (never silently
//        retained); this module derives the reconciled selection.
//   §6.7 scope identities are TYPED ({ kind, id }), not raw `org:<id>` strings.
//   §6.8 server authority — this is DISPLAY input only; the server independently
//        rejects a forged/stale selection (enforced outside the picker).
// ---------------------------------------------------------------------------

/** The six scope kinds of the closed vocabulary (spec §II). */
export type ScopeKind =
  | "personal"
  | "project"
  | "team"
  | "org"
  | "workspace"
  | "admin";

/**
 * A TYPED scope identity (spec §6.7): `{ kind, id? }` — never a raw `org:<id>`
 * string threaded through the API. `id` is present for project / team / org and
 * absent for personal / workspace / admin.
 */
export type ScopeIdentity = { kind: ScopeKind; id?: string };

/**
 * The lower-level containment constraint (spec §6.4): an explicit SET of typed
 * identities OR a PREDICATE, for arbitrary policies that do not reduce to one
 * parent identity. `parentScope` is sugar for the common single-parent case;
 * `allowedScopes` covers the general case; both may be honoured together
 * (intersection).
 */
export type AllowedScopes =
  | ReadonlyArray<ScopeIdentity>
  | ((scope: ScopeIdentity) => boolean);

/**
 * True iff `token` is a well-formed member of the closed visibility vocabulary.
 * An UNRECOGNIZED token is NOT recognized here so that containment fails CLOSED
 * on it (never offered, always reconciled away) rather than being silently
 * treated as Personal.
 */
export function isRecognizedToken(token: string): boolean {
  if (token === "owner" || token === "workspace" || token === "admin" || token === "org") {
    return true;
  }
  // `org:<id>` — and the INTENTIONAL empty-tail `org:` the server emits for the
  // no-active-org install target — are recognized (org is lenient by design).
  if (token.startsWith("org:")) return true;
  // team / project require a NON-EMPTY id suffix; a bare `team:` / `project:` is
  // malformed and fails closed (never offered / always reconciled away).
  if (token.startsWith("team:")) return token.length > "team:".length;
  if (token.startsWith("project:")) return token.length > "project:".length;
  return false;
}

/**
 * Parse a stored visibility token string into a typed identity. Legacy bare
 * `"org"` maps to `{ kind: "org" }` (no id). An UNRECOGNIZED token maps to
 * `{ kind: "personal" }` only as a structural default — callers gate the
 * "Personal is always offered" rule on the ACTUAL `owner` token (see
 * `isScopeOffered`), so a garbage token never rides the Personal exemption.
 */
export function scopeIdentityOf(token: string): ScopeIdentity {
  if (token === "owner") return { kind: "personal" };
  if (token === "workspace") return { kind: "workspace" };
  if (token === "admin") return { kind: "admin" };
  if (token === "org") return { kind: "org" };
  if (token.startsWith("org:")) return { kind: "org", id: token.slice("org:".length) };
  if (token.startsWith("team:")) return { kind: "team", id: token.slice("team:".length) };
  if (token.startsWith("project:")) return { kind: "project", id: token.slice("project:".length) };
  return { kind: "personal" };
}

/** Render a typed identity back to its stored visibility token string. */
export function scopeIdentityToToken(s: ScopeIdentity): string {
  switch (s.kind) {
    case "personal":
      return "owner";
    case "workspace":
      return "workspace";
    case "admin":
      return "admin";
    case "org":
      return s.id ? `org:${s.id}` : "org";
    case "team":
      return `team:${s.id ?? ""}`;
    case "project":
      return `project:${s.id ?? ""}`;
  }
}

/**
 * The resolved parent-containment mode (spec §6.1 / §6.3). `all` = no narrowing;
 * `org-descendants` = only that org's teams + projects; `personal-only` = the
 * leaf / Personal / unknown-stale fail-closed floor.
 */
export type ParentContainment =
  | { mode: "all" }
  | { mode: "personal-only" }
  | { mode: "org-descendants"; orgId: string };

/**
 * Resolve `parentScope` to a containment mode against the set of orgs the picker
 * actually knows about. Only a KNOWN org parent yields strict descendants; a
 * leaf (team/project) parent, a Personal parent, a workspace/admin parent, or an
 * unknown / stale org all fail closed to Personal-only (§6.1, §6.3). No parent
 * (null/undefined) = all options (§6.1 default).
 */
export function resolveParentContainment(
  parentScope: ScopeIdentity | null | undefined,
  knownOrgIds: ReadonlySet<string>,
): ParentContainment {
  if (parentScope == null) return { mode: "all" };
  if (parentScope.kind === "org" && parentScope.id && knownOrgIds.has(parentScope.id)) {
    return { mode: "org-descendants", orgId: parentScope.id };
  }
  return { mode: "personal-only" };
}

/** Constraints the caller supplies (either, both, or neither). */
export type ContainmentConstraints = {
  parentScope?: ScopeIdentity | null;
  allowedScopes?: AllowedScopes;
};

/**
 * Data the pure algebra needs from the picker's own scope shape: which org ids
 * are known (for stale-parent detection), a team → owning-org lookup, and a
 * project → owning-org lookup (both for the org-descendants filter). Derived
 * from the picker's data, not fetched. `projectOrgOf` is OPTIONAL: the nested
 * multi-select `AvailableScopes` shape carries no per-project org attribution,
 * so multi mode omits it and projects fail CLOSED under an org parent (an
 * explicit `allowedScopes` is the lever that admits specific projects, §6.4);
 * the flat single-org shape supplies it (every flat project belongs to the one
 * active org).
 */
export type ContainmentContext = {
  knownOrgIds: ReadonlySet<string>;
  teamOrgOf: (teamId: string) => string | undefined;
  projectOrgOf?: (projectId: string) => string | undefined;
};

/** True when the caller supplied ANY containment constraint (else the picker is
 *  a pure no-op passthrough — the shipped behaviour). */
export function hasContainment(c: ContainmentConstraints): boolean {
  return c.parentScope != null || c.allowedScopes != null;
}

function allowedScopesAdmits(
  allowed: AllowedScopes | undefined,
  s: ScopeIdentity,
): boolean {
  if (allowed == null) return true;
  if (typeof allowed === "function") return allowed(s);
  return allowed.some((a) => a.kind === s.kind && (a.id ?? undefined) === (s.id ?? undefined));
}

/**
 * Is the visibility `token` OFFERED under the containment constraints?
 *
 * Personal is NEVER dropped by containment (§6.2/§6.5). For every other kind:
 * the parent-containment mode must admit it AND `allowedScopes` (if given) must
 * admit it — parentScope ∩ allowedScopes (§6.4). In `org-descendants` the org
 * itself and the broader workspace/admin scopes are EXCLUDED (strict
 * descendants, §6.1); a team is admitted only when it belongs to the parent
 * org; a project is admitted only when `projectOrgOf` attributes it to the
 * parent org (multi mode has no attribution → projects fail CLOSED; an explicit
 * `allowedScopes` admits specific projects — the agent-run intersection case).
 * An UNRECOGNIZED token fails CLOSED (never offered), not silently Personal.
 */
export function isScopeOffered(
  token: string,
  constraints: ContainmentConstraints,
  ctx: ContainmentContext,
): boolean {
  // An unrecognized token fails CLOSED (never offered / always reconciled away).
  if (!isRecognizedToken(token)) return false;
  const s = scopeIdentityOf(token);
  // §6.2/§6.5: Personal (the real `owner` token) is never dropped by containment.
  if (token === "owner") return true;

  const parent = resolveParentContainment(constraints.parentScope, ctx.knownOrgIds);
  let parentAdmits: boolean;
  switch (parent.mode) {
    case "all":
      parentAdmits = true;
      break;
    case "personal-only":
      parentAdmits = false;
      break;
    case "org-descendants":
      if (s.kind === "team") parentAdmits = s.id != null && ctx.teamOrgOf(s.id) === parent.orgId;
      // A project is admitted only when it is ATTRIBUTED to the parent org
      // (fail closed when unattributed — multi mode has no per-project org
      // mapping, so pure parentScope excludes projects; allowedScopes admits
      // specific projects, §6.4).
      else if (s.kind === "project")
        parentAdmits = s.id != null && ctx.projectOrgOf?.(s.id) === parent.orgId;
      else parentAdmits = false; // org itself, workspace, admin excluded
      break;
  }
  if (!parentAdmits) return false;

  return allowedScopesAdmits(constraints.allowedScopes, s);
}

/**
 * Partition a selection into the still-offered `kept` tokens and the now
 * out-of-scope `dropped` tokens (spec §6.6 reconciliation). Personal is always
 * kept. Callers use this to CLEAR the invalid selection and surface the
 * invalidation inline — never to silently retain an out-of-scope value.
 */
export function reconcileSelection(
  selection: readonly string[],
  constraints: ContainmentConstraints,
  ctx: ContainmentContext,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const t of selection) {
    if (isScopeOffered(t, constraints, ctx)) kept.push(t);
    else dropped.push(t);
  }
  return { kept, dropped };
}
