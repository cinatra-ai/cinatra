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
 *   D7 the decision-state query is scoped to the organization, the artifact and
 *      the revision
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getObjectByIdMock, runQueriesMock, readTextMock } = vi.hoisted(() => ({
  getObjectByIdMock: vi.fn(),
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

// red-first-expect: Cannot find module '/src/lib/artifacts/current-decided-revision-read'
import { readCurrentDecidedRevision } from "../current-decided-revision-read";

const BODY_TYPE = "@cinatra-ai/email:body";
const ref = { orgId: "org-1", artifactId: "art-1", representationRevisionId: "rev-2", objectTypeId: BODY_TYPE };

beforeEach(() => {
  vi.clearAllMocks();
  getObjectByIdMock.mockReturnValue({
    id: "art-1",
    type: BODY_TYPE,
    orgId: "org-1",
    data: { latestRepresentationRevisionId: "rev-2", subject: "Hello", contactId: "c1" },
  });
  runQueriesMock.mockResolvedValue([
    { rows: [{ decided_against: false, open_gate: false, repaired: false }] },
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
    expect(getObjectByIdMock).toHaveBeenCalledWith("art-1", { orgId: "org-1" });
    expect(readTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", artifactId: "art-1", representationRevisionId: "rev-2" }),
    );
  });

  it("D2 refuses an artifact that is not a live row of the organization", async () => {
    getObjectByIdMock.mockReturnValue(null);
    const read = await readCurrentDecidedRevision(ref);
    expect(read).toEqual({ ok: false, error: "artifact art-1 is not a live artifact of organization org-1" });
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
    getObjectByIdMock.mockReturnValue({
      id: "art-1",
      type: BODY_TYPE,
      orgId: "org-1",
      data: { latestRepresentationRevisionId: "rev-3" },
    });
    const read = await readCurrentDecidedRevision(ref);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("is not its current revision (the current one is rev-3)");
    expect(runQueriesMock).not.toHaveBeenCalled();
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it("D5 refuses a revision decided against, one an open gate pins, and one a repair names", async () => {
    for (const [flag, words] of [
      ["decided_against", "was decided against"],
      ["open_gate", "still waits on an open decision"],
      ["repaired", "has a repair filed against it"],
    ] as const) {
      runQueriesMock.mockResolvedValueOnce([
        { rows: [{ decided_against: false, open_gate: false, repaired: false, [flag]: true }] },
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
    expect(queries[0]!.values).toEqual(["org-1", "art-1", "rev-2"]);
    const sql = queries[0]!.text;
    expect(sql).toContain(`"public"."artifact_review_audit"`);
    expect(sql).toContain("a.disposition IN ('reject', 'changes_requested')");
    expect(sql).toContain("g.status = 'pending'");
    expect(sql).toContain("g.pinned_targets @> jsonb_build_array(");
    expect(sql).toContain(`"public"."lifecycle_repair"`);
    expect(sql).toContain("r.base_representation_revision_id = $3");
  });
});
