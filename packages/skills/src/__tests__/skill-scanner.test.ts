// Unit tests for skill-scanner.
//
// Builds a temp dir with the scanner layout and asserts the
// scanner yields the expected records, with correct inferred identities and
// no spurious warnings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

import { scanSkillsRoot, type ScannedSkill, type ScannerWarning } from "../skill-scanner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skill-scanner-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(p: string, body = "# Skill\n") {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, body, "utf-8");
}

async function collect(warnings: ScannerWarning[] = []): Promise<ScannedSkill[]> {
  const collected: ScannedSkill[] = [];
  for await (const r of scanSkillsRoot(root, (w) => warnings.push(w))) {
    collected.push(r);
  }
  return collected;
}

describe("scanner — happy paths", () => {
  it("personal owner-bound installed skill", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "zubair", "ai-marketing", "linkedin-post", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(w).toEqual([]);
    expect(r).toHaveLength(1);
    expect(r[0].inferred_identity).toMatchObject({
      owner_scope: "personal",
      owner_segment_slugs: ["owner-alpha"],
      binding_scope: "owner",
      vendor: "zubair",
      package: "ai-marketing",
      skill_slug: "linkedin-post",
      project_slug: null,
    });
  });

  it("personal agent-bound skill", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "~agents", "cinatra", "auditor-agent", "pii-check", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(w).toEqual([]);
    expect(r).toHaveLength(1);
    expect(r[0].inferred_identity).toMatchObject({
      owner_scope: "personal",
      binding_scope: "agent",
      vendor: "cinatra",
      package: "auditor-agent",
      agent_package_name: "cinatra/auditor-agent",
      skill_slug: "pii-check",
    });
  });

  it("team owner-bound installed skill (nested under organization/~teams)", async () => {
    await writeSkill(
      path.join(root, "organization", "acme", "~teams", "growth", "coreyhaines31", "marketingskills", "blog-outline", "SKILL.md"),
    );
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(w).toEqual([]);
    expect(r).toHaveLength(1);
    expect(r[0].inferred_identity).toMatchObject({
      owner_scope: "team",
      owner_segment_slugs: ["acme", "growth"],
      binding_scope: "owner",
      vendor: "coreyhaines31",
      package: "marketingskills",
      skill_slug: "blog-outline",
    });
  });

  it("project agent-bound skill nested under team", async () => {
    await writeSkill(
      path.join(
        root,
        "organization", "acme", "~teams", "growth", "~projects", "q1-campaign", "~agents", "cinatra", "blog-draft-writer-agent", "pillar-piece",
        "SKILL.md",
      ),
    );
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(w).toEqual([]);
    expect(r).toHaveLength(1);
    expect(r[0].inferred_identity).toMatchObject({
      owner_scope: "project",
      project_slug: "q1-campaign",
      binding_scope: "agent",
      vendor: "cinatra",
      package: "blog-draft-writer-agent",
      skill_slug: "pillar-piece",
    });
  });

  it("workspace installed skill (no slug segment)", async () => {
    await writeSkill(path.join(root, "workspace", "cinatra", "sample-pack", "hello-world", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(w).toEqual([]);
    expect(r).toHaveLength(1);
    expect(r[0].inferred_identity).toMatchObject({
      owner_scope: "workspace",
      owner_segment_slugs: [],
      binding_scope: "owner",
      vendor: "cinatra",
      package: "sample-pack",
      skill_slug: "hello-world",
    });
  });
});

describe("scanner — invariant violations", () => {
  it("rejects unknown top-level dir", async () => {
    await writeSkill(path.join(root, "bogus-top", "x", "v", "p", "s", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(0);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe("unknown_top_level");
  });

  it("rejects unknown sub-bucket (~unknown)", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "~unknown", "v", "p", "s", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(0);
    expect(w.find((x) => x.kind === "unknown_subbucket")).toBeDefined();
  });

  it("rejects vendor starting with ~ inside ~agents bucket", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "~agents", "~bad", "p", "s", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(0);
    expect(w.find((x) => x.kind === "vendor_with_tilde")).toBeDefined();
  });

  it("rejects ~teams inside personal scope (only valid inside organization)", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "~teams", "x", "y", "z", "s", "SKILL.md"));
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(0);
    expect(w.find((x) => x.kind === "unknown_subbucket" && x.detail.includes("~teams"))).toBeDefined();
  });
});

describe("scanner — moving marker skips subtree", () => {
  it("skips owner-level subtree when .cinatra-moving.json present at owner dir", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "v", "p", "s", "SKILL.md"));
    await writeFile(path.join(root, "personal", "owner-alpha", ".cinatra-moving.json"), "{}");
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(0);
    expect(w.find((x) => x.kind === "marker_present")).toBeDefined();
  });

  it("skips a single skill dir when marker is on it", async () => {
    await writeSkill(path.join(root, "personal", "owner-alpha", "v", "p", "s1", "SKILL.md"));
    await writeSkill(path.join(root, "personal", "owner-alpha", "v", "p", "s2", "SKILL.md"));
    await writeFile(path.join(root, "personal", "owner-alpha", "v", "p", "s2", ".cinatra-moving.json"), "{}");
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(1);
    expect(r[0].inferred_identity.skill_slug).toBe("s1");
  });
});

describe("scanner — missing SKILL.md", () => {
  it("warns when SKILL.md is missing", async () => {
    await mkdir(path.join(root, "personal", "owner-alpha", "v", "p", "s"), { recursive: true });
    const w: ScannerWarning[] = [];
    const r = await collect(w);
    expect(r).toHaveLength(0);
    expect(w.find((x) => x.kind === "missing_skill_md")).toBeDefined();
  });
});
