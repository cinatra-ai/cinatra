import "server-only";
import { z } from "zod";
// cinatra#1891 DEFECT-3: the mime→extension helpers come from the dependency-free
// capability leaf (NOT the heavy @cinatra-ai/llm index) so they are cheap to load
// here and resolve to the REAL implementation in tests (no mock) — the same
// authority the provider's ingestion rules use.
import {
  extensionForIngestibleMime,
  filenameExtensionMatchesMime,
} from "@cinatra-ai/llm/attachment-capability";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Async LLM artifact matcher.
//
// The deterministic producer-assertion path types agent-produced
// artifacts at creation. THIS worker is the fallback for everything
// else: an upload / non-agent artifact gets an LLM matcher pass per
// candidate artifact-extension whose `accepts.file` MIME set matches,
// and a confident match writes a `matcher`-asserted draft. The
// default-floor invariant holds throughout (a blocked or absent matcher
// leaves the artifact default-typed — never typeless).
//
// Runtime hardening:
//   - orphan-assertion guard: authoritative read FIRST; absent ⇒
//     clean exit, no LLM / no assert;
//   - runtime-unconfigured ⇒ structured log + skip (no crash);
//   - package-owned skill trust anchor (matcher skill MUST belong to
//     the artifact extension's own package);
//   - frontmatter-stripped system prompt;
//   - declaredToolboxIds:[] (no MCP tools in a classifier);
//   - strict Zod re-parse of the LLM response (confidence 0..1);
//   - assertSemanticType blockedByPrecedence ⇒ expected no-op;
//   - boot-order resilience: on a catalog miss for the owning artifact
//     package, run a one-shot co-located skill registration for that
//     package then retry the lookup.
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

// The retired generic host object-type id (epic #1785). NO artifact row carries
// it any more — every row is minted with its exact declared type. The matcher's
// authoritative read USED to key on it, which is precisely why the chassis went
// dormant (the read matched nothing). It is kept ONLY as a defensive exclusion
// so a stray legacy row can never be classified. cinatra#1891 re-keys the read
// to `data->>'artifactType' = 'file'` on any REGISTERED artifact type.
const RETIRED_GENERIC_ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

/**
 * A TRANSIENT failure inside the matcher worker (LLM provider hiccup, a DB
 * read/write blip). Thrown out of `runArtifactMatch` so BullMQ retries the job
 * per `ARTIFACT_MATCH_RETRY_POLICY` (cinatra#1891 scope 6 — honest retry). This
 * is the ONLY error class that escapes the top-level boundary; terminal
 * conditions (no runtime configured, orphaned row, a malformed LLM response)
 * resolve cleanly and are never retried.
 */
export class MatcherRetryableError extends Error {
  readonly retryable = true as const;
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MatcherRetryableError";
  }
}

function isRetryable(err: unknown): err is MatcherRetryableError {
  return (
    err instanceof MatcherRetryableError ||
    (typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === true)
  );
}
// Raised from 8 to 24 because matcher-classified artifact extensions
// can overlap on text/markdown / application/pdf / text/plain; with
// cap=8 the matcher would silently skip later-registered candidates
// after the cap is reached, making per-artifact classification
// order-dependent. 24 = 8 × 3 — comfortable headroom for roughly
// 15–20 installed artifact extensions. A hard per-extension budget
// guard belongs in separate runtime hardening.
const MAX_CANDIDATES = 24;

/** Matcher worker actor context. A System principal anchored to the
 *  artifact's org satisfies `requireActorFrame`'s ALS requirement (the
 *  LLM runtime itself is resolved separately via
 *  `resolveConfiguredLlmRuntime`). Org-anchored so every downstream
 *  scope-filtered read stays tenant-correct. */
export function buildArtifactMatcherActorContext(input: {
  orgId: string;
}): ActorContext {
  return {
    principalType: "System",
    principalId: "artifact-matcher",
    organizationId: input.orgId,
    teamIds: [],
    projectIds: [],
    authSource: "worker",
    policyVersion: "v2",
  };
}

export type ArtifactMatchJobPayload = {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  /** Provenance only — the producer path already ran at creation; the
   *  matcher does not re-derive producer assertions. */
  createdByRunId?: string | null;
};

