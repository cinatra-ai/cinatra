import "server-only";

// artifact-review-effect-store (cinatra#3978): the ONE record of the effect that
// carried out a reviewed change, stored as the call returned it. Never the
// model's account of the call, never a time core takes from its own clock
// (`recorded_at` is only when the row was stored).
//
// SOURCE-SPECIFIC WRITERS: a caller never names the writer kind, org, run or
// target; each writer derives them from stored state. FIRST WRITE WINS: one
// record per (gate, artifact, revision); an identical retry answers
// `already-recorded`, any other second write `conflict`, and nothing overwrites.

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { and, eq } from "drizzle-orm";

import { db } from "./db";
import { artifactReviewEffectRecords, artifactReviewGates, artifactVerificationRecords } from "./schema";
import { readCmsSnapshotTargetByOperation } from "./cms-snapshot-readback-store";

/** The limit in UTF-8 bytes of the compact JSON text; the DB CHECK counts the same text. */
export const REVIEW_EFFECT_RECORD_MAX_BYTES = 8192;

const MAX_DEPTH = 32;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type ReviewEffectRecordJson =
  | { ok: true; json: string }
  | { ok: false; code: "not-a-plain-object" | "invalid-value" | "too-large" };

function isPlainJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > MAX_DEPTH) return false;
  if (utilTypes.isProxy(value) || ancestors.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
  if ("toJSON" in value) return false; // `in` runs no getter
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k === "symbol")) return false;
  if (isArray && keys.length !== (value as unknown[]).length + 1) return false; // holes, extra keys
  ancestors.add(value);
  try {
    return (keys as string[]).every((key) => {
      if (isArray && key === "length") return true;
      const d = Object.getOwnPropertyDescriptor(value, key);
      return !!d && "value" in d && d.enumerable === true && isPlainJsonValue(d.value, ancestors, depth + 1);
    });
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serialize an effect record, or refuse it. The top level must be a plain
 * object. Refused: null, arrays, non-finite numbers, undefined, functions,
 * symbols, bigint, cycles, binary objects, class instances, getters, proxies,
 * `toJSON`, NUL and lone surrogates (the DB JSON type refuses both), and
 * anything over the byte limit.
 */
export function serializeReviewEffectRecord(value: unknown): ReviewEffectRecordJson {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "not-a-plain-object" };
  }
  if (!isPlainJsonValue(value, new Set(), 0)) return { ok: false, code: "invalid-value" };
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > REVIEW_EFFECT_RECORD_MAX_BYTES) return { ok: false, code: "too-large" };
  return { ok: true, json };
}

/** The closed status set of a CMS apply result; an adapter maps its site's word. */
export const CMS_APPLY_REMOTE_STATUSES = ["published", "scheduled", "draft", "pending", "private"] as const;

/** The CLOSED, credential-free CMS apply result: exactly these keys, no free
 *  text, no address. `remotePublishedAt` is the site's own time, or null. */
export interface CmsApplyEffectResult {
  remoteId: string;
  remoteStatus: (typeof CMS_APPLY_REMOTE_STATUSES)[number];
  remotePublishedAt: string | null;
}

/** Validate against the closed schema, or null. Rebuilt in a fixed key order,
 *  so an identical retry serializes to identical bytes. */
export function parseCmsApplyEffectResult(value: unknown): CmsApplyEffectResult | null {
  if (!serializeReviewEffectRecord(value).ok) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "remoteId,remotePublishedAt,remoteStatus") return null;
  const { remoteId, remoteStatus, remotePublishedAt: at } = v;
  if (typeof remoteId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(remoteId)) return null;
  if (!(CMS_APPLY_REMOTE_STATUSES as readonly unknown[]).includes(remoteStatus)) return null;
  const canonical = typeof at === "string" && CANONICAL_ISO.test(at) &&
    Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at;
  if (at !== null && !canonical) return null;
  return {
    remoteId,
    remoteStatus: remoteStatus as CmsApplyEffectResult["remoteStatus"],
    remotePublishedAt: at as string | null,
  };
}

/** A gate's stored pinned set read fail-closed: every element a plain object
 *  with two non-empty string ids, or null for the whole set. */
export function storedPinnedTargets(value: unknown): { artifactId: string; representationRevisionId: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { artifactId: string; representationRevisionId: string }[] = [];
  for (const el of value) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) return null;
    const { artifactId, representationRevisionId } = el as Record<string, unknown>;
    if (typeof artifactId !== "string" || artifactId.length === 0) return null;
    if (typeof representationRevisionId !== "string" || representationRevisionId.length === 0) return null;
    out.push({ artifactId, representationRevisionId });
  }
  return out;
}

