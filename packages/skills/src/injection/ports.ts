/**
 * Host ports for the injection resolver (cinatra#2091, epic #2086 S4).
 *
 * The resolver owns the POLICY — which sources feed which intent, the ranking,
 * the cap, the attribution rules. It owns no I/O. Every fact it needs arrives
 * through one of these ports, supplied by the surface that holds the trusted
 * handles (a server-vetted run row, a session, the catalog client). That keeps
 * `@cinatra-ai/skills/injection` a pure leaf and makes every authorization rule
 * unit-testable without a database.
 *
 * All ports are optional on the type. The resolver requires exactly the ones
 * its intent needs and throws `MissingInjectionPortError` naming the missing
 * port — never a silent empty set.
 */

/**
 * Re-declared as a literal union rather than imported from `./index`: the
 * contract module imports THESE types, so importing back would be a cycle. The
 * canonical vocabulary (and its runtime guard) lives in `./index`; this is the
 * same shape, and a drift is a compile error at every port implementation.
 */
type ReviewerLane = "security-reviewer" | "code-reviewer" | "planner";

/**
 * The outcome of a server-side authorization check. A refusal is EXPLICIT:
 * `{ok: false, reason}` becomes a thrown `SkillInjectionAuthorizationError`,
 * so an authorization failure can never be mistaken for a correctly-empty set.
 */
export type InjectionAuthorization =
  | {
      readonly ok: true;
      /**
       * The server-verified owner of the subject run, when the check resolved
       * one. This — never a caller-supplied id — is what scopes the personal
       * delta.
       */
      readonly runOwnerUserId?: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** A skill a port resolved, optionally pinned to an immutable revision. */
export type InjectionSkillRef = {
  readonly skillId: string;
  readonly revisionId?: string | null;
};

/** The personal delta a port resolved. Content WITHOUT an id is refused. */
export type InjectionPersonalDelta = {
  readonly skillId: string;
  readonly revisionId?: string | null;
  readonly content: string;
};

export type InjectionResolverPorts = {
  // -- authorization -------------------------------------------------------
  /** Verify the caller owns the run it claims (`agent-run`). */
  authorizeAgentRun?(input: {
    agentId: string;
    runId?: string;
    userId?: string;
  }): Promise<InjectionAuthorization>;
  /** Verify the assistant session belongs to the user (`assistant`). */
  authorizeAssistantSession?(input: {
    agentId: string;
    userId: string;
    sessionId: string;
  }): Promise<InjectionAuthorization>;
  /** Verify the caller IS the authoring surface (`agent-authoring`). */
  authorizeAuthoringSurface?(input: {
    agentSpecRef: string;
  }): Promise<InjectionAuthorization>;
  /**
   * Verify the caller is the server-side creation-review orchestration AND that
   * the lane identity was bound server-side (`agent-creation-review`).
   */
  authorizeCreationReview?(input: {
    candidateAgentRef: string;
    reviewerLane: ReviewerLane;
  }): Promise<InjectionAuthorization>;
  /** Verify audit authority + run ownership (`auditor-run-skills`). */
  authorizeAuditAuthority?(input: {
    runId: string;
  }): Promise<InjectionAuthorization>;

  // -- member derivation ---------------------------------------------------
  /**
   * The consumer extension's DECLARED runtime skill dependencies — the S3
   * dependency-to-injection projection. Top rank, never dropped for a
   * recommendation.
   */
  resolveDeclaredDependencySkills?(input: {
    consumerRef: string;
  }): Promise<readonly InjectionSkillRef[]>;
  /**
   * The run's authoritative selected-revision set when one exists, else the
   * computed assignment. Recommendation rank.
   */
  resolveRunRecommendedSkills?(input: {
    agentId: string;
    runId?: string;
    actorUserId?: string | null;
  }): Promise<readonly InjectionSkillRef[]>;
  /** The assistant's own required (declared) injectable set. */
  resolveAssistantRequiredSkills?(input: {
    agentId: string;
  }): Promise<readonly InjectionSkillRef[]>;
  /** The authoring surface's own skill set. */
  resolveAuthoringSkills?(input: {
    agentSpecRef: string;
  }): Promise<readonly InjectionSkillRef[]>;
  /** THAT LANE's pinned methodology skills — never the candidate's. */
  resolveLaneMethodologySkills?(input: {
    reviewerLane: ReviewerLane;
  }): Promise<readonly InjectionSkillRef[]>;
  /** The RECORDED skill set of an already-executed run. */
  resolveRecordedRunSkills?(input: {
    runId: string;
  }): Promise<readonly InjectionSkillRef[]>;
  /** The run owner's personal delta skill, scoped to a VERIFIED owner id. */
  resolvePersonalDelta?(input: {
    agentId: string;
    userId: string;
  }): Promise<InjectionPersonalDelta | null>;
};