type AuthoritativeArtifact = {
  digest: string;
  mime: string;
  originKind: string;
  storageKey: string;
  /** The row's EXACT declared object type (`objects.type`). cinatra#1891: the
   *  read no longer keys on the retired generic type — it returns whatever
   *  registered artifact type the row was minted with, and the caller validates
   *  registration against the in-memory registry. */
  type: string;
  /** The persisted `representation.classifier_signals` blob (or null). Consumed
   *  by the matcher prompt (cinatra#1891 scope 2). */
  classifierSignals: ClassifierSignalsForPrompt | null;
};

/** The subset of `ClassifierSignals` the matcher prompt renders. Parsed
 *  defensively from the persisted jsonb — never trusted structurally (the write
 *  path already strict-validated it, but a hand-edited row must not crash the
 *  worker). */
type ClassifierSignalsForPrompt = {
  chatContext?: { messages?: Array<{ role?: string; content?: string }> };
  produces?: Array<{ extension?: string }>;
  upload?: {
    filename?: string;
    declaredMime?: string;
    originKind?: string;
    parentType?: string;
  };
};

/** Resolve the `filename` for the matcher's LLM attachment so it carries a
 *  provider-recognized extension. OpenAI's Responses `input_file`
 *  (context-stuffing) path derives the file FORMAT from the filename extension;
 *  an extensionless name (the matcher previously sent none → the resolver fell
 *  back to the bare artifact UUID) is a deterministic 400 (cinatra#1891
 *  DEFECT-3). Preference order:
 *    1. the persisted upload filename when its extension MATCHES the
 *       authoritative mime (a genuine classifier signal — keep it verbatim);
 *    2. that persisted name with the mime-derived extension APPENDED — used when
 *       the persisted name is extensionless OR carries an extension for a
 *       DIFFERENT mime (a `report.pdf` on text/markdown bytes must NOT reach the
 *       provider as `.pdf`, or markdown is parsed under PDF format detection;
 *       appending `.md` makes the TRAILING extension match the bytes);
 *    3. a synthesized `<artifactId><ext>` from the authoritative mime.
 *  When the authoritative mime is not one the provider ingests (`ext === null`)
 *  we do NOT invent an extension — fall back to the persisted name or bare id
 *  unchanged (that attachment would degrade to the not-readable manifest at the
 *  resolver anyway). `extensionForMime` / `extensionMatchesMime` are injected
 *  (the real `@cinatra-ai/llm` capability helpers at the call site) so the
 *  contract test drives the SAME ingestible-set authority, not a local copy. */
function resolveMatcherAttachmentFilename(args: {
  artifactId: string;
  mime: string;
  persistedFilename: string | undefined;
  extensionForMime: (mime: string) => string | null;
  extensionMatchesMime: (filename: string, mime: string) => boolean;
}): string {
  const persisted = args.persistedFilename?.trim();
  if (persisted && args.extensionMatchesMime(persisted, args.mime)) {
    return persisted.slice(0, 200);
  }
  const ext = args.extensionForMime(args.mime);
  if (persisted && ext) {
    return `${persisted.slice(0, 180)}${ext}`;
  }
  if (ext) {
    return `${args.artifactId}${ext}`;
  }
  return persisted ? persisted.slice(0, 200) : args.artifactId;
}

// Test-only exports of the pure matching helpers (mime normalization /
// wildcard / package-owned trust). Not part of the production surface.
export const __test = {
  normalizeMime: (m: string) => normalizeMime(m),
  mimeMatches: (a: string, x: string) => mimeMatches(a, x),
  skillTrusted: (s: SkillEntry, e: string) => skillTrusted(s, e),
  renderClassifierSignalsForPrompt: (s: ClassifierSignalsForPrompt | null) =>
    renderClassifierSignalsForPrompt(s),
  parseClassifierSignals: (raw: unknown) => parseClassifierSignals(raw),
  resolveMatcherAttachmentFilename,
};

/** Slugify mirroring `@cinatra-ai/agents` store.slugify — inlined (3
 *  lines, not worth a cross-package edge). Only used as the COMPAT
 *  fallback trust check (`packageSlug === slugify(extPackageName)`);
 *  the primary check is the exact `packageName` equality. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

/** Normalize a MIME for matching: lowercase + strip `;...` params +
 *  trim. `text/plain; charset=utf-8` ⇒ `text/plain`. */
