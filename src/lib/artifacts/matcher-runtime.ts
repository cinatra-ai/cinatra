import "server-only";
import { z } from "zod";
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

// Leaf-mirror of `@cinatra-ai/objects/semantic-manifest`
// SEMANTIC_ARTIFACT_OBJECT_TYPE — inlined to keep the heavy
// `@cinatra-ai/objects` barrel out of this worker's import-time graph
// (same leaf-mirror pattern as artifact-creation.ts / producer-
// assertions.ts). Keep in lock-step with the canonical constant.
const SEMANTIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";
const ARTIFACT_TYPE_SUFFIX = ":artifact";
const DEFAULT_MATCHER_CONFIDENCE_THRESHOLD = 0.7;
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
};

// Test-only exports of the pure matching helpers (mime normalization /
// wildcard / package-owned trust). Not part of the production surface.
export const __test = {
  normalizeMime: (m: string) => normalizeMime(m),
  mimeMatches: (a: string, x: string) => mimeMatches(a, x),
  skillTrusted: (s: SkillEntry, e: string) => skillTrusted(s, e),
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

/** Org-scoped authoritative read. Joins representation→resource→
 *  artifact_blobs→objects. Validates the object is not tombstoned and
 *  the resource is a live blob. Returns null when anything is absent
 *  (orphan-assertion guard). */
function readAuthoritative(
  payload: ArtifactMatchJobPayload,
): AuthoritativeArtifact | null {
  ensurePostgresSchema();
  const schema = q();
  let res;
  try {
    [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `SELECT b.sha256 AS digest, r.mime AS mime,
       b.storage_key AS storage_key,
       (o.data->>'originKind') AS origin_kind
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r
  ON r.id = rep.resource_id AND r.org_id = rep.org_id
JOIN "${schema}"."artifact_blobs" b
  ON b.id = (r.metadata->>'blobId') AND b.org_id = r.org_id
JOIN "${schema}"."objects" o
  ON o.id = rep.artifact_id AND o.org_id = rep.org_id
WHERE rep.id = $1 AND rep.artifact_id = $2 AND rep.org_id = $3
  AND r.kind = 'blob'
  AND o.type = $4
  AND o.deleted_at IS NULL
LIMIT 1`,
          values: [
            payload.representationRevisionId,
            payload.artifactId,
            payload.orgId,
            SEMANTIC_ARTIFACT_OBJECT_TYPE,
          ],
        },
      ],
    });
  } catch (err) {
    console.warn(
      `[artifact-matcher] authoritative read failed for ${payload.artifactId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const row = res?.rows?.[0] as
    | {
        digest?: string;
        mime?: string;
        storage_key?: string;
        origin_kind?: string;
      }
    | undefined;
  if (!row?.digest || !row.mime || !row.storage_key) return null;
  return {
    digest: row.digest,
    mime: row.mime,
    storageKey: row.storage_key,
    originKind: row.origin_kind || "upload",
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
WHERE id = $1 AND org_id = $2 AND type = $3 AND deleted_at IS NULL
LIMIT 1`,
          values: [artifactId, orgId, SEMANTIC_ARTIFACT_OBJECT_TYPE],
        },
      ],
    });
    return Boolean(res?.rows && res.rows.length > 0);
  } catch {
    // On a read error, be conservative: do NOT assert (skip).
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
 * Run the LLM artifact matcher for a freshly-created artifact. Always
 * resolves (never throws past this boundary) — the matcher is a
 * best-effort classification fallback; every failure path leaves the
 * artifact at its default-floor type.
 */
export async function runArtifactMatch(
  payload: ArtifactMatchJobPayload,
  opts: { actorContext: ActorContext },
): Promise<void> {
  // TOP-LEVEL boundary guard. The matcher is a best-effort
  // classification fallback, so ANY failure (registry import,
  // registerAllObjectTypes, listInstalledSkills,
  // buildAttachmentResolverPorts, frontmatter parse, …) must leave
  // the artifact at its default-floor type WITHOUT failing the
  // BullMQ job (a thrown job would retry 3× pointlessly). The inner
  // impl already degrades per-candidate; this catch covers the
  // pre-loop setup paths too.
  try {
    await runArtifactMatchImpl(payload, opts);
  } catch (err) {
    console.error(
      `[artifact-matcher] unexpected failure for ${payload.artifactId} (default-floor stands; job NOT retried):`,
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

  // 2) Candidate discovery via the object registry.
  const { registerAllObjectTypes } = await import(
    "@/lib/register-all-object-types"
  );
  const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
  registerAllObjectTypes();
  type Candidate = {
    extPackageName: string;
    matcherSkillId: string;
    threshold: number;
  };
  const candidates: Candidate[] = [];
  for (const def of objectTypeRegistry.listArtifacts()) {
    if (candidates.length >= MAX_CANDIDATES) {
      console.info(
        `[artifact-matcher] candidate cap (${MAX_CANDIDATES}) reached — remaining artifact extensions skipped this run`,
      );
      break;
    }
    const manifest = def.isArtifact;
    if (!manifest) continue;
    const matcherSkillId = manifest.skills?.matchers?.[0];
    if (!matcherSkillId) continue; // no matcher skill declared
    const fileForms = manifest.accepts?.file?.mimeTypes;
    if (!fileForms || fileForms.length === 0) continue; // file-form only (MVP)
    const mimeOk = fileForms.some((acc) =>
      mimeMatches(authoritative.mime, acc),
    );
    if (!mimeOk) continue;
    if (!def.type.endsWith(ARTIFACT_TYPE_SUFFIX)) continue; // never the legacy generic
    const extPackageName = def.type.slice(
      0,
      def.type.length - ARTIFACT_TYPE_SUFFIX.length,
    );
    if (!extPackageName) continue;
    const threshold =
      typeof manifest.matcherConfidenceThreshold === "number"
        ? manifest.matcherConfidenceThreshold
        : DEFAULT_MATCHER_CONFIDENCE_THRESHOLD;
    candidates.push({ extPackageName, matcherSkillId, threshold });
  }
  if (candidates.length === 0) {
    console.info(
      `[artifact-matcher] no MIME-matching matcher extensions for ${authoritative.mime} (${payload.artifactId}) — default-floor stands`,
    );
    return;
  }

  // 3) Resolve the LLM runtime once; prefetch the installed-skills map.
  let runtime;
  try {
    const { resolveConfiguredLlmRuntime } = await import(
      "@cinatra-ai/llm"
    );
    runtime = await resolveConfiguredLlmRuntime();
  } catch (err) {
    console.warn(
      "[artifact-matcher] resolveConfiguredLlmRuntime threw — skipping run:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (!runtime) {
    console.info(
      "[artifact-matcher] no LLM runtime configured — skipping match (default-floor stands)",
    );
    return;
  }

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

  const attachmentRef = {
    artifactId: payload.artifactId,
    representationRevisionId: payload.representationRevisionId,
    digest: authoritative.digest,
    mime: authoritative.mime,
    originKind:
      authoritative.originKind as "upload" | "email_attachment" | "agent_generated" | "external_link" | "live_generator",
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

    let parsed: z.infer<typeof matcherResponseSchema>;
    try {
      const result = await runResolvedDeterministicLlmTask({
        runtime,
        system,
        user: `Classify the attached artifact. Decide whether it is a "${cand.extPackageName}" work product. Respond ONLY with JSON: {"matches": boolean, "confidence": number between 0 and 1, "rationale": short string}.`,
        attachments: [attachmentRef],
        attachmentResolverPorts: ports,
        declaredToolboxIds: [],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["matches", "confidence"],
          properties: {
            matches: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string" },
          },
        },
        logLabel: "artifact-matcher",
        actorContext: opts.actorContext,
      });
      const raw = JSON.parse(String(result.text ?? "{}"));
      parsed = matcherResponseSchema.parse(raw);
    } catch (err) {
      console.warn(
        `[artifact-matcher] ${cand.extPackageName} classification failed / malformed response — skipping:`,
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

    try {
      const outcome = assertSemanticType({
        orgId: payload.orgId,
        artifactId: payload.artifactId,
        extension: cand.extPackageName,
        assertedBy: "matcher",
        confidence: parsed.confidence,
      });
      console.info(
        outcome.inserted
          ? `[artifact-matcher] asserted ${cand.extPackageName} (matcher draft, conf=${parsed.confidence}) on ${payload.artifactId}`
          : `[artifact-matcher] ${cand.extPackageName} blocked by precedence on ${payload.artifactId} — expected no-op (producer/user/authoring already asserted)`,
      );
    } catch (err) {
      console.error(
        `[artifact-matcher] assertSemanticType threw for ${cand.extPackageName} on ${payload.artifactId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
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
