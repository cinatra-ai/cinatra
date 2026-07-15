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

import { z } from "zod";
import { SDK_EXTENSIONS_ABI_VERSION, isSdkAbiRangeSatisfied } from "./register";

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
  /**
   * The versioned `cinatra.artifact.ui` block (cinatra#1621, epic #1620): an
   * artifact extension declares an extension-shipped renderer per v1 slot
   * (`detail`/`preview`). Optional — a purely declarative artifact extension
   * (representation forms + skills only) ships none and renders generically.
   * PARSED FIELD-TOLERANTLY: an unsupported/invalid `ui` never rejects the
   * whole manifest (never drops type registration or `objectTypes` claims) —
   * it degrades-with-diagnostic at boot and is rejected fail-closed at the
   * publish/conformance gate. See {@link parseArtifactUi}.
   */
  ui?: ArtifactUiManifest;
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

// ===========================================================================
// cinatra.artifact.ui — the versioned artifact-renderer manifest block
// (cinatra#1621, epic #1620 "artifact extensions own their UI", S1).
//
// This is the CANONICAL v1 schema for the `ui` sub-block. It lives in the
// sdk-extensions LEAF so BOTH byte-mirrored strict manifest schemas
// (`packages/objects/src/semantic-manifest.ts` +
// `packages/extensions/src/artifact-handler.ts`) can import it without sharing
// anything else across the objects↔extensions import cycle (the same
// leaf-import discipline `ARTIFACT_ALLOWED_CINATRA_KEYS` above already uses).
//
// The mirror sides carry `ui` as raw `unknown` in their strict object schema
// (so a malformed `ui` can never fail the whole parse and drop the extension's
// type registration / `objectTypes` claims) and delegate the ACTUAL validation
// to {@link parseArtifactUi} here. Boot degrades-with-diagnostic and keeps the
// claims; the publish/conformance gate rejects fail-closed on the same result.
// ===========================================================================

/**
 * The `ui` block ABI version (distinct from the SDK ABI). v1 is the only
 * shape this schema accepts; a future v2 is an additive, versioned migration.
 * Read AS A LITERAL by the conformance gate's rule derivation
 * (`scripts/extensions/lib/conformance-rules.mjs` — never a re-listed copy).
 */
export const ARTIFACT_UI_ABI_VERSION = 1;

/**
 * The CLOSED v1 renderer-slot enum. `detail` is the artifact detail view;
 * `preview` is the neutral inline-preview capability consumed by in-core reuse
 * sites. An extension declares any NON-EMPTY subset (e.g. `detail` only) — the
 * map is a partial over this enum. Read as a literal by the conformance gate.
 */
export const ARTIFACT_UI_SLOTS = ["detail", "preview"] as const;

/**
 * Slots RESERVED for later waves (e.g. S7 activates `listRow`) — REJECTED in
 * v1 by the closed-enum schema below. Listed (not merged into the active enum)
 * so the reservation is explicit and the gate can name it. The HITL
 * field-renderer system and the chat renderable-view system are SEPARATE
 * channels with their own declaration surfaces, NOT slots of this enum.
 */
export const ARTIFACT_UI_RESERVED_SLOTS = ["listRow", "card", "inline"] as const;

export type ArtifactUiSlot = (typeof ARTIFACT_UI_SLOTS)[number];

/**
 * A single slot renderer. v1 requests NO host ports — a renderer consumes only
 * the host-supplied authorized snapshot, so the schema is `.strict()` and any
 * extra key (a `ports`/`requestedHostPorts` request, or any other field) is
 * REJECTED (a read-only renderer port is out of scope pending an ABI-major
 * process).
 */
export type ArtifactUiRenderer = {
  /**
   * Package-relative, path-contained subpath to the renderer module
   * (`"./src/renderers/detail.tsx"`). Must resolve via the package's
   * `exports`/`files` (validated at the publish/conformance gate, which has
   * the package.json in hand); here we pin the path SHAPE only.
   */
  entry: string;
  /** The props-contract version this renderer expects (integer ≥ 1). */
  propsApiVersion: number;
  /** Optional MIME patterns this slot renders (e.g. `["application/pdf"]`). */
  representations?: string[];
};

export type ArtifactUiManifest = {
  abiVersion: typeof ARTIFACT_UI_ABI_VERSION;
  /**
   * GENERATED from the canonical SDK ABI — never hand-written. The renderer is
   * built against a specific SDK ABI; this pins the compatible host range. See
   * {@link generateArtifactUiSdkAbiRange}.
   */
  sdkAbiRange: string;
  /** NON-EMPTY partial map over the closed v1 slot enum. */
  renderers: Partial<Record<ArtifactUiSlot, ArtifactUiRenderer>>;
};

/**
 * True iff `entry` is a package-relative, path-contained subpath: `"./…"`, no
 * `".."`/empty segment, no absolute path, no protocol/URL, no backslash. The
 * full `exports`/`files` resolution is the publish/conformance gate's job
 * (it has the package on disk); this is the host-neutral shape guard.
 */
export function isContainedEntryPath(entry: string): boolean {
  if (typeof entry !== "string" || entry.length === 0) return false;
  if (!entry.startsWith("./")) return false;
  if (entry.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(entry)) return false; // protocol / URL
  const segments = entry.slice(2).split("/");
  return !segments.some((s) => s === "" || s === "." || s === "..");
}

