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
  /** Every gate row of the run, not one of them. */
  waitForMarkedReviewGates(runId: string): Promise<{ reviewTaskId: string; status: string; pinnedTargets: ReviewTarget[] }[]>;
}

const targetKey = (t: ReviewTarget) => `${t.artifactId}\u0000${t.representationRevisionId}`;
/** The WayFlow task a leg belongs to: its id up to the first `#` (as
 *  `baseReviewTaskId` in src/lib/artifacts/artifact-review-target.ts). */
const baseTaskId = (id: string) => (id.includes("#") ? id.slice(0, id.indexOf("#")) : id);

/**
 * Seed a run of the marked review gate fixture with the six filed revisions
 * and wait for its gates. Only run creation is seeded; WayFlow pauses the run
 * and the executor pins the targets as one family of six single-target gates,
 * one per artifact, under one review task ("task", "task#2" ... "task#6"). The
 * family must pin exactly the six filed revisions, none missing, none foreign
 * and none twice, or this fails. The executor mints no new gate with several
 * targets, so a single six-target gate fails here too.
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
  const gates = await h.waitForMarkedReviewGates(runId);
  const pinned = gates.flatMap((gate) => gate.pinnedTargets.map(targetKey));
  const base = gates.find((gate) => baseTaskId(gate.reviewTaskId) === gate.reviewTaskId);
  if (gates.length !== expected.size || !gates.every((gate) => gate.pinnedTargets.length === 1)) {
    throw new Error(`The gates of run ${runId} are not six single-target gates (${gates.length} gates, ${pinned.length} pins)`);
  }
  if (!base || !gates.every((gate) => baseTaskId(gate.reviewTaskId) === base.reviewTaskId) ||
    new Set(gates.map((gate) => gate.reviewTaskId)).size !== gates.length) {
    throw new Error(`The gates of run ${runId} are not one review family`);
  }
  if (new Set(pinned).size !== pinned.length || !pinned.every((k) => expected.has(k))) {
    throw new Error(`The gates of run ${runId} do not pin exactly the six filed revisions (they pin ${pinned.length})`);
  }
  return { runId, reviewTaskId: base.reviewTaskId, status: base.status, pinned: pinned.length };
}

const MEDIA_KINDS = new Set<string>(["image", "video", "audio", "pdf", "document", "archive"]);

/** `--promote <kind>=<extension>`: one filed kind and the extension whose
 *  meaning the person would confirm for it in the type picker. */
export function parsePromoteOption(value: string): { kind: MediaKindSample["kind"]; extension: string } {
  const parts = value.split("=");
  const kind = parts[0]?.trim() ?? "", extension = parts[1]?.trim() ?? "";
  if (parts.length !== 2 || !MEDIA_KINDS.has(kind) || !extension) {
    throw new Error(`--promote takes <kind>=<extension> with one of the six kinds (got ${JSON.stringify(value)})`);
  }
  return { kind: kind as MediaKindSample["kind"], extension };
}

/** The type picker's confirmation, as the fixture runs it (injectable for tests). */
export interface PickerConfirmation {
  /** Run `fn` in the user's own session in the organization. */
  runAs<T>(ids: { orgId: string; userId: string }, fn: () => Promise<T>): Promise<T>;
  /** The picker's server action (`assertUploadMeaning`). */
  confirm(input: { artifactId: string; extension: string }): Promise<
    | { ok: true; promotion?: { promoted: true; toType: string; representationRevisionId: string; revision: number | null } | { promoted: false; reason: string } }
    | { ok: false; reason: string; message: string }
  >;
}

/**
 * Promote one filed upload into an extension's own type, as the person does in
 * the library's type picker (specs/app-artifacts.html §VI.1): the fixture calls
 * the picker's own server action, `assertUploadMeaning`, in the user's session.
 * That action validates the choice against the installed candidates, writes the
 * person's meaning and runs the typed promotion road, which retypes the same
 * artifact and appends a revision that shares the stored bytes. Nothing here
 * writes a row itself. It fails unless the action reports a promotion that
 * landed: a refused choice or a confirmation that retyped nothing is an error.
 */
export async function promoteFiledUpload(
  input: { orgId: string; userId: string; filed: FiledMediaKind[]; kind: MediaKindSample["kind"]; extension: string },
  picker?: PickerConfirmation,
) {
  assertMediaFixtureRuntime();
  const ids = normalizeFixtureIds(input);
  const upload = input.filed.find((f) => f.kind === input.kind);
  if (!upload) throw new Error(`There is no filed ${input.kind} upload to promote`);
  const p = picker ?? await defaultPickerConfirmation();
  const target = { artifactId: upload.artifactId, extension: input.extension };
  const answer = await p.runAs(ids, () => p.confirm(target));
  if (!answer.ok) {
    throw new Error(`The type picker refused ${input.extension} for ${upload.artifactId}: ${answer.reason}: ${answer.message}`);
  }
  if (!answer.promotion) throw new Error(`The type picker's confirmation of ${input.extension} retyped nothing`);
  if (!answer.promotion.promoted) {
    throw new Error(`${upload.artifactId} was not promoted: ${answer.promotion.reason}`);
  }
  const { toType, representationRevisionId, revision } = answer.promotion;
  return { kind: input.kind, artifactId: upload.artifactId, extension: input.extension, toType, representationRevisionId, revision };
}

async function defaultPickerConfirmation(): Promise<PickerConfirmation> {
  // The fixture's loader (picker-action-session.mjs) gives the action the
  // session module below; any other loader leaves the action without a session.
  const [{ runAsPickerUser }, { assertUploadMeaning }] = await Promise.all([
    import("./picker-session"),
    import("@/app/artifacts/upload-typing-actions"),
  ]);
  return { runAs: runAsPickerUser, confirm: assertUploadMeaning };
}
