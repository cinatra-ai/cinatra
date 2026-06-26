// Unit tests for the skill-paths resolver.
//
// Each case asserts that resolveSkillDir produces the exact on-disk skill
// directory the skill-store writes/reads.
//
// NOTE: for agent-bound skills the resolver normalizes the npm-scoped
// `agent_templates.package_name` (e.g. "@cinatra-ai/auditor-agent") to the
// unscoped on-disk segment ("cinatra-ai/auditor-agent"). The SQL relocation
// trigger still composes the raw scoped value and so currently diverges for
// scoped names — fixing it requires a migration (tracked in cinatra#550).

import { describe, expect, it } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertValidVendor,
  identityKey,
  RESERVED_SUBBUCKETS,
  RESERVED_TOP_LEVEL,
  resolveOwnerSegmentPath,
  resolveSkillDir,
  resolveSkillDirsBatch,
  resolveSkillDirsBatchKeyed,
  type SkillIdentity,
  type SlugMap,
} from "../skill-paths";
import { vi } from "vitest";

const ROOT = "/test/data/skills";

const slugs: SlugMap = {
  users: new Map([
    ["u-user-one", "user-one"],
    ["u-alice", "alice"],
  ]),
  teams: new Map([
    ["t-growth", { slug: "growth", organizationId: "o-acme" }],
    ["t-sales", { slug: "sales", organizationId: "o-acme" }],
  ]),
  organizations: new Map([
    ["o-acme", "acme"],
    ["o-globex", "globex"],
  ]),
  projects: new Map([
    ["p-q1campaign", { slug: "q1-campaign", owner_level: "team", owner_id: "t-growth" }],
    ["p-onboarding", { slug: "onboarding", owner_level: "personal", owner_id: "u-user-one" }],
    ["p-wsproj", { slug: "ws-project", owner_level: "workspace", owner_id: "" }],
  ]),
  agentTemplates: new Map([
    [
      "tmpl-auditor",
      { ownerLevel: "team", ownerId: "t-growth", packageName: "@cinatra-ai/auditor-agent" },
    ],
    [
      "tmpl-blog",
      { ownerLevel: "team", ownerId: "t-growth", packageName: "@cinatra-ai/blog-draft-writer-agent" },
    ],
  ]),
};

describe("RESERVED constants", () => {
  it("RESERVED_TOP_LEVEL is exactly the 3 ownership tiers (no top-level team)", () => {
    expect([...RESERVED_TOP_LEVEL].sort()).toEqual(["organization", "personal", "workspace"]);
  });
  it("RESERVED_SUBBUCKETS includes ~agents, ~teams, ~projects", () => {
    expect([...RESERVED_SUBBUCKETS].sort()).toEqual(["~agents", "~projects", "~teams"]);
  });
});

describe("assertValidVendor", () => {
  it("accepts simple lowercase alphanum", () => {
    expect(() => assertValidVendor("cinatra")).not.toThrow();
    expect(() => assertValidVendor("coreyhaines31")).not.toThrow();
    expect(() => assertValidVendor("zubair-trabzada")).not.toThrow();
  });
  it("rejects names starting with ~", () => {
    expect(() => assertValidVendor("~agents")).toThrow(/must not start with '~'/);
  });
  it("rejects empty / non-string", () => {
    expect(() => assertValidVendor("")).toThrow();
    expect(() => assertValidVendor(undefined as unknown as string)).toThrow();
  });
  it("rejects names with slashes", () => {
    expect(() => assertValidVendor("foo/bar")).toThrow();
  });
});

