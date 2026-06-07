import "server-only";

// ---------------------------------------------------------------------------
// Chat-driven authoring-skill invocation.
//
// Server-side authoring emission. The chat assistant follows the
// `chat-create-artifact` skill, gathers user inputs, composes the
// artifact content as markdown text, and calls the server through
// the `artifact_authoring_emit` MCP primitive (or the
// `createArtifactFromAuthoring` server action). This module is the
// service-layer wrapper that both entry points call.
//
// **What this module is responsible for** (service layer, not app action):
//   1. Validate the extension exists + has a semantic manifest.
//   2. Validate the declared MIME is in `manifest.accepts.file.mimeTypes`.
//   3. Validate content size (cap 10MB to match upload route default).
//   4. Open a recursion-ledger step — refuse cycles + depth-cap exceedances.
//   5. Create the artifact via `createSemanticArtifact`
//      (`skipFallbackClassification: true`).
//   6. Assert the typed `semantic_assertion` with
//      `assertedBy: "authoring_skill"` — server-decided, not
//      input-controlled.
//   7. Mark the ledger step committed.
//
// **What this module DOES NOT do**:
//   - Invoke declared `agentDependencies`. The chat model is the one
//     that fires sub-agents through its own `agent_run` primitive,
//     subject to the recursion ledger. Server-side automatic fan-out
//     is a v2 follow-on.
// ---------------------------------------------------------------------------

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { createSemanticArtifact, type CreateSemanticArtifactResult } from "./artifact-creation";
import { assertSemanticType } from "./semantic-assertion-store";
import { tombstoneArtifact } from "./artifact-service";
import {
  recordAuthoringInvocation,
  markAuthoringInvocationCommitted,
  markAuthoringInvocationAborted,
  type RecordAuthoringInvocationResult,
} from "./authoring-recursion-ledger";
import type { ActorContext } from "@/lib/authz/actor-context";
import { canAccessArtifactExtension } from "./artifact-extension-access";

const ARTIFACT_TYPE_SUFFIX = ":artifact";

/** 10 MB hard cap on authored content size — matches the upload-route
 *  default (`@/lib/artifacts/upload` ~ 10MB). Authoring should never
 *  produce huge content; this guards a runaway-LLM scenario. */
const MAX_AUTHORED_CONTENT_BYTES = 10 * 1024 * 1024;

/** Text-content authoring may ONLY emit text-shaped MIMEs. Binary
 *  types (image/png, application/pdf, etc.)
 *  cannot be authored as a UTF-8 string stream; the upload route is
 *  the right entry point for those. This set is intentionally
 *  narrower than `accepts.file.mimeTypes` may declare. */
const TEXT_AUTHORING_COMPATIBLE_MIMES: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/plain",
  "text/html",
  "application/json",
  "application/xml",
]);

export type AuthorArtifactInput = {
  orgId: string;
  actor: ActorContext;
  /** Artifact-extension package name, e.g. "@cinatra-ai/marketing-icp-artifact". */
  extension: string;
  /** The composed content the chat-driven authoring produced. */
  content: string;
  /** MIME — MUST appear in `manifest.accepts.file.mimeTypes`. */
  declaredMime: string;
  /** User-facing title. */
  title: string;
  /** Optional parent step id for chain attribution. Server-derived
   *  (NEVER trust LLM-supplied). For chat-driven root authoring this
   *  is null. */
  parentStepId?: string | null;
  /** Optional agent_run_id when the authoring step is inside an
   *  agent_run (e.g. an authoring agent calling this primitive). */
  runId?: string | null;
};

export type AuthorArtifactError =
  | {
      ok: false;
      reason:
        | "extension-not-found"
        | "extension-not-file-form"
        | "extension-has-no-authoring-skill"
        | "mime-not-accepted"
        | "mime-not-text-authorable"
        | "access-denied";
      message: string;
    }
  | {
      ok: false;
      reason: "content-too-large";
      message: string;
      /** Actual byte size that exceeded the cap. */
      bytes: number;
      capBytes: number;
    }
  | {
      ok: false;
      reason: "cycle" | "depth-cap-exceeded" | "parent-not-found";
      message: string;
      /** Ledger detail — chain length + the conflicting extension. */
      detail: string;
    };

export type AuthorArtifactSuccess = {
  ok: true;
  artifactId: string;
  representationRevisionId: string;
  /** Recursion depth at which this step was admitted (0 = root). */
  depth: number;
  /** The opaque step id; surface this back to the chat so a sub-
   *  authoring within the SAME chain can use it as `parentStepId`. */
  authoringStepId: string;
};

