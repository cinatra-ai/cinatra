import {
  artifactEditCapabilityForPropsVersion,
  artifactRendererPropsAtVersion,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";

/**
 * THE SNAPSHOT A RUNTIME DISPLAY IS HANDED (cinatra#3814). PURE.
 *
 * "The channel version moves, and a display that declared the older version
 * keeps the contract it has." A runtime display that declared an older props
 * version keeps the edit contract it declared: its edit capability is handed at
 * the props version its admitted tuple declares, through the one rule that
 * decides it.
 *
 * THE REVIEW READING AND THE DATA ROAD ARE NARROWED TOO (cinatra#4311). The
 * artifact page builds its snapshot at the host's ceiling and hands the same
 * snapshot to whichever display resolves, so a runtime display that declared
 * version 2 or 1 would otherwise be handed `review` and `data`, the two fields
 * those shapes have no place for ("ABSENT BELOW v3"), and the decision time
 * below version 5. Those fields are read off the one narrowing rule,
 * `artifactRendererPropsAtVersion`, so this hand-over and the build-map seam
 * cannot disagree on them. Nothing else of the snapshot is narrowed here: the
 * byte reference and `propsApiVersion` stay as carried, as cinatra#3814 pinned.
 */
export function runtimeDisplayProps(
  props: ArtifactRendererProps,
  declaredPropsApiVersion: number,
): ArtifactRendererProps {
  const edit = artifactEditCapabilityForPropsVersion(props.edit, declaredPropsApiVersion);
  const atDeclared = artifactRendererPropsAtVersion(props, declaredPropsApiVersion);
  const dropData = "data" in props && !("data" in atDeclared);
  const dropReview = "review" in props && !("review" in atDeclared);
  const dropDecidedAt =
    !dropReview &&
    props.review?.decidedAt !== undefined &&
    atDeclared.review?.decidedAt === undefined;
  if (edit === props.edit && !dropData && !dropReview && !dropDecidedAt) return props;
  const next: ArtifactRendererProps = { ...props, edit };
  if (dropData) delete next.data;
  if (dropReview) delete next.review;
  else if (dropDecidedAt && atDeclared.review) next.review = atDeclared.review;
  return next;
}
