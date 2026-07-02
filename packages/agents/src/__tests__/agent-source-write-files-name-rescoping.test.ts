/**
 * Server-side `package.json#name` rescoping in `agent_source_write_files`.
 *
 * Bug: chat-LLMs often emit `name: "@cinatra/<slug>"` even when the operator's
 * vendor namespace is different (e.g. "@acme"). That creates a mismatch
 * between the package's manifest scope and the operator's published scope
 * (see actions.ts:393-398 — origin scope is derived from instanceNamespace,
 * not from package.json#name). Fix: server-side coerce `name` to
 * `@<vendorName>/<packageSlug>` before writing.
 *
 * Coercion policy: the `packageSlug` argument is authoritative; the operator's
 * `vendorName` / `instanceNamespace` is authoritative; the LLM-emitted name is
 * advisory and gets overwritten.
 * Fallback chain: `vendorName` → `instanceNamespace` → "cinatra".
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
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => { throw new Error("not used"); },
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
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
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
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
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
  AuthzError: class extends Error { statusCode = 403; reason = "denied"; },
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("../store", () => ({ resolveDefaultOrgId: vi.fn(async () => "org-1") }));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const TEST_SLUG = "name-rescope-test";
let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "name-rescope-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
  mockReadInstanceIdentity.mockReset();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function buildRequest(input: { packageSlug: string; packageJson: string; skillMd: string }) {
  return {
    primitiveName: "agent_source_write_files",
    input,
    actor: {
      actorType: "user",
      source: "ui",
      userId: "u-admin",
      platformRole: "platform_admin",
    },
    mode: "deterministic",
  };
}

function getHandler(): (req: unknown) => Promise<unknown> {
  return createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
}

// The source tree is written under <installRoot>/<vendor>/<slug>/ (cinatra#537),
// where <vendor> is the same namespace the package.json#name is rescoped to —
// e.g. "acme" for an operator on @acme, "cinatra-ai" for the default instance.
// Every test that reads back a written package.json runs on the @acme operator,
// so the on-disk vendor segment is "acme".
async function readWrittenPackageJson(
  slug: string,
  vendor = "acme",
): Promise<Record<string, unknown>> {
  const p = path.join(tmpRoot, vendor, slug, "package.json");
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("agent_source_write_files — package.json#name rescoping", () => {
  it("operator on @acme: '@cinatra/foo' coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@cinatra/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { written?: boolean; nameNormalized?: { from: string; to: string } };

    expect(result.written).toBe(true);
    expect(result.nameNormalized).toEqual({ from: "@cinatra/foo", to: `@acme/${TEST_SLUG}` });
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("operator on @acme: already-correct '@acme/<packageSlug>' is preserved (no nameNormalized)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: `@acme/${TEST_SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { written?: boolean; nameNormalized?: unknown };

    expect(result.written).toBe(true);
    expect(result.nameNormalized).toBeUndefined();
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("operator on @acme: scope-correct but slug-mismatched ('@acme/wrong') coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@acme/wrong-slug", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized).toEqual({ from: "@acme/wrong-slug", to: `@acme/${TEST_SLUG}` });
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("operator on @acme: unscoped name ('foo') coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized).toEqual({ from: "foo", to: `@acme/${TEST_SLUG}` });
  });

  it("operator on @acme: missing name field coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string | null; to: string } };

    expect(result.nameNormalized).toEqual({ from: null, to: `@acme/${TEST_SLUG}` });
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("no identity in store → falls back to '@cinatra-ai/<packageSlug>' (handler-side normalization)", async () => {
    mockReadInstanceIdentity.mockReturnValue(null);
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@something-else/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized?.to).toBe(`@cinatra-ai/${TEST_SLUG}`);
  });

  it("identity present but vendorName/instanceNamespace empty → falls back to 'cinatra-ai'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: undefined, instanceNamespace: undefined });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@x/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized?.to).toBe(`@cinatra-ai/${TEST_SLUG}`);
  });

  it("legacy vendorName (no instanceNamespace) is honored", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: "legacy-vendor" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@cinatra/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized?.to).toBe(`@legacy-vendor/${TEST_SLUG}`);
  });

  it("preserves other package.json fields (version, description, cinatra block)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: "@cinatra/foo",
          version: "0.1.0",
          description: "A test agent",
          cinatra: { kind: "agent", apiVersion: "cinatra.ai/v1" },
        }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
    expect(written.version).toBe("0.1.0");
    expect(written.description).toBe("A test agent");
    expect(written.cinatra).toEqual({ kind: "agent", apiVersion: "cinatra.ai/v1" });
  });

  it("rejects non-object packageJson with a clear error", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify(["not", "an", "object"]),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/packageJson must be a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// cinatra#537 — the oas.json writer (agent_source_write), the package.json
// writer (agent_source_write_files), and the package.json#name MUST all derive
// ONE vendor segment for a hyphenated-scope operator. Before the fix, the
// oas.json writer hardcoded "cinatra-ai", so a user agent on a hyphenated
// vendor (e.g. "marcushorndt-local") was split across
// extensions/cinatra-ai/<slug>/cinatra/oas.json and
// extensions/marcushorndt-local/<slug>/package.json — three identities for one
// agent.
// ---------------------------------------------------------------------------
describe("agent source writers agree on one vendor segment for a hyphenated scope (cinatra#537)", () => {
  const HYPHEN_VENDOR = "marcushorndt-local";
  const SLUG = "page-summarizer-agent";

  function getWriteFilesHandler(): (req: unknown) => Promise<unknown> {
    return createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
  }
  function actor() {
    return { actorType: "user", source: "ui", userId: "u-admin", platformRole: "platform_admin" };
  }

  it("resolveInstanceVendorSegment returns the hyphenated vendor verbatim (no '-' split)", async () => {
    const mod = (await import("../mcp/handlers")) as unknown as {
      __resolveInstanceVendorSegment: () => string;
    };
    mockReadInstanceIdentity.mockReturnValue({ vendorName: HYPHEN_VENDOR });
    expect(mod.__resolveInstanceVendorSegment()).toBe(HYPHEN_VENDOR);
  });

  it("the oas.json WRITE resolver and the package.json writer share ONE vendor dir (not cinatra-ai)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: HYPHEN_VENDOR });

    // (a) The oas.json writer's resolver — previously hardcoded "cinatra-ai".
    const mod = (await import("../mcp/handlers")) as unknown as {
      __resolveAgentJsonPathForWrite: (slug: string) => { dir: string; path: string };
    };
    const oasTarget = mod.__resolveAgentJsonPathForWrite(SLUG);
    // oas.json lands at <root>/<vendor>/<slug>/cinatra/oas.json — the vendor/slug
    // root is the dir two levels up from the cinatra/ dir.
    const oasVendorSlugRoot = path.dirname(path.dirname(oasTarget.path));
    expect(oasVendorSlugRoot).toBe(path.join(process.cwd(), HYPHEN_VENDOR, SLUG));
    expect(oasTarget.path).not.toContain(`${path.sep}cinatra-ai${path.sep}`);

    // (b) The package.json writer (agent_source_write_files).
    const filesRes = (await getWriteFilesHandler()({
      primitiveName: "agent_source_write_files",
      input: {
        packageSlug: SLUG,
        packageJson: JSON.stringify({ name: `@${HYPHEN_VENDOR}/${SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      },
      actor: actor(),
      mode: "deterministic",
    })) as { written?: boolean };
    expect(filesRes.written).toBe(true);

    const pkgVendorSlugRoot = path.join(tmpRoot, HYPHEN_VENDOR, SLUG);
    const pkg = JSON.parse(
      await fs.readFile(path.join(pkgVendorSlugRoot, "package.json"), "utf-8"),
    ) as { name?: string };
    // package.json#name vendor === on-disk vendor === oas.json vendor.
    expect(pkg.name).toBe(`@${HYPHEN_VENDOR}/${SLUG}`);
    expect(oasVendorSlugRoot).toBe(pkgVendorSlugRoot);

    // No first-party-namespace pollution: nothing was written under cinatra-ai/.
    await expect(fs.stat(path.join(tmpRoot, "cinatra-ai", SLUG))).rejects.toThrow();
  });

  it("OAS write + package.json land on the SAME root even when a legacy flat agent.json pre-exists (CodeRabbit data-integrity)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: HYPHEN_VENDOR });
    // Plant a pre-existing LEGACY FLAT layout: <root>/<slug>/agent.json.
    // Previously the OAS writer would overwrite there (legacy root), splitting
    // the agent's identity from the canonical <vendor>/<slug>/ package.json.
    await fs.mkdir(path.join(tmpRoot, SLUG), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, SLUG, "agent.json"), "{}", "utf-8");

    const mod = (await import("../mcp/handlers")) as unknown as {
      __resolveAgentJsonPathForWrite: (slug: string) => { dir: string; path: string };
    };
    const oasTarget = mod.__resolveAgentJsonPathForWrite(SLUG);
    // OAS now ALWAYS resolves to the canonical <vendor>/<slug>/cinatra/oas.json,
    // NOT the legacy flat <slug>/agent.json — the same root as package.json.
    const oasVendorSlugRoot = path.dirname(path.dirname(oasTarget.path));
    expect(oasVendorSlugRoot).toBe(path.join(process.cwd(), HYPHEN_VENDOR, SLUG));
    expect(oasTarget.path.endsWith(path.join("cinatra", "oas.json"))).toBe(true);
    expect(oasTarget.path).not.toContain(`${path.sep}${SLUG}${path.sep}agent.json`);

    // Drive the package.json writer too; assert both share one root.
    const filesRes = (await getWriteFilesHandler()({
      primitiveName: "agent_source_write_files",
      input: {
        packageSlug: SLUG,
        packageJson: JSON.stringify({ name: `@${HYPHEN_VENDOR}/${SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      },
      actor: actor(),
      mode: "deterministic",
    })) as { written?: boolean };
    expect(filesRes.written).toBe(true);
    expect(oasVendorSlugRoot).toBe(path.join(tmpRoot, HYPHEN_VENDOR, SLUG));
  });

  it("the write resolver FAILS CLOSED on a traversal slug (cinatra#537 hardening)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: HYPHEN_VENDOR });
    const mod = (await import("../mcp/handlers")) as unknown as {
      __resolveAgentJsonPathForWrite: (slug: string) => unknown;
      __resolveAgentJsonPathForRead: (slug: string) => unknown;
    };
    // A `..` / separator / leading-~ / leading-@ slug must never reach path.join.
    expect(() => mod.__resolveAgentJsonPathForWrite("..")).toThrow(/unsafe/);
    expect(() => mod.__resolveAgentJsonPathForWrite("a/b")).toThrow(/unsafe/);
    expect(() => mod.__resolveAgentJsonPathForWrite("@..")).toThrow(/unsafe/);
    expect(() => mod.__resolveAgentJsonPathForWrite("@~evil")).toThrow(/unsafe/);
    // The read resolver returns null (no throw) for an unsafe slug — a read miss.
    expect(mod.__resolveAgentJsonPathForRead("..")).toBeNull();
    expect(mod.__resolveAgentJsonPathForRead("../../etc")).toBeNull();
    expect(mod.__resolveAgentJsonPathForRead("@..")).toBeNull();
    expect(mod.__resolveAgentJsonPathForRead("@~evil")).toBeNull();
  });

  it("resolveInstanceVendorSegment FAILS CLOSED on an unsafe identity-derived vendor", async () => {
    const mod = (await import("../mcp/handlers")) as unknown as {
      __resolveInstanceVendorSegment: () => string;
    };
    // A misconfigured identity providing a traversal/separator/@-prefixed vendor
    // must throw rather than silently joining it into the on-disk path.
    mockReadInstanceIdentity.mockReturnValue({ vendorName: "../evil" });
    expect(() => mod.__resolveInstanceVendorSegment()).toThrow(/unsafe/);
    mockReadInstanceIdentity.mockReturnValue({ vendorName: "a/b" });
    expect(() => mod.__resolveInstanceVendorSegment()).toThrow(/unsafe/);
    // A vendor that still carries an "@" (e.g. a mis-stored scoped value) is a
    // leaked malformed segment — the shared guard rejects leading-"@".
    mockReadInstanceIdentity.mockReturnValue({ vendorName: "@evil" });
    expect(() => mod.__resolveInstanceVendorSegment()).toThrow(/unsafe/);
  });
});
