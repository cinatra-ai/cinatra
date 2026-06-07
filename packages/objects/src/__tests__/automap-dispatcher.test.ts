// ---------------------------------------------------------------------------
// Dispatcher decision tests.
// ---------------------------------------------------------------------------
//
// Covers dispatcher decisions:
//   (a) Duplicate detection — same identityKey → UPDATE not CREATE.
//   (b) Merge — compatible field updates combine without loss.
//   (c) Partial update — input with only a subset of declared fields updates
//       only those fields.
//   (d) HITL fallback — confidence below threshold / missing required field /
//       no identityKey + onNoMatch=hitl / no existing + onNoMatch=hitl.
import { describe, it, expect } from "vitest";
import {
  decideDispatch,
  type ExistingObject,
} from "../automap/dispatcher";
import {
  type AutomapCrudPolicy,
  DEFAULT_HITL_CONFIDENCE_THRESHOLD,
} from "../automap/policy";

// ---- representative type policies (mirror what the live type registry
// declares for accounts / contacts / blog-post).
const ACCOUNT_POLICY: AutomapCrudPolicy = {
  onMatch: "update",
  onNoMatch: "create",
  preserveOnUpdate: ["id", "createdAt"],
  requiredFields: ["name"],
  hitlConfidenceThreshold: 0.7,
};

const CONTACT_POLICY: AutomapCrudPolicy = {
  onMatch: "merge",
  onNoMatch: "create",
  mergeableFields: ["tags", "phoneNumbers"],
  preserveOnUpdate: ["id", "createdAt"],
  requiredFields: ["email"],
};

const STRICT_POLICY: AutomapCrudPolicy = {
  onMatch: "skip",
  onNoMatch: "hitl",
};

const accountIdentityKey = (d: Record<string, unknown>) =>
  (typeof d.websiteHost === "string" && d.websiteHost) ||
  (typeof d.website === "string" && d.website) ||
  null;

const contactIdentityKey = (d: Record<string, unknown>) =>
  (typeof d.email === "string" && d.email) || null;

// ---------------------------------------------------------------------------
// Duplicate detection — same identityKey → UPDATE.
// ---------------------------------------------------------------------------
describe("duplicate detection (UPDATE, not CREATE)", () => {
  it("update path when identityKey matches an existing object", () => {
    const existing: ExistingObject = {
      id: "acc-1",
      data: { id: "acc-1", name: "Old Co", website: "https://acme.com", createdAt: "2026-01-01" },
    };
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-accounts:account",
      output: { name: "Acme Co", website: "https://acme.com" },
      policy: ACCOUNT_POLICY,
      identityKey: accountIdentityKey,
      classifierConfidence: 0.95,
      existing,
    });
    expect(decision.kind).toBe("update");
    if (decision.kind === "update") {
      expect(decision.objectId).toBe("acc-1");
      expect(decision.data.name).toBe("Acme Co");
      // preserveOnUpdate honored: createdAt stays from existing.
      expect(decision.data.createdAt).toBe("2026-01-01");
      // and id stays
      expect(decision.data.id).toBe("acc-1");
    }
  });

  it("create path when identityKey resolves but no existing match", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-accounts:account",
      output: { name: "Brand New", website: "https://newco.com" },
      policy: ACCOUNT_POLICY,
      identityKey: accountIdentityKey,
      classifierConfidence: 0.9,
      existing: null,
    });
    expect(decision.kind).toBe("create");
  });
});

// ---------------------------------------------------------------------------
// Merge — combine arrays without loss + onMatch=merge.
// ---------------------------------------------------------------------------
describe("merge (combine, not overwrite)", () => {
  it("merge path combines mergeableFields arrays without duplication", () => {
    const existing: ExistingObject = {
      id: "c1",
      data: { id: "c1", email: "a@b.co", tags: ["customer"], phoneNumbers: ["+1"], createdAt: "x" },
    };
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-contacts:contact",
      output: { email: "a@b.co", tags: ["beta-list", "customer"], phoneNumbers: ["+2"], notes: "new" },
      policy: CONTACT_POLICY,
      identityKey: contactIdentityKey,
      classifierConfidence: 0.9,
      existing,
    });
    expect(decision.kind).toBe("merge");
    if (decision.kind === "merge") {
      // mergeableFields: tags + phoneNumbers union'd
      expect(decision.data.tags).toEqual(["customer", "beta-list"]);
      expect(decision.data.phoneNumbers).toEqual(["+1", "+2"]);
      // non-mergeable: notes from incoming replaces (no existing value)
      expect(decision.data.notes).toBe("new");
      // preserveOnUpdate respected even under merge
      expect(decision.data.createdAt).toBe("x");
    }
  });
});

