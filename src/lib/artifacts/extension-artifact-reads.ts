import "server-only";

// THE THREE ARTIFACT READS A FLOW MAY MAKE (cinatra#3031, epic #3023 W7; plan
// (C) enabler 0.26).
//
// "the passthrough admits the list, the get and a new content read — the text
// of a representation up to a cap — only for types the calling extension
// declares as artifact dependencies … bound to the organisation of the run,
// size-capped and audited; the listing gains a filter by type and a cursor in
// place of its flat cap."
//
// Least privilege, spelled out:
//   * the TYPE SET is the admission's, not the caller's — a request may narrow
//     it and can never widen it;
//   * the ORGANISATION is the run's, never the request's;
//   * the CONTENT READ is capped in bytes and refuses a form that is not text,
//     because "the text of a representation" is what was admitted, not a
//     download road;
//   * every read — allowed and refused alike — is audited WITH THE CALLING
//     EXTENSION (§8.7).
//
// Nothing here re-implements the listing or the fetch: they are the same
// `listArtifactsPage` / `getArtifact` / `resolveArtifactVersionForServe` the
// product already serves, called with an admitted type set.

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  ArtifactAdmissionRefusal,
  admitsArtifactType,
  admittedArtifactTypes,
  type ArtifactDependencyAdmission,
} from "./extension-artifact-admission";
import {
  getArtifact,
  listArtifactsPage,
  registeredArtifactTypeIds,
  type ArtifactPage,
  type ArtifactSummary,
} from "./artifact-service";

/** "the text of a representation up to a cap" — the cap. */
export const EXTENSION_ARTIFACT_CONTENT_MAX_BYTES = 256 * 1024;

/** The forms a content read is admitted for: text, and nothing else. */
export const EXTENSION_ARTIFACT_TEXT_MIME_RE =
  /^(text\/|application\/(json|xml|x-ndjson|yaml|x-yaml)\b)/i;

export class ArtifactContentRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "ArtifactContentRefusal";
    this.reason = reason;
  }
}

type AuditFn = (event: Record<string, unknown>) => Promise<void>;

async function defaultAudit(event: Record<string, unknown>): Promise<void> {
  const { logAuditEvent } = await import("@/lib/authz/audit");
  await logAuditEvent(event as Parameters<typeof logAuditEvent>[0]);
}

function auditBase(input: {
  admission: ArtifactDependencyAdmission;
  orgId: string;
  runId: string;
  operation: string;
  actorPrincipalId?: string | null;
}) {
  return {
    organizationId: input.orgId,
    actorPrincipalId: input.actorPrincipalId ?? undefined,
    actorPrincipalType: "a2a" as const,
    authSource: "agent" as const,
    resourceType: "artifact",
    operation: input.operation,
    runId: input.runId,
  };
}

function admissionMetadata(admission: ArtifactDependencyAdmission) {
  return {
    extension: admission.packageName,
    extensionVersion: admission.packageVersion,
    admittedPackages: admission.admittedPackages,
    declarationDigest: admission.declarationDigest,
  };
}

export type ExtensionArtifactReadContext = {
  admission: ArtifactDependencyAdmission;
  /** The run's organisation — the only tenant these reads ever touch. */
  orgId: string;
  runId: string;
  actor?: ActorContext;
  actorPrincipalId?: string | null;
  audit?: AuditFn;
};

/**
 * The LIST, admitted per declared dependency, filtered by type and paged by
 * cursor.
 *
 * `types` NARROWS the admitted set. A request naming a type the caller does not
 * declare is refused outright rather than quietly dropped: a flow that believes
 * it listed a type and received an empty page reads that as "there are none",
 * which is a different and wrong answer.
 */
