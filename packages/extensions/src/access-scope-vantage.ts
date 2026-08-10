/**
 * The SCOPE-VANTAGE projection of an extension access policy (cinatra#2474 PR4).
 *
 * `evaluateExtensionAccess` answers "may THIS ACTOR reach this extension". A
 * collection surface sometimes needs the orthogonal question the platform's
 * collection-add contract already names (cinatra#1886 C2 / D11, spec §IX.1):
 *
 *     "could a GENERIC MEMBER positioned at exactly this scope already reach it?"
 *
 * `src/lib/derived-store-ownership.ts` answers that for a data ROW
 * (`scopeMaySeeRow` over `vantageFromScope`). This module answers it for an
 * extension ACCESS POLICY, and it obeys the same doctrine that module states:
 *
 *   > "The projection carries ONLY the axis the scope structurally represents …
 *   >  NOT a synthesized actor (D11: 'no synthesized fake actor') …
 *   >  `isPlatformAdmin` is NEVER set from a scope."
 *
 * So this is deliberately NOT `evaluateExtensionAccess` called with a fabricated
 * `ActorContext`. A scope has no principal id, no platform role and no admin
 * standing; handing the actor evaluator an invented actor to obtain those
 * answers is exactly what D11 forbids.
 *
 * PURE (no I/O, no `server-only`) so it is directly unit-testable and usable
 * from a render path.
 *
 * ── DRIFT CONTROL ──────────────────────────────────────────────────────────
 * The token vocabulary lives with the policy type, so the switch below is
 * EXHAUSTIVE over `AgentAuthPolicyVisibility` and ends in a `never` assignment:
 * a NEW TOKEN IS A COMPILE ERROR HERE, not a silent fall-through. The paired
 * conformance test (`__tests__/access-scope-vantage.test.ts`) additionally
 * asserts that this projection and `evaluateExtensionAccess` agree on the
 * ordinary-member cases where both are defined, so a semantic change to
 * `visibilityAllows` cannot drift past this file unnoticed.
 */

import type {
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
} from "@cinatra-ai/agents/auth-policy-types";

/**
 * The scope a collection surface is asking on behalf of — the SAME roster
 * `CollectionScope` carries, minus the axes an extension policy has no token
 * for. `personal` is the acting user's own scope (see the note on
 * {@link visibilityAdmitsScopeVantage}).
 */
export type AccessScopeVantage =
  | { readonly kind: "personal"; readonly orgId: string }
  | { readonly kind: "team"; readonly orgId: string; readonly scopeId: string }
  | {
      readonly kind: "organization";
      readonly orgId: string;
      readonly scopeId: string;
    }
  | { readonly kind: "project"; readonly orgId: string; readonly scopeId: string };

/**
 * Does ONE stored visibility token admit a generic member of `vantage`?
 *
 * Token-by-token, mirroring `visibilityAllows` in `enforce-extension-access.ts`
 * with the actor axes replaced by the scope's structural axes:
 *
 *   | token          | scope vantage                                          |
 *   |----------------|--------------------------------------------------------|
 *   | `workspace`    | admitted — every member of the tenant. The token itself |
 *   |                | carries no org, so this is only sound AFTER the caller's |
 *   |                | tenant fence has pinned the vantage to the owning org.   |
 *   | `org`          | admitted — same reading ("any same-org member").         |
 *   | `org:<X>`      | admitted iff X is the vantage's org.                     |
 *   | `team:<T>`     | admitted only by team T's own vantage.                   |
 *   | `project:<P>`  | admitted only by project P's own vantage.                |
 *   | `admin`        | DENIED. The tier is owner-aware ADMIN STANDING, a role a |
 *   |                | principal holds; a scope holds none — the same reading   |
 *   |                | `vantageFromScope` encodes with `isPlatformAdmin:false`. |
 *   | `owner`        | DENIED. `visibilityAllows` returns false for it too: the |
 *   |                | owner path is an ACTOR short-circuit, and a scope has no |
 *   |                | principal to match.                                      |
 *
 * PERSONAL IS ADMITTED BY EVERY TOKEN, deliberately, and it is the one arm that
 * is not a structural projection. A personal scope has exactly ONE member — the
 * acting user — so "could a generic member of this scope reach it" and "may the
 * actor reach it" are THE SAME QUESTION, and the caller has already answered it
 * with the actor arm. Returning `false` here for, say, a `team:<T>` token would
 * refuse the actor their own team's extension on their own private page: a
 * denial with no reader to protect. This is sound ONLY while the caller
 * guarantees the destination is owned by that same actor — `listInstalledCatalogTemplates`
 * derives the destination ref from the vantage and pins `ownerLevel:"user"` +
 * the acting user's id for exactly that reason (codex convergence r0/Q3).
 */
export function visibilityAdmitsScopeVantage(
  token: AgentAuthPolicyVisibility,
  vantage: AccessScopeVantage,
): boolean {
  // Structurally invalid vantage → admits nothing (fail closed, mirroring
  // `vantageFromScope`'s null return).
  if (!vantage.orgId) return false;
  if (vantage.kind !== "personal" && !vantage.scopeId) return false;

  // The single member of a personal scope is the actor the caller already
  // authorized — see the docstring.
  if (vantage.kind === "personal") return true;

  if (token === "workspace") return true;
  if (token === "org") return true;
  if (token === "admin") return false;
  if (token === "owner") return false;
  if (token.startsWith("org:")) {
    return token.slice("org:".length) === vantage.orgId;
  }
  if (token.startsWith("team:")) {
    return (
      vantage.kind === "team" && token.slice("team:".length) === vantage.scopeId
    );
  }
  if (token.startsWith("project:")) {
    return (
      vantage.kind === "project" &&
      token.slice("project:".length) === vantage.scopeId
    );
  }

  // Unreachable for a well-typed token (see TOKEN_ROSTER_IS_COVERED below). At
  // runtime a value that reaches here is corruption or a bypassed writer, denied
  // exactly as `visibilityAllows` denies its own unrecognized tail.
  return false;
}

/**
 * COMPILE-TIME DRIFT PIN. The switch above cannot use a `never` assignment,
 * because TypeScript does not narrow a template-literal member
 * (`` `team:${string}` ``) through a `startsWith` test. This assignment gives
 * the same guarantee directly: it fails to compile the moment
 * `AgentAuthPolicyVisibility` gains a token this module does not handle, so a
 * new access tier can never fall through to the silent `return false` above
 * without someone deciding what it means for a SCOPE.
 */
type HandledVisibilityToken =
  | "owner"
  | "org"
  | "admin"
  | "workspace"
  | `org:${string}`
  | `team:${string}`
  | `project:${string}`;

const TOKEN_ROSTER_IS_COVERED: AgentAuthPolicyVisibility extends HandledVisibilityToken
  ? true
  : never = true;
void TOKEN_ROSTER_IS_COVERED;

/**
 * ANY-MATCH over a policy field's token selection — the scope-vantage twin of
 * `tokens.some((v) => visibilityAllows(v, actor, owner))` in
 * `evaluateExtensionAccess`. A selection is a non-empty union of grants, so the
 * vantage is admitted iff SOME token admits it.
 *
 * Accepts a plain readonly array as well as the non-empty tuple, and treats an
 * EMPTY selection as a denial (the type makes it unrepresentable; a value read
 * back from storage might not be).
 */
export function policyFieldAdmitsScopeVantage(
  tokens: AgentAuthPolicyVisibilitySelection | readonly AgentAuthPolicyVisibility[],
  vantage: AccessScopeVantage,
): boolean {
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  return tokens.some((token) => visibilityAdmitsScopeVantage(token, vantage));
}
