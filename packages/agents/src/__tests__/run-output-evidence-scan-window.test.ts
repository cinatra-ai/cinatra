/**
 * readRunOutputEvidence — the candidate scan window (cinatra#2482).
 *
 * CODEX ROUND-A BLOCKING FINDING, locked here.
 *
 * The provenance read (`objects.run_id`) is ordered `created_at DESC` and knows
 * nothing about artifact types or read authority. The first cut passed the
 * card's display cap (10) straight into that read, so ten newer non-artifact or
 * read-denied rows could push a genuine artifact out of the result entirely —
 * and the card would then tell the user "this run produced no output" about a
 * run that produced some. That false claim is the exact failure this whole fix
 * exists to remove, so it is worth a dedicated regression.
 *
 * What this locks:
 *
 *   1. the SCAN window is wider than the display cap, so classification happens
 *      over a real candidate set, not a pre-truncated one;
 *   2. an artifact buried behind ten non-artifact siblings is still found;
 *   3. the DISPLAY cap still holds at 10 — the widened scan is not a licence to
 *      render an unbounded list;
 *   4. the classification loop stops once the cap is met (one
 *      `readArtifactForDetail` per candidate is the per-row cost).
 *
 * The run read + session are mocked; the module's own selection logic runs for
 * real, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-output-evidence-scan-window.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2482-scan";
const ORG_ID = "org-2482";
const USER_ID = "user-2482";

const authSession = vi.hoisted(() => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: USER_ID },
    session: { activeOrganizationId: ORG_ID },
  })),
  requireActorContext: vi.fn(async () => ({ principalId: USER_ID })),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForSession: vi.fn(async () => "owner"),
}));
type ProducedRow = { id: string; type: string; data: unknown };
type ObjectsFilter = {
  orgId?: string | null;
  runId?: string;
  limit?: number;
};

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunMessages: vi.fn(async (): Promise<{ id: string }[]> => []),
}));
const objectsStore = vi.hoisted(() => ({
  listObjectsByFilter: vi.fn(
    (filter: { orgId?: string | null; runId?: string; limit?: number }): {
      id: string;
      type: string;
      data: unknown;
    }[] => {
      void filter;
      return [];
    },
  ),
}));
const artifactService = vi.hoisted(() => ({ readArtifactForDetail: vi.fn() }));

vi.mock("@/lib/auth-session", () => authSession);
vi.mock("@/lib/authz", () => ({ AuthzError: class AuthzError extends Error {} }));
vi.mock("../store", () => store);
vi.mock("@/lib/objects-store", () => objectsStore);
vi.mock("@/lib/artifacts/artifact-service", () => artifactService);

import { readRunOutputEvidence } from "../run-actions";

/** `count` non-artifact rows, then the artifacts — the buried-output case. */
function producedRows(nonArtifactCount: number, artifactIds: string[]): ProducedRow[] {
  return [
    ...Array.from({ length: nonArtifactCount }, (_, i) => ({
      id: `noise-${i}`,
      type: "email_draft",
      data: {},
    })),
    ...artifactIds.map((id) => ({
      id,
      type: "@cinatra-ai/blog-post-artifact:post",
      data: { title: `Artifact ${id}` },
    })),
  ];
}

/**
 * Install the produced-object set behind a stub that HONOURS `filter.limit`.
 *
 * Load-bearing: a stub that ignores the limit would return the buried artifact
 * no matter how narrow the scan was, and the truncation bug would sail through
 * green. Respecting it is what makes these assertions mean anything.
 */
function stubProduced(rows: ProducedRow[]) {
  objectsStore.listObjectsByFilter.mockImplementation((filter: ObjectsFilter) =>
    typeof filter.limit === "number" ? rows.slice(0, filter.limit) : rows,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    runBy: USER_ID,
    orgId: ORG_ID,
    status: "completed",
    stepResults: null,
    streamedText: null,
  });
  store.readAgentRunMessages.mockResolvedValue([]);
  artifactService.readArtifactForDetail.mockImplementation(
    ({ artifactId }: { artifactId: string }) =>
      artifactId.startsWith("noise-")
        ? { kind: "not-found" }
        : { kind: "ok", artifact: { title: `Artifact ${artifactId}`, artifactType: "file" } },
  );
});

