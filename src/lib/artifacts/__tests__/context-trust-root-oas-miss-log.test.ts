// cinatra#2297 AC4 — "the failure is legible".
//
// When the context trust root cannot produce an installed OAS, the SERVER LOG
// must name the resolved extension data root AND every read root that was
// probed, with its concrete path. Before #2297 a miss produced only the
// stable-code rejection line, which named neither — so a developer hitting
// `404 oas_missing` (or, on a composed child, `403
// attestation_node_unrecognized`) had nothing to look at.
//
// The counterpart invariant is pinned here too: those filesystem paths stay
// SERVER-SIDE. The route returns `{ error: code, message: err.message }`, so
// this suite asserts the ContextRouteError message carries the package name
// and NO path.
//
// Real files under a temp runtime mount root; `readInstalledOas` and the
// shared probe run for real (same fixture style as the multi-vendor suite).
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

const MOUNT_ROOT = mkdtempSync(join(tmpdir(), "ctx-oas-miss-mount-"));
const DEV_SOURCE_ROOT = mkdtempSync(join(tmpdir(), "ctx-oas-miss-dev-"));
const DATA_ROOT = "/data/extensions-under-test";

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunByTokenHash: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  readAgentTemplateById: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => MOUNT_ROOT,
  resolveDevExtensionSourceRoot: () => DEV_SOURCE_ROOT,
}));
vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => DATA_ROOT,
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/a2a-auth", () => ({ verifyLangGraphBridgeToken: () => ({ ok: true }) }));
vi.mock("@/lib/agent-run-actor-resolve", () => ({ resolveAgentRunMcpActor: vi.fn() }));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: async () => [],
  readProjectGrantsForUser: async () => [],
}));
vi.mock("@cinatra-ai/mcp-server/obo-ceiling", () => ({
  deriveOboCeilingChain: () => null,
  oboCeilingContains: () => false,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({ sub: "user-1", organizationId: "org-1" }),
}));
vi.mock("../context-mcp", () => ({ getInstalledExtensionDescriptors: () => [] }));
vi.mock("../context-resolver", () => ({ resolveContextSlot: () => [] }));

const { loadTrustedSlot } = await import("../context-route-io");
const { ContextRouteError } = await import("../context-route-support");

const MISS_PKG = "@cinatra-ai/not-installed-anywhere-agent";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  // A well-formed but UNREADABLE installed OAS for the `unreadable` case.
  const dir = join(MOUNT_ROOT, "cinatra-ai", "corrupt-agent", "cinatra");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oas.json"), "{ this is not json");
});

afterAll(() => {
  rmSync(MOUNT_ROOT, { recursive: true, force: true });
  rmSync(DEV_SOURCE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CINATRA_RUNTIME_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
});

/** The one `[context-route] installed-oas miss …` line, or "". */
function missLine(): string {
  return (
    warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[context-route] installed-oas miss")) ?? ""
  );
}

async function expectOasMissing(promise: Promise<unknown>): Promise<string> {
  let message = "";
  await promise.then(
    () => {
      throw new Error("expected ContextRouteError, got success");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(ContextRouteError);
      const err = e as InstanceType<typeof ContextRouteError>;
      expect(err.status).toBe(404);
      expect(err.code).toBe("oas_missing");
      message = err.message;
    },
  );
  return message;
}

describe("context trust-root OAS miss — server-log legibility (cinatra#2297 AC4)", () => {
  it("names the resolved extension data root and the probed runtime mount", async () => {
    await expectOasMissing(loadTrustedSlot(MISS_PKG, "anySlot"));
    const line = missLine();
    expect(line).toContain(`pkg=${MISS_PKG}`);
    expect(line).toContain("reason=not_found");
    expect(line).toContain(`extension-data-root=${JSON.stringify(DATA_ROOT)}`);
    expect(line).toContain(`runtime-mount=${JSON.stringify(MOUNT_ROOT)}`);
    expect(line).toContain("probed=1");
    // Production posture: the dev root is NOT probed and NOT named.
    expect(line).not.toContain("dev-source");
  });

  it("names BOTH roots when the dev gate is open", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    vi.stubEnv("NODE_ENV", "development");
    await expectOasMissing(loadTrustedSlot(MISS_PKG, "anySlot"));
    const line = missLine();
    expect(line).toContain("probed=2");
    expect(line).toContain(`runtime-mount=${JSON.stringify(MOUNT_ROOT)}`);
    expect(line).toContain(`dev-source=${JSON.stringify(DEV_SOURCE_ROOT)}`);
  });

  it("distinguishes an UNREADABLE installed OAS and names the file", async () => {
    await expectOasMissing(loadTrustedSlot("@cinatra-ai/corrupt-agent", "anySlot"));
    const line = missLine();
    expect(line).toContain("reason=unreadable");
    expect(line).toContain(
      `path=${JSON.stringify(join(MOUNT_ROOT, "cinatra-ai", "corrupt-agent", "cinatra", "oas.json"))}`,
    );
  });

  it("keeps filesystem paths OUT of the error the route returns to callers", async () => {
    const message = await expectOasMissing(loadTrustedSlot(MISS_PKG, "anySlot"));
    // The route body is `{ error: code, message }` — this message is caller-visible.
    expect(message).toContain(MISS_PKG);
    expect(message).not.toContain(MOUNT_ROOT);
    expect(message).not.toContain(DEV_SOURCE_ROOT);
    expect(message).not.toContain(DATA_ROOT);
    expect(message).not.toContain(".agent-mount");
    expect(message).not.toContain("oas.json");
    // Beyond the package name's own `@vendor/slug` slash, no path separator at
    // all — so no filesystem path can have been interpolated in.
    expect(message.split(MISS_PKG).join("")).not.toMatch(/[/\\]/);
  });
});
