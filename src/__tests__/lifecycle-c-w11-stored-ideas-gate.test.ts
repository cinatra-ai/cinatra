/**
 * THE PIPELINE'S STORED-IDEAS GATE (cinatra#3035, epic #3023 W11; plan (C) §5.1
 * "The pipeline's stored-ideas gate", §6.1 step 2).
 *
 * "A preparation step lists every blog-idea artifact of the organisation through
 * the dependency-scoped read road, reads each candidate's text — the first line
 * is its title — subtracts the ideas its relation table links to a draft or holds
 * reserved, and emits the rest as the message the existing gate renderer already
 * reads; the person picks exactly one; the pick is recorded by artifact id and
 * revision, validated against the offered list, and fails closed when the list is
 * missing — the renderer's silent first-idea default goes. The pick writes a
 * reservation row under a uniqueness rule that allows one live reservation or
 * relation per idea, so two runs that offer the same idea cannot both take it:
 * the second pick is refused at the gate. An empty list ends the run with a
 * stated reason instead of a pick."
 *
 *   pnpm exec vitest run src/__tests__/lifecycle-c-w11-stored-ideas-gate.test.ts
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  IDEA_RELATION_TABLE,
  offerStoredIdeas,
  parseOfferedIdeas,
  resolveIdeaPick,
  titleFromIdeaText,
} from "@/lib/blog/stored-ideas-gate";
import {
  completeIdeaRelation,
  prepareStoredIdeas,
  releaseIdeaReservation,
  reserveStoredIdea,
  type StoredIdeasPorts,
} from "@/lib/blog/stored-ideas-gate-runner";

const IDEA_A = {
  artifactId: "idea-a",
  representationRevisionId: "rev-a",
  text: "Title: Shipping on Fridays\n\nWhy a Friday deploy is a habit, not a risk.",
};
const IDEA_B = {
  artifactId: "idea-b",
  representationRevisionId: "rev-b",
  text: "Reading a run's own page\n\nWhat a run should show when it is done.",
};

function ports(overrides: Partial<StoredIdeasPorts> = {}): StoredIdeasPorts {
  const rows: Array<Record<string, unknown>> = [];
  return {
    async listIdeaArtifacts() {
      return [
        { artifactId: IDEA_A.artifactId, representationRevisionId: IDEA_A.representationRevisionId },
        { artifactId: IDEA_B.artifactId, representationRevisionId: IDEA_B.representationRevisionId },
      ];
    },
    async readIdeaText(artifactId) {
      return artifactId === IDEA_A.artifactId ? IDEA_A.text : IDEA_B.text;
    },
    async listRelationRows() {
      return rows;
    },
    async insertRelationRow(row) {
      const live = rows.find(
        (r) => r.idea_artifact_id === row.idea_artifact_id && r.state !== "released",
      );
      if (live) return { ok: false as const, conflict: true as const };
      rows.push({ ...row });
      return { ok: true as const };
    },
    async updateRelationRow(keys, patch) {
      const row = rows.find(
        (r) => r.run_id === keys.run_id && r.idea_artifact_id === keys.idea_artifact_id,
      );
      if (!row) return { ok: false as const, conflict: false as const };
      Object.assign(row, patch);
      return { ok: true as const };
    },
    ...overrides,
  };
}

describe("W11 — the idea's title is the first line of its text", () => {
  it("reads a bare first line as the title", () => {
    expect(titleFromIdeaText(IDEA_B.text)).toBe("Reading a run's own page");
  });
  it("strips the Title: prefix the idea generator writes", () => {
    expect(titleFromIdeaText(IDEA_A.text)).toBe("Shipping on Fridays");
  });
  it("has no title for text with no first line", () => {
    expect(titleFromIdeaText("   \n\nbody")).toBe("");
  });
});

describe("W11 — the offered list", () => {
  it("offers every idea no draft has used and none holds reserved", () => {
    const offer = offerStoredIdeas({
      candidates: [IDEA_A, IDEA_B],
      takenArtifactIds: [],
    });
    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    expect(offer.ideas.map((i) => i.artifactId)).toEqual(["idea-a", "idea-b"]);
    expect(offer.ideas[0].title).toBe("Shipping on Fridays");
    expect(offer.ideas[0].representationRevisionId).toBe("rev-a");
  });

  it("subtracts an idea a draft has used or a run holds reserved", () => {
    const offer = offerStoredIdeas({
      candidates: [IDEA_A, IDEA_B],
      takenArtifactIds: ["idea-a"],
    });
    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    expect(offer.ideas.map((i) => i.artifactId)).toEqual(["idea-b"]);
  });

  it("ends the run with a stated reason when nothing is left to offer", () => {
    const offer = offerStoredIdeas({
      candidates: [IDEA_A],
      takenArtifactIds: ["idea-a"],
    });
    expect(offer.ok).toBe(false);
    if (offer.ok) return;
    expect(offer.reason).toMatch(/no blog idea/i);
    expect(offer.reason).toMatch(/draft/i);
  });
});

describe("W11 — the pick", () => {
  const offered = [
    { artifactId: "idea-a", representationRevisionId: "rev-a", title: "A", text: "A" },
    { artifactId: "idea-b", representationRevisionId: "rev-b", title: "B", text: "B" },
  ];

  it("records the pick by artifact id and revision", () => {
    const picked = resolveIdeaPick({
      pick: JSON.stringify({ artifactId: "idea-b", representationRevisionId: "rev-b" }),
      offered,
    });
    expect(picked).toEqual({
      ok: true,
      idea: offered[1],
    });
  });

  it("never picks the first idea for a person who picked nothing", () => {
    for (const nothing of ["", "   ", "{}", "null", undefined]) {
      const picked = resolveIdeaPick({ pick: nothing, offered });
      expect(picked.ok).toBe(false);
    }
  });

  it("refuses a pick that is not on the offered list", () => {
    const picked = resolveIdeaPick({
      pick: JSON.stringify({ artifactId: "idea-z", representationRevisionId: "rev-z" }),
      offered,
    });
    expect(picked.ok).toBe(false);
    if (picked.ok) return;
    expect(picked.reason).toMatch(/offered/i);
  });

  it("refuses a pick on a revision the list did not offer", () => {
    const picked = resolveIdeaPick({
      pick: JSON.stringify({ artifactId: "idea-a", representationRevisionId: "rev-old" }),
      offered,
    });
    expect(picked.ok).toBe(false);
  });

  it("fails closed when there is no offered list to validate against", () => {
    const picked = resolveIdeaPick({
      pick: JSON.stringify({ artifactId: "idea-a", representationRevisionId: "rev-a" }),
      offered: [],
    });
    expect(picked.ok).toBe(false);
  });
});

describe("W11 — the offered list as the flow actually sends it", () => {
  // The pipeline flow reserves through an ApiNode whose `offered` field is the
  // template `{{ ideas | tojson }}` and whose `pick` field is one InputMessageNode
  // string: BOTH arrive as JSON TEXT, never as an array and an object. The pick
  // side was already read back that way; the offered side was not, so every real
  // reservation refused itself with "no offered list to validate a pick against"
  // and no idea could ever be taken. (blog-pipeline-agent#52.)
  const ideas = [
    { artifactId: "idea-a", representationRevisionId: "rev-a", title: "A", text: "A" },
    { artifactId: "idea-b", representationRevisionId: "rev-b", title: "B", text: "B" },
  ];

  it("reads back an offered list the flow encoded as JSON text", () => {
    expect(parseOfferedIdeas(JSON.stringify(ideas))).toEqual(ideas);
  });

  it("passes an offered list that is already an array straight through", () => {
    expect(parseOfferedIdeas(ideas)).toEqual(ideas);
  });

  it("offers nothing at all when the field is missing or unreadable", () => {
    for (const nothing of [undefined, null, "", "   ", "not json", "{}", 42]) {
      expect(parseOfferedIdeas(nothing)).toEqual([]);
    }
  });

  it("drops an element that is not a usable idea reference", () => {
    const mixed = JSON.stringify([ideas[0], { artifactId: "idea-x" }, null, "idea-y"]);
    expect(parseOfferedIdeas(mixed)).toEqual([ideas[0]]);
  });

  it("resolves the run's pick against the encoded list the same call carried", () => {
    const picked = resolveIdeaPick({
      pick: JSON.stringify({ artifactId: "idea-b", representationRevisionId: "rev-b" }),
      offered: parseOfferedIdeas(JSON.stringify(ideas)),
    });
    expect(picked).toEqual({ ok: true, idea: ideas[1] });
  });
});

describe("W11 — the reservation row and its uniqueness rule", () => {
  it("prepares the offer from the dependency-scoped listing and one content read per idea", async () => {
    const reads: string[] = [];
    const p = ports({
      async readIdeaText(artifactId) {
        reads.push(artifactId);
        return artifactId === IDEA_A.artifactId ? IDEA_A.text : IDEA_B.text;
      },
    });
    const out = await prepareStoredIdeas({ ports: p, orgId: "org-1", runId: "run-1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ideas).toHaveLength(2);
    expect(reads).toEqual(["idea-a", "idea-b"]);
  });

  it("writes one reservation row on the pick", async () => {
    const p = ports();
    const taken = await reserveStoredIdea({
      ports: p,
      orgId: "org-1",
      runId: "run-1",
      idea: { artifactId: "idea-a", representationRevisionId: "rev-a", title: "A", text: "A" },
    });
    expect(taken.ok).toBe(true);
    const rows = await p.listRelationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idea_artifact_id: "idea-a",
      idea_revision_id: "rev-a",
      run_id: "run-1",
      org_id: "org-1",
      state: "reserved",
    });
  });

  it("refuses the losing pick when two runs take the same idea at once", async () => {
    const p = ports();
    const idea = {
      artifactId: "idea-a",
      representationRevisionId: "rev-a",
      title: "A",
      text: "A",
    };
    const first = await reserveStoredIdea({ ports: p, orgId: "org-1", runId: "run-1", idea });
    const second = await reserveStoredIdea({ ports: p, orgId: "org-1", runId: "run-2", idea });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/just taken/i);
  });

  it("hides an idea another run reserved from the next run's list", async () => {
    const p = ports();
    await reserveStoredIdea({
      ports: p,
      orgId: "org-1",
      runId: "run-1",
      idea: { artifactId: "idea-a", representationRevisionId: "rev-a", title: "A", text: "A" },
    });
    const out = await prepareStoredIdeas({ ports: p, orgId: "org-1", runId: "run-2" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ideas.map((i) => i.artifactId)).toEqual(["idea-b"]);
  });

  it("completes the reservation into the relation row, and a retry completes the same row", async () => {
    const p = ports();
    const idea = {
      artifactId: "idea-a",
      representationRevisionId: "rev-a",
      title: "A",
      text: "A",
    };
    await reserveStoredIdea({ ports: p, orgId: "org-1", runId: "run-1", idea });
    await completeIdeaRelation({
      ports: p,
      orgId: "org-1",
      runId: "run-1",
      ideaArtifactId: "idea-a",
      draftArtifactId: "draft-1",
    });
    await completeIdeaRelation({
      ports: p,
      orgId: "org-1",
      runId: "run-1",
      ideaArtifactId: "idea-a",
      draftArtifactId: "draft-1",
    });
    const rows = await p.listRelationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "drafted", draft_artifact_id: "draft-1" });
  });

  it("names the table under the pipeline extension's own prefix", () => {
    expect(IDEA_RELATION_TABLE).toBe("ext_cinatra_ai_blog_pipeline_agent_idea_drafts");
  });

  it("ends a run with a stated reason when the organisation has no stored idea at all", async () => {
    const out = await prepareStoredIdeas({
      ports: ports({ async listIdeaArtifacts() { return []; } }),
      orgId: "org-1",
      runId: "run-1",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/no blog idea/i);
  });
});

describe("W11 — releasing a reservation leaves a completed relation alone", () => {
  // "A row already completed into a relation is NOT released - the update names
  // the reserved state, so a drafted row is left alone." The release keys carry
  // that state, so a lapse or a failure sweeping a run's reservation cannot undo
  // the relation a finished draft already wrote and hand its idea back to the
  // list while the draft still stands. (blog-pipeline-agent#52.)
  function keyRecordingPorts() {
    const seen: Array<Record<string, unknown>> = [];
    const ports = {
      listIdeaArtifacts: async () => [],
      readIdeaText: async () => null,
      listRelationRows: async () => [],
      insertRelationRow: async () => ({ ok: true }) as const,
      updateRelationRow: async (keys: Record<string, unknown>) => {
        seen.push(keys);
        return { ok: true } as const;
      },
    } as unknown as StoredIdeasPorts;
    return { ports, seen };
  }

  it("names the reserved state in the keys it releases on", async () => {
    const { ports, seen } = keyRecordingPorts();
    await releaseIdeaReservation({ ports, runId: "run-1", ideaArtifactId: "idea-a" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      run_id: "run-1",
      idea_artifact_id: "idea-a",
      state: "reserved",
    });
  });

  it("still keys a completion by run and idea alone, so a retry completes it", async () => {
    const { ports, seen } = keyRecordingPorts();
    await completeIdeaRelation({
      ports,
      orgId: "org-1",
      runId: "run-1",
      ideaArtifactId: "idea-a",
      draftArtifactId: "draft-a",
    });
    expect(seen[0]).toEqual({ run_id: "run-1", idea_artifact_id: "idea-a" });
  });
});

describe("W11 — the reserve call site reads the offer through the gate's parser", () => {
  // The parser above is only half the fix: the OTHER half is that the passthrough's
  // reserve branch actually calls it. Before this change that branch tested
  // `Array.isArray(raw.offered)`, and the flow sends `"offered": "{{ ideas | tojson }}"`
  // — JSON TEXT — so the offer collapsed to an empty list and every real pick was
  // refused. The unit tests above cannot see that, because they call the parser
  // directly; this reads the call site itself, the way the ledger chokepoint test
  // reads its seam, so reverting the branch reds here instead of only in a live run.
  const RESERVE_SITE = readFileSync(
    path.resolve(__dirname, "../lib/extension-scoped-tools.ts"),
    "utf8",
  );

  it("passes the offered field through parseOfferedIdeas", () => {
    expect(RESERVE_SITE).toContain("parseOfferedIdeas(raw.offered)");
  });

  it("imports the parser from the gate it shares with resolveIdeaPick", () => {
    expect(RESERVE_SITE).toMatch(
      /parseOfferedIdeas[\s\S]{0,80}resolveIdeaPick[\s\S]{0,120}stored-ideas-gate/,
    );
  });

  it("no longer decides the offer with an array test the encoded list fails", () => {
    expect(RESERVE_SITE).not.toContain("Array.isArray(raw.offered)");
  });
});
