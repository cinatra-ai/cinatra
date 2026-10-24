/**
 * THE REVIEW TARGET'S ROW FACTS (§IV): the read-only facts of the target
 * header's meta line, composed from the row the host authorized.
 *
 * A MODULE OF ITS OWN, DELIBERATELY. The generic review surface model
 * (`@/lib/artifacts/review-surface-model`) is reached from the chat surface's
 * own module graph, and every module it imports is reached with it. This line
 * words each scope through the one scope composer
 * (`@/lib/artifacts/artifact-owner-label`), and only the hosts that draw the
 * header read it, so it lives here and the model imports nothing for it. The
 * one relative-time formatter stays in the model and is read from there.
 */
import {
  artifactOwnerLabel,
  artifactVisibilityLabel,
} from "@/lib/artifacts/artifact-owner-label";
import { relativeInstant } from "@/lib/artifacts/review-surface-model";

/**
 * The read-only row facts the header's meta line carries (§IV) — the ones the
 * drawing names: "the read-only row facts the host authorized — owner level /
 * visibility, MIME, and updated time".
 *
 * EACH SCOPE BY ITS TYPE AND ITS NAME, NAMED ONCE (cinatra#3443; the §IV rule
 * as the approved drawing redraws it). The owner level and the visibility are
 * two row facts; where a fact names a scope, the line names it the way every
 * scope surface does — its type, then its actual name: "Team: Growth",
 * "Organization: Acme Corp". The type alone is the kind of scope, not the scope.
 * A visibility that reaches the owner's own scope adds no second scope, so an
 * organization's artifact visible to its organization reads "Organization: Acme
 * Corp" once, never twice; a visibility that reaches another scope names it
 * second in the same form ("Team: Growth · Organization: Acme Corp"); a
 * visibility that reaches no scope stays its one word ("Team: Growth ·
 * Private"). The facts carry no label, as the drawing draws them.
 *
 * THE NAMES ARE THE HOST'S. A row carries ids, not names; the host resolves
 * them through the one owner-name resolver and passes them here. A name that
 * did not resolve floors to the drawn type word, never to a stored value.
 *
 * Pure copy, no type keying — every artifact type reads the same line.
 */
export function reviewTargetRowFacts(
  artifact: {
    ownerLevel: string;
    visibility: string;
    mime: string;
    updatedAt: string;
    /** The owning team's or organization's display name, as the host
     *  resolved it; absent or null where none resolved. */
    ownerName?: string | null;
    /** The organization's display name, read where the visibility reaches
     *  the organization; absent or null where none resolved. */
    organizationName?: string | null;
  },
  /** The instant to read `updatedAt` against. Injected so the reading is
   *  testable; defaults to now, which is what every caller wants. */
  now: Date = new Date(),
): string[] {
  return [
    ...reviewTargetScopeFacts(artifact),
    artifact.mime,
    // THE DRAWN READING IS RELATIVE, NOT AN INSTANT (cinatra#3046). The drawing
    // writes "updated 8 min ago"; the decided target printed the stored column
    // straight through — `2026-08-29T06:18:07.421Z`, milliseconds and all — which
    // is a machine's reading of the same fact and is not what §IV draws. One
    // formatter does it, for this line and for the header row facts the sibling
    // leg (pull request 3058) draws from the same projection, so the two surfaces
    // cannot render one column two ways.
    `updated ${relativeInstant(artifact.updatedAt, now)}`,
  ];
}

/** The scope levels that name an entity of their own: a visibility equal to
 *  one of them reaches the owner's own scope when the owner is that level. */
const SCOPE_VISIBILITIES: ReadonlySet<string> = new Set(["team", "organization"]);

/**
 * The scope facts of the meta line (§IV): the owner's scope, then the
 * visibility unless it reaches the owner's own scope. One or two facts.
 */
export function reviewTargetScopeFacts(artifact: {
  ownerLevel: string;
  visibility: string;
  ownerName?: string | null;
  organizationName?: string | null;
}): string[] {
  const owner = artifactOwnerLabel(artifact.ownerLevel, artifact.ownerName);
  if (artifact.visibility === artifact.ownerLevel && SCOPE_VISIBILITIES.has(artifact.visibility)) {
    return [owner];
  }
  if (artifact.visibility === "organization") {
    return [owner, artifactOwnerLabel("organization", artifact.organizationName)];
  }
  return [owner, artifactVisibilityLabel(artifact.visibility)];
}
