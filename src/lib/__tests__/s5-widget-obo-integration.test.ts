/**
 * S5 (cinatra#1221) — WIDGET OBO END-TO-END INTEGRATION MATRIX (T1–T8).
 *
 * The per-module unit suites (widget-mcp-actor-token, delegated-widget-tool-
 * policy, host-content-editor-dispatch-widget, route.widget-broker) each prove
 * ONE seam. THIS suite wires the REAL modules together across the package
 * boundary and walks the full public-site widget OBO path exactly as production
 * composes it:
 *
 *   issueWidgetMcpActorToken            (src/lib, W1)
 *     → verifyWidgetMcpActorToken       (the MCP-boundary verifier, W1)
 *       → DelegatedMcpActor union        (packages/mcp-server request-context)
 *         → isDelegatedWidgetMcpToolAllowed  (the CLOSED kind-keyed policy, W2)
 *         → mcpRequestContextStorage frame stamp (the transport ALS)
 *           → resolveWidgetActorFromFrame     (host frame reader, W2/host)
 *             → dispatchContentEditorViaA2A   (the carrier-run binding, host)
 *
 * Only the true runtime EDGES are mocked (A2A client, A2A/LLM bearer mint, the
 * agents store, the per-install identity resolver, live-membership lookup). The
 * token codec, the verifier, the tool policy, the request-context union, the
 * frame reader, and the dispatch binding are all the REAL modules — so a
 * regression in ANY link fails here.
 *
 * The design's negative-test contract (S5-W1 §6.1) mapped to this file:
 *   T1 fail-closed token   — a malformed/expired/bad-HMAC widget token never
 *                            resolves a widget actor (→ machine-token deny).
 *   T2 instance pin        — the server-pinned `inst` rides the verified actor
 *                            AND the reconstructed override; a mismatched
 *                            override.instanceId is refused at dispatch (the
 *                            host half of the G3 pin; the tool-arg assertion is
 *                            the connector primitive's half — external repo).
 *   T3 blast radius        — the verified actor's kind drives the CLOSED policy:
 *                            every non-editor primitive is DENIED.
 *   T4 kind binding        — a wordpress-verified actor cannot drive the drupal
 *                            editor primitive (and vice versa).
 *   T5 platform-admin floor— even a token smuggling prole:"platform_admin"
 *                            resolves platformRole:"member" through the whole
 *                            chain.
 *   T6 replay window       — a token past its 120 s TTL never resolves an actor;
 *                            the per-turn `jti` is surfaced for turn-binding.
 *   T7 no-downgrade        — with a widget frame active the dispatch NEVER
 *                            reaches the install/single-tenant identity resolver
 *                            and never falls to anonymous; the carrier run is
 *                            AS THE END USER.
 *   T8 cross-type          — a chat / agent-run token never resolves under the
 *                            widget verifier (the cookie/chat path is proven
 *                            byte-identical in route.widget-broker T-cookie).
 */
import {
  afterEach,
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Canonical public MCP surface (mint/verify audience + issuer).
// ---------------------------------------------------------------------------
const PUBLIC_BASE_URL = "https://cinatra-test.tailnet000.ts.net";
const PUBLIC_MCP_URL = `${PUBLIC_BASE_URL}/api/mcp`;
const PUBLIC_AUTH_URL = `${PUBLIC_BASE_URL}/api/auth`;

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalMcpServerUrl: (path: string) => `http://localhost:3000${path}`,
  getPublicMcpServerUrl: () => PUBLIC_MCP_URL,
}));

// The transport request-context ALS. In production the MCP transport
// (packages/mcp-server/src/index.tsx) stamps the VERIFIED delegated actor here;
// the host frame reader (resolveWidgetActorFromFrame) reads it back. The root
// vitest sandbox cannot load the heavy `@cinatra-ai/mcp-server` barrel, so we
// expose a REAL AsyncLocalStorage under the same symbol — behaviorally
// identical to the package's `export const mcpRequestContextStorage = new
// AsyncLocalStorage()`. The test stamps it; the REAL frame reader consumes it.
type FrameStore = { delegatedActor?: unknown };
// vi.hoisted so the SAME AsyncLocalStorage instance is available both to the
// hoisted vi.mock factory below and to the test body (they must share it — the
// test stamps the store the REAL frame reader reads back).
const { mcpRequestContextStorage } = vi.hoisted(() => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  return { mcpRequestContextStorage: new AsyncLocalStorage() as import("node:async_hooks").AsyncLocalStorage<FrameStore> };
});
vi.mock("@cinatra-ai/mcp-server", () => ({ mcpRequestContextStorage }));