describe("resolveOwnerSegmentPath", () => {
  it("workspace returns 'workspace' with null id", () => {
    expect(resolveOwnerSegmentPath("workspace", null, slugs)).toBe("workspace");
  });
  it("workspace throws when id is non-null", () => {
    expect(() => resolveOwnerSegmentPath("workspace", "some-id", slugs)).toThrow(/workspace owner_id must be null|one workspace per deployment/);
  });
  it("personal composes personal/<username>", () => {
    expect(resolveOwnerSegmentPath("personal", "u-user-one", slugs)).toBe("personal/user-one");
  });
  it("personal returns null on unknown user", () => {
    expect(resolveOwnerSegmentPath("personal", "u-unknown", slugs)).toBeNull();
  });
  it("organization composes organization/<slug>", () => {
    expect(resolveOwnerSegmentPath("organization", "o-acme", slugs)).toBe("organization/acme");
  });
  it("team chains organization/<org>/~teams/<team>", () => {
    expect(resolveOwnerSegmentPath("team", "t-growth", slugs)).toBe(
      "organization/acme/~teams/growth",
    );
  });
  it("project recurses to its owner with ~projects/<slug>", () => {
    expect(resolveOwnerSegmentPath("project", "p-q1campaign", slugs)).toBe(
      "organization/acme/~teams/growth/~projects/q1-campaign",
    );
    expect(resolveOwnerSegmentPath("project", "p-onboarding", slugs)).toBe(
      "personal/user-one/~projects/onboarding",
    );
    expect(resolveOwnerSegmentPath("project", "p-wsproj", slugs)).toBe(
      "workspace/~projects/ws-project",
    );
  });
  it("project returns null on unknown project", () => {
    expect(resolveOwnerSegmentPath("project", "p-unknown", slugs)).toBeNull();
  });
});

describe("resolveSkillDir — representative ownership examples", () => {
  it("personal owner-bound installed skill", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "owner",
      vendor: "zubair-trabzada",
      package: "ai-marketing-claude",
      agent_template_id: null,
      skill_slug: "linkedin-post",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/personal/user-one/zubair-trabzada/ai-marketing-claude/linkedin-post",
    );
  });

  it("personal agent-bound skill (uses package_name from template)", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "agent",
      vendor: null,
      package: null,
      agent_template_id: "tmpl-auditor",
      skill_slug: "hot-fix-subject",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/personal/user-one/~agents/cinatra-ai/auditor-agent/hot-fix-subject",
    );
  });

  it("team owner-bound installed skill", () => {
    const id: SkillIdentity = {
      owner_scope: "team",
      owner_id: "t-growth",
      binding_scope: "owner",
      vendor: "coreyhaines31",
      package: "marketingskills",
      agent_template_id: null,
      skill_slug: "blog-outline",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/organization/acme/~teams/growth/coreyhaines31/marketingskills/blog-outline",
    );
  });

  it("organization agent-bound skill", () => {
    const id: SkillIdentity = {
      owner_scope: "organization",
      owner_id: "o-acme",
      binding_scope: "agent",
      vendor: null,
      package: null,
      agent_template_id: "tmpl-auditor",
      skill_slug: "pii-check",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/organization/acme/~agents/cinatra-ai/auditor-agent/pii-check",
    );
  });

  it("project (under team) agent-bound skill", () => {
    const id: SkillIdentity = {
      owner_scope: "project",
      owner_id: "p-q1campaign",
      binding_scope: "agent",
      vendor: null,
      package: null,
      agent_template_id: "tmpl-blog",
      skill_slug: "pillar-piece",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/organization/acme/~teams/growth/~projects/q1-campaign/~agents/cinatra-ai/blog-draft-writer-agent/pillar-piece",
    );
  });

  it("project (under personal user) installed skill", () => {
    const id: SkillIdentity = {
      owner_scope: "project",
      owner_id: "p-onboarding",
      binding_scope: "owner",
      vendor: "coreyhaines31",
      package: "marketingskills",
      agent_template_id: null,
      skill_slug: "welcome-email",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/personal/user-one/~projects/onboarding/coreyhaines31/marketingskills/welcome-email",
    );
  });

  it("workspace owner-bound installed skill (no slug segment)", () => {
    const id: SkillIdentity = {
      owner_scope: "workspace",
      owner_id: null,
      binding_scope: "owner",
      vendor: "cinatra",
      package: "sample-pack",
      agent_template_id: null,
      skill_slug: "hello-world",
    };
    expect(resolveSkillDir(id, slugs, ROOT)).toBe(
      "/test/data/skills/workspace/cinatra/sample-pack/hello-world",
    );
  });
});

