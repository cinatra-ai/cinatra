import { describe, it, expect } from "vitest";

import {
  LIFECYCLE_STATES,
  REVISION_SOURCES,
  LIFECYCLE_TRANSITIONS,
  INITIAL_LIFECYCLE_STATE,
  isLifecycleState,
  isRevisionSource,
  isLegalTransition,
  authorizeTransition,
  wouldCreateSupersedeCycle,
  buildRevisionRecord,
  buildUpsertRevisionWrite,
  newRevisionId,
  isCustomOrPersonalSkillPayload,
  computeSkillSourceRevision,
  type LifecycleState,
} from "./skill-source";

const ALL: LifecycleState[] = [...LIFECYCLE_STATES];

// The one true legal set — the test's independent copy of the graph. If the
// production graph changes, this must change with it (the assertions below
// cross-check both directions against it).
const LEGAL = new Set<string>([
  "draft->active",
  "draft->archived",
  "active->deprecated",
  "active->archived",
  "deprecated->active",
  "deprecated->archived",
]);

describe("lifecycle states + sources", () => {
  it("exposes exactly the four states and six sources", () => {
    expect([...LIFECYCLE_STATES]).toEqual(["draft", "active", "deprecated", "archived"]);
    expect([...REVISION_SOURCES]).toEqual(["manual", "autosave", "hitl", "chat-capture", "migration", "rollback"]);
    expect(INITIAL_LIFECYCLE_STATE).toBe("active");
  });

  it("guards states + sources", () => {
    expect(isLifecycleState("active")).toBe(true);
    expect(isLifecycleState("live")).toBe(false);
    expect(isLifecycleState(null)).toBe(false);
    expect(isRevisionSource("migration")).toBe(true);
    expect(isRevisionSource("rollback")).toBe(true);
    expect(isRevisionSource("import")).toBe(false);
  });
});

describe("buildRevisionRecord — rollback provenance biconditional (cinatra#1362)", () => {
  it("a rollback revision carries its restored-revision id", () => {
    const r = buildRevisionRecord({
      skillId: "s1",
      contentDigest: "sha-prior",
      source: "rollback",
      restoresRevisionId: "rev-prior",
    });
    expect(r.source).toBe("rollback");
    expect(r.restoresRevisionId).toBe("rev-prior");
    expect(r.contentDigest).toBe("sha-prior");
  });

  it("a NON-rollback revision has a null restoresRevisionId", () => {
    for (const source of ["manual", "autosave", "hitl", "chat-capture", "migration"] as const) {
      expect(buildRevisionRecord({ skillId: "s1", contentDigest: "d", source }).restoresRevisionId).toBeNull();
    }
  });

  it("FAILS CLOSED when rollback omits restoresRevisionId", () => {
    expect(() => buildRevisionRecord({ skillId: "s1", contentDigest: "d", source: "rollback" })).toThrow(/rollback provenance/);
  });

  it("FAILS CLOSED when a non-rollback source carries a restoresRevisionId", () => {
    expect(() =>
      buildRevisionRecord({ skillId: "s1", contentDigest: "d", source: "manual", restoresRevisionId: "rev-x" }),
    ).toThrow(/rollback provenance/);
  });
});

describe("buildUpsertRevisionWrite — content blob passthrough (cinatra#1362)", () => {
  const content = "# My skill\nDo the thing.";
  const digest = computeSkillSourceRevision(content);

  it("carries the content blob when content + digest are present", () => {
    const w = buildUpsertRevisionWrite(
      { id: "s1", content, source: { revision: { value: digest } } },
      true,
      "u1",
    );
    expect(w.content).toBe(content);
    expect(w.contentDigest).toBe(digest);
    expect(w.source).toBe("manual");
    expect(w.restoresRevisionId).toBeNull();
    expect(w.authorUserId).toBe("u1");
  });

  it("omits the blob when there is no digest (never a mismatched pair)", () => {
    const w = buildUpsertRevisionWrite({ id: "s1", content, source: null }, false);
    expect(w.contentDigest).toBeNull();
    expect(w.content).toBeNull();
  });
});

describe("isLegalTransition — every from/to pair, both directions", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const key = `${from}->${to}`;
      const expected = LEGAL.has(key);
      it(`${key} is ${expected ? "legal" : "rejected"}`, () => {
        expect(isLegalTransition(from, to)).toBe(expected);
      });
    }
  }

  it("rejects same-state no-ops", () => {
    for (const s of ALL) expect(isLegalTransition(s, s)).toBe(false);
  });

  it("archived is terminal", () => {
    expect(LIFECYCLE_TRANSITIONS.archived).toEqual([]);
    for (const to of ALL) expect(isLegalTransition("archived", to)).toBe(false);
  });

  it("nothing transitions INTO draft", () => {
    for (const from of ALL) expect(isLegalTransition(from, "draft")).toBe(false);
  });

  it("rejects unknown states", () => {
    expect(isLegalTransition("active", "gone" as LifecycleState)).toBe(false);
    expect(isLegalTransition("nope" as LifecycleState, "active")).toBe(false);
  });
});