// ---------------------------------------------------------------------------
// Partial update — input only sets a subset; existing fields kept.
// ---------------------------------------------------------------------------
describe("partial update", () => {
  it("UPDATE: incoming-keys overwrite, preserved fields stay, unrelated fields stay (merge variant)", () => {
    const existing: ExistingObject = {
      id: "c1",
      data: { id: "c1", email: "a@b.co", tags: ["existing"], notes: "old note", createdAt: "x" },
    };
    // Use merge policy: non-mergeable, non-preserved keys NOT in output stay.
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-contacts:contact",
      output: { email: "a@b.co", tags: ["new"] }, // notes intentionally omitted
      policy: CONTACT_POLICY,
      identityKey: contactIdentityKey,
      classifierConfidence: 0.9,
      existing,
    });
    expect(decision.kind).toBe("merge");
    if (decision.kind === "merge") {
      expect(decision.data.email).toBe("a@b.co");
      expect(decision.data.tags).toEqual(["existing", "new"]);
      expect(decision.data.notes).toBe("old note"); // preserved (not in output)
      expect(decision.data.createdAt).toBe("x"); // preserveOnUpdate
    }
  });
});

// ---------------------------------------------------------------------------
// HITL fallback paths.
// ---------------------------------------------------------------------------
describe("HITL fallback", () => {
  it("escalates to HITL when classifier confidence < threshold", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-accounts:account",
      output: { name: "Acme", website: "https://acme.com" },
      policy: ACCOUNT_POLICY,
      identityKey: accountIdentityKey,
      classifierConfidence: 0.5, // below 0.7
      existing: null,
    });
    expect(decision.kind).toBe("hitl");
    if (decision.kind === "hitl") {
      expect(decision.reason).toMatch(/confidence/);
    }
  });

  it("escalates to HITL when a required field is missing/empty", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-accounts:account",
      output: { website: "https://acme.com" }, // name missing
      policy: ACCOUNT_POLICY,
      identityKey: accountIdentityKey,
      classifierConfidence: 0.95,
      existing: null,
    });
    expect(decision.kind).toBe("hitl");
    if (decision.kind === "hitl") {
      expect(decision.reason).toMatch(/required field/);
    }
  });

  it("escalates to HITL when identityKey returns null AND policy is onNoMatch=hitl", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-contacts:contact",
      output: { name: "no email here" },
      policy: STRICT_POLICY,
      identityKey: contactIdentityKey,
      classifierConfidence: 0.95,
      existing: null,
    });
    expect(decision.kind).toBe("hitl");
  });

  it("escalates to HITL when identityKey resolves but no existing match AND policy is onNoMatch=hitl", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-contacts:contact",
      output: { email: "x@y.co" },
      policy: STRICT_POLICY,
      identityKey: contactIdentityKey,
      classifierConfidence: 0.95,
      existing: null,
    });
    expect(decision.kind).toBe("hitl");
    if (decision.kind === "hitl") {
      expect(decision.reason).toMatch(/no existing match/);
    }
  });

  it("skip path when identityKey matches but policy is onMatch=skip", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-contacts:contact",
      output: { email: "x@y.co" },
      policy: STRICT_POLICY,
      identityKey: contactIdentityKey,
      classifierConfidence: 0.95,
      existing: { id: "c1", data: { id: "c1", email: "x@y.co" } },
    });
    expect(decision.kind).toBe("skip");
  });

  it("uses DEFAULT_HITL_CONFIDENCE_THRESHOLD when policy omits one", () => {
    expect(DEFAULT_HITL_CONFIDENCE_THRESHOLD).toBe(0.6);
    const decision = decideDispatch({
      typeId: "@cinatra-ai/entity-accounts:account",
      output: { name: "Acme", website: "https://x" },
      policy: { onMatch: "update", onNoMatch: "create" }, // no threshold
      identityKey: accountIdentityKey,
      classifierConfidence: 0.5, // below default 0.6
      existing: null,
    });
    expect(decision.kind).toBe("hitl");
  });
});

// ---------------------------------------------------------------------------
// Coverage for additional object types handled by dispatcher policies.
// ---------------------------------------------------------------------------
const CAMPAIGN_POLICY: AutomapCrudPolicy = {
  onMatch: "update",
  onNoMatch: "create",
  preserveOnUpdate: ["id", "createdAt", "cinatra_agent_run_id", "name"],
};