describe("resolveSkillDir — validation errors", () => {
  it("throws when owner_scope=workspace and owner_id non-null", () => {
    const id: SkillIdentity = {
      owner_scope: "workspace",
      owner_id: "ws-1",
      binding_scope: "owner",
      vendor: "v",
      package: "p",
      agent_template_id: null,
      skill_slug: "s",
    };
    expect(() => resolveSkillDir(id, slugs, ROOT)).toThrow(/workspace owner_id must be null|one workspace per deployment/);
  });
  it("throws when owner-bound but vendor or package missing", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "owner",
      vendor: null,
      package: "p",
      agent_template_id: null,
      skill_slug: "s",
    };
    expect(() => resolveSkillDir(id, slugs, ROOT)).toThrow(/requires vendor \+ package/);
  });
  it("throws when agent-bound but agent_template_id missing", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "agent",
      vendor: null,
      package: null,
      agent_template_id: null,
      skill_slug: "s",
    };
    expect(() => resolveSkillDir(id, slugs, ROOT)).toThrow(/requires agent_template_id/);
  });
  it("throws when template not in SlugMap", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "agent",
      vendor: null,
      package: null,
      agent_template_id: "tmpl-unknown",
      skill_slug: "s",
    };
    expect(() => resolveSkillDir(id, slugs, ROOT)).toThrow(/not found in SlugMap/);
  });
  it("throws when owner chain cannot be resolved", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-missing",
      binding_scope: "owner",
      vendor: "v",
      package: "p",
      agent_template_id: null,
      skill_slug: "s",
    };
    expect(() => resolveSkillDir(id, slugs, ROOT)).toThrow(/cannot resolve owner path/);
  });
  it("throws when vendor starts with ~", () => {
    const id: SkillIdentity = {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "owner",
      vendor: "~bad",
      package: "p",
      agent_template_id: null,
      skill_slug: "s",
    };
    expect(() => resolveSkillDir(id, slugs, ROOT)).toThrow(/must not start with '~'/);
  });
});

describe("resolveSkillDirsBatch / Keyed", () => {
  const ids: SkillIdentity[] = [
    {
      owner_scope: "personal",
      owner_id: "u-user-one",
      binding_scope: "owner",
      vendor: "a",
      package: "b",
      agent_template_id: null,
      skill_slug: "s1",
    },
    {
      owner_scope: "organization",
      owner_id: "o-acme",
      binding_scope: "agent",
      vendor: null,
      package: null,
      agent_template_id: "tmpl-auditor",
      skill_slug: "s2",
    },
  ];
  it("batch produces same paths as individual calls", () => {
    const batch = resolveSkillDirsBatch(ids, slugs, ROOT);
    expect(batch.get("s1")).toBe(resolveSkillDir(ids[0], slugs, ROOT));
    expect(batch.get("s2")).toBe(resolveSkillDir(ids[1], slugs, ROOT));
  });
  it("batchKeyed disambiguates same-slug identities", () => {
    const dup: SkillIdentity[] = [ids[0], { ...ids[0], owner_id: "u-alice" }];
    const map = resolveSkillDirsBatchKeyed(dup, { ...slugs, users: new Map([["u-user-one", "user-one"], ["u-alice", "alice"]]) }, ROOT);
    expect(map.size).toBe(2);
    expect([...map.keys()][0]).toContain("u-user-one");
    expect([...map.keys()][1]).toContain("u-alice");
  });
  it("identityKey is stable + deterministic", () => {
    const id = ids[0];
    expect(identityKey(id)).toBe(identityKey(id));
    expect(identityKey({ ...id, owner_id: "x" })).not.toBe(identityKey(id));
  });
});
