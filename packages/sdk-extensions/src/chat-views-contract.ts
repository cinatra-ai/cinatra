// Shared CHAT RENDERABLE-VIEW declaration contract — `cinatra.views` v1
// (cinatra#1626, epic #1620 "artifact extensions own their UI", S9/M4).
//
// This is the CANONICAL v1 schema for the versioned top-level `cinatra.views`
// manifest field: the declaration surface by which an extension ships the chat
// renderable-view COMPONENT for one or more wire `viewType`s (e.g. the migrating
// `chart` embed). It is a SEPARATE channel from `cinatra.artifact.ui`
// (cinatra#1621, S1) — the S1 comment already records that "the chat
// renderable-view system are SEPARATE channels with their own declaration
// surfaces": this file is that surface. It has its OWN ABI version
// ({@link CHAT_VIEWS_ABI_VERSION}), distinct from the `cinatra.artifact.ui` ABI
// and from the SDK ABI.
//
// SCOPE OF THIS SLICE (S9-a): the declaration + generation contract only. The
// wire viewType PAYLOAD schemas + detectors stay host-side permanently
// (`@cinatra-ai/agent-ui-protocol/renderable-views`; they emit stable payloads
// and never import an extension — epic AC2); the host dispatch that resolves a
// `viewType` to the generated extension component (and falls back to
// `RenderableViewFallback` on absence — epic AC1) rides the S9 host-wiring slice.
//
// WHY THE LEAF (objects↔extensions no-cycle rule): like the S1 `parseArtifactUi`
// precedent in `./artifact-contract`, the schema + tolerant parser live in the
// `sdk-extensions` LEAF so every consumer imports the ONE shared source and no
// two of them drift. `cinatra.views` is a TOP-LEVEL CROSS-KIND manifest field
// (the carrier kinds are initially the kinds owning the migrating views,
// extendable) consumed exactly like the other top-level cross-kind fields
// `cinatra.streams`/`cinatra.webhooks`: the BUILD generator
// (`scripts/extensions/generate-extension-manifest.mjs`) reads it into a
// literal-import map keyed by `viewType`, and the extension-repo publish
// CONFORMANCE gate (`scripts/extensions/conformance-gate.mjs`) validates it
// fail-closed — neither is an objects↔extensions dual-parsed DESCRIPTOR (the
// case that forces the S1 `cinatra.artifact.ui` byte-mirror block across
// `packages/objects` + `packages/extensions`), so `cinatra.views` needs no such
// runtime block. The generator hand-mirrors the resolvability rules and the gate
// hand-mirrors the grammar/containment as plain JS (both run on bare `node`);
// the gate DERIVES {@link CHAT_VIEWS_ABI_VERSION} from THIS source text (never a
// re-listed copy — the #979 addendum principle), so the leaf stays the single
// authority.

import { z } from "zod";
import { isContainedEntryPath } from "./artifact-contract";

/**
 * The `cinatra.views` block ABI version (distinct from BOTH the SDK ABI and the
 * `cinatra.artifact.ui` ABI). v1 is the only shape this schema accepts; a future
 * v2 is an additive, versioned migration. Read AS A LITERAL by the conformance
 * gate's rule derivation (`scripts/extensions/lib/conformance-rules.mjs`) — never
 * a re-listed copy.
 */
export const CHAT_VIEWS_ABI_VERSION = 1;

/**
 * The `viewType` discriminator grammar: strict lowercase snake_case (a leading
 * alnum segment, underscore-joined alnum segments) — the shape the shipped wire
 * viewTypes already use (`content_change_proposal`, `artifact_preview`,
 * `citation_group`, `change_history`). This is the wire discriminator an
 * extension binds its renderer to; the host owns the PAYLOAD schema for that
 * discriminator (`@cinatra-ai/agent-ui-protocol/renderable-views`). Hand-mirrored
 * as one line in the conformance gate (like `isUiEntryContained` mirrors the
 * leaf's `isContainedEntryPath`); the leaf schema stays the runtime authority.
 */
export const CHAT_VIEW_TYPE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** True iff `viewType` is a valid discriminator (strict lowercase snake_case). */
export function isValidChatViewType(viewType: unknown): boolean {
  return typeof viewType === "string" && CHAT_VIEW_TYPE_RE.test(viewType);
}

/**
 * A single chat renderable-view provider entry: an extension binds ONE renderer
 * module to ONE wire `viewType`.
 */