export async function extensionArtifactsList(
  ctx: ExtensionArtifactReadContext,
  request: { types?: readonly string[]; cursor?: string | null; limit?: number } = {},
): Promise<ArtifactPage> {
  const audit = ctx.audit ?? defaultAudit;
  const base = auditBase({ ...ctx, operation: "artifacts_list" });
  const admitted = admittedArtifactTypes(ctx.admission, registeredArtifactTypeIds());
  let types = admitted;
  if (request.types !== undefined) {
    for (const t of request.types) {
      if (!admitsArtifactType(ctx.admission, t)) {
        await audit({
          ...base,
          resourceId: t,
          decision: "denied",
          metadata: { ...admissionMetadata(ctx.admission), requestedType: t },
        }).catch(() => {});
        throw new ArtifactAdmissionRefusal(ctx.admission, t);
      }
    }
    types = [...request.types];
  }
  const page = listArtifactsPage({
    orgId: ctx.orgId,
    ...(ctx.actor ? { actor: ctx.actor } : {}),
    types,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });
  await audit({
    ...base,
    decision: "allowed",
    metadata: {
      ...admissionMetadata(ctx.admission),
      types,
      returned: page.artifacts.length,
      paged: page.nextCursor !== null,
    },
  }).catch(() => {});
  return page;
}

/** The GET, admitted per declared dependency and bound to the run's organisation. */
export async function extensionArtifactGet(
  ctx: ExtensionArtifactReadContext,
  request: { artifactId: string },
): Promise<ArtifactSummary> {
  const audit = ctx.audit ?? defaultAudit;
  const base = auditBase({ ...ctx, operation: "artifacts_get" });
  const artifact = getArtifact({
    artifactId: request.artifactId,
    orgId: ctx.orgId,
    ...(ctx.actor ? { actor: ctx.actor } : {}),
  });
  if (!artifact) {
    await audit({
      ...base,
      resourceId: request.artifactId,
      decision: "denied",
      metadata: { ...admissionMetadata(ctx.admission), reason: "not-found" },
    }).catch(() => {});
    throw new ArtifactContentRefusal(
      "not-found",
      `artifacts_get: ${request.artifactId} is not an artifact this run's organisation can see`,
    );
  }
  if (!admitsArtifactType(ctx.admission, artifact.objectType)) {
    await audit({
      ...base,
      resourceId: request.artifactId,
      decision: "denied",
      metadata: { ...admissionMetadata(ctx.admission), objectType: artifact.objectType },
    }).catch(() => {});
    throw new ArtifactAdmissionRefusal(ctx.admission, artifact.objectType);
  }
  await audit({
    ...base,
    resourceId: request.artifactId,
    decision: "allowed",
    metadata: { ...admissionMetadata(ctx.admission), objectType: artifact.objectType },
  }).catch(() => {});
  return artifact;
}

export type ExtensionArtifactContent = {
  artifactId: string;
  representationRevisionId: string;
  mime: string;
  text: string;
  /** True when the representation is longer than the cap and was cut. */
  truncated: boolean;
  bytesRead: number;
  totalBytes: number;
};

/**
 * The CONTENT READ: the text of one representation, up to the cap. New in W7 —
 * "nothing returns content" was the whole of the before-state.
 */
export async function extensionArtifactContentRead(
  ctx: ExtensionArtifactReadContext,
  request: { artifactId: string; representationRevisionId?: string; maxBytes?: number },
): Promise<ExtensionArtifactContent> {
  const audit = ctx.audit ?? defaultAudit;
  const base = auditBase({ ...ctx, operation: "artifact_content_read" });
  // The GET's admission and organisation binding are the same ones this read
  // needs; going through it means there is ONE place a type is admitted.
  const artifact = await extensionArtifactGet(
    { ...ctx, audit: async () => {} },
    { artifactId: request.artifactId },
  ).catch(async (e) => {
    await audit({
      ...base,
      resourceId: request.artifactId,
      decision: "denied",
      metadata: {
        ...admissionMetadata(ctx.admission),
        reason: e instanceof ArtifactAdmissionRefusal ? e.reason : "not-found",
      },
    }).catch(() => {});
    throw e;
  });

  try {
    const result = await readArtifactRepresentationText({
      orgId: ctx.orgId,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      artifactId: request.artifactId,
      ...(request.representationRevisionId
        ? { representationRevisionId: request.representationRevisionId }
        : {}),
      ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
      knownLatestRevisionId: artifact.latestRepresentationRevisionId,
    });
    await audit({
      ...base,
      resourceId: request.artifactId,
      decision: "allowed",
      metadata: {
        ...admissionMetadata(ctx.admission),
        objectType: artifact.objectType,
        representationRevisionId: result.representationRevisionId,
        bytesRead: result.bytesRead,
        truncated: result.truncated,
      },
    }).catch(() => {});
    return result;
  } catch (e) {
    await audit({
      ...base,
      resourceId: request.artifactId,
      decision: "denied",
      metadata: {
        ...admissionMetadata(ctx.admission),
        reason: e instanceof ArtifactContentRefusal ? e.reason : "read-failed",
      },
    }).catch(() => {});
    throw e;
  }
}

