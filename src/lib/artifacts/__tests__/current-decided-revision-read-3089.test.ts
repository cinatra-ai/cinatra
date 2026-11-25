/**
 * cinatra#3089 — the read of a revision a person decided on, only while it is
 * the artifact's current, undisputed revision (`readCurrentDecidedRevision`).
 *
 * The objects row, the decision-state query and the one representation-text
 * reader are mocked; the unit under test is never stubbed.
 *
 * Cases:
 *   D1 the current revision of the declared type in the organization is read
 *      whole, with the artifact's own fields
 *   D2 an artifact that is not a live row of the organization is refused
 *   D3 an artifact of another type is refused
 *   D4 a revision that is not the artifact's current revision is refused, and
 *      nothing is read
 *   D5 a revision a gate decided against, one an open gate still pins, and one
 *      a repair names as its base are refused
 *   D6 a text cut at the read cap is refused
 *   D7 the decision-state query is scoped to the organization, the artifact,
 *      the revision and the run
 *   D8 an actor that may not read the artifact gets exactly the refusal of an
 *      artifact that does not exist, and nothing else is read
 *   D9 an artifact the run never filed is refused
 *   D10 object data whose revision pointer was moved back to an older revision
 *       does not make that revision current: the newest representation row
 *       decides
 *   D11 a pointer in object data that disagrees with the newest representation
 *       row is a refusal
 *   D12 a revision no person approved is refused
 *   D13 a body changed after its approval (a subject altered through an object
 *       update) is refused, whatever the altered data says
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getObjectByIdMock, getArtifactMock, runQueriesMock, readTextMock } = vi.hoisted(() => ({
  getObjectByIdMock: vi.fn(),
  getArtifactMock: vi.fn(),
  runQueriesMock: vi.fn(),
  readTextMock: vi.fn(),
}));

vi.mock("@/lib/objects-store", () => ({ getObjectById: getObjectByIdMock }));
vi.mock("@/lib/postgres-async", () => ({ runPostgresQueriesAsync: runQueriesMock }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("../extension-artifact-reads", () => ({ readArtifactRepresentationText: readTextMock }));
vi.mock("../artifact-service", () => ({ getArtifact: getArtifactMock }));

// red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
import { readCurrentDecidedRevision } from "../current-decided-revision-read";

const BODY_TYPE = "@cinatra-ai/email:body";
const actor = { principalId: "user-1", principalType: "user", organizationId: "org-1" } as never;
const ref = {
  orgId: "org-1",
  actor,
  runId: "run-1",
  artifactId: "art-1",
  representationRevisionId: "rev-2",
  objectTypeId: BODY_TYPE,
};
const UNSEEN = "artifact art-1 is not an artifact this organisation can see";
/** The decision state of an approved, current, undisputed revision. */
const CLEAR = {
  latest_revision_id: "rev-2",
  approved: true,
  changed_after_approval: false,
  decided_against: false,
  open_gate: false,
  repaired: false,
  filed_in_run: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  runQueriesMock.mockReset();
  getArtifactMock.mockReturnValue({ artifactId: "art-1", objectType: BODY_TYPE });
  getObjectByIdMock.mockReturnValue({
    id: "art-1",
    type: BODY_TYPE,
    orgId: "org-1",
    data: { latestRepresentationRevisionId: "rev-2", subject: "Hello", contactId: "c1" },
  });
  runQueriesMock.mockResolvedValue([
    { rows: [{ ...CLEAR }] },
  ]);
  readTextMock.mockResolvedValue({
    artifactId: "art-1",
    representationRevisionId: "rev-2",
    mime: "text/markdown",
    text: "The approved body",
    truncated: false,
    bytesRead: 17,
    totalBytes: 17,
  });
});