/**
 * Compute the GENERATED `sdkAbiRange` for a renderer built against a canonical
 * SDK ABI version: a caret range admitting the version and every later MINOR
 * until the next ABI MAJOR (the SDK's additive-minor / breaking-major policy —
 * see `register.ts`). e.g. `"2.4.0"` → `"^2.4.0"`. The conformance gate mirrors
 * this rule (regex-only, over `SDK_EXTENSIONS_ABI_VERSION`'s live source text)
 * to assert a manifest's declared range equals the generated one.
 */
export function generateArtifactUiSdkAbiRange(
  canonicalAbi: string = SDK_EXTENSIONS_ABI_VERSION,
): string {
  const m = canonicalAbi.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    throw new Error(`unparseable canonical SDK ABI version: ${JSON.stringify(canonicalAbi)}`);
  }
  return `^${m[1]}.${m[2]}.${m[3]}`;
}

/** The generated `sdkAbiRange` for the CURRENT canonical SDK ABI. */
export const ARTIFACT_UI_SDK_ABI_RANGE = generateArtifactUiSdkAbiRange();

const artifactUiRendererSchema = z
  .object({
    entry: z
      .string()
      .min(1)
      .refine(isContainedEntryPath, {
        message:
          'renderer `entry` must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL)',
      }),
    propsApiVersion: z.number().int().min(1),
    representations: z.array(z.string().min(1)).min(1).optional(),
  })
  // `.strict()` = v1 renderers request NO host ports: any extra key (a `ports`
  // request or any other field) is rejected.
  .strict();

const artifactUiRenderersSchema = z
  .object(
    Object.fromEntries(
      ARTIFACT_UI_SLOTS.map((slot) => [slot, artifactUiRendererSchema.optional()]),
    ) as Record<ArtifactUiSlot, z.ZodOptional<typeof artifactUiRendererSchema>>,
  )
  // `.strict()` = closed slot enum: a RESERVED slot (listRow/card/inline) or
  // any unknown slot is rejected in v1.
  .strict()
  .refine((r) => Object.keys(r).length > 0, {
    message:
      "`renderers` must declare at least one slot (a non-empty partial map over the v1 slot enum: detail, preview)",
  });

const artifactUiSchema = z
  .object({
    abiVersion: z.literal(ARTIFACT_UI_ABI_VERSION),
    sdkAbiRange: z.string().min(1),
    renderers: artifactUiRenderersSchema,
  })
  .strict();

export type ArtifactUiParseResult =
  | { ok: true; ui: ArtifactUiManifest }
  | { ok: false; diagnostic: string };

/**
 * SANITIZE a zod validation failure into a single-line diagnostic that echoes
 * only the failing PATH + zod issue CODE — never a received value — so a
 * hostile manifest can't smuggle content into host logs / the boot diagnostic.
 */
function sanitizeUiDiagnostic(error: z.ZodError): string {
  const parts = error.issues.slice(0, 6).map((issue) => {
    const at = issue.path.length ? issue.path.join(".") : "<root>";
    return `${at} (${issue.code})`;
  });
  const suffix = error.issues.length > 6 ? "; …" : "";
  return `cinatra.artifact.ui is invalid: ${parts.join("; ")}${suffix}`;
}

/**
 * TOLERANT validator for the `cinatra.artifact.ui` block, shared by both
 * byte-mirrored strict manifest schemas. NEVER throws and NEVER implies the
 * surrounding manifest is invalid: the caller keeps the extension's type
 * registration + claims regardless.
 *  - boot / runtime: on `{ ok: false }` the caller DROPS `ui` (generic
 *    rendering) and surfaces `diagnostic` — degrade, never reject.
 *  - publish / conformance gate: the SAME `{ ok: false }` is rejected
 *    fail-closed.
 *
 * sdkAbiRange SEMANTICS — this HOST-SIDE verdict checks SATISFACTION, not the
 * exact generated pin: the host does not know which SDK the extension was built
 * against except via the declared range, and a renderer built against an EARLIER
 * host-compatible SDK (e.g. `^2.3.0` on host `2.4.0`) must still render — an
 * exact-match here would break forward compatibility. The GENERATED-only
 * contract ("`sdkAbiRange` is generated, never hand-written" — it must equal
 * `^<the SDK it was built against>`) is enforced ONE layer up, at the
 * extension-repo publish CONFORMANCE GATE (`conformance-gate.mjs`, which runs
 * against the pinned SDK checkout that IS the build target). So a well-formed
 * but non-canonical range is accepted here yet rejected at publish — the
 * intended layering, not a divergence.
 */
export function parseArtifactUi(input: unknown): ArtifactUiParseResult {
  const parsed = artifactUiSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostic: sanitizeUiDiagnostic(parsed.error) };
  }
  if (!isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, parsed.data.sdkAbiRange)) {
    return {
      ok: false,
      diagnostic:
        `cinatra.artifact.ui declares sdkAbiRange the host SDK ABI ` +
        `${SDK_EXTENSIONS_ABI_VERSION} does not satisfy (renderer built for an incompatible SDK)`,
    };
  }
  return { ok: true, ui: parsed.data as ArtifactUiManifest };
}