export type ChatRenderableViewEntry = {
  /**
   * The wire viewType discriminator this entry provides the renderer for. At
   * most ONE effective provider per viewType across the fleet — a within-manifest
   * duplicate rejects here (the schema refinement below); a cross-fleet duplicate
   * rejects at generation (the build map is keyed by `viewType`).
   */
  viewType: string;
  /**
   * Package-relative, path-contained subpath to the renderer module
   * (`"./src/views/chart.tsx"`) default-exporting a component implementing the
   * renderable-view props ABI. Full `exports`/`files` resolution is the
   * publish/conformance gate + generator's job (they have the package on disk);
   * here we pin the path SHAPE only (the SAME containment guard a
   * `cinatra.artifact.ui` renderer `entry` uses — reused from `./artifact-contract`).
   */
  entry: string;
  /** The props-contract version this renderer expects (integer ≥ 1). */
  propsApiVersion: number;
};

export type ChatViewsManifest = {
  abiVersion: typeof CHAT_VIEWS_ABI_VERSION;
  /** NON-EMPTY list of provider entries; `viewType`s are unique within a manifest. */
  entries: ChatRenderableViewEntry[];
};

const chatViewEntrySchema = z
  .object({
    viewType: z
      .string()
      .min(1)
      .refine(isValidChatViewType, {
        message:
          "chat-view `viewType` must be strict lowercase snake_case ([a-z0-9], underscore-joined, e.g. `chart`, `content_change_proposal`)",
      }),
    entry: z
      .string()
      .min(1)
      .refine(isContainedEntryPath, {
        message:
          'chat-view `entry` must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL)',
      }),
    propsApiVersion: z.number().int().min(1),
  })
  // `.strict()` = the closed v1 entry shape: viewType/entry/propsApiVersion only.
  // Any extra key (a port request or any other field) is REJECTED.
  .strict();

const chatViewsSchema = z
  .object({
    abiVersion: z.literal(CHAT_VIEWS_ABI_VERSION),
    entries: z
      .array(chatViewEntrySchema)
      .min(1)
      .superRefine((entries, ctx) => {
        // One effective provider per viewType — a manifest declaring the same
        // viewType twice is a collision the dispatch could never disambiguate.
        // (The cross-FLEET facet of the same rule is the generator's viewType-
        // keyed build map, which rejects two packages claiming one viewType.)
        const seen = new Set<string>();
        for (const [i, entry] of entries.entries()) {
          if (seen.has(entry.viewType)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, "viewType"],
              message: `duplicate viewType "${entry.viewType}" within the manifest (one effective provider per viewType)`,
            });
          }
          seen.add(entry.viewType);
        }
      }),
  })
  .strict();

export type ChatViewsParseResult =
  | { ok: true; views: ChatViewsManifest }
  | { ok: false; diagnostic: string };

/**
 * SANITIZE a zod validation failure into a single-line diagnostic that echoes
 * only the failing PATH + zod issue CODE — never a received value — so a hostile
 * manifest can't smuggle content into host logs / the boot diagnostic (the same
 * discipline as the S1 `parseArtifactUi` sanitizer).
 */
function sanitizeViewsDiagnostic(error: z.ZodError): string {
  const parts = error.issues.slice(0, 6).map((issue) => {
    const at = issue.path.length ? issue.path.join(".") : "<root>";
    return `${at} (${issue.code})`;
  });
  const suffix = error.issues.length > 6 ? "; …" : "";
  return `cinatra.views is invalid: ${parts.join("; ")}${suffix}`;
}

/**
 * TOLERANT validator for the `cinatra.views` block (the S1 `parseArtifactUi`
 * discipline). NEVER throws and NEVER implies the surrounding manifest is
 * invalid:
 *  - host / runtime: on `{ ok: false }` the caller DROPS the extension's chat
 *    views (the affected `viewType` falls back to `RenderableViewFallback`) and
 *    surfaces `diagnostic` — degrade, never reject the whole extension.
 *  - publish / conformance gate: the SAME `{ ok: false }` is rejected
 *    fail-closed (see {@link validateChatViewsForPublish}).
 */
export function parseChatViews(input: unknown): ChatViewsParseResult {
  const parsed = chatViewsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostic: sanitizeViewsDiagnostic(parsed.error) };
  }
  return { ok: true, views: parsed.data as ChatViewsManifest };
}

/**
 * PUBLISH/authoring verdict wrapper: the authoring/publish path is FAIL-CLOSED on
 * the `cinatra.views` block (unlike the host path, which DEGRADES an unsupported
 * block to the fallback). Any diagnostic from {@link parseChatViews} becomes a
 * validation error here.
 */
export function validateChatViewsForPublish(
  input: unknown,
): { valid: boolean; errors: string[] } {
  const r = parseChatViews(input);
  return r.ok ? { valid: true, errors: [] } : { valid: false, errors: [r.diagnostic] };
}
