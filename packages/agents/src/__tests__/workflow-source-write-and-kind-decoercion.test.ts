/**
 * SDK-P5 — declarative WORKFLOW package source-authoring + the
 * de-coercion of the agent-only `cinatra.kind` write path.
 *
 * Two cohesive concerns:
 *  1. `agent_source_write_files` no longer HARD-coerces kind to "agent": it is
 *     parametric over an optional `kind`. The agent path (no kind, or kind:
 *     "agent") is byte-for-byte unchanged; an unsupported/connector kind is
 *     rejected.
 *  2. The new `workflow_source_write` materializes a WORKFLOW EXTENSION PACKAGE
 *     (package.json with cinatra.kind="workflow" + cinatra/workflow.bpmn),
 *     validates the BPMN before writing (fail-closed), and is DISTINCT from the
 *     workflow_draft_* runtime tools.
 *
 * The @cinatra-ai/workflows BPMN + spec validators are NOT mocked — they run
 * for real (no DB) so the validation chain is exercised end-to-end.
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
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: vi.fn(() => ({})),
}));
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

const VALID_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0" id="d" targetNamespace="http://cinatra.ai/schema/bpmn/profile-1.0">
  <bpmn:process id="mini" name="Mini" isExecutable="false">
    <bpmn:extensionElements>
      <cinatra:workflowMeta name="{{product}} mini" product="{{product}}" />
      <cinatra:placeholders><cinatra:placeholder name="product" type="string" required="true" /></cinatra:placeholders>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start" name="Start" />
    <bpmn:userTask id="kick" name="Kickoff"><bpmn:extensionElements><cinatra:taskKind value="checkpoint" /><cinatra:taskSchedule mode="relative" anchor="target" offsetIso8601="P1D" direction="before" /></bpmn:extensionElements></bpmn:userTask>
    <bpmn:endEvent id="end" name="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="kick" />
    <bpmn:sequenceFlow id="f2" sourceRef="kick" targetRef="end" />
  </bpmn:process>
</bpmn:definitions>`;

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wf-source-"));
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

describe("agent_source_write_files — kind de-coercion (parametric, default agent)", () => {
  it("explicit kind: 'agent' behaves identically to the legacy default", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
    const result = (await handler(
      req("agent_source_write_files", {
        packageSlug: "agent-explicit",
        kind: "agent",
        packageJson: JSON.stringify({ name: "@cinatra/agent-explicit", version: "0.1.0", cinatra: { kind: "skill" } }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { written?: boolean };
    expect(result.written).toBe(true);
    const written = await readPkgJson("agent-explicit");
    // stale "skill" still coerced to "agent" for the agent path.
    expect((written.cinatra as Record<string, unknown>).kind).toBe("agent");
  });

  it("rejects an unsupported kind", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
    const result = (await handler(
      req("agent_source_write_files", {
        packageSlug: "bad-kind",
        kind: "nonsense",
        packageJson: JSON.stringify({ name: "@cinatra/bad-kind", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { error?: string };
    expect(result.error).toMatch(/Unsupported kind/);
  });

  it("rejects connector kind (gated on SDK-P0)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
    const result = (await handler(
      req("agent_source_write_files", {
        packageSlug: "conn",
        kind: "connector",
        packageJson: JSON.stringify({ name: "@cinatra/conn", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { error?: string };
    expect(result.error).toMatch(/Connector authoring is not available/);
  });
});

describe("workflow_source_write — declarative workflow PACKAGE authoring", () => {
  const SLUG = "demo-launch-workflow";

  it("writes a workflow package: cinatra.kind=workflow + cinatra/workflow.bpmn", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["workflow_source_write"];
    const result = (await handler(
      req("workflow_source_write", {
        packageSlug: SLUG,
        packageJson: JSON.stringify({ name: `@cinatra/${SLUG}`, version: "0.1.0", license: "Apache-2.0" }),
        workflowBpmn: VALID_BPMN,
      }),
    )) as { written?: boolean; kind?: string; paths?: Record<string, string> };
    expect(result.written).toBe(true);
    expect(result.kind).toBe("workflow");

    const written = await readPkgJson(SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("workflow");
    expect(cinatra.apiVersion).toBe("cinatra.ai/v1");
    expect(cinatra.workflowVersion).toBe(1);
    // name rescoped to canonical @cinatra-ai scope (vendor identity empty in test).
    expect(written.name).toBe(`@cinatra-ai/${SLUG}`);

    const bpmnOnDisk = await fs.readFile(path.join(tmpRoot, "cinatra-ai", SLUG, "cinatra", "workflow.bpmn"), "utf-8");
    expect(bpmnOnDisk).toContain("bpmn:process");
  });

  it("fails closed on a structurally-invalid BPMN (nothing lands on disk)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["workflow_source_write"];
    const result = (await handler(
      req("workflow_source_write", {
        packageSlug: "bad-workflow",
        packageJson: JSON.stringify({ name: "@cinatra/bad-workflow", version: "0.1.0", license: "Apache-2.0" }),
        workflowBpmn: "<not-valid-bpmn/>",
      }),
    )) as { error?: string; valid?: boolean };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/workflow\.bpmn failed validation/);
    // no package dir created
    await expect(fs.access(path.join(tmpRoot, "cinatra-ai", "bad-workflow"))).rejects.toBeTruthy();
  });

  it("rejects a literal credential in package files (review_blocked)", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["workflow_source_write"];
    const result = (await handler(
      req("workflow_source_write", {
        packageSlug: "cred-workflow",
        packageJson: JSON.stringify({
          name: "@cinatra/cred-workflow",
          version: "0.1.0",
          license: "Apache-2.0",
          scripts: { leak: "echo sk-test1234567890abcdef1234567890ABCDEF12" },
        }),
        workflowBpmn: VALID_BPMN,
      }),
    )) as { code?: string };
    expect(result.code).toBe("review_blocked");
  });

  it("workflow_source_validate accepts a valid BPMN string", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["workflow_source_validate"];
    const result = (await handler(
      req("workflow_source_validate", { content: VALID_BPMN }),
    )) as { valid?: boolean; errors?: string[] };
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("write → compile runs the full on-disk sidecar/package validation", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "compile-demo-workflow";
    const wrote = (await handlers["workflow_source_write"](
      req("workflow_source_write", {
        packageSlug: slug,
        packageJson: JSON.stringify({ name: `@cinatra/${slug}`, version: "0.1.0", license: "Apache-2.0" }),
        workflowBpmn: VALID_BPMN,
      }),
    )) as { written?: boolean };
    expect(wrote.written).toBe(true);

    const compiled = (await handlers["workflow_source_compile"](
      req("workflow_source_compile", { packageSlug: slug }),
    )) as { compiled?: boolean; valid?: boolean; error?: string };
    expect(compiled.error).toBeUndefined();
    expect(compiled.compiled).toBe(true);
    expect(compiled.valid).toBe(true);
  });

  it("publish refuses a package with no detectable license (parity with agent publish)", async () => {
    const handlers = createAgentBuilderPrimitiveHandlers();
    const slug = "no-license-workflow";
    await handlers["workflow_source_write"](
      req("workflow_source_write", {
        packageSlug: slug,
        // no `license` field → detectSpdxLicense returns tier "reject" (missing)
        packageJson: JSON.stringify({ name: `@cinatra/${slug}`, version: "0.1.0" }),
        workflowBpmn: VALID_BPMN,
      }),
    );
    const result = (await handlers["workflow_source_publish"](
      req("workflow_source_publish", { packageSlug: slug }),
    )) as { error?: string; code?: string };
    expect(result.error).toBeDefined();
    expect(result.code).toBeDefined(); // LICENSE_DETECTION_REJECTED
  });

  it("non-admin is rejected at the write boundary", async () => {
    const handler = createAgentBuilderPrimitiveHandlers()["workflow_source_write"];
    const result = (await handler({
      primitiveName: "workflow_source_write",
      input: { packageSlug: "x", packageJson: "{}", workflowBpmn: VALID_BPMN },
      actor: { actorType: "user", source: "ui", userId: "u-member", platformRole: "member" },
      mode: "deterministic",
    })) as { error?: string };
    expect(result.error).toMatch(/session required to write/);
  });
});
