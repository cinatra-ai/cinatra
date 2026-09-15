/**
 * The `@cinatra-ai/memory:concept` envelope a sync run sends, and the content
 * digest a run classifies with.
 *
 * The envelope shape is the SERVER's contract (`memoryConceptEnvelopeSchema`
 * in `packages/objects/src/integration/register-types.ts`). This module builds
 * it; it does not define it. Everything the server can recompute for itself it
 * DOES recompute — `externalId` above all — so a forged bundle field cannot
 * steer a row's identity. What is built here is what makes the request
 * legible, not what makes it authorized.
 */
import { createHash } from "node:crypto";

import { extractMemoryLinks } from "./links.ts";
import { MEMORY_FORMAT_OKF_VERSION } from "./bundle.ts";
import type { MemoryConcept } from "./types.ts";

/** The static object type id memory rows are saved under. */
export const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";

/**
 * `sha256(UTF-8(bundleId + NUL + conceptId))`, lowercase hex.
 *
 * The SERVER recomputes this and rejects a mismatch. Computing it here is a
 * convenience for the local plan (and gives the dry-run something to print);
 * it is never the thing that decides which row a save lands on.
 */
export function computeMemoryConceptExternalId(
  bundleId: string,
  conceptId: string,
): string {
  return createHash("sha256")
    .update(`${bundleId}\u0000${conceptId}`, "utf8")
    .digest("hex");
}

/** One link as the envelope carries it. */
export interface MemoryConceptEnvelopeLink {
  target: string;
  resolvedConceptId?: string;
}

/** The envelope `objects_save` receives as `rawData`. */
export interface MemoryConceptEnvelope {
  conceptId: string;
  bundleId: string;
  externalId: string;
  okfType: string;
  frontmatter: Record<string, unknown>;
  bodyMarkdown: string;
  links: MemoryConceptEnvelopeLink[];
  okfVersion: string;
  /**
   * Client-declared provenance: which tool produced this sync call.
   *
   * Deliberately NOT authorization-bearing. The provenance that MATTERS —
   * organization, user, agent id, run id, package version — is stamped
   * server-side off the authenticated actor and is not readable from here.
   * This pair only answers "which local tool wrote it", which no server-side
   * value can answer, and is treated as untrusted like the rest of the file.
   */
  provenance: { tool: string; toolVersion: string };
}

/** Build the envelope for one concept in the bundle identified by `bundleId`. */
export function buildMemoryConceptEnvelope(
  bundleId: string,
  concept: MemoryConcept,
  provenance: { tool: string; toolVersion: string },
): MemoryConceptEnvelope {
  const links: MemoryConceptEnvelopeLink[] = extractMemoryLinks(
    concept.path,
    concept.body,
  ).map((link) =>
    link.resolvedPath !== undefined && link.resolvedPath.endsWith(".md")
      ? { target: link.target, resolvedConceptId: link.resolvedPath.slice(0, -3) }
      : { target: link.target },
  );
  return {
    conceptId: concept.id,
    bundleId,
    externalId: computeMemoryConceptExternalId(bundleId, concept.id),
    okfType: concept.type,
    frontmatter: concept.frontmatter,
    bodyMarkdown: concept.body,
    links,
    okfVersion: MEMORY_FORMAT_OKF_VERSION,
    provenance,
  };
}

/**
 * Canonical JSON: object keys sorted at every level, so two structurally equal
 * values serialize to identical bytes. `undefined` members are dropped the way
 * `JSON.stringify` drops them, and every other value keeps JSON semantics.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    out[key] = canonicalize(entry);
  }
  return out;
}

/**
 * The digest a sync run classifies on: sha256 over the canonical form of the
 * envelope's CONTENT fields.
 *
 * Identity fields are excluded on purpose — `conceptId` / `bundleId` /
 * `externalId` select the row, they are not part of "did the content change".
 * `provenance` is excluded for the same reason a tool-version bump must not
 * rewrite every row in the bundle.
 *
 * The important property: BOTH sides of a comparison are digested by THIS
 * function. A preflight compares `digest(local envelope)` against
 * `digest(the envelope stored on the remote row)`, both computed locally, so
 * there is no second implementation to drift from and nothing the server has
 * to be trusted to have computed.
 */
export function memoryConceptContentDigest(envelope: {
  okfType: string;
  frontmatter: Record<string, unknown>;
  bodyMarkdown: string;
  links: MemoryConceptEnvelopeLink[];
  okfVersion?: string;
}): string {
  const canonical = canonicalize({
    okfType: envelope.okfType,
    frontmatter: envelope.frontmatter,
    bodyMarkdown: envelope.bodyMarkdown,
    links: envelope.links,
    okfVersion: envelope.okfVersion ?? MEMORY_FORMAT_OKF_VERSION,
  });
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * Read the content digest of a REMOTE row's stored `data`.
 *
 * Returns null when the stored payload is not envelope-shaped. A row that
 * cannot be digested is classified as an UPDATE — the direction that writes
 * the local truth over an unreadable remote shape, rather than skipping and
 * leaving it that way.
 */
export function remoteMemoryConceptDigest(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d["okfType"] !== "string") return null;
  if (typeof d["bodyMarkdown"] !== "string") return null;
  const frontmatter = d["frontmatter"];
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return null;
  }
  const rawLinks = d["links"];
  if (!Array.isArray(rawLinks)) return null;
  const links: MemoryConceptEnvelopeLink[] = [];
  for (const entry of rawLinks) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const link = entry as Record<string, unknown>;
    if (typeof link["target"] !== "string") return null;
    links.push(
      typeof link["resolvedConceptId"] === "string"
        ? { target: link["target"], resolvedConceptId: link["resolvedConceptId"] }
        : { target: link["target"] },
    );
  }
  return memoryConceptContentDigest({
    okfType: d["okfType"],
    frontmatter: frontmatter as Record<string, unknown>,
    bodyMarkdown: d["bodyMarkdown"],
    links,
    ...(typeof d["okfVersion"] === "string" ? { okfVersion: d["okfVersion"] } : {}),
  });
}
