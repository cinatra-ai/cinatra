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

/**
 * The complete allowlist of top-level `cinatra.*` package.json keys a
 * `kind:"artifact"` extension may declare (cinatra#979 checker-rules
 * addendum: "mirror ARTIFACT_ALLOWED_CINATRA_KEYS by importing the live
 * constants, never a re-listed copy").
 *
 * This is now the SINGLE canonical copy. It used to be hand-duplicated
 * ("kept in lock-step") across `packages/objects/src/integration/
 * register-artifact-extensions.ts`, `packages/extensions/src/
 * artifact-handler.ts`, and `packages/agents/src/mcp/handlers.ts` — three
 * independent literals with no shared source, exactly the prose-vs-code drift
 * risk the #979 addendum calls out. All three now import this export instead
 * of re-declaring it. Safe to share from here: `sdk-extensions` is a leaf
 * package (no workspace dependencies of its own), so importing it does not
 * create the objects↔extensions cycle those two packages otherwise avoid by
 * duplicating code between themselves.
 *
 * `dependencies` (cross-kind `ExtensionDependency[]`, extension-deps gate) and
 * `roles` (cinatra#151 Stage 5 role bindings, validated fail-closed by the
 * agent-bindings generator) are permitted CROSS-KIND metadata on any
 * extension manifest, not agent-package drift — hence their presence here
 * alongside the artifact-only `artifact` key.
 *
 * `displayName` is likewise cross-kind PRESENTATION metadata: a human-readable
 * label the host already recognises as a name source for a type
 * (`generic-renderers` name-key list) and that connectors declare too. The
 * shipped artifact fleet (every `@cinatra-ai/*-artifact`) declares it, and the
 * companion repos' own kind-gate (`extension-kind-gate.mjs`
 * ARTIFACT_ALLOWED_CINATRA_KEYS) already permits it — so the host allowlist is
 * reconciled to that shipped contract here. Without it the artifact bridge
 * (`registerArtifactExtensions`) rejects the whole manifest as extraneous and
 * skips registration, dropping the extension's `artifact` descriptor AND its
 * `objectTypes` claims at boot.
 *
 * `vendor` (cinatra#12 `ConnectorVendorIdentity`, `{ key, name }`) is admitted
 * for the SAME cross-kind PRESENTATION reason as `displayName`. It began as a
 * connector-only key, but the installed-card byline (`{Kind} by {Vendor}`,
 * cinatra#948 §VI / #1570) reads it kind-agnostically: the byline resolver
 * (`resolveInstalledVendorName` → `vendorFor`) takes the manifest's declared
 * vendor NAME for ANY kind and never infers one from the npm scope, so a
 * first-party artifact (e.g. `@cinatra-ai/default-artifact`) needs a declared
 * `vendor` to render "… by Cinatra" instead of dropping the clause. The host
 * loader carries it through UNVALIDATED (shape/ownership/uniqueness are the
 * marketplace publish gate's job, per `ConnectorVendorIdentity` in
 * `./manifest`); admitting it here is purely so the artifact bridge does not
 * reject the whole manifest as extraneous. Narrowly additive — unknown keys
 * stay rejected.
 */
export const ARTIFACT_ALLOWED_CINATRA_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "apiVersion",
  "artifact",
  "dependencies",
  "roles",
  "displayName",
  "vendor",
]);