function normalizeMime(m: string): string {
  const semi = m.indexOf(";");
  return (semi >= 0 ? m.slice(0, semi) : m).trim().toLowerCase();
}

// Match an authoritative mime against one `accepts.file.mimeTypes`
// entry. Supports exact, subtype-wildcard ("image/" + star), and the
// "star/star" any-type wildcard. (Plain `//` comments here on purpose
// — a JSDoc block must not contain a literal star-slash.)
function mimeMatches(authoritative: string, accept: string): boolean {
  const a = normalizeMime(authoritative);
  const x = normalizeMime(accept);
  if (x === "*/*") return true;
  if (x === a) return true;
  if (x.endsWith("/*")) {
    const prefix = x.slice(0, -1); // "image/"
    return a.startsWith(prefix);
  }
  return false;
}

/** Best-effort parse of the persisted `classifier_signals` jsonb into the
 *  prompt-facing subset. Returns null on any shape surprise (the write path
 *  strict-validated it, but a hand-edited/legacy row must never crash the
 *  worker). */
function parseClassifierSignals(raw: unknown): ClassifierSignalsForPrompt | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  return obj as ClassifierSignalsForPrompt;
}

/** Org-scoped authoritative read (cinatra#1891 scope 1). Joins
 *  representation→resource→artifact_blobs→objects. Keys on ANY FILE-FORM
 *  artifact row (`data->>'artifactType' = 'file'`) that is not tombstoned — NO
 *  longer on the retired generic type (which matched nothing, keeping the
 *  chassis dormant). The retired generic id is kept as a DEFENSIVE exclusion.
 *  Registration of the row's declared type is validated by the caller against
 *  the in-memory registry AFTER `registerAllObjectTypes`. Also selects the
 *  persisted `classifier_signals` (scope 2) and the row's `type` (scope 4).
 *
 *  Returns null when the row is absent (orphan-assertion guard). THROWS
 *  `MatcherRetryableError` on a DB read error — a transient DB blip must retry
 *  the job, not be silently swallowed into a permanent no-classify (scope 6). */
function readAuthoritative(
  payload: ArtifactMatchJobPayload,
): AuthoritativeArtifact | null {
  const schema = q();
  let res;
  try {
    // `ensurePostgresSchema` is INSIDE the retryable try: on a cold worker whose
    // DB is momentarily unreachable, the schema-bootstrap DDL throws — that is a
    // TRANSIENT DB failure and must retry (cinatra#1891 scope 6), not fall to the
    // top-level non-retryable catch and silently complete the job.
    ensurePostgresSchema();
    [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `SELECT b.sha256 AS digest, r.mime AS mime,
       b.storage_key AS storage_key,
       o.type AS object_type,
       (o.data->>'originKind') AS origin_kind,
       rep.classifier_signals AS classifier_signals
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r
  ON r.id = rep.resource_id AND r.org_id = rep.org_id
JOIN "${schema}"."artifact_blobs" b
  ON b.id = (r.metadata->>'blobId') AND b.org_id = r.org_id
JOIN "${schema}"."objects" o
  ON o.id = rep.artifact_id AND o.org_id = rep.org_id
WHERE rep.id = $1 AND rep.artifact_id = $2 AND rep.org_id = $3
  AND r.kind = 'blob'
  AND (o.data->>'artifactType') = 'file'
  AND o.type <> $4
  AND o.deleted_at IS NULL
LIMIT 1`,
          values: [
            payload.representationRevisionId,
            payload.artifactId,
            payload.orgId,
            RETIRED_GENERIC_ARTIFACT_TYPE,
          ],
        },
      ],
    });
  } catch (err) {
    throw new MatcherRetryableError(
      `authoritative read failed for ${payload.artifactId}`,
      err,
    );
  }
  const row = res?.rows?.[0] as
    | {
        digest?: string;
        mime?: string;
        storage_key?: string;
        object_type?: string;
        origin_kind?: string;
        classifier_signals?: unknown;
      }
    | undefined;
  if (!row?.digest || !row.mime || !row.storage_key || !row.object_type) return null;
  return {
    digest: row.digest,
    mime: row.mime,
    storageKey: row.storage_key,
    type: row.object_type,
    originKind: row.origin_kind || "upload",
    classifierSignals: parseClassifierSignals(row.classifier_signals),
  };
}