export type ReviewEffectRefusal =
  | "invalid-result" | "target-not-found" | "gate-not-found" | "gate-org-mismatch"
  | "gate-run-mismatch" | "gate-not-approved" | "pinned-targets-malformed"
  | "target-not-pinned" | "not-verified" | "conflict";

export type ReviewEffectWriteResult =
  | { ok: true; status: "recorded" | "already-recorded"; effectId: string }
  | { ok: false; code: ReviewEffectRefusal };

/** The deterministic row id of the one effect of a reviewed target. */
export function reviewEffectId(gateId: string, artifactId: string, revisionId: string): string {
  return `effect:${createHash("sha256").update(`${gateId}\u0000${artifactId}\u0000${revisionId}`).digest("hex")}`;
}

/**
 * Record the effect of an approved CMS apply whose read-back VERIFIED. The
 * result passes the closed schema before any read; then, from stored state:
 * the operation's snapshot is the target; the gate exists, belongs to `orgId`
 * (the trusted frame's org) and `runId`, resolved `approve`, and its well-formed
 * pinned set pins the snapshot; its stored verification of the snapshot reads
 * `verified` (a drifted or unmet apply records nothing). THROWS only on a
 * database failure; every refusal is a typed answer.
 */
export async function recordCmsApplyEffect(input: {
  orgId: string;
  runId: string;
  gateId: string;
  operationId: string;
  result: unknown;
}): Promise<ReviewEffectWriteResult> {
  const result = parseCmsApplyEffectResult(input.result);
  if (!result) return { ok: false, code: "invalid-result" };
  const serialized = serializeReviewEffectRecord(result);
  if (!serialized.ok) return { ok: false, code: "invalid-result" };

  const target = await readCmsSnapshotTargetByOperation(input.operationId);
  if (!target) return { ok: false, code: "target-not-found" };
  const artifactId = target.artifactId;
  const revisionId = target.snapshotRevisionId;

  const [gate] = await db.select().from(artifactReviewGates).where(eq(artifactReviewGates.id, input.gateId)).limit(1);
  if (!gate) return { ok: false, code: "gate-not-found" };
  if (gate.orgId !== input.orgId) return { ok: false, code: "gate-org-mismatch" };
  if (gate.runId !== input.runId) return { ok: false, code: "gate-run-mismatch" };
  if (gate.status !== "resolved" || gate.disposition !== "approve") return { ok: false, code: "gate-not-approved" };
  const pinned = storedPinnedTargets(gate.pinnedTargets);
  if (!pinned) return { ok: false, code: "pinned-targets-malformed" };
  if (!pinned.some((p) => p.artifactId === artifactId && p.representationRevisionId === revisionId)) {
    return { ok: false, code: "target-not-pinned" };
  }

  const v = artifactVerificationRecords;
  const [verified] = await db
    .select({ id: v.id })
    .from(v)
    .where(and(eq(v.gateId, gate.id), eq(v.reviewedArtifactId, artifactId),
      eq(v.reviewedRepresentationRevisionId, revisionId), eq(v.outcome, "verified")))
    .limit(1);
  if (!verified) return { ok: false, code: "not-verified" };

  const e = artifactReviewEffectRecords;
  const id = reviewEffectId(gate.id, artifactId, revisionId);
  const inserted = await db
    .insert(e)
    .values({
      id, gateId: gate.id, orgId: gate.orgId, runId: gate.runId,
      reviewedArtifactId: artifactId, reviewedRepresentationRevisionId: revisionId,
      writer: "cms_apply", sourceRef: input.operationId, recordJson: serialized.json,
    })
    .onConflictDoNothing()
    .returning({ id: e.id });
  if (inserted.length === 1) return { ok: true, status: "recorded", effectId: id };

  // The key is taken (a retry, or a concurrent writer that won). Only a
  // byte-identical record from the same writer and source is the same effect.
  const [existing] = await db
    .select({ id: e.id, writer: e.writer, sourceRef: e.sourceRef, recordJson: e.recordJson })
    .from(e)
    .where(and(eq(e.gateId, gate.id), eq(e.reviewedArtifactId, artifactId),
      eq(e.reviewedRepresentationRevisionId, revisionId)))
    .limit(1);
  if (existing?.writer === "cms_apply" && existing.sourceRef === input.operationId &&
    existing.recordJson === serialized.json) {
    return { ok: true, status: "already-recorded", effectId: existing.id };
  }
  return { ok: false, code: "conflict" };
}