describe("cinatra#3089 — readCurrentDecidedRevision", () => {
  it("D1 reads the current revision of the declared type in the organization whole", async () => {
    const read = await readCurrentDecidedRevision(ref);
    expect(read).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rev-2",
      text: "The approved body",
      data: { latestRepresentationRevisionId: "rev-2", subject: "Hello", contactId: "c1" },
    });
    expect(getArtifactMock).toHaveBeenCalledWith({ artifactId: "art-1", orgId: "org-1", actor });
    expect(getObjectByIdMock).toHaveBeenCalledWith("art-1", { orgId: "org-1" }, actor);
    expect(readTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", actor, artifactId: "art-1", representationRevisionId: "rev-2" }),
    );
  });

  it("D2 refuses an artifact that is not a live row of the organization", async () => {
    getArtifactMock.mockReturnValue(null);
    getObjectByIdMock.mockReturnValue(null);
    const read = await readCurrentDecidedRevision(ref);
    expect(read).toEqual({ ok: false, error: UNSEEN });
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D3 refuses an artifact of another type", async () => {
    getObjectByIdMock.mockReturnValue({
      id: "art-1",
      type: "@cinatra-ai/blog:post",
      orgId: "org-1",
      data: { latestRepresentationRevisionId: "rev-2" },
    });
    const read = await readCurrentDecidedRevision(ref);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain('is of type "@cinatra-ai/blog:post"');
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D4 refuses a revision that is not the artifact's current revision and reads nothing", async () => {
    runQueriesMock.mockResolvedValueOnce([{ rows: [{ ...CLEAR, latest_revision_id: "rev-3" }] }]);
    getObjectByIdMock.mockReturnValue({
      id: "art-1",
      type: BODY_TYPE,
      orgId: "org-1",
      data: { latestRepresentationRevisionId: "rev-3" },
    });
    const read = await readCurrentDecidedRevision(ref);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("is not its current revision (the current one is rev-3)");
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D5 refuses a revision decided against, one an open gate pins, and one a repair names", async () => {
    for (const [flag, words] of [
      ["decided_against", "was decided against"],
      ["open_gate", "still waits on an open decision"],
      ["repaired", "has a repair filed against it"],
    ] as const) {
      runQueriesMock.mockResolvedValueOnce([
        { rows: [{ ...CLEAR, [flag]: true }] },
      ]);
      const read = await readCurrentDecidedRevision(ref);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.error).toContain(words);
    }
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D6 refuses a text cut at the read cap", async () => {
    readTextMock.mockResolvedValue({
      artifactId: "art-1",
      representationRevisionId: "rev-2",
      mime: "text/markdown",
      text: "cut",
      truncated: true,
      bytesRead: 3,
      totalBytes: 999999,
    });
    const read = await readCurrentDecidedRevision(ref);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("is too long to be read whole");
  });

  it("D7 scopes the decision-state query to the organization, the artifact and the revision", async () => {
    await readCurrentDecidedRevision(ref);
    const [{ queries }] = runQueriesMock.mock.calls[0] as [{ queries: Array<{ text: string; values: unknown[] }> }];
    expect(queries).toHaveLength(1);
    expect(queries[0]!.values).toEqual(["org-1", "art-1", "rev-2", "run-1"]);
    const sql = queries[0]!.text;
    expect(sql).toContain(`"public"."artifact_review_audit"`);
    expect(sql).toContain("a.disposition IN ('reject', 'changes_requested')");
    expect(sql).toContain("g.status = 'pending'");
    expect(sql).toContain("g.pinned_targets @> jsonb_build_array(");
    expect(sql).toContain(`"public"."lifecycle_repair"`);
    expect(sql).toContain("r.base_representation_revision_id = $3");
    expect(sql).toContain(`"public"."artifact_materializations" m`);
    expect(sql).toContain("m.org_id = $1 AND m.run_id = $4 AND m.artifact_id = $2");
    // The run's ledger row must name this exact revision: a row of the run at
    // another revision of the same artifact does not admit this one.
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(sql).toMatch(/m\.artifact_id = \$2\s+AND m\.representation_revision_id = \$3 AND m\.phase = 'finalized'/);
    // Current is the newest row of the append-only representation table.
    expect(sql).toMatch(
      /SELECT p\.id FROM "public"\."representation" p\s+WHERE p\.org_id = \$1 AND p\.artifact_id = \$2\s+ORDER BY p\.revision DESC LIMIT 1/,
    );
    // Approved is a person's approve audit row on a resolved approve gate pinning the revision.
    expect(sql).toMatch(/a\.disposition = 'approve'\s+AND g\.status = 'resolved' AND g\.disposition = 'approve'/);
    expect(sql).toContain("o.updated_at > approval.approved_at");
  });

  it("D8 an actor that may not read the artifact gets the refusal of an absent artifact, and nothing else is read", async () => {
    // The row exists in the organization (an organization-only lookup finds
    // it), but the actor-scoped read does not admit this actor.
    getArtifactMock.mockReturnValue(null);
    const read = await readCurrentDecidedRevision(ref);
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(read).toEqual({ ok: false, error: UNSEEN });
    expect(getArtifactMock).toHaveBeenCalledWith({ artifactId: "art-1", orgId: "org-1", actor });
    expect(runQueriesMock).not.toHaveBeenCalled();
    expect(readTextMock).not.toHaveBeenCalled();
    // The same answer when the row does not exist at all: nothing tells the two apart.
    getObjectByIdMock.mockReturnValue(null);
    expect(await readCurrentDecidedRevision(ref)).toEqual(read);
  });

  it("D9 refuses an artifact the run never filed", async () => {
    runQueriesMock.mockResolvedValueOnce([
      { rows: [{ ...CLEAR, filed_in_run: false }] },
    ]);
    const read = await readCurrentDecidedRevision(ref);
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(read).toEqual({ ok: false, error: "revision rev-2 of artifact art-1 was not filed in run run-1" });
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D10 a pointer moved back to an older revision in object data does not make that revision current", async () => {
    // An ordinary object update merged `latestRepresentationRevisionId: rev-1`
    // into the data; the representation table's newest row is still rev-2.
    getObjectByIdMock.mockReturnValue({
      id: "art-1",
      type: BODY_TYPE,
      orgId: "org-1",
      data: { latestRepresentationRevisionId: "rev-1", subject: "Hello", contactId: "c1" },
    });
    // The older revision's text is readable as such.
    readTextMock.mockResolvedValue({
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      mime: "text/markdown",
      text: "A superseded body",
      truncated: false,
      bytesRead: 17,
      totalBytes: 17,
    });
    const read = await readCurrentDecidedRevision({ ...ref, representationRevisionId: "rev-1" });
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(read).toEqual({
      ok: false,
      error:
        "revision rev-1 of artifact art-1 is not its current revision (the current one is rev-2); a revision filed after the decision supersedes it",
    });
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D11 a pointer in object data that disagrees with the newest representation row is a refusal", async () => {
    getObjectByIdMock.mockReturnValue({
      id: "art-1",
      type: BODY_TYPE,
      orgId: "org-1",
      data: { latestRepresentationRevisionId: "rev-9", subject: "Hello" },
    });
    const read = await readCurrentDecidedRevision(ref);
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(read).toEqual({
      ok: false,
      error: "revision rev-2 of artifact art-1 is the newest revision of the artifact, but the artifact names rev-9 as its current one",
    });
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D12 a revision no person approved is refused", async () => {
    runQueriesMock.mockResolvedValueOnce([{ rows: [{ ...CLEAR, approved: false }] }]);
    const read = await readCurrentDecidedRevision(ref);
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(read).toEqual({ ok: false, error: "revision rev-2 of artifact art-1 was not approved by a person" });
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D13 a body changed after its approval is refused, whatever the altered data says", async () => {
    // The subject was altered through an object update after the approval; the
    // data itself looks like any other (it even keeps the right pointer).
    getObjectByIdMock.mockReturnValue({
      id: "art-1",
      type: BODY_TYPE,
      orgId: "org-1",
      data: { latestRepresentationRevisionId: "rev-2", subject: "Altered subject", contactId: "c1" },
    });
    runQueriesMock.mockResolvedValueOnce([{ rows: [{ ...CLEAR, changed_after_approval: true }] }]);
    const read = await readCurrentDecidedRevision(ref);
    // red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
    expect(read).toEqual({ ok: false, error: "artifact art-1 was changed after revision rev-2 of artifact art-1 was approved" });
    expect(readTextMock).not.toHaveBeenCalled();
    // The same data with no change after the approval reads: the decision rests
    // on the rows, not on what the data says.
    const unchanged = await readCurrentDecidedRevision(ref);
    expect(unchanged.ok).toBe(true);
  });
});