/** Pre-assert liveness re-check. The authoritative read happens BEFORE
 *  the (potentially slow) LLM call; an artifact can be tombstoned in
 *  that window. Re-checking `objects.deleted_at IS NULL` immediately
 *  before `assertSemanticType` shrinks the TOCTOU window to ~µs. The
 *  residual race (tombstone commits between this check and the
 *  assertion's own locked tx) is bounded and low-harm: a matcher DRAFT
 *  on a just-tombstoned artifact is precedence-irrelevant and
 *  GC-reclaimed. The complete fix is a locked-transaction conditional
 *  assert. */
function objectStillLive(orgId: string, artifactId: string): boolean {
  try {
    const schema = q();
    const [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `SELECT 1 FROM "${schema}"."objects"
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
LIMIT 1`,
          values: [artifactId, orgId],
        },
      ],
    });
    return Boolean(res?.rows && res.rows.length > 0);
  } catch {
    // On a read error, be conservative: do NOT assert (skip). This liveness
    // re-check is a TOCTOU narrowing, not the authoritative read — a transient
    // blip here safely degrades to "skip the assert" rather than retrying the
    // whole (already-classified) job.
    return false;
  }
}

const matcherResponseSchema = z
  .object({
    matches: z.boolean(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().optional(),
  })
  .strict();

/**
 * Run the LLM meaning-matcher for a freshly-created artifact. The matcher layers
 * a MEANING assertion (a `matcher` DRAFT, surfaced by the presentation resolver)
 * on top of the row's structural type — it never changes `objects.type`. Resolves
 * cleanly for every terminal / best-effort outcome; RE-THROWS only a
 * `MatcherRetryableError` (a transient DB/LLM failure) so BullMQ retries the job
 * per `ARTIFACT_MATCH_RETRY_POLICY` (cinatra#1891 scope 6).
 */
export async function runArtifactMatch(
  payload: ArtifactMatchJobPayload,
  opts: { actorContext: ActorContext },
): Promise<void> {
  // TOP-LEVEL boundary guard with HONEST retry semantics (cinatra#1891
  // scope 6). Two failure classes:
  //   - TRANSIENT (`MatcherRetryableError`: a DB read/write blip, an LLM
  //     provider hiccup) is RE-THROWN so BullMQ retries the job per
  //     `ARTIFACT_MATCH_RETRY_POLICY`. The previous chassis swallowed
  //     EVERYTHING, so the attempts/backoff the enqueue declared never
  //     actually fired — a transient failure became a permanent no-classify.
  //   - TERMINAL / non-retryable (a registry-import boom, a frontmatter parse
  //     error, any other setup throw) is logged + swallowed: retrying it would
  //     fail identically, so the row simply stays at its structural identity.
  //     Per-candidate best-effort skips (a malformed LLM response) already
  //     degrade INSIDE the impl without throwing.
  try {
    await runArtifactMatchImpl(payload, opts);
  } catch (err) {
    if (isRetryable(err)) {
      console.warn(
        `[artifact-matcher] transient failure for ${payload.artifactId} — rethrowing for BullMQ retry:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
    console.error(
      `[artifact-matcher] non-retryable failure for ${payload.artifactId} (structural identity stands; job NOT retried):`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function runArtifactMatchImpl(
  payload: ArtifactMatchJobPayload,
  opts: { actorContext: ActorContext },
): Promise<void> {
  // 1) Authoritative read FIRST (orphan-assertion guard).
  const authoritative = readAuthoritative(payload);
  if (!authoritative) {
    console.info(
      `[artifact-matcher] ${payload.artifactId} not resolvable (tombstoned / orphaned / missing) — skipping match`,
    );
    return;
  }

  // 2) Candidate discovery via the meaning-surface channel (cinatra#1891 A3).
  const { registerAllObjectTypes } = await import(
    "@/lib/register-all-object-types"
  );
  const { objectTypeRegistry, matcherManifestRegistry } = await import(
    "@cinatra-ai/objects/registry"
  );
  registerAllObjectTypes();

  // cinatra#1891 scope 1 (registration half): the authoritative read keys on any
  // file-form row; here we require the row's OWN declared type to still be a
  // REGISTERED artifact type. A row whose definer was uninstalled after the row
  // was minted is stale — skip it (no meaning classification on a dead type).
  const ownDef = objectTypeRegistry.resolve(authoritative.type);
  if (!ownDef || !ownDef.isArtifact) {
    console.info(
      `[artifact-matcher] ${payload.artifactId} type "${authoritative.type}" is not a registered artifact type (definer uninstalled?) — skipping match`,
    );
    return;
  }

  type Candidate = {
    extPackageName: string;
    matcherSkillId: string;
    threshold: number;
  };
  const candidates: Candidate[] = [];
  let capReached = false;
  // cinatra#1891 A3: candidates come from the MEANING-SURFACE channel, NOT
  // `objectTypeRegistry.listArtifacts()`. Post-#1785 the umbrella that once
  // carried `skills.matchers` on a listable descriptor is retired and
  // `declaredTypeArtifactDescriptor` strips the matcher surface off every
  // per-type descriptor, so the old list-source was ALWAYS empty for the 13
  // matcher-declaring packs (silent no-op). The channel is populated on the
  // same bridge pass keyed by package name and IS the provenance record — only
  // a pack that DECLARED matchers is in it — so `definerOf` is no longer needed
  // (the channel key IS the owning package). The threshold is already RESOLVED
  // on the entry (manifest value or the pack default).
  for (const entry of matcherManifestRegistry.list()) {
    if (capReached) break;
    const mimeOk = entry.fileMimeTypes.some((acc) =>
      mimeMatches(authoritative.mime, acc),
    );
    if (!mimeOk) continue; // file-form only (MVP)
    const extPackageName = entry.packageName;
    const threshold = entry.matcherConfidenceThreshold;
    // cinatra#1891 scope 5: run ALL declared matchers, not just the first —
    // one candidate PER matcher skill the extension declares.
    for (const matcherSkillId of entry.matcherSkillIds) {
      if (candidates.length >= MAX_CANDIDATES) {
        console.info(
          `[artifact-matcher] candidate cap (${MAX_CANDIDATES}) reached — remaining matcher candidates skipped this run`,
        );
        capReached = true;
        break;
      }
      candidates.push({ extPackageName, matcherSkillId, threshold });
    }
  }

  // CG-4 (cinatra#661) — install-active write gate on the ACTOR-LESS matcher.
  // The candidate set above is built purely from `matcherManifestRegistry
  // .list()` (in-memory channel membership). The channel is NOT the
  // only authz: a registered-but-archived pack (a stale process whose teardown
  // never fired, or a disk descriptor lingering past an archive) could otherwise
  // receive a `matcher`-asserted semantic type. Drop any candidate whose
  // canonical install row is archived/absent-and-governed — DB-status-driven, so
  // it holds even in a process that never received the in-memory teardown.
  // Ungoverned (no-row) bundled/disk artifact types stay matchable (CG-1).
  const { isArtifactExtensionWriteAllowed } = await import(
    "./artifact-extension-access"
  );
  const allowedFlags = await Promise.all(
    candidates.map((c) => isArtifactExtensionWriteAllowed(c.extPackageName, payload.orgId)),
  );
  const gatedCandidates = candidates.filter((_, i) => allowedFlags[i]);
  const droppedCount = candidates.length - gatedCandidates.length;
  if (droppedCount > 0) {
    console.info(
      `[artifact-matcher] ${droppedCount} candidate(s) dropped (install archived/absent) for ${payload.artifactId}`,
    );
  }
  candidates.length = 0;
  candidates.push(...gatedCandidates);

  if (candidates.length === 0) {
    console.info(
      `[artifact-matcher] no MIME-matching matcher extensions for ${authoritative.mime} (${payload.artifactId}) — structural identity stands`,
    );
    return;
  }

  // 3) Resolve the LLM runtime once; prefetch the installed-skills map.
  //    A THROW here is transient (provider config read / network) → retry the
  //    job. A clean `null` return is TERMINAL (no runtime configured for the
  //    org) → skip without retry (cinatra#1891 scope 6).
  let runtime;
  try {
    const { resolveConfiguredLlmRuntime } = await import(
      "@cinatra-ai/llm"
    );
    runtime = await resolveConfiguredLlmRuntime();
  } catch (err) {
    throw new MatcherRetryableError(
      "resolveConfiguredLlmRuntime threw",
      err,
    );
  }
  if (!runtime) {
    console.info(
      "[artifact-matcher] no LLM runtime configured — skipping match (structural identity stands)",
    );
    return;
  }

  // cinatra#1891 scope 2: render the persisted classifier signals (chat
  // context, upload metadata, producer `produces`) into a compact prompt block
  // the matcher sees for EVERY candidate. Composed once — it does not vary by
  // candidate.
  const signalsBlock = renderClassifierSignalsForPrompt(
    authoritative.classifierSignals,
  );

  const { listInstalledSkills, parseFrontmatter } = await import(
    "@cinatra-ai/skills"
  );
  let skillMap = await loadSkillMap(listInstalledSkills);

  const { runResolvedDeterministicLlmTask } = await import(
    "@cinatra-ai/llm"
  );
  const { buildAttachmentResolverPorts } = await import(
    "./attachment-resolver-ports"
  );
  const { assertSemanticType } = await import("./semantic-assertion-store");

  // cinatra#1891 DEFECT-3: the attachment MUST carry a filename with a
  // provider-recognized extension. OpenAI's `input_file` path derives the file
  // format from the extension; the matcher previously sent no `filename`, so the
  // resolver fell back to the bare artifact UUID and EVERY classification call
  // 400'd ("context stuffing file type … but got none"). Prefer the persisted
  // upload filename (a real signal); synthesize from the authoritative mime
  // otherwise.
  const attachmentRef = {
    artifactId: payload.artifactId,
    representationRevisionId: payload.representationRevisionId,
    digest: authoritative.digest,
    mime: authoritative.mime,
    originKind:
      authoritative.originKind as "upload" | "email_attachment" | "agent_generated" | "external_link" | "live_generator",
    filename: resolveMatcherAttachmentFilename({
      artifactId: payload.artifactId,
      mime: authoritative.mime,
      persistedFilename: authoritative.classifierSignals?.upload?.filename,
      extensionForMime: extensionForIngestibleMime,
      extensionMatchesMime: filenameExtensionMatchesMime,
    }),
  };
  const ports = buildAttachmentResolverPorts({ orgId: payload.orgId });

  // 4) Per-candidate classification.
  for (const cand of candidates) {
    // Trust anchor — the matcher skill MUST belong to the artifact
    // extension's OWN package. Boot-order resilience: a catalog miss
    // for this package triggers a one-shot co-located registration for
    // it, then a single map reload + retry.
    let skill = skillMap.get(cand.matcherSkillId);
    if (!skill || !skillTrusted(skill, cand.extPackageName)) {
      const reloaded = await tryLazyRegisterAndReload(
        cand.extPackageName,
        listInstalledSkills,
      );
      if (reloaded) {
        skillMap = reloaded;
        skill = skillMap.get(cand.matcherSkillId);
      }
    }
    if (!skill) {
      console.warn(
        `[artifact-matcher] matcher skill ${cand.matcherSkillId} not in catalog (even after lazy-register) — skipping ${cand.extPackageName}`,
      );
      continue;
    }
    if (!skillTrusted(skill, cand.extPackageName)) {
      console.warn(
        `[artifact-matcher] matcher skill ${cand.matcherSkillId} is NOT package-owned by ${cand.extPackageName} (foreign packageName "${skill.packageName}") — refusing to honor it`,
      );
      continue;
    }

    const system = parseFrontmatter(skill.content).body.trim();
    if (!system) {
      console.warn(
        `[artifact-matcher] matcher skill ${cand.matcherSkillId} has empty body — skipping ${cand.extPackageName}`,
      );
      continue;
    }

    const userPrompt =
      `Classify the attached artifact. Decide whether it is a "${cand.extPackageName}" work product. ` +
      signalsBlock +
      `Respond ONLY with JSON: {"matches": boolean, "confidence": number between 0 and 1, "rationale": short string}.`;

    // cinatra#1891 scope 6: split the TRANSIENT invocation failure (provider
    // error / timeout — the call itself threw) from a TERMINAL malformed
    // response (the provider answered, the JSON/zod parse failed). The former
    // rethrows as retryable so the whole job retries; the latter is a
    // best-effort per-candidate skip. Swallowing the invocation throw (as the
    // old chassis did) meant a flapping provider silently produced NO
    // classification instead of retrying.
    let llmText: string;
    try {
      const result = await runResolvedDeterministicLlmTask({
        runtime,
        system,
        user: userPrompt,
        attachments: [attachmentRef],
        attachmentResolverPorts: ports,
        declaredToolboxIds: [],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["matches", "confidence", "rationale"],
          properties: {
            matches: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string" },
          },
        },
        logLabel: "artifact-matcher",
        actorContext: opts.actorContext,
      });
      llmText = String(result.text ?? "{}");
    } catch (err) {
      throw new MatcherRetryableError(
        `LLM classification call failed for ${cand.extPackageName} on ${payload.artifactId}`,
        err,
      );
    }

    let parsed: z.infer<typeof matcherResponseSchema>;
    try {
      parsed = matcherResponseSchema.parse(JSON.parse(llmText));
    } catch (err) {
      console.warn(
        `[artifact-matcher] ${cand.extPackageName} malformed / out-of-range response — skipping candidate:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (!parsed.matches || parsed.confidence < cand.threshold) {
      console.info(
        `[artifact-matcher] ${cand.extPackageName} not matched (matches=${parsed.matches} confidence=${parsed.confidence} threshold=${cand.threshold}) for ${payload.artifactId}`,
      );
      continue;
    }

    // Re-check the object is still live right before asserting (it may
    // have been tombstoned during the LLM call). Skip the assert if
    // not.
    if (!objectStillLive(payload.orgId, payload.artifactId)) {
      console.info(
        `[artifact-matcher] ${payload.artifactId} tombstoned during classification — skipping ${cand.extPackageName} assertion`,
      );
      continue;
    }

    // The matcher write is a DRAFT (the store maps `assertedBy:"matcher"` →
    // `draft` eligibility) — it surfaces via the presentation resolver, never
    // by mutating `objects.type` (cinatra#1891 scope 8). A blocked-by-precedence
    // outcome is the EXPECTED no-op when a producer/user/authoring assertion
    // already exists. A THROW here is a transient DB write failure → rethrow as
    // retryable so the whole job retries rather than silently dropping the
    // classification (cinatra#1891 scope 6).
    let outcome;
    try {
      outcome = assertSemanticType({
        orgId: payload.orgId,
        artifactId: payload.artifactId,
        extension: cand.extPackageName,
        assertedBy: "matcher",
        confidence: parsed.confidence,
      });
    } catch (err) {
      throw new MatcherRetryableError(
        `assertSemanticType failed for ${cand.extPackageName} on ${payload.artifactId}`,
        err,
      );
    }
    console.info(
      outcome.inserted
        ? `[artifact-matcher] asserted ${cand.extPackageName} (matcher draft, conf=${parsed.confidence}) on ${payload.artifactId}`
        : `[artifact-matcher] ${cand.extPackageName} blocked by precedence on ${payload.artifactId} — expected no-op (producer/user/authoring already asserted)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Classifier-signals prompt renderer (cinatra#1891 scope 2).
//
// Turns the persisted `representation.classifier_signals` blob into a compact,
// human-readable block spliced into the matcher's user prompt. Bounded (a fixed
// number of short lines) so a large signals blob cannot dominate the prompt.
// Returns "" when there is nothing useful to say — the prompt then reads exactly
// as it did before signals existed.
// ---------------------------------------------------------------------------
function renderClassifierSignalsForPrompt(
  signals: ClassifierSignalsForPrompt | null,
): string {
  if (!signals || typeof signals !== "object") return "";
  const lines: string[] = [];

  const upload = signals.upload;
  if (upload && typeof upload === "object") {
    if (typeof upload.filename === "string" && upload.filename.trim()) {
      lines.push(`filename: ${upload.filename.trim().slice(0, 200)}`);
    }
    if (typeof upload.declaredMime === "string" && upload.declaredMime.trim()) {
      lines.push(`declared type: ${upload.declaredMime.trim().slice(0, 100)}`);
    }
    if (typeof upload.parentType === "string" && upload.parentType.trim()) {
      lines.push(`attached to: ${upload.parentType.trim().slice(0, 100)}`);
    }
    if (typeof upload.originKind === "string" && upload.originKind.trim()) {
      lines.push(`origin: ${upload.originKind.trim().slice(0, 60)}`);
    }
  }

  // Producer `produces` — the extension(s) the emitting run declared it produces
  // (scope 3 persists these). A strong hint about the intended meaning.
  if (Array.isArray(signals.produces)) {
    const exts = signals.produces
      .map((p) => (p && typeof p.extension === "string" ? p.extension.trim() : null))
      .filter((e): e is string => !!e)
      // Clamp EACH extension (not just the count): the write path byte-caps a
      // normally-composed row, but this renderer is the DEFENSIVE reader for a
      // hand-edited / legacy jsonb row, so a single multi-megabyte extension
      // string must not balloon the prompt (cinatra#1891 — a real per-string
      // bound, mirroring the upload/chat clamps above).
      .map((e) => e.slice(0, 200))
      .slice(0, 8);
    if (exts.length > 0) {
      lines.push(`producer declared it produces: ${exts.join(", ")}`);
    }
  }

  // Recent chat context — role-tagged, short. The upstream stripper already
  // capped these; re-clamp defensively.
  const messages = signals.chatContext?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const rendered = messages
      .filter((m) => m && typeof m.content === "string" && m.content.trim())
      .slice(-3)
      .map((m) => {
        const role = m.role === "assistant" ? "assistant" : "user";
        return `  ${role}: ${String(m.content).trim().slice(0, 400)}`;
      });
    if (rendered.length > 0) {
      lines.push(`recent conversation context:\n${rendered.join("\n")}`);
    }
  }

  if (lines.length === 0) return "";
  return (
    `Context signals gathered when this artifact was created (use as supporting evidence, not proof):\n` +
    lines.join("\n") +
    `\n\n`
  );
}

type SkillEntry = {
  id: string;
  packageName: string;
  packageSlug: string;
  content: string;
};

async function loadSkillMap(
  listInstalledSkills: () => Promise<unknown[]>,
): Promise<Map<string, SkillEntry>> {
  const map = new Map<string, SkillEntry>();
  try {
    const skills = (await listInstalledSkills()) as SkillEntry[];
    for (const s of skills) {
      if (s && typeof s.id === "string") map.set(s.id, s);
    }
  } catch (err) {
    console.warn(
      "[artifact-matcher] listInstalledSkills failed — empty skill map:",
      err instanceof Error ? err.message : err,
    );
  }
  return map;
}

/** Package-owned trust: the matcher skill MUST ship in the artifact
 *  extension's OWN package. Primary check is exact `packageName`
 *  equality; the slugified `packageSlug` is only a COMPAT fallback
 *  (never compare the slug raw against `@scope/pkg`). */
function skillTrusted(skill: SkillEntry, extPackageName: string): boolean {
  if (skill.packageName === extPackageName) return true;
  return skill.packageSlug === slugify(extPackageName);
}

/** Boot-order resilience: the dev/boot extension scan is
 *  fire-and-forget, so a first artifact-create right after restart can
 *  run the matcher before the owning package's co-located skills are
 *  registered. On a catalog miss, run a ONE-SHOT co-located
 *  registration for just that package, then reload the map once.
 *  Returns the reloaded map on success, or null when the package dir
 *  could not be located / registration produced nothing. */
async function tryLazyRegisterAndReload(
  extPackageName: string,
  listInstalledSkills: () => Promise<unknown[]>,
): Promise<Map<string, SkillEntry> | null> {
  try {
    const { registerArtifactExtensionSkillsForPackage } = await import(
      "@/lib/extensions-dev-watcher"
    );
    const n = await registerArtifactExtensionSkillsForPackage(extPackageName);
    if (n <= 0) return null;
    return await loadSkillMap(listInstalledSkills);
  } catch (err) {
    console.warn(
      `[artifact-matcher] lazy skill registration failed for ${extPackageName}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
