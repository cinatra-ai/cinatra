import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import {
  createSemanticArtifact,
  type CreateSemanticArtifactResult,
} from "./artifact-creation";
import { assertSemanticType } from "./semantic-assertion-store";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Artifact template materialization.
//
// The "create from template" path: given an artifact extension package
// name, materialize a starter representation + an eligible
// semantic_assertion (user-asserted). The user can then edit it (in a
// direct-edit surface, or the chat-driven authoring skill can fill it in.
//
// This path is deterministic and does not invoke skills:
//   1. Resolve the extension's manifest from objectTypeRegistry.
//   2. Read manifest.templates[0] when declared; fall back to an empty-
//      content placeholder otherwise.
//   3. Reject binary-only extensions (image/* + application/pdf only)
//      until real templates exist; the fallback is markdown text, which
//      cannot be served as image/PDF.
//   4. Create the artifact via createSemanticArtifact with the template
//      stream + the first text-compatible accepted MIME.
//   5. Write a USER-asserted ELIGIBLE assertion via assertSemanticType
//      so the floor rebalance + Graphiti outbox refresh runs atomically
//      rather than using a raw INSERT.
//
// Not supported by this deterministic path:
//   - Chat-driven authoring-skill invocation.
//   - Recursion ledger.
//   - defer-matchers-during-authoring-tx.
//   - Image/PDF template materialization.
// ---------------------------------------------------------------------------

const ARTIFACT_TYPE_SUFFIX = ":artifact";

// The placeholder content is markdown text. Only declare a MIME from this
// set; anything else (image/png, application/pdf, etc.) needs a real template
// binary.
const TEXT_TEMPLATE_COMPATIBLE_MIMES = new Set([
  "text/markdown",
  "text/plain",
]);

export type MaterializeArtifactFromTemplateInput = {
  orgId: string;
  actor: ActorContext;
  /** The artifact-extension package name, e.g.
   *  "@cinatra-ai/marketing-icp-artifact". */
  extension: string;
  /** Optional title for the new artifact (defaults to the extension's
   *  short label). */
  title?: string;
};

export type MaterializeArtifactFromTemplateError =
  | { ok: false; reason: "extension-not-found"; message: string }
  | { ok: false; reason: "extension-not-file-form"; message: string }
  | { ok: false; reason: "no-text-template-mime"; message: string }
  | { ok: false; reason: "template-path-not-supported"; message: string };

export type MaterializeArtifactFromTemplateResult =
  | { ok: true; artifactId: string; representationRevisionId: string }
  | MaterializeArtifactFromTemplateError;

/** Build a single-pass AsyncIterable<Uint8Array> from a string. */
async function* asUtf8Stream(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

function shortExtensionLabel(ext: string): string {
  if (!ext.startsWith("@cinatra-ai/")) return ext;
  return ext.replace(/^@cinatra-ai\//, "").replace(/-artifact$/, "");
}

/**
 * Materialize a starter representation for the named artifact extension.
 * Returns `ok:false` for invalid extensions / unsupported template
 * shapes; throws on infra failures (DB, blob store) — same posture as
 * createSemanticArtifact.
 */
export async function materializeArtifactFromTemplate(
  input: MaterializeArtifactFromTemplateInput,
): Promise<MaterializeArtifactFromTemplateResult> {
  // Warm the registry so the listArtifacts() call sees every installed
  // extension regardless of boot-order timing.
  registerAllObjectTypes();

  const defs = objectTypeRegistry.listArtifacts();
  const def = defs.find(
    (d) => d.type === `${input.extension}${ARTIFACT_TYPE_SUFFIX}`,
  );
  if (!def) {
    return {
      ok: false,
      reason: "extension-not-found",
      message: `No installed artifact extension matches "${input.extension}". Check pnpm-workspace.yaml + extensions-dev-watcher boot scan.`,
    };
  }
  const manifest = def.isArtifact;
  if (!manifest) {
    return {
      ok: false,
      reason: "extension-not-found",
      message: `Extension "${input.extension}" is registered but carries no semantic manifest.`,
    };
  }
  const fileForms = manifest.accepts?.file?.mimeTypes;
  if (!fileForms || fileForms.length === 0) {
    // This deterministic path supports file-form templates only. Dashboard
    // and connectorRef template materialization are handled elsewhere.
    return {
      ok: false,
      reason: "extension-not-file-form",
      message: `Extension "${input.extension}" does not accept the file form; only file-form template materialization is supported by this path.`,
    };
  }

  // The placeholder is markdown text. Pick the first accepted MIME that's
  // text-compatible. If none, reject; binary-only extensions (screenshot,
  // slide-deck-PDF) need a real template binary.
  const textCompatibleMime = fileForms.find((m) =>
    TEXT_TEMPLATE_COMPATIBLE_MIMES.has(m),
  );

  const templates = manifest.templates ?? [];
  const fileTemplate = templates.find((t) => t.form === "file");

  if (fileTemplate) {
    // Return a structured error instead of throwing an unstructured 500 when
    // a manifest declares a template path. The live action needs a clean
    // rejection path for extensions that provide template files.
    return {
      ok: false,
      reason: "template-path-not-supported",
      message: `Extension "${input.extension}" declares a file template at "${fileTemplate.path}", but template-path reading is not implemented. Use the chat-driven authoring skill flow instead.`,
    };
  }

  if (!textCompatibleMime) {
    return {
      ok: false,
      reason: "no-text-template-mime",
      message: `Extension "${input.extension}" accepts ${fileForms.join(", ")} — none are text-compatible. The placeholder is markdown text; binary-only extensions need a real template.`,
    };
  }

  // Fallback content: empty-content markdown placeholder. This gives the user
  // a usable starter representation they can edit when no template is
  // declared.
  const templateContent = `# ${input.title ?? shortExtensionLabel(input.extension)}\n\n_Empty starter template created by Cinatra. Edit me!_\n`;

  // `originKind` should reflect the truth of the creation channel. No agent
  // ran, and no live external generator fetched content. `upload` is the
  // closest existing kind for this user-initiated create path, matching the
  // upload route default.
  //
  // `skipFallbackClassification: true` skips the post-tx2 matcher enqueue.
  // This path types the artifact via the typed `assertSemanticType` call
  // below; running the matcher would (a) waste a job + LLM scoring call and
  // (b) race with the user assertion (the matcher could observe the artifact
  // pre-assertion and write a precedence-doomed draft).
  const result: CreateSemanticArtifactResult = await createSemanticArtifact({
    orgId: input.orgId,
    createdBy: input.actor.principalId ?? null,
    ownerLevel: "organization",
    ownerId: input.orgId,
    title: input.title ?? `${shortExtensionLabel(input.extension)} starter`,
    declaredMime: textCompatibleMime,
    originKind: "upload",
    stream: asUtf8Stream(templateContent),
    skipFallbackClassification: true,
  });

  // Use assertSemanticType, which runs the floor rebalance + Graphiti outbox
  // refresh atomically, instead of a raw INSERT. assertedBy: "user" because
  // this is a human direct choice; no skill or LLM was in the loop.
  assertSemanticType({
    orgId: input.orgId,
    artifactId: result.artifactId,
    extension: input.extension,
    assertedBy: "user",
    principal: input.actor.principalId ?? null,
  });

  return {
    ok: true,
    artifactId: result.artifactId,
    representationRevisionId: result.representationRevisionId,
  };
}
