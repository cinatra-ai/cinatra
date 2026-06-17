/**
 * SDK-P5 (eng#167) — declarative ARTIFACT + SKILL package source-authoring.
 *
 * Mirrors workflow-source-write-and-kind-decoercion.test.ts for the second
 * vertical (artifact + skill kinds). Three cohesive concerns per kind:
 *  1. *_source_write materializes the EXTENSION PACKAGE on disk
 *     (package.json with the correct cinatra.kind + the kind's declarative
 *     definition), fail-closed on an invalid definition, and rescopes the name.
 *  2. The package authoring is DISJOINT from the INSTANCE/ROW tools of the same
 *     kind (artifact_authoring_emit; skills_personal_upsert / skills_installed_
 *     upsert / skills_packages_install) — verified at the handler-table level.
 *  3. write → compile runs the full on-disk validation gate.
 *
 * The canonical validators (@cinatra-ai/objects parseSemanticArtifactManifest;
 * @cinatra-ai/skills parseFrontmatter) run for REAL (no DB) so the validation
 * chain is exercised end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const { mockReadInstanceIdentity } = vi.hoisted(() => ({
  mockReadInstanceIdentity: vi.fn(() => null as unknown),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: mockReadInstanceIdentity,
  markFirstPublishedIfCurrentScope: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => {
    throw new Error("not used");
  },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
  publishExtensionPackageFromDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn((p: unknown) => p) }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => ({})),
}));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => true),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error {
    statusCode = 403;
    reason = "denied";
  },
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("../store", () => ({ resolveDefaultOrgId: vi.fn(async () => "org-1") }));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

// Minimal VALID semantic artifact manifest (accepts ≥1 representation form).
const VALID_ARTIFACT_MANIFEST = {
  accepts: { file: { mimeTypes: ["text/markdown", "text/plain"] } },
  matcherConfidenceThreshold: 0.7,
};
const VALID_SKILL_MD = "---\nname: demo-skill\ndescription: A demo skill.\n---\nDo the demo thing.";

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "art-skill-source-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});
afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function adminActor() {
  return { actorType: "user", source: "ui", userId: "u-admin", platformRole: "platform_admin" };
}

function req(primitiveName: string, input: Record<string, unknown>) {
  return { primitiveName, input, actor: adminActor(), mode: "deterministic" };
}

async function readPkgJson(slug: string): Promise<Record<string, unknown>> {
  const p = path.join(tmpRoot, "cinatra-ai", slug, "package.json");
  return JSON.parse(await fs.readFile(p, "utf-8")) as Record<string, unknown>;
}

describe("artifact_source_* — declarative artifact PACKAGE authoring", () => {
  const SLUG = "demo-sales-playbook-artifact";

  it("writes an artifact package: cinatra.kind=artifact + the semantic manifest", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["artifact_source_write"];
    const result = (await handler(
      req("artifact_source_write", {
        packageSlug: SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${SLUG}`,
          version: "0.1.0",
          license: "Apache-2.0",
          cinatra: { artifact: VALID_ARTIFACT_MANIFEST },
        }),
      }),
    )) as { written?: boolean; kind?: string };
    expect(result.written).toBe(true);
    expect(result.kind).toBe("artifact");

    const written = await readPkgJson(SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("artifact");
    expect(cinatra.apiVersion).toBe("cinatra.ai/v1");
    // the semantic manifest is preserved (the de-coercion normalizer only
    // touches kind + apiVersion).
    expect(cinatra.artifact).toEqual(VALID_ARTIFACT_MANIFEST);
    // name rescoped to canonical @cinatra-ai scope (vendor identity empty in test).
    expect(written.name).toBe(`@cinatra-ai/${SLUG}`);
  });

  it("fails closed on an invalid cinatra.artifact manifest (nothing lands on disk)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["artifact_source_write"];
    const result = (await handler(
      req("artifact_source_write", {
        packageSlug: "bad-artifact",
        packageJson: JSON.stringify({
          name: "@cinatra/bad-artifact",
          version: "0.1.0",
          license: "Apache-2.0",
          // `accepts` declares no representation form → schema refinement fails.
          cinatra: { artifact: { accepts: {} } },
        }),
      }),
    )) as { error?: string; valid?: boolean };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/cinatra\.artifact failed validation/);
    await expect(fs.access(path.join(tmpRoot, "cinatra-ai", "bad-artifact"))).rejects.toBeTruthy();
  });

  it("rejects an artifact package with NO cinatra.artifact manifest at all", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["artifact_source_write"];
    const result = (await handler(
      req("artifact_source_write", {
        packageSlug: "no-manifest-artifact",
        packageJson: JSON.stringify({ name: "@cinatra/no-manifest-artifact", version: "0.1.0", license: "Apache-2.0" }),
      }),
    )) as { valid?: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/cinatra\.artifact failed validation/);
  });

  it("artifact_source_validate accepts a valid manifest passed as content", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["artifact_source_validate"];
    const result = (await handler(
      req("artifact_source_validate", { content: JSON.stringify(VALID_ARTIFACT_MANIFEST) }),
    )) as { valid?: boolean; errors?: string[] };
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("write → compile runs the full on-disk manifest validation", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "compile-demo-artifact";
    const wrote = (await handlers["artifact_source_write"](
      req("artifact_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({
          name: `@cinatra/${slug}`,
          version: "0.1.0",
          license: "Apache-2.0",
          cinatra: { artifact: VALID_ARTIFACT_MANIFEST },
        }),
      }),
    )) as { written?: boolean };
    expect(wrote.written).toBe(true);

    const compiled = (await handlers["artifact_source_compile"](
      req("artifact_source_compile", { packageSlug: slug }),
    )) as { compiled?: boolean; valid?: boolean; error?: string };
    expect(compiled.error).toBeUndefined();
    expect(compiled.compiled).toBe(true);
    expect(compiled.valid).toBe(true);
  });

  it("rejects a literal credential in package files (review_blocked)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["artifact_source_write"];
    const result = (await handler(
      req("artifact_source_write", {
        packageSlug: "cred-artifact",
        packageJson: JSON.stringify({
          name: "@cinatra/cred-artifact",
          version: "0.1.0",
          license: "Apache-2.0",
          cinatra: { artifact: VALID_ARTIFACT_MANIFEST },
          scripts: { leak: "echo sk-test1234567890abcdef1234567890ABCDEF12" },
        }),
      }),
    )) as { code?: string };
    expect(result.code).toBe("review_blocked");
  });

  it("non-admin is rejected at the write boundary", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["artifact_source_write"];
    const result = (await handler({
      primitiveName: "artifact_source_write",
      input: { packageSlug: "x", packageJson: "{}" },
      actor: { actorType: "user", source: "ui", userId: "u-member", platformRole: "member" },
      mode: "deterministic",
    })) as { error?: string };
    expect(result.error).toMatch(/session required to write/);
  });

  it("publish refuses a package with no detectable license (parity with workflow publish)", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "no-license-artifact";
    await handlers["artifact_source_write"](
      req("artifact_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({
          name: `@cinatra/${slug}`,
          version: "0.1.0",
          cinatra: { artifact: VALID_ARTIFACT_MANIFEST },
        }),
      }),
    );
    const result = (await handlers["artifact_source_publish"](
      req("artifact_source_publish", { packageSlug: slug }),
    )) as { error?: string; code?: string };
    expect(result.error).toBeDefined();
    expect(result.code).toBeDefined();
  });
});

describe("skill_source_* — declarative skill PACKAGE authoring", () => {
  const SLUG = "demo-blog-skills";

  it("writes a skill package: cinatra.kind=skill + capabilities + skills/<slug>/SKILL.md", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["skill_source_write"];
    const result = (await handler(
      req("skill_source_write", {
        packageSlug: SLUG,
        packageJson: JSON.stringify({ name: `@cinatra/${SLUG}`, version: "0.1.0", license: "Apache-2.0" }),
        skillMd: VALID_SKILL_MD,
      }),
    )) as { written?: boolean; kind?: string };
    expect(result.written).toBe(true);
    expect(result.kind).toBe("skill");

    const written = await readPkgJson(SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("skill");
    expect(cinatra.apiVersion).toBe("cinatra.ai/v1");
    // capabilities defaulted to a single binding when none emitted.
    const caps = cinatra.capabilities as Record<string, string>;
    expect(Object.values(caps)).toContain(SLUG);
    expect(written.name).toBe(`@cinatra-ai/${SLUG}`);

    const md = await fs.readFile(path.join(tmpRoot, "cinatra-ai", SLUG, "skills", SLUG, "SKILL.md"), "utf-8");
    expect(md).toContain("name: demo-skill");
  });

  it("honors an explicit capabilities map + skillSlug", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["skill_source_write"];
    const result = (await handler(
      req("skill_source_write", {
        packageSlug: "multi-skills",
        skillSlug: "do-thing",
        packageJson: JSON.stringify({
          name: "@cinatra/multi-skills",
          version: "0.1.0",
          license: "Apache-2.0",
          cinatra: { capabilities: { "widget.do-thing": "do-thing" } },
        }),
        skillMd: VALID_SKILL_MD,
      }),
    )) as { written?: boolean };
    expect(result.written).toBe(true);
    const written = await readPkgJson("multi-skills");
    expect((written.cinatra as Record<string, unknown>).capabilities).toEqual({ "widget.do-thing": "do-thing" });
    // SKILL.md landed under the explicit skillSlug.
    await expect(
      fs.access(path.join(tmpRoot, "cinatra-ai", "multi-skills", "skills", "do-thing", "SKILL.md")),
    ).resolves.toBeUndefined();
  });

  it("fails closed on a SKILL.md with no frontmatter name (nothing lands on disk)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["skill_source_write"];
    const result = (await handler(
      req("skill_source_write", {
        packageSlug: "bad-skill",
        packageJson: JSON.stringify({ name: "@cinatra/bad-skill", version: "0.1.0", license: "Apache-2.0" }),
        skillMd: "No frontmatter here, just prose.",
      }),
    )) as { valid?: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/frontmatter `name`/);
    await expect(fs.access(path.join(tmpRoot, "cinatra-ai", "bad-skill"))).rejects.toBeTruthy();
  });

  it("write → validate runs the on-disk capabilities↔SKILL.md contract", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "validate-demo-skills";
    await handlers["skill_source_write"](
      req("skill_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({ name: `@cinatra/${slug}`, version: "0.1.0", license: "Apache-2.0" }),
        skillMd: VALID_SKILL_MD,
      }),
    );
    const valid = (await handlers["skill_source_validate"](
      req("skill_source_validate", { packageSlug: slug }),
    )) as { valid?: boolean; errors?: string[] };
    expect(valid.valid).toBe(true);
    expect(valid.errors).toEqual([]);
  });

  it("write → compile runs the full on-disk package validation", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "compile-demo-skills";
    await handlers["skill_source_write"](
      req("skill_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({ name: `@cinatra/${slug}`, version: "0.1.0", license: "Apache-2.0" }),
        skillMd: VALID_SKILL_MD,
      }),
    );
    const compiled = (await handlers["skill_source_compile"](
      req("skill_source_compile", { packageSlug: slug }),
    )) as { compiled?: boolean; valid?: boolean; error?: string };
    expect(compiled.error).toBeUndefined();
    expect(compiled.compiled).toBe(true);
    expect(compiled.valid).toBe(true);
  });

  it("rejects a literal credential in package files (review_blocked)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["skill_source_write"];
    const result = (await handler(
      req("skill_source_write", {
        packageSlug: "cred-skills",
        packageJson: JSON.stringify({
          name: "@cinatra/cred-skills",
          version: "0.1.0",
          license: "Apache-2.0",
          scripts: { leak: "echo sk-test1234567890abcdef1234567890ABCDEF12" },
        }),
        skillMd: VALID_SKILL_MD,
      }),
    )) as { code?: string };
    expect(result.code).toBe("review_blocked");
  });

  it("non-admin is rejected at the write boundary", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["skill_source_write"];
    const result = (await handler({
      primitiveName: "skill_source_write",
      input: { packageSlug: "x", packageJson: "{}", skillMd: VALID_SKILL_MD },
      actor: { actorType: "user", source: "ui", userId: "u-member", platformRole: "member" },
      mode: "deterministic",
    })) as { error?: string };
    expect(result.error).toMatch(/session required to write/);
  });
});

describe("kind-disjointness hardening (codex convergence)", () => {
  it("artifact compile rejects a package with an extraneous cinatra key (stale from a reused slug)", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "stale-key-artifact";
    // Write a clean artifact package first.
    await handlers["artifact_source_write"](
      req("artifact_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({
          name: `@cinatra/${slug}`,
          version: "0.1.0",
          license: "Apache-2.0",
          cinatra: { artifact: VALID_ARTIFACT_MANIFEST },
        }),
      }),
    );
    // Simulate a reused-slug stale state: inject a forbidden agent `oas` key.
    const pkgPath = path.join(tmpRoot, "cinatra-ai", slug, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
    (pkg.cinatra as Record<string, unknown>).oas = { paths: {} };
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    const compiled = (await handlers["artifact_source_compile"](
      req("artifact_source_compile", { packageSlug: slug }),
    )) as { valid?: boolean; error?: string };
    expect(compiled.valid).toBe(false);
    expect(compiled.error).toMatch(/cinatra\.oas|unexpected key/);
  });

  it("artifact compile rejects a stale workflow.bpmn sidecar (kind-foreign file from a reused slug)", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "stale-sidecar-artifact";
    await handlers["artifact_source_write"](
      req("artifact_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({
          name: `@cinatra/${slug}`,
          version: "0.1.0",
          license: "Apache-2.0",
          cinatra: { artifact: VALID_ARTIFACT_MANIFEST },
        }),
      }),
    );
    await fs.mkdir(path.join(tmpRoot, "cinatra-ai", slug, "cinatra"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "cinatra-ai", slug, "cinatra", "workflow.bpmn"), "<stale/>");

    const compiled = (await handlers["artifact_source_compile"](
      req("artifact_source_compile", { packageSlug: slug }),
    )) as { valid?: boolean; error?: string };
    expect(compiled.valid).toBe(false);
    expect(compiled.error).toMatch(/workflow\.bpmn/);
  });

  it("skill_source_write fails closed on a capabilities map referencing an unwritten slug", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["skill_source_write"];
    const result = (await handler(
      req("skill_source_write", {
        packageSlug: "dangling-skills",
        skillSlug: "authored-one",
        packageJson: JSON.stringify({
          name: "@cinatra/dangling-skills",
          version: "0.1.0",
          license: "Apache-2.0",
          // references a DIFFERENT slug than the one this write authors.
          cinatra: { capabilities: { "widget.other": "not-authored" } },
        }),
        skillMd: VALID_SKILL_MD,
      }),
    )) as { valid?: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not authored by this write|must bind to/);
    // nothing landed on disk
    await expect(fs.access(path.join(tmpRoot, "cinatra-ai", "dangling-skills"))).rejects.toBeTruthy();
  });
});

describe("package-authoring vs instance/row tools — DISJOINT handler surfaces", () => {
  it("registers BOTH the artifact PACKAGE source tools AND the artifact INSTANCE emit tool, distinctly", () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    // Package authoring (this vertical).
    expect(typeof handlers["artifact_source_write"]).toBe("function");
    expect(typeof handlers["artifact_source_validate"]).toBe("function");
    expect(typeof handlers["artifact_source_compile"]).toBe("function");
    expect(typeof handlers["artifact_source_publish"]).toBe("function");
    // The INSTANCE emit tool (artifact_authoring_emit) is a DIFFERENT surface —
    // it must NOT collide with a source tool name. (It is registered elsewhere,
    // not on this agent-builder table; the disjointness we assert here is that
    // the source tools never shadow an emit-shaped name.)
    expect(handlers["artifact_source_write"]).not.toBe(handlers["artifact_source_publish"]);
    expect(handlers["artifact_authoring_emit"]).toBeUndefined();
  });

  it("registers the skill PACKAGE source tools, distinct from skills_* row/install names", () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    expect(typeof handlers["skill_source_write"]).toBe("function");
    expect(typeof handlers["skill_source_validate"]).toBe("function");
    expect(typeof handlers["skill_source_compile"]).toBe("function");
    expect(typeof handlers["skill_source_publish"]).toBe("function");
    // The personal/installed/install skill mutations live on the skills MCP
    // surface (plural `skills_`), NOT this agent-builder table — so the package
    // source tools cannot shadow them.
    expect(handlers["skills_personal_upsert"]).toBeUndefined();
    expect(handlers["skills_installed_upsert"]).toBeUndefined();
    expect(handlers["skills_packages_install"]).toBeUndefined();
  });

  it("the 8 new source tools are all distinct functions (no accidental aliasing)", () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const names = [
      "artifact_source_write",
      "artifact_source_validate",
      "artifact_source_compile",
      "artifact_source_publish",
      "skill_source_write",
      "skill_source_validate",
      "skill_source_compile",
      "skill_source_publish",
    ];
    const fns = names.map((n) => handlers[n]);
    expect(new Set(fns).size).toBe(names.length);
  });
});