const BLOG_PROJECT_POLICY: AutomapCrudPolicy = {
  onMatch: "update",
  onNoMatch: "hitl",
  requiredFields: ["name"],
  preserveOnUpdate: ["id", "createdAt", "name", "companyUrl"],
};

const ARTIFACT_REF_POLICY: AutomapCrudPolicy = {
  onMatch: "skip",
  onNoMatch: "hitl",
  requiredFields: ["artifactId", "representationRevisionId"],
};

const runIdentityKey = (d: Record<string, unknown>) =>
  typeof d.cinatra_agent_run_id === "string" && d.cinatra_agent_run_id.length > 0
    ? d.cinatra_agent_run_id
    : null;

describe("coverage for additional object types handled by dispatcher policies", () => {
  it("campaign / run-scoped: re-run within same run UPDATES; name is preserved", () => {
    const existing: ExistingObject = {
      id: "camp-1",
      data: { id: "camp-1", cinatra_agent_run_id: "run-1", name: "Owner-named Campaign", createdAt: "x" },
    };
    const decision = decideDispatch({
      typeId: "@cinatra-ai/campaigns:campaign",
      output: { cinatra_agent_run_id: "run-1", name: "Agent-generated Campaign", description: "new" },
      policy: CAMPAIGN_POLICY,
      identityKey: runIdentityKey,
      classifierConfidence: 0.9,
      existing,
    });
    expect(decision.kind).toBe("update");
    if (decision.kind === "update") {
      // User's campaign name preserved despite agent attempting to overwrite.
      expect(decision.data.name).toBe("Owner-named Campaign");
      // Non-preserved fields take incoming.
      expect(decision.data.description).toBe("new");
    }
  });

  it("blog-project: agent never auto-creates — onNoMatch=hitl", () => {
    const decision = decideDispatch({
      typeId: "@cinatra-ai/assets:blog-project",
      output: { name: "Brand-new project", companyUrl: "https://x.co" },
      policy: BLOG_PROJECT_POLICY,
      identityKey: () => null, // no natural identity
      classifierConfidence: 0.95,
      existing: null,
    });
    expect(decision.kind).toBe("hitl");
  });

  it("blog-project: existing match UPDATES, but name/companyUrl preserved", () => {
    const existing: ExistingObject = {
      id: "p-1",
      data: { id: "p-1", name: "Owner Brand Blog", companyUrl: "https://owner.co", createdAt: "x" },
    };
    const decision = decideDispatch({
      typeId: "@cinatra-ai/assets:blog-project",
      output: { name: "Renamed by agent", companyUrl: "https://different.co", ideaGeneration: { status: "running" } },
      policy: BLOG_PROJECT_POLICY,
      identityKey: () => "p-1",
      classifierConfidence: 0.95,
      existing,
    });
    expect(decision.kind).toBe("update");
    if (decision.kind === "update") {
      expect(decision.data.name).toBe("Owner Brand Blog"); // preserved
      expect(decision.data.companyUrl).toBe("https://owner.co"); // preserved
      expect((decision.data.ideaGeneration as { status: string }).status).toBe("running");
    }
  });

  it("artifact-ref: materializer-owned — onMatch=skip, onNoMatch=hitl", () => {
    const existing: ExistingObject = {
      id: "ar-1",
      data: { id: "ar-1", artifactId: "art-1", representationRevisionId: "rev-1" },
    };
    const matchDecision = decideDispatch({
      typeId: "@cinatra-ai/artifacts:artifact-ref",
      output: { artifactId: "art-1", representationRevisionId: "rev-2" },
      policy: ARTIFACT_REF_POLICY,
      identityKey: (d) => (typeof d.artifactId === "string" ? d.artifactId : null),
      classifierConfidence: 0.95,
      existing,
    });
    expect(matchDecision.kind).toBe("skip");

    const noMatchDecision = decideDispatch({
      typeId: "@cinatra-ai/artifacts:artifact-ref",
      output: { artifactId: "art-new", representationRevisionId: "rev-new" },
      policy: ARTIFACT_REF_POLICY,
      identityKey: (d) => (typeof d.artifactId === "string" ? d.artifactId : null),
      classifierConfidence: 0.95,
      existing: null,
    });
    expect(noMatchDecision.kind).toBe("hitl");
  });
});
