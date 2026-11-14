import "server-only";

// ---------------------------------------------------------------------------
// THE REVIEW SURFACE'S ROADS — wave 3 of `PLAN: Agents Lifecycle (D) — Review`
// (cinatra#3091, epic #3087).
//
// A review target is prepared by ONE composition on every surface, which is what
// keeps the card, the page and the island drawing the same artifact. But the
// three surfaces do not all reach BYTES the same way, and after this wave they
// do not all reach CONTENT the same way either:
//
//   · the byte road — a first-party reader carries a cookie and the session byte
//     routes work; an island reader carries a broker bearer, and a subresource
//     load carries no bearer, so its addresses have to be sealed capabilities.
//   · the content channel — the three browser fetchers stop fetching and are
//     handed their substance, read on the server from the pinned revision.
//
// SO THE ROADS ARE BUILT HERE AND HANDED IN, and the shared preparation path
// takes them as data. That is not only tidiness: `review-gate-ports.ts` and
// `review-target-prepare.ts` are reachable from four routes whose first-party
// module count is LOCKED by the route-graph ratchet, and the channel's builder
// and the capability minters pull real graphs behind them. Importing them where
// the roads are CHOSEN — on the review page, the artifact page and the island,
// none of which is a locked route — costs those four routes nothing, and the
// shared path names the roads by type alone.
//
// A SURFACE THAT NAMES NO ROAD IS UNCHANGED IN EVERY PARTICULAR: no byte
// reference beyond the session addresses it always had, and the channel's own
// named absence for its content.
// ---------------------------------------------------------------------------

import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

import {
  buildArtifactContentProjection,
  type ArtifactRepresentationForm,
} from "@/lib/artifacts/artifact-content-channel";
import { createPinnedSubstanceReader } from "@/lib/artifacts/artifact-content-substance-reader";
import {
  buildIslandArtifactByteMinter,
  type ArtifactByteUrlMinter,
  type IslandBytePrincipal,
} from "@/lib/lifecycle/review-island-byte-road";

// Re-exported so the shared preparation path names BOTH roads from one module,
// by type alone. It never has to reach the lifecycle tree to do it.
export type { ArtifactByteUrlMinter };

/**
 * Read one pinned revision's substance and project it for a display.
 *
 * The SEAM, not the implementation: a surface that has one hands it in, and the
 * preparation path calls it. A surface with none gets the channel's named
 * absence, which is what every consumer of this contract said about itself
 * before this wave.
 */
export type ArtifactContentBuilder = (input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string | null;
  form: ArtifactRepresentationForm | null;
  mime: string | null;
  /**
   * The bound the CALLER's membership answer was made under. A live reading
   * never replays a tombstoned pin; the gate-authorized historical reading
   * (enabler 0.9) may, inside the frozen set the gate pinned. Absent reads as
   * the safe reading.
   */
  liveOnly?: boolean;
  /**
   * The pinned configuration record the caller already resolved (enabler 0.10),
   * so the configuration arm does not read the same row a second time.
   */
  carriedConfiguration?: { configuration: unknown; digest: string | null } | null;
}) => Promise<ArtifactContentProjection>;

/**
 * THE ISLAND ROAD — one reader, one gate, and the bindings every capability
 * minted for this paint is sealed to.
 *
 * It is the ONE argument that turns a surface from cookie addresses to island
 * ones, so there is exactly one place a surface can be on the wrong road and
 * exactly one place to read which road it is on.
 */
export interface ReviewIslandRoad {
  principal: IslandBytePrincipal;
  runId: string;
  reviewTaskId: string;
}

/** Everything a surface may hand the shared preparation path. */
export interface ReviewSurfaceRoads {
  /** How this surface addresses bytes. Absent ⇒ the session byte routes. */
  byteMinter?: ArtifactByteUrlMinter;
  /** How this surface reads content. Absent ⇒ the channel's named absence. */
  buildContent?: ArtifactContentBuilder;
}

/**
 * The host's content builder — the channel's asynchronous builder bound to the
 * host's own pinned-revision read.
 *
 * ONE PORTS OBJECT per surface load, so every target on a gate reads its
 * substance through the same seam.
 */
export function hostArtifactContentBuilder(): ArtifactContentBuilder {
  // THE CHANNEL'S OWN READ (enabler 0.3, cinatra#3027). Bound PER TARGET rather
  // than once per surface, because two of its inputs are the target's own: the
  // bound its membership answer was made under, and the pinned configuration
  // record that answer already carried. Constructing it here — and never on the
  // shared preparation path — is what keeps the four locked routes' first-party
  // module counts where the route-graph ratchet holds them.
  return (input) =>
    buildArtifactContentProjection(
      input,
      createPinnedSubstanceReader({
        liveOnly: input.liveOnly !== false,
        carriedConfiguration: input.carriedConfiguration ?? null,
      }),
    );
}

/**
 * The roads for a FIRST-PARTY surface: the content channel, and nothing else.
 *
 * The byte road stays the session routes — they work under a cookie and they
 * are the narrower grant.
 */
export function firstPartyReviewSurfaceRoads(): ReviewSurfaceRoads {
  return { buildContent: hostArtifactContentBuilder() };
}

/**
 * The roads for the ISLAND: the same content channel, plus the capability road
 * that makes a media display paint inside a third-party application at all.
 *
 * MINTING IS NOT AUTHORIZING. Every binding sealed here is re-proved live by
 * the serving paths before a byte is read; a road built for a gate its reader
 * may not see produces addresses that 404.
 */
export function islandReviewSurfaceRoads(road: ReviewIslandRoad): ReviewSurfaceRoads {
  return {
    buildContent: hostArtifactContentBuilder(),
    byteMinter: buildIslandArtifactByteMinter(road),
  };
}