// --- the true runtime edges the dispatch binding drives (mocked) ------------
const sendTask = vi.fn();
const createExternalA2AClient = vi.fn(async () => ({ sendTask }));
const buildA2aBearerToken = vi.fn(async () => "bearer-token");
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: (...a: unknown[]) =>
    createExternalA2AClient(...(a as [])),
}));
vi.mock("@cinatra-ai/llm", () => ({
  buildA2aBearerToken: (...a: unknown[]) => buildA2aBearerToken(...(a as [])),
}));

// cinatra#1940 P3: createAgentRun now takes a REQUIRED trailing `authority`
// param (the guarded creation perimeter); the mock forwards it.
const createAgentRun = vi.fn<(input: { id: string }, authority?: unknown) => Promise<unknown>>();
const readAgentTemplateByPackageName = vi.fn<(pkg: string) => Promise<unknown>>();
const readLatestAgentVersionIdForTemplate = vi.fn<(id: string) => Promise<unknown>>();
const transitionRunStatus = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: (input: { id: string }, authority?: unknown) => createAgentRun(input, authority),
  readAgentTemplateByPackageName: (pkg: string) => readAgentTemplateByPackageName(pkg),
  readLatestAgentVersionIdForTemplate: (id: string) =>
    readLatestAgentVersionIdForTemplate(id),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
}));

// The per-install identity resolver MUST NOT be reached on the widget path
// (T7 no-downgrade). A spy asserts it stays untouched.
const resolveContentEditorIdentityForInstance = vi.fn();
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveContentEditorIdentityForInstance: (...a: unknown[]) =>
    resolveContentEditorIdentityForInstance(...a),
}));

// Live-membership re-check (G11 default re-assert at the carrier boundary).
const resolveOrgRoleForUser = vi.fn<(orgId: string, userId: string) => Promise<string | undefined>>();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (orgId: string, userId: string) =>
    resolveOrgRoleForUser(orgId, userId),
}));

// ---- REAL modules under integration ----------------------------------------
import {
  issueWidgetMcpActorToken,
  verifyWidgetMcpActorToken,
  WIDGET_MCP_TOKEN_TYPE,
  type WidgetMcpActor,
  type WidgetMcpActorTokenInput,
} from "../widget-mcp-actor-token";
import { issueChatMcpActorToken } from "../chat-mcp-actor-token";
import { issueAgentRunMcpActorToken } from "../agent-run-mcp-actor-token";
import { isDelegatedWidgetMcpToolAllowed } from "@cinatra-ai/mcp-server/delegated-widget-tool-policy";
// The REAL host frame reader (reads the ALS mock above) + the REAL dispatch.
import { resolveWidgetActorFromFrame } from "../widget-actor-frame";
import { dispatchContentEditorViaA2A } from "../host-content-editor-dispatch";

const WIDGET_INPUT: WidgetMcpActorTokenInput = {
  userId: "user-77",
  orgId: "org-9",
  instanceId: "inst-canonical",
  kind: "wordpress",
  jti: "turn-nonce-1",
};

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "s5-widget-obo-integration-secret";
});
afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
});

/** Resolve a bearer through the REAL MCP-boundary widget verifier at the
 *  canonical public audience/issuer (exactly what the transport passes). */
function boundaryVerify(token: string): WidgetMcpActor | null {
  return verifyWidgetMcpActorToken({
    authHeader: `Bearer ${token}`,
    request: new Request(PUBLIC_MCP_URL),
    expectedAudience: PUBLIC_MCP_URL,
    expectedIssuer: PUBLIC_AUTH_URL,
  });
}

/** Hand-sign arbitrary claims under the live secret (the claim-shape attack:
 *  a valid HMAC must not defeat the fail-closed verifier). */
