import { notFound } from "next/navigation";

/**
 * The merge-proposals LIST lives at `/artifacts?mode=merge` (an admin mode of
 * the consolidated surface, cinatra#1431). This bare-path guard exists only so
 * `/artifacts/merge-proposals` cannot be misread by the single-segment
 * `/artifacts/[id]` artifact-detail route as an artifact whose id is
 * "merge-proposals"; it 404s. The detail route is
 * `/artifacts/merge-proposals/[proposalId]`.
 */
export default function MergeProposalsIndexRedirectGuard(): never {
  notFound();
}
