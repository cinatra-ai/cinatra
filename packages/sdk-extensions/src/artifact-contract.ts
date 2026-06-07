// Shared SEMANTIC-ARTIFACT manifest contract.
//
// Lives in the SDK so an `kind:"artifact"` extension depends ONLY on
// `@cinatra-ai/sdk-extensions` to type its `cinatra.artifact` manifest and never
// imports the internal host package `@cinatra-ai/objects`. The concrete artifact
// registry + matcher runtime stay host-side in `@cinatra-ai/objects`; this module
// is the schema-only, host-neutral manifest contract the 14 artifact extensions
// declare against.
//
// Consumed by all *-artifact extensions. Structurally identical to
// the `@cinatra-ai/objects` source of truth (objects keeps its own copy for the
// host runtime; they are the same shape so cross-assignability holds).

export type ArtifactRepresentationForms = {
  file?: { mimeTypes: string[] };
  connectorRef?: { resolvedMimeTypes: string[] };
  dashboard?: true;
};

export type ArtifactTemplateVariant = {
  id: string;
  form: "file" | "connectorRef" | "dashboard";
  mimeType: string;
  path: string;
  default?: boolean;
};

export type ArtifactSkillBundle = {
  authoring?: string[];
  matchers?: string[];
  validators?: string[];
  enrichers?: string[];
};

export type SemanticArtifactManifest = {
  accepts: ArtifactRepresentationForms;
  satisfies?: string[];
  templates?: ArtifactTemplateVariant[];
  skills?: ArtifactSkillBundle;
  agentDependencies?: string[];
  /**
   * Per-extension matcher confidence floor (0..1). The matcher runtime asserts
   * this artifact type only when the classifier's returned confidence ≥ this
   * value. The runtime defaults to 0.7 when absent.
   */
  matcherConfidenceThreshold?: number;
};

/**
 * Counterpart on the AGENT-extension side: deterministic agents declare the
 * semantic artifact types they produce. Schema-only.
 */
export type SemanticArtifactRef = { extension: string };