export type AuthorArtifactResult = AuthorArtifactSuccess | AuthorArtifactError;

/** Single-pass AsyncIterable<Uint8Array> from a string (matches the
 *  pattern in artifact-template.ts). */
async function* asUtf8Stream(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

/**
 * Emit a chat-authored semantic artifact. Server-side validation +
 * recursion-ledger gating + typed assertion writing. Throws on infra
 * failures (DB, blob store) — same posture as `createSemanticArtifact`.
 */
export async function authorArtifact(
  input: AuthorArtifactInput,
): Promise<AuthorArtifactResult> {
  // Warm the registry so listArtifacts() sees every installed
  // extension regardless of boot-order timing.
  registerAllObjectTypes();

  // Validate extension exists.
  const defs = objectTypeRegistry.listArtifacts();
  const def = defs.find(
    (d) => d.type === `${input.extension}${ARTIFACT_TYPE_SUFFIX}`,
  );
  if (!def) {
    return {
      ok: false,
      reason: "extension-not-found",
      message: `No installed artifact extension matches "${input.extension}".`,
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

  // Uniform extension-access gate on the emit (execute) boundary.
  // The object-type id is `<package_name>:artifact`, so input.extension is the
  // installed_extension package_name. Install-governed extensions the actor
  // can't use are refused here (filtering search/get alone would not stop a
  // direct emit). Ungoverned (disk-registered, no install row) artifacts pass.
  if (!(await canAccessArtifactExtension(input.extension, input.actor, "execute"))) {
    return {
      ok: false,
      reason: "access-denied",
      message: `You do not have access to author with extension "${input.extension}".`,
    };
  }

  // Require the extension to declare at least one `skills.authoring`
  // entry. Without this gate, a chat could
  // self-classify arbitrary content as ANY compatible extension at
  // `authoring_skill` precedence (which outranks the matcher), turning
  // emit into a high-precedence type-laundering primitive.
  const authoringSkills = manifest.skills?.authoring ?? [];
  if (authoringSkills.length === 0) {
    return {
      ok: false,
      reason: "extension-has-no-authoring-skill",
      message: `Extension "${input.extension}" declares no authoring skill (manifest.skills.authoring is empty). Authoring emits require an authoring-skill-declared extension. Use the deterministic template path (createArtifactFromTemplate) for un-authored starters.`,
    };
  }

  // Validate the declared MIME is in the manifest's accepted file MIMEs.
  const fileForms = manifest.accepts?.file?.mimeTypes;
  if (!fileForms || fileForms.length === 0) {
    return {
      ok: false,
      reason: "extension-not-file-form",
      message: `Extension "${input.extension}" does not accept the file form; only file-form authoring is supported.`,
    };
  }
  if (!fileForms.includes(input.declaredMime)) {
    return {
      ok: false,
      reason: "mime-not-accepted",
      message: `Extension "${input.extension}" accepts ${fileForms.join(", ")}; received "${input.declaredMime}".`,
    };
  }

  // Even when the manifest accepts a binary MIME (e.g. image/png,
  // application/pdf), the chat-authoring path
  // is UTF-8-string-content-only. Binary representations must go
  // through the upload route. Refuse text-as-binary smuggle.
  if (!TEXT_AUTHORING_COMPATIBLE_MIMES.has(input.declaredMime)) {
    return {
      ok: false,
      reason: "mime-not-text-authorable",
      message: `MIME "${input.declaredMime}" is not text-authorable through the chat path. Allowed: ${Array.from(TEXT_AUTHORING_COMPATIBLE_MIMES).join(", ")}. Use the upload route for binary content.`,
    };
  }

  // Validate content size (server-side cap; the chat can't smuggle a
  // huge runaway LLM output past this).
  const contentBytes = new TextEncoder().encode(input.content).byteLength;
  if (contentBytes > MAX_AUTHORED_CONTENT_BYTES) {
    return {
      ok: false,
      reason: "content-too-large",
      message: `Authored content (${contentBytes} bytes) exceeds the ${MAX_AUTHORED_CONTENT_BYTES}-byte cap.`,
      bytes: contentBytes,
      capBytes: MAX_AUTHORED_CONTENT_BYTES,
    };
  }

  // Open a recursion-ledger step. Cycle / depth-cap-exceeded ⇒ refuse
  // before any artifact write.
  const ledger: RecordAuthoringInvocationResult = recordAuthoringInvocation({
    orgId: input.orgId,
    parentStepId: input.parentStepId ?? null,
    extension: input.extension,
    runId: input.runId ?? null,
  });
  if (!ledger.ok) {
    return {
      ok: false,
      reason: ledger.reason,
      message: `Authoring refused: ${ledger.reason} (${ledger.detail}).`,
      detail: ledger.detail,
    };
  }

  // Create the artifact. `originKind: "agent_generated"` because the
  // chat-agent did the authoring; reuse the existing origin kind
  // instead of expanding the enum. `skipFallbackClassification:
  // true` because we'll type it ourselves via the assertion below.
  let result: CreateSemanticArtifactResult;
  try {
    result = await createSemanticArtifact({
      orgId: input.orgId,
      createdBy: input.actor.principalId ?? null,
      ownerLevel: "organization",
      ownerId: input.orgId,
      title: input.title,
      declaredMime: input.declaredMime,
      originKind: "agent_generated",
      stream: asUtf8Stream(input.content),
      skipFallbackClassification: true,
      createdByRunId: input.runId ?? null,
      // Thread the ledger step id into the artifact tx so the
      // authoring_step_artifacts linkage row commits atomically with
      // the artifact + representation. The workflow engine reads this
      // linkage to surface produced artifacts on the task that drove
      // the agent run.
      authoringStepId: ledger.stepId,
    });
  } catch (err) {
    // Mark ledger aborted so the orphan step has a final status.
    markAuthoringInvocationAborted(input.orgId, ledger.stepId);
    throw err;
  }

  // Type the artifact via the assertion service (floor rebalance +
  // Graphiti outbox refresh runs atomically). assertedBy is server-
  // decided ("authoring_skill"), never derived from input.
  //
  // If the assertion fails, the artifact has already been created
  // (with default-floor typing only) and the
  // matcher was suppressed. Leaving it would create an orphan typed
  // as default-artifact that the user thought would be `marketing-icp`.
  // Tombstone it before propagating the error so the user can retry
  // cleanly. The tombstone is soft-delete (retained for replay); it
  // does not actually delete the row.
  try {
    assertSemanticType({
      orgId: input.orgId,
      artifactId: result.artifactId,
      extension: input.extension,
      assertedBy: "authoring_skill",
      principal: input.actor.principalId ?? null,
    });
  } catch (err) {
    markAuthoringInvocationAborted(input.orgId, ledger.stepId);
    // Best-effort tombstone; don't let a tombstone failure swallow the
    // original assertion error.
    try {
      tombstoneArtifact({
        artifactId: result.artifactId,
        orgId: input.orgId,
        actor: input.actor,
        auditActor: input.actor.principalId ?? null,
      });
    } catch (tombErr) {
      // Log but propagate the original assertion error — the orphan
      // artifact is an operational gap, the assertion error is the
      // root cause the caller needs.
      console.warn(
        `[artifact-authoring] tombstone of orphan artifact ${result.artifactId} failed after assertion error:`,
        tombErr instanceof Error ? tombErr.message : tombErr,
      );
    }
    throw err;
  }

  // Ledger commit — the chain step finished cleanly.
  markAuthoringInvocationCommitted(input.orgId, ledger.stepId);

  return {
    ok: true,
    artifactId: result.artifactId,
    representationRevisionId: result.representationRevisionId,
    depth: ledger.depth,
    authoringStepId: ledger.stepId,
  };
}

// ---------------------------------------------------------------------------
// searchArtifactExtensions — intent → ranked extension list. Used by
// the `artifact_extension_search` MCP primitive.
//
// Naive scoring: token-overlap on (packageName short label,
// manifest.accepts.file.mimeTypes). Future-extend with manifest-level
// `intentKeywords[]` once extensions declare them.
// ---------------------------------------------------------------------------

export type ExtensionSearchResult = {
  packageName: string;
  /** Short label derived from the package slug, e.g. "marketing-icp". */
  label: string;
  /** Manifest's accepted file MIME types (upload/matcher contract). */
  acceptedMimes: string[];
  /** SUBSET that the chat-authoring path accepts — text MIMEs only.
   *  Empty when the extension accepts only binary representations
   *  (image/*, application/pdf, etc.). When empty, the chat MUST NOT
   *  call `artifact_authoring_emit` for this extension — use the
   *  upload route instead. */
  authorableMimes: string[];
  /** Whether the extension declares at least one authoring skill. */
  hasAuthoringSkill: boolean;
  /** Match score 0..1 — higher = closer. */
  score: number;
};

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function shortLabelFromPackage(packageName: string): string {
  // "@cinatra-ai/marketing-icp-artifact" → "marketing-icp"
  return packageName
    .replace(/^@cinatra-ai\//, "")
    .replace(/-artifact$/, "");
}

export async function searchArtifactExtensions(opts: {
  query: string;
  limit?: number;
  /** Filters out artifact extensions the actor cannot list. */
  actor?: ActorContext | null;
}): Promise<ExtensionSearchResult[]> {
  registerAllObjectTypes();
  const defs = objectTypeRegistry.listArtifacts();
  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];

  const results: ExtensionSearchResult[] = [];
  for (const d of defs) {
    if (!d.type.endsWith(ARTIFACT_TYPE_SUFFIX)) continue;
    const packageName = d.type.slice(0, -ARTIFACT_TYPE_SUFFIX.length);
    const manifest = d.isArtifact;
    if (!manifest) continue;
    const label = shortLabelFromPackage(packageName);
    const labelTokens = tokenize(label);
    // Score = fraction of query tokens that match label tokens.
    let hits = 0;
    for (const qt of queryTokens) {
      // Match if any label token equals the query token OR contains it
      // OR is contained in it (handles "icp" → "marketing-icp").
      if (
        labelTokens.some(
          (lt) => lt === qt || lt.includes(qt) || qt.includes(lt),
        )
      ) {
        hits++;
      }
    }
    if (hits === 0) continue;
    const score = hits / queryTokens.length;
    const acceptedMimes = manifest.accepts?.file?.mimeTypes ?? [];
    results.push({
      packageName,
      label,
      acceptedMimes,
      authorableMimes: acceptedMimes.filter((m) =>
        TEXT_AUTHORING_COMPATIBLE_MIMES.has(m),
      ),
      hasAuthoringSkill: (manifest.skills?.authoring ?? []).length > 0,
      score,
    });
  }

  // Sort high-score first; tie-break by label alphabetical.
  results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  // Drop extensions the actor cannot list (install-governed
  // visibility). Ungoverned (disk-registered) artifacts pass through.
  const visible: ExtensionSearchResult[] = [];
  for (const r of results) {
    if (await canAccessArtifactExtension(r.packageName, opts.actor ?? null, "list")) {
      visible.push(r);
    }
  }
  return opts.limit ? visible.slice(0, opts.limit) : visible;
}

// ---------------------------------------------------------------------------
// getArtifactExtension — manifest lookup. Used by the
// `artifact_extension_get` MCP primitive so the chat can read
// `skills.authoring[]` + `agentDependencies` + accepted MIMEs.
// ---------------------------------------------------------------------------

export type ExtensionManifestView = {
  packageName: string;
  label: string;
  /** All MIMEs the manifest accepts for the file form (used by upload
   *  / matcher / template paths). */
  acceptedMimes: string[];
  /** SUBSET of acceptedMimes that the chat-driven authoring path will
   *  accept. The authoring path is UTF-8-string content only; binary
   *  MIMEs (image/*, application/pdf, etc.) are
   *  in acceptedMimes for the upload path but NOT here. The chat must
   *  pick from `authorableMimes`, not `acceptedMimes`, when calling
   *  `artifact_authoring_emit`. */
  authorableMimes: string[];
  authoringSkillIds: string[];
  matcherSkillIds: string[];
  agentDependencies: string[];
};

export async function getArtifactExtension(
  packageName: string,
  actor?: ActorContext | null,
): Promise<ExtensionManifestView | null> {
  registerAllObjectTypes();
  const defs = objectTypeRegistry.listArtifacts();
  const def = defs.find((d) => d.type === `${packageName}${ARTIFACT_TYPE_SUFFIX}`);
  if (!def || !def.isArtifact) return null;
  // Hide a manifest the actor cannot read (install-governed).
  if (!(await canAccessArtifactExtension(packageName, actor ?? null, "read"))) {
    return null;
  }
  const manifest = def.isArtifact;
  const acceptedMimes = manifest.accepts?.file?.mimeTypes ?? [];
  return {
    packageName,
    label: shortLabelFromPackage(packageName),
    acceptedMimes,
    // Surface the authoring MIME contract separately from the upload
    // MIME contract.
    authorableMimes: acceptedMimes.filter((m) =>
      TEXT_AUTHORING_COMPATIBLE_MIMES.has(m),
    ),
    authoringSkillIds: manifest.skills?.authoring ?? [],
    matcherSkillIds: manifest.skills?.matchers ?? [],
    agentDependencies: manifest.agentDependencies ?? [],
  };
}