describe("authorizeTransition — fail closed", () => {
  it("owner may perform any legal transition", () => {
    expect(authorizeTransition({ actorType: "user", isOwner: true, from: "active", to: "deprecated" }))
      .toEqual({ allowed: true });
    expect(authorizeTransition({ actorType: "user", isOwner: true, from: "draft", to: "active" }))
      .toEqual({ allowed: true });
  });

  it("denies a non-owner user even on a legal transition", () => {
    const d = authorizeTransition({ actorType: "user", isOwner: false, from: "active", to: "archived" });
    expect(d.allowed).toBe(false);
  });

  it("allows org/platform admins and system", () => {
    for (const actorType of ["org_admin", "platform_admin", "system"] as const) {
      expect(authorizeTransition({ actorType, isOwner: false, from: "active", to: "archived" }).allowed).toBe(true);
    }
  });

  it("denies an illegal transition even for an owner/admin", () => {
    expect(authorizeTransition({ actorType: "user", isOwner: true, from: "archived", to: "active" }).allowed).toBe(false);
    expect(authorizeTransition({ actorType: "platform_admin", isOwner: true, from: "active", to: "draft" }).allowed).toBe(false);
  });

  it("denies an unknown actor type", () => {
    expect(authorizeTransition({ actorType: "robot" as "system", isOwner: true, from: "active", to: "archived" }).allowed).toBe(false);
  });
});

describe("wouldCreateSupersedeCycle — fail closed", () => {
  const chain = (edges: Record<string, string | null>) => (id: string) => edges[id] ?? null;

  it("rejects a self-supersede", () => {
    expect(wouldCreateSupersedeCycle("a", "a", () => null)).toBe(true);
  });

  it("accepts an acyclic edge", () => {
    // a -> b, b has no successor: setting a.superseded_by=b is fine.
    expect(wouldCreateSupersedeCycle("a", "b", chain({ b: null }))).toBe(false);
  });

  it("rejects a direct loop back to origin (a->b, b->a)", () => {
    expect(wouldCreateSupersedeCycle("a", "b", chain({ b: "a" }))).toBe(true);
  });

  it("rejects an indirect loop (a->b, b->c, c->a)", () => {
    expect(wouldCreateSupersedeCycle("a", "b", chain({ b: "c", c: "a" }))).toBe(true);
  });

  it("fails closed on a pre-existing cycle in the data (b->c->b), origin uninvolved", () => {
    expect(wouldCreateSupersedeCycle("a", "b", chain({ b: "c", c: "b" }))).toBe(true);
  });

  it("is bounded — a very long acyclic chain still terminates false", () => {
    const edges: Record<string, string | null> = {};
    for (let i = 0; i < 50; i++) edges[`n${i}`] = `n${i + 1}`;
    edges["n50"] = null;
    expect(wouldCreateSupersedeCycle("origin", "n0", chain(edges))).toBe(false);
  });
});

describe("buildRevisionRecord — distinct provenance", () => {
  it("assigns a distinct id even for identical content", () => {
    const a = buildRevisionRecord({ skillId: "s1", contentDigest: "sha", source: "manual" });
    const b = buildRevisionRecord({ skillId: "s1", contentDigest: "sha", source: "manual" });
    expect(a.id).not.toBe(b.id);
    expect(a.contentDigest).toBe("sha");
    expect(a.source).toBe("manual");
  });

  it("honors a caller-supplied revision id (retry idempotency)", () => {
    const r = buildRevisionRecord({ skillId: "s1", contentDigest: null, source: "hitl", revisionId: "fixed-1" });
    expect(r.id).toBe("fixed-1");
    expect(r.contentDigest).toBeNull();
  });

  it("normalizes empty based-on collections to null and preserves non-empty", () => {
    expect(buildRevisionRecord({ skillId: "s1", contentDigest: null, source: "manual", basedOnSkillIds: [] }).basedOnSkillIds).toBeNull();
    const r = buildRevisionRecord({
      skillId: "s1", contentDigest: null, source: "chat-capture",
      basedOnSkillIds: ["b1", "b2"], baseDigests: { b1: "d1" },
    });
    expect(r.basedOnSkillIds).toEqual(["b1", "b2"]);
    expect(r.baseDigests).toEqual({ b1: "d1" });
  });

  it("throws on an invalid source (fail closed)", () => {
    expect(() => buildRevisionRecord({ skillId: "s1", contentDigest: null, source: "import" as "manual" })).toThrow();
  });

  it("newRevisionId yields distinct ids", () => {
    expect(newRevisionId()).not.toBe(newRevisionId());
  });
});

describe("isCustomOrPersonalSkillPayload — mirrors the backfill predicate", () => {
  it("matches custom: package ids and the flags", () => {
    expect(isCustomOrPersonalSkillPayload({ packageId: "custom:personal-skills" })).toBe(true);
    expect(isCustomOrPersonalSkillPayload({ packageId: "custom:email-recipients" })).toBe(true);
    expect(isCustomOrPersonalSkillPayload({ isCustomSkill: true })).toBe(true);
    expect(isCustomOrPersonalSkillPayload({ isPersonal: true })).toBe(true);
  });

  it("does not match extension / bare skills or non-objects", () => {
    expect(isCustomOrPersonalSkillPayload({ packageId: "github:acme/skills" })).toBe(false);
    expect(isCustomOrPersonalSkillPayload({ packageId: "cinatra-ai/blog-skills" })).toBe(false);
    expect(isCustomOrPersonalSkillPayload({})).toBe(false);
    expect(isCustomOrPersonalSkillPayload(null)).toBe(false);
    expect(isCustomOrPersonalSkillPayload("custom:x")).toBe(false);
  });
});