describe("readRunOutputEvidence — candidate scan window (cinatra#2482)", () => {
  it("scans a WIDER window than the 10 it will display", async () => {
    stubProduced([]);
    await readRunOutputEvidence({ runId: RUN_ID });

    const filter = objectsStore.listObjectsByFilter.mock.calls[0]![0] as ObjectsFilter;
    expect(filter.runId).toBe(RUN_ID);
    expect(filter.orgId).toBe(ORG_ID);
    expect(filter.limit).toBeGreaterThan(10);
  });

  it("still finds an artifact buried behind ten non-artifact siblings", async () => {
    stubProduced(producedRows(10, ["obj-buried"]));

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.outputs.map((o) => o.id)).toEqual(["obj-buried"]);
  });

  it("keeps the DISPLAY cap at 10 even when the run produced more", async () => {
    stubProduced(producedRows(0, Array.from({ length: 25 }, (_, i) => `obj-${i}`)));

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok === true && result.outputs).toHaveLength(10);
  });

  it("stops classifying once the cap is met", async () => {
    stubProduced(producedRows(0, Array.from({ length: 40 }, (_, i) => `obj-${i}`)));

    await readRunOutputEvidence({ runId: RUN_ID });

    expect(artifactService.readArtifactForDetail).toHaveBeenCalledTimes(10);
  });

  // CONFIRMATION-ROUND FINDING. Twelve provenance rows exist; the artifact gate
  // rejects all twelve. `outputs: []` here does NOT mean the run produced
  // nothing — it means nothing it produced can be opened from this card. Left
  // unflagged, the resolver read the empty list as a genuinely empty run and
  // the card asserted "nothing was returned and nothing was saved" about a run
  // that saved twelve rows.
  it("flags rows that existed but could not be linked, rather than reporting absence", async () => {
    stubProduced(producedRows(12, []));

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok === true && result.outputs).toEqual([]);
    expect(result.ok === true && result.hasTranscript).toBe(false);
    expect(result.ok === true && result.hasStepResults).toBe(false);
    expect(result.ok === true && result.unlinkableOutputs).toBe(true);
    // The read itself SUCCEEDED — this is not an infrastructure failure.
    expect(result.ok === true && result.outputsUnavailable).toBe(false);
  });

  it("reports a genuinely empty run as empty — no rows, no unlinkable flag", async () => {
    stubProduced([]);

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok === true && result.outputs).toEqual([]);
    expect(result.ok === true && result.unlinkableOutputs).toBe(false);
    expect(result.ok === true && result.outputsUnavailable).toBe(false);
  });

  it("does not flag unlinkable when at least one row DID link", async () => {
    stubProduced(producedRows(10, ["obj-buried"]));

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok === true && result.outputs.map((o) => o.id)).toEqual(["obj-buried"]);
    expect(result.ok === true && result.unlinkableOutputs).toBe(false);
  });

  it("never links a row the artifact route would refuse", async () => {
    stubProduced(producedRows(0, ["obj-denied", "obj-ok"]));
    artifactService.readArtifactForDetail.mockImplementation(
      ({ artifactId }: { artifactId: string }) =>
        artifactId === "obj-denied"
          ? { kind: "denied" }
          : { kind: "ok", artifact: { title: "Readable", artifactType: "file" } },
    );

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok === true && result.outputs.map((o) => o.id)).toEqual(["obj-ok"]);
  });

  it("fails soft to transcript evidence when the object read throws", async () => {
    objectsStore.listObjectsByFilter.mockImplementation(() => {
      throw new Error("objects store down");
    });
    store.readAgentRunMessages.mockResolvedValue([{ id: "m1" }]);

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.outputs).toEqual([]);
    expect(result.ok === true && result.hasTranscript).toBe(true);
  });

  // Codex round-2 finding: a broken read must report "could not look", never
  // an empty list that the card would render as "produced no output".
  it("marks the outputs UNAVAILABLE when the read throws, rather than absent", async () => {
    objectsStore.listObjectsByFilter.mockImplementation(() => {
      throw new Error("objects store down");
    });

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    expect(result.ok === true && result.outputsUnavailable).toBe(true);
  });

  it("leaves the UNAVAILABLE flag false on a read that succeeded but linked nothing", async () => {
    stubProduced(producedRows(3, []));

    const result = await readRunOutputEvidence({ runId: RUN_ID });

    // The read worked, so it is not "unavailable" — but the three rows it found
    // were unlinkable, which is the separate, weaker claim.
    expect(result.ok === true && result.outputsUnavailable).toBe(false);
    expect(result.ok === true && result.unlinkableOutputs).toBe(true);
  });
});
