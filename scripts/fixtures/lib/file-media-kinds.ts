import { createUploadedArtifact } from "@/lib/artifacts/artifact-service";
import { resolveUploadArtifactType } from "@/lib/artifacts/upload-artifact-type-map";
import { readUserIsOrgMember } from "@/lib/better-auth-db";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { mediaKindSamples, type MediaKindSample } from "./media-kind-samples";

/** One filed sample: what the marked review gate fixture pins, plus its kind. */
export interface FiledMediaKind {
  kind: MediaKindSample["kind"];
  mime: string;
  objectType: string;
  artifactId: string;
  representationRevisionId: string;
}

interface ReviewTarget { artifactId: string; representationRevisionId: string }

export function assertMediaFixtureRuntime(env: Record<string, string | undefined> = process.env) {
  if (env.CINATRA_RUNTIME_MODE !== "development") {
    throw new Error("Media fixtures require CINATRA_RUNTIME_MODE=development");
  }
}

/** The trimmed ids every read and write of the fixture uses. */
export function normalizeFixtureIds(input: { orgId: string; userId: string }) {
  const orgId = input.orgId.trim(), userId = input.userId.trim();
  if (!orgId || !userId) throw new Error("The organization and the user must be nonempty");
  return { orgId, userId };
}

/**
 * File one artifact of each of the six media kinds for one user, through the
 * upload route's own service entry: the form is mapped to the one installed
 * required artifact type that accepts it, and the writer refuses a stored form
 * the type does not accept before it writes any artifact row.
 *
 * The user must be a member of the organization; the upload route takes both
 * from a signed-in session, so this fixture reads the membership instead.
 * Membership and every kind are checked before the first write, so a
 * non-member or a missing type files nothing. The six are filed one after
 * another with no rollback: a failure at a later kind leaves the earlier ones
 * filed, and a second run files a second set. The artifacts are the user's
 * own private uploads. They are typed by their form, so no matcher runs.
 */
export async function fileMediaKindSamples(
  input: { orgId: string; userId: string },
  samples: MediaKindSample[] = mediaKindSamples(),
): Promise<FiledMediaKind[]> {
  assertMediaFixtureRuntime();
  const { orgId, userId } = normalizeFixtureIds(input);
  if (!(await readUserIsOrgMember(userId, orgId))) {
    throw new Error("The user is not a member of the organization; nothing was filed");
  }
  registerAllObjectTypes();
  const plan = samples.map((sample) => {
    const resolved = resolveUploadArtifactType(sample.mime);
    if (!resolved.ok) {
      throw new Error(`No installed upload type takes the ${sample.kind} sample (${sample.mime}): ${resolved.reason}; nothing was filed`);
    }
    return { sample, objectType: resolved.objectTypeId };
  });
  const filed: FiledMediaKind[] = [];
  for (const { sample, objectType } of plan) {
    const result = await createUploadedArtifact({
      orgId, createdBy: userId, ownerLevel: "user", ownerId: userId, visibility: "private",
      declaredMime: sample.mime, title: sample.title, originKind: "upload",
      skipFallbackClassification: true,
      stream: (async function* () { yield sample.bytes; })(),
    });
    filed.push({
      kind: sample.kind, mime: sample.mime, objectType,
      artifactId: result.artifactId, representationRevisionId: result.representationRevisionId,
    });
  }
  return filed;
}

/** The e2e harness the review run is seeded through (injectable for tests). */
export interface ReviewGateHarness {
  seedMarkedReviewGateRun(input: { userId: string; orgId: string; targets: ReviewTarget[] }): Promise<string>;
  waitForMarkedReviewGate(runId: string): Promise<{ reviewTaskId: string; status: string; pinnedTargets: ReviewTarget[] }>;
}

const targetKey = (t: ReviewTarget) => `${t.artifactId}\u0000${t.representationRevisionId}`;

/**
 * Seed a run of the marked review gate fixture with the six filed revisions
 * and wait for its gate. Only run creation is seeded; WayFlow pauses the run
 * and the executor pins the targets. The gate must pin exactly the six filed
 * revisions, none missing, none foreign and none twice, or this fails.
 */
export async function seedMediaKindReviewRun(
  input: { orgId: string; userId: string; filed: FiledMediaKind[] },
  harness?: ReviewGateHarness,
) {
  const { orgId, userId } = normalizeFixtureIds(input);
  const targets = input.filed.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
  const expected = new Set(targets.map(targetKey));
  if (targets.length !== 6 || expected.size !== 6) throw new Error("A review run needs the six filed kinds, each once");
  const h = harness ?? await import("../../../tests/e2e/agents-run/review-gate-fixture.ts");
  const runId = await h.seedMarkedReviewGateRun({ orgId, userId, targets });
  const gate = await h.waitForMarkedReviewGate(runId);
  const pinned = gate.pinnedTargets.map(targetKey);
  if (pinned.length !== expected.size || new Set(pinned).size !== pinned.length || !pinned.every((k) => expected.has(k))) {
    throw new Error(`The gate of run ${runId} does not pin exactly the six filed revisions (it pins ${pinned.length})`);
  }
  return { runId, reviewTaskId: gate.reviewTaskId, status: gate.status, pinned: pinned.length };
}