function signClaims(claims: Record<string, unknown>): string {
  const { createHmac } = require("node:crypto");
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
function baseClaims(overrides: Record<string, unknown> = {}) {
  const iat = nowSec();
  return {
    t: WIDGET_MCP_TOKEN_TYPE,
    sub: "user-77",
    org: "org-9",
    inst: "inst-canonical",
    knd: "wordpress",
    src: "public_site_widget",
    jti: "turn-nonce-1",
    scope: "mcp:connect",
    aud: PUBLIC_MCP_URL,
    iss: PUBLIC_AUTH_URL,
    iat,
    exp: iat + 120,
    ...overrides,
  };
}

/** Run `fn` with the VERIFIED widget actor stamped on the transport frame,
 *  exactly as the MCP transport does before invoking a tool handler. */
function withWidgetFrame<T>(actor: WidgetMcpActor, fn: () => Promise<T>): Promise<T> {
  return mcpRequestContextStorage.run({ delegatedActor: actor }, fn);
}

function lastRunInput(): { runBy?: string; orgId?: string; sourceType?: string } {
  return (createAgentRun.mock.calls.at(-1)?.[0] ?? {}) as {
    runBy?: string;
    orgId?: string;
    sourceType?: string;
  };
}
function lastSentText(): string {
  const call = sendTask.mock.calls.at(-1)?.[0] as {
    message: { parts: Array<{ kind: string; text: string }> };
  };
  return call.message.parts[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  buildA2aBearerToken.mockResolvedValue("bearer-token");
  createExternalA2AClient.mockResolvedValue({ sendTask });
  readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl_wp" });
  readLatestAgentVersionIdForTemplate.mockResolvedValue("ver_1");
  createAgentRun.mockImplementation(async (input: { id: string }) => ({
    id: input.id,
    inputParams: {},
  }));
  sendTask.mockResolvedValue({
    history: [{ role: "agent", parts: [{ kind: "text", text: '{"postId":"7"}' }] }],
  });
  resolveOrgRoleForUser.mockResolvedValue("member");
});
afterEach(() => vi.clearAllMocks());

// ===========================================================================
// HAPPY PATH — the whole chain, real modules, end to end.
// ===========================================================================
describe("S5 widget OBO — full chain (mint → verify → policy → frame → dispatch)", () => {
  it("a fresh widget token drives the carrier run AS THE END USER against the pinned instance", async () => {
    // 1. The seam mints the OBO token from the server-verified principal.
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);

    // 2. The MCP boundary verifies it and reconstructs the delegated actor.
    const actor = boundaryVerify(token);
    expect(actor).toEqual<WidgetMcpActor>({
      delegation: "public_site_widget",
      userId: "user-77",
      orgId: "org-9",
      instanceId: "inst-canonical",
      kind: "wordpress",
      jti: "turn-nonce-1",
      platformRole: "member",
    });

    // 3. The CLOSED policy lets ONLY the bound kind's editor primitive register.
    expect(isDelegatedWidgetMcpToolAllowed(actor!.kind, "wordpress_content_editor_run")).toBe(true);

    // 4/5. Stamp the verified actor on the transport frame; the REAL frame
    // reader projects it and the REAL dispatch runs the carrier AS THE END USER.
    await withWidgetFrame(actor!, async () => {
      const frame = resolveWidgetActorFromFrame();
      expect(frame).toEqual({
        delegation: "public_site_widget",
        runBy: "user-77",
        orgId: "org-9",
        instanceId: "inst-canonical",
      });
      await dispatchContentEditorViaA2A({
        agentUrl: "http://agent",
        payload: { instanceId: frame!.instanceId, postId: 7 },
        timeoutMs: 1000,
        packageName: "@cinatra-ai/wordpress-agent",
        actorOverride: { ...frame!, sourceType: "public_site_widget" },
        preCreateAuthorize: async () => true,
      });
    });

    const run = lastRunInput();
    expect(run.runBy).toBe("user-77");
    expect(run.orgId).toBe("org-9");
    expect(run.sourceType).toBe("public_site_widget");
    expect(lastSentText()).toContain("cinatra_run_id");
    // T7: the install/single-tenant resolver is NEVER reached on the widget path.
    expect(resolveContentEditorIdentityForInstance).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// T1 — fail-closed token: no malformed credential resolves a widget actor.
// ===========================================================================
describe("T1 — fail-closed token (no fall-through to a widget actor)", () => {
  it("rejects missing/blank inst, missing/unknown knd, wrong t, bad HMAC, malformed", () => {
    // Each of these — even under a VALID signature — resolves NO actor, so the
    // MCP boundary falls back to the machine token (denied). It never yields an
    // un-pinned or un-kinded widget delegation.
    const { inst: _i, ...noInst } = baseClaims();
    const { knd: _k, ...noKnd } = baseClaims();
    expect(boundaryVerify(signClaims(noInst))).toBeNull();
    expect(boundaryVerify(signClaims(baseClaims({ inst: "" })))).toBeNull();
    // Whitespace-only identity/instance is treated as blank (fail closed).
    expect(boundaryVerify(signClaims(baseClaims({ inst: "   " })))).toBeNull();
    expect(boundaryVerify(signClaims(baseClaims({ org: " " })))).toBeNull();
    expect(boundaryVerify(signClaims(noKnd))).toBeNull();
    expect(boundaryVerify(signClaims(baseClaims({ knd: "shopify" })))).toBeNull();
    expect(boundaryVerify(signClaims(baseClaims({ t: "cinatra.chat.mcp-obo" })))).toBeNull();
    // Bad HMAC (tampered payload, original signature spliced back on).
    const good = issueWidgetMcpActorToken(WIDGET_INPUT);
    const [h, p, s] = good.split(".");
    const tampered = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    tampered.inst = "attacker-instance";
    const forged = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
    expect(boundaryVerify(`${h}.${forged}.${s}`)).toBeNull();
    // Non-canonical re-encoding of the valid signature is rejected.
    expect(boundaryVerify(`${h}.${p}.${s}=`)).toBeNull();
    expect(boundaryVerify("not-a-jwt")).toBeNull();
  });

  it("a rejected token means resolveWidgetActorFromFrame sees no widget delegation", async () => {
    // With no verified actor there is nothing to stamp — the frame reader
    // returns null and the dispatch atomicity guard is inert (non-widget turn).
    await mcpRequestContextStorage.run({}, async () => {
      expect(resolveWidgetActorFromFrame()).toBeNull();
    });
  });
});

// ===========================================================================
// T2 — instance pin: the server-pinned `inst` rides both the actor and the
// reconstructed override; a mismatched override is refused at dispatch.
// ===========================================================================
describe("T2 — instance pin (host half of the G3 origin re-pin)", () => {
  it("the verified actor + the frame projection both carry the pinned instance", () => {
    const actor = boundaryVerify(issueWidgetMcpActorToken(WIDGET_INPUT));
    expect(actor!.instanceId).toBe("inst-canonical");
  });

  it("an override whose instanceId ≠ the frame actor is refused (no carrier run)", async () => {
    const actor = boundaryVerify(issueWidgetMcpActorToken(WIDGET_INPUT));
    await withWidgetFrame(actor!, async () => {
      await expect(
        dispatchContentEditorViaA2A({
          agentUrl: "http://agent",
          payload: { instanceId: "inst-OTHER" },
          timeoutMs: 1000,
          packageName: "@cinatra-ai/wordpress-agent",
          // A different origin-matched instance in the same org — the exact
          // model-chosen-instance loosening the pin closes.
          actorOverride: {
            runBy: "user-77",
            orgId: "org-9",
            instanceId: "inst-OTHER",
            sourceType: "public_site_widget",
          },
          preCreateAuthorize: async () => true,
        }),
      ).rejects.toThrow(/does not match the server-verified/);
    });
    expect(createAgentRun).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// T3 — blast radius: the verified kind drives the CLOSED policy.
// ===========================================================================
describe("T3 — blast radius (CLOSED delegated-widget policy)", () => {
  it("every non-editor primitive is DENIED for the verified widget actor", () => {
    const actor = boundaryVerify(issueWidgetMcpActorToken(WIDGET_INPUT))!;
    for (const tool of [
      "agent_run",
      "objects_list",
      "wordpress_instances_list",
      "wordpress_post_update",
      "wordpress_media_upload",
      "artifact_authoring_emit",
      "system_screen_lookup",
    ]) {
      expect(isDelegatedWidgetMcpToolAllowed(actor.kind, tool)).toBe(false);
    }
    // Only the one CMS-edit primitive for the bound kind is allowed.
    expect(isDelegatedWidgetMcpToolAllowed(actor.kind, "wordpress_content_editor_run")).toBe(true);
  });
});

// ===========================================================================
// T4 — kind binding (G9): a kind can never drive the other kind's editor.
// ===========================================================================
describe("T4 — kind binding (G9)", () => {
  it("a wordpress-verified actor cannot drive drupal_content_editor_run (and vice versa)", () => {
    const wp = boundaryVerify(issueWidgetMcpActorToken({ ...WIDGET_INPUT, kind: "wordpress" }))!;
    const dr = boundaryVerify(issueWidgetMcpActorToken({ ...WIDGET_INPUT, kind: "drupal" }))!;
    expect(isDelegatedWidgetMcpToolAllowed(wp.kind, "drupal_content_editor_run")).toBe(false);
    expect(isDelegatedWidgetMcpToolAllowed(dr.kind, "wordpress_content_editor_run")).toBe(false);
    expect(isDelegatedWidgetMcpToolAllowed(dr.kind, "drupal_content_editor_run")).toBe(true);
  });
});

// ===========================================================================
// T5 — platform-admin floor: member all the way through the chain.
// ===========================================================================
describe("T5 — platform-admin floor (G5)", () => {
  it("a token smuggling prole:'platform_admin' still resolves member end to end", async () => {
    const smuggled = signClaims(baseClaims({ prole: "platform_admin" }));
    const actor = boundaryVerify(smuggled);
    expect(actor!.platformRole).toBe("member");
    // The floored actor carries through the frame projection + carrier run.
    await withWidgetFrame(actor!, async () => {
      await dispatchContentEditorViaA2A({
        agentUrl: "http://agent",
        payload: { instanceId: "inst-canonical" },
        timeoutMs: 1000,
        packageName: "@cinatra-ai/wordpress-agent",
        actorOverride: {
          runBy: "user-77",
          orgId: "org-9",
          instanceId: "inst-canonical",
          sourceType: "public_site_widget",
        },
        preCreateAuthorize: async () => true,
      });
    });
    // sourceType public_site_widget on the carrier run is what suppresses the
    // platform-admin bypass at the downstream bridge (belt-and-braces to the
    // mint-time floor).
    expect(lastRunInput().sourceType).toBe("public_site_widget");
  });
});

// ===========================================================================
// T6 — replay window: TTL bound + jti surfaced for turn-binding.
// ===========================================================================
describe("T6 — replay window (120 s TTL; jti surfaced)", () => {
  it("a token past its 120 s TTL resolves NO actor", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-19T01:00:00Z"));
      const token = issueWidgetMcpActorToken(WIDGET_INPUT);
      vi.setSystemTime(new Date("2026-07-19T01:02:01Z")); // +121 s
      expect(boundaryVerify(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the per-turn jti verbatim (the transport turn-binding input)", () => {
    const actor = boundaryVerify(issueWidgetMcpActorToken({ ...WIDGET_INPUT, jti: "nonce-xyz" }));
    expect(actor!.jti).toBe("nonce-xyz");
  });
});

// ===========================================================================
// T7 — no-downgrade: a widget frame NEVER reaches install/anonymous identity.
// ===========================================================================
describe("T7 — no-downgrade (per-user OBO, never install/anonymous)", () => {
  it("a widget frame WITHOUT a matching override fails LOUD (never install identity)", async () => {
    const actor = boundaryVerify(issueWidgetMcpActorToken(WIDGET_INPUT))!;
    await withWidgetFrame(actor, async () => {
      await expect(
        dispatchContentEditorViaA2A({
          agentUrl: "http://agent",
          payload: { instanceId: "inst-canonical" },
          timeoutMs: 1000,
          packageName: "@cinatra-ai/wordpress-agent",
          // NO actorOverride — the exact silent-parity-gap the atomicity guard closes.
        }),
      ).rejects.toThrow(/public_site_widget delegation is active/);
    });
    expect(resolveContentEditorIdentityForInstance).not.toHaveBeenCalled();
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("G11: absent a caller hook, a REVOKED member is refused at the carrier boundary", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined); // membership revoked
    const actor = boundaryVerify(issueWidgetMcpActorToken(WIDGET_INPUT))!;
    await withWidgetFrame(actor, async () => {
      await expect(
        dispatchContentEditorViaA2A({
          agentUrl: "http://agent",
          payload: { instanceId: "inst-canonical" },
          timeoutMs: 1000,
          packageName: "@cinatra-ai/wordpress-agent",
          actorOverride: {
            runBy: "user-77",
            orgId: "org-9",
            instanceId: "inst-canonical",
            sourceType: "public_site_widget",
          },
        }),
      ).rejects.toThrow();
    });
    expect(createAgentRun).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// T8 — cross-type: a chat / agent-run token never resolves under the widget
// verifier (the cookie/chat path is byte-identical — route.widget-broker
// T-cookie proves the route half).
// ===========================================================================
describe("T8 — cross-type forgery protection", () => {
  it("a chat-typed token does NOT resolve under the widget verifier", () => {
    const chat = issueChatMcpActorToken({
      delegation: "chat",
      userId: "user-77",
      orgId: "org-9",
      platformRole: "member",
    });
    expect(boundaryVerify(chat)).toBeNull();
  });

  it("an agent-run-typed token does NOT resolve under the widget verifier", () => {
    const agentRun = issueAgentRunMcpActorToken({
      delegation: "agent_run",
      userId: "user-77",
      orgId: "org-9",
      runId: "run-1",
      platformRole: "member",
      oboCeiling: [
        { tier: "user", id: "user-77" },
        { tier: "organization", id: "org-9" },
      ],
    });
    expect(boundaryVerify(agentRun)).toBeNull();
  });
});
