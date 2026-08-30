import "server-only";

// The ISLAND DATA-CAPABILITY ADMISSION (enabler 0.12 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// The pure decision a display's data road runs BEFORE it reads anything: the
// live access re-check the enabler requires "on every call", and the ONE named
// refusal a display is allowed to see.
//
// THE LADDER, fail-closed, in the same order as the byte egress's:
//   1. THE CAPABILITY ITSELF — sealed, unexpired, under the DATA label. An
//      island credential or a byte capability presented here cannot decode, so
//      "the one-use island credential is never reused for data" is structural.
//   2. THE LIVE PRINCIPAL — the `cwu_` row behind the sealed `jti` still alive
//      and still bound to the same person, org, site, client, instance, agent.
//   3. RUN READ ACCESS — RE-CHECKED ON THIS CALL. Not cached, not carried over
//      from the paint: a reader who lost access between two queries loses the
//      second one.
//   4. THE GATE BINDING — the sealed (artifact, revision) pair must be in this
//      gate's FROZEN pinned set.
//   5. THE CONFIGURATION AGREEMENT — the sealed configuration digest must equal
//      the digest of the configuration pinned at that revision RIGHT NOW. This
//      is what keeps a display's drawn chrome and its fetched numbers on one
//      revision; a capability minted against an earlier configuration is refused
//      rather than served against a later one.
//
// THE NAMED NO-DATA STATE. Unlike the byte egress, whose every refusal must be
// one indistinguishable 404 (it answers a subresource load a reader can see),
// this road answers CODE the host itself wrote and mounted. The enabler says "a
// refused capability yields the named no-data state", so the answer carries ONE
// name — `no-data` — which the display renders as its own honest empty reading.
// It is a SINGLE name for every refusal, not a taxonomy: the display learns that
// there are no numbers, never why, so nothing here is an oracle either.

import {
  verifyReviewIslandDataCapability,
  type VerifiedReviewIslandDataCapability,
} from "@/lib/lifecycle/review-island-data-capability";
import type { LiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

/** The ONE name a refused data road yields. The display draws its no-data
 *  reading from this and nothing else. */
export const ISLAND_NO_DATA_STATE = "no-data" as const;

/** One pinned target of a gate, as the gate froze it. */
export interface IslandDataGateTarget {
  artifactId: string;
  representationRevisionId: string;
}

export interface IslandDataServePorts {
  /** The live `cwu_` binding behind the sealed jti — null when dead/revoked. */
  readLivePrincipal: (jti: string) => LiveWidgetCapturePrincipal | null;
  /** Live run READ access for the sealed principal — called ON EVERY CALL. */
  runReadAccess: (input: { runId: string; userId: string; orgId: string }) => Promise<boolean>;
  /** The gate's FROZEN pinned target set — null when the gate is absent. */
  readGatePinnedTargets: (
    runId: string,
    reviewTaskId: string,
  ) => Promise<readonly IslandDataGateTarget[] | null>;
  /** The digest of the configuration pinned at that exact revision, right now.
   *  Null when there is no such pinned configuration to agree with. */
  readPinnedConfigurationDigest: (input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
  }) => Promise<string | null> | string | null;
}

export type IslandDataAdmission =
  | { ok: true; capability: VerifiedReviewIslandDataCapability }
  | { ok: false; state: typeof ISLAND_NO_DATA_STATE };

const NO_DATA: IslandDataAdmission = { ok: false, state: ISLAND_NO_DATA_STATE };

/**
 * Admit — or refuse — ONE data call. Never throws: a port that rejects is the
 * no-data state, because an exception would surface as a distinguishable answer.
 */
export async function admitIslandDataCall(params: {
  encodedCapability: string | null | undefined;
  ports: IslandDataServePorts;
  nowSeconds?: number;
}): Promise<IslandDataAdmission> {
  const { encodedCapability, ports } = params;

  // 1. The capability itself, under the DATA label.
  const capability = verifyReviewIslandDataCapability(encodedCapability, {
    nowSeconds: params.nowSeconds,
  });
  if (!capability) return NO_DATA;

  try {
    // 2. The live principal, and the sealed binding still agreeing with it.
    const live = ports.readLivePrincipal(capability.jti);
    if (!live) return NO_DATA;
    if (
      live.userId !== capability.userId ||
      live.orgId !== capability.orgId ||
      live.siteId !== capability.siteId ||
      live.client !== capability.client ||
      live.instanceId !== capability.instanceId ||
      live.agentSlug !== capability.agentSlug
    ) {
      return NO_DATA;
    }

    // 3. Live run READ access — on THIS call.
    const canRead = await ports.runReadAccess({
      runId: capability.runId,
      userId: capability.userId,
      orgId: capability.orgId,
    });
    if (!canRead) return NO_DATA;

    // 4. The gate binding.
    const targets = await ports.readGatePinnedTargets(
      capability.runId,
      capability.reviewTaskId,
    );
    if (!targets || targets.length === 0) return NO_DATA;
    const pinnedByThisGate = targets.some(
      (t) =>
        t.artifactId === capability.artifactId &&
        t.representationRevisionId === capability.representationRevisionId,
    );
    if (!pinnedByThisGate) return NO_DATA;

    // 5. The configuration agreement.
    const digest = await ports.readPinnedConfigurationDigest({
      orgId: capability.orgId,
      artifactId: capability.artifactId,
      representationRevisionId: capability.representationRevisionId,
    });
    if (!digest || digest !== capability.configurationDigest) return NO_DATA;

    return { ok: true, capability };
  } catch {
    return NO_DATA;
  }
}
