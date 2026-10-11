import {
  artifactEditCapabilityForPropsVersion,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";

/**
 * THE SNAPSHOT A RUNTIME DISPLAY IS HANDED (cinatra#3814). PURE.
 *
 * "The channel version moves, and a display that declared the older version
 * keeps the contract it has." A runtime display that declared an older props
 * version keeps the edit contract it declared: its edit capability is handed at
 * the props version its admitted tuple declares, through the one rule that
 * decides it. Nothing else of the snapshot is narrowed here.
 */
export function runtimeDisplayProps(
  props: ArtifactRendererProps,
  declaredPropsApiVersion: number,
): ArtifactRendererProps {
  const edit = artifactEditCapabilityForPropsVersion(props.edit, declaredPropsApiVersion);
  return edit === props.edit ? props : { ...props, edit };
}