/**
 * THE ONE READER of a representation's text, capped. No admission and no audit
 * of its own: the two callers differ only in the perimeter around them — the
 * chat surface, whose scope `resolveScope()` established, and the passthrough,
 * which wraps this in the calling extension's dependency admission. Two
 * readers would be two places for a cap or a liveness rule to drift.
 */
export async function readArtifactRepresentationText(input: {
  orgId: string;
  actor?: ActorContext;
  artifactId: string;
  representationRevisionId?: string;
  maxBytes?: number;
  /** Saves a second `getArtifact` when the caller already read the row. */
  knownLatestRevisionId?: string | null;
}): Promise<ExtensionArtifactContent> {
  const request = input;
  const artifact =
    input.knownLatestRevisionId !== undefined
      ? { latestRepresentationRevisionId: input.knownLatestRevisionId }
      : getArtifact({
          artifactId: input.artifactId,
          orgId: input.orgId,
          ...(input.actor ? { actor: input.actor } : {}),
        });
  if (!artifact) {
    throw new ArtifactContentRefusal(
      "not-found",
      `artifact_content_read: ${input.artifactId} is not an artifact this organisation can see`,
    );
  }
  const revisionId =
    request.representationRevisionId ?? artifact.latestRepresentationRevisionId;
  if (!revisionId) {
    throw new ArtifactContentRefusal(
      "no-representation",
      `artifact_content_read: ${request.artifactId} carries no representation to read`,
    );
  }

  const { resolveArtifactVersionForServe } = await import("./artifact-read");
  const resolved = resolveArtifactVersionForServe({
    orgId: input.orgId,
    artifactId: request.artifactId,
    representationRevisionId: revisionId,
    // A flow reads what is LIVE. The tombstoned-pin override is a route-only
    // road with its own visibility gate, and this seam must not widen it.
    liveOnly: true,
  });
  if (!resolved) {
    throw new ArtifactContentRefusal(
      "revision-not-resolvable",
      `artifact_content_read: representation ${revisionId} of ${request.artifactId} does not resolve`,
    );
  }
  if (!EXTENSION_ARTIFACT_TEXT_MIME_RE.test(resolved.mime)) {
    throw new ArtifactContentRefusal(
      "not-text",
      `artifact_content_read: ${resolved.mime} is not a text representation — the tool admits ` +
        `"the text of a representation", not a download road`,
    );
  }

  const cap = Math.min(
    Math.max(1, request.maxBytes ?? EXTENSION_ARTIFACT_CONTENT_MAX_BYTES),
    EXTENSION_ARTIFACT_CONTENT_MAX_BYTES,
  );
  const { createLocalDiskBlobStore } = await import("./local-disk-blob-store");
  const store = createLocalDiskBlobStore();
  const handle = await store.openRangeByStorageKey({
    orgId: input.orgId,
    storageKey: resolved.storageKey,
    start: 0,
    end: cap - 1,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
  const buf = Buffer.concat(chunks);
  return {
    artifactId: request.artifactId,
    representationRevisionId: revisionId,
    mime: resolved.mime,
    text: buf.toString("utf8"),
    truncated: handle.totalSize > buf.length,
    bytesRead: buf.length,
    totalBytes: handle.totalSize,
  };
}
