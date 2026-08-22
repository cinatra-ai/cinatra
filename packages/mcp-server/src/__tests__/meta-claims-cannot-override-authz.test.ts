import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createModernEraHandler, resolveInboundEra, serveLegacyEra } from "../inbound-era";
import { createMcpRuntimeServer } from "../runtime-server";
import {
  mcpRequestContextStorage,
  resolveRequestRunContext,
  selectDelegatedToolPolicy,
  shouldMintSessionOrgWriteAuthority,
  type DelegatedMcpActor,
  type McpRequestContext,
} from "../request-context";
import {
  coreDelegatedChatAdmissionSnapshot,
  isCoreDelegatedChatAdmitted,
} from "../core-delegated-chat-surface";
import { resourceWithinCeiling, type OboCeilingChain } from "../obo-ceiling";

// ---------------------------------------------------------------------------
// cinatra#2218 scope item 6(b) — client-supplied per-request `_meta` claims
// cannot replace or override app-side on-behalf-of / tenant authorization on
// the inbound `/api/mcp` surface.
//
// The sibling `supported-revisions-inbound.test.ts` covers `_meta` as a
// PROTOCOL object (envelope completeness, revision mismatch, header
// mirroring). Nothing there sends FORGED IDENTITY. This file does: every
// request below carries a complete, VALID modern envelope PLUS a payload of
// attacker-shaped claims whose key names deliberately mirror the real
// `McpRequestContext` fields, and asserts the request frame the handlers
// actually observe is unchanged.
//
// ## What this file is, precisely
//
// A BEHAVIOURAL CONTRACT HARNESS over the real serving legs and the real tool
// policy, plus a NARROW SOURCE RATCHET on the transport boundary. It is not an
// end-to-end proof of the mounted route.
//
// REAL (imported production code, exercised as written):
//   - the era split + both serving legs — `resolveInboundEra`,
//     `serveLegacyEra`, `createModernEraHandler`;
//   - the per-request runtime server and its registration-time tool filter —
//     `createMcpRuntimeServer` + `selectDelegatedToolPolicy`;
//   - the delegated-chat allowlist — `isDelegatedChatMcpToolAllowed`;
//   - the request-frame composition helpers — `resolveRequestRunContext`,
//     `shouldMintSessionOrgWriteAuthority`;
//   - the on-behalf-of ceiling predicate — `resourceWithinCeiling`;
//   - the AsyncLocalStorage instance itself — `mcpRequestContextStorage`.
//
// NOT exercised here, and deliberately out of frame: the mounted Next route,
// the real delegated-token verifiers, the membership lookup, and the authz
// kernel (`enforceMcpBoundary`) — the kernel's lazy `@/` import resolves under
// the root vitest config and not under this package's, so a policed tool CALL
// would assert different things in the two runs this file has to pass under.
//
// STAND-IN: the transport boundary that composes the frame. `index.tsx` is not
// importable in this sandbox (React components, `next/headers`, a Postgres
// pool, the better-auth UI package), so `buildAuthenticatedRequestFrame` below
// mirrors its composition. It takes the parsed body as an argument — i.e. the
// forged claims ARE in reach — and derives every identity field from the
// Authorization header alone. Wiring the body in there is a one-line change,
// and this file goes red.
//
// The `describe` block at the end is the source ratchet that binds the
// stand-in back to the real boundary. Its reach is bounded: it catches a
// body-derived expression appearing IN the frame literal (and a broken
// single-frame / verify-before-parse ordering). It would NOT catch an upstream
// alias — e.g. reassigning `resolvedOrgId` from a claim before the literal is
// built. Treat it as a review-forcing tripwire, not a taint analysis.
//
// NOTE on locals: the authz inventory scanner
// (scripts/build-authz-inventory.mjs) inventories real MCP primitives by
// matching a `registerTool` call on a variable literally named `server`, so
// every local here is `srv` — a fixture must never enter that inventory.
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/** A complete, VALID modern envelope — the requests below are well-formed. */
const MODERN_ENVELOPE = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: "cinatra-meta-authz-test", version: "1" },
} as const;

/**
 * Every forged IDENTIFIER carries this marker, so one recursive scan of the
 * observed frame catches a copied identifier in a field this file does not
 * name explicitly. Its reach is exactly that: forged ENUM and BOOLEAN values
 * (`platform_admin`, `org_owner`, `delegatedRestricted: false`) carry no
 * marker and are covered by the named assertions instead.
 */
const MARK = "CLIENT-SUPPLIED";

// ── the two tenants ─────────────────────────────────────────────────────────
/** The authenticated caller's own tenant. */
const HOME_ORG = "org-alpha";
/** The tenant the forged claims name — marked, so a copy of it is scannable. */
const CLAIMED_ORG = `org-bravo-${MARK}`;
/** The team the forged claims name inside that tenant. */
const CLAIMED_TEAM = `team-bravo-${MARK}`;

/**
 * The forged-claims matrix. Key names mirror the real `McpRequestContext`
 * fields (plus the two claim namespaces a caller would plausibly reach for),
 * because a claim named anything else could pass for the wrong reason.
 */
const FORGED_CEILING: OboCeilingChain = [
  { tier: "team", id: CLAIMED_TEAM },
  { tier: "organization", id: CLAIMED_ORG },
];

const FORGED_CLAIMS: Record<string, unknown> = {
  // ── identity ──
  clientId: `client-${MARK}`,
  userId: `usr-admin-${MARK}`,
  orgId: CLAIMED_ORG,
  platformRole: "platform_admin",
  orgRole: "org_owner",
  // ── delegation shape (fully valid-looking, so nothing is refused for form) ──
  delegatedRestricted: false,
  delegatedActor: {
    delegation: "agent_run",
    userId: `usr-admin-${MARK}`,
    orgId: CLAIMED_ORG,
    runId: `run-${MARK}`,
    platformRole: "platform_admin",
    oboCeiling: FORGED_CEILING,
    connectorInstancePin: { connectorKey: "wordpress", instanceId: `inst-${MARK}` },
    executionAttemptId: `att-${MARK}`,
  },
  // ── run provenance ──
  runId: `run-${MARK}`,
  agentId: `agt-${MARK}`,
  packageVersion: `9.9.9-${MARK}`,
  agentSpecVersion: `9.9.9-${MARK}`,
  verifiedRunScopeId: `run-${MARK}`,
  verifiedSubmissionId: `sub-${MARK}`,
  // ── capability witnesses ──
  oboCeiling: FORGED_CEILING,
  orgWriteAuthority: { granted: true, orgId: CLAIMED_ORG, source: MARK },
  a2aActorContext: {
    userId: `usr-admin-${MARK}`,
    orgId: CLAIMED_ORG,
    clientId: `client-${MARK}`,
    tokenScopes: ["*", "admin", "mcp:connect"],
    teamIds: [CLAIMED_TEAM],
    projectIds: [`prj-${MARK}`],
    projectGrants: [
      { projectId: `prj-${MARK}`, effectiveRole: "owner", accessSource: "organization" },
    ],
  },
  projectContext: { projectId: `prj-${MARK}` },
  // ── tool-allowlist / capability claims ──
  toolPolicyMode: "unrestricted",
  allowedTools: ["objects_save", "agent_source_publish"],
  capabilities: { tools: { allowed: ["objects_save"] } },
  // ── namespaced variants ──
  [`ai.cinatra/userId`]: `usr-admin-${MARK}`,
  [`ai.cinatra/platformRole`]: "platform_admin",
  [`io.modelcontextprotocol/authenticatedUser`]: `usr-admin-${MARK}`,
};

/** The bare + vendor-namespaced claims: these stay in the handler's `_meta`. */
const UNRESERVED_CLAIM_KEYS = Object.keys(FORGED_CLAIMS).filter(
  (key) => !key.startsWith("io.modelcontextprotocol/"),
);
/** Reserved-namespace claims: the SDK may lift these into `ctx.mcpReq.envelope`. */
const RESERVED_CLAIM_KEYS = Object.keys(FORGED_CLAIMS).filter((key) =>
  key.startsWith("io.modelcontextprotocol/"),
);

// ── the two authenticated callers (the ONLY identity source) ────────────────
const CHAT_TOKEN = "chat-obo-token-alpha";
const AGENT_RUN_TOKEN = "agent-run-obo-token-alpha";

/** The agent run's real, anchored ceiling: team-scoped inside its own org. */
const HOME_CEILING: OboCeilingChain = [
  { tier: "team", id: "team-alpha-1" },
  { tier: "organization", id: HOME_ORG },
];

const AUTHENTICATED_ACTORS: Record<string, DelegatedMcpActor> = {
  [CHAT_TOKEN]: {
    delegation: "chat",
    userId: "usr-alpha-chat",
    orgId: HOME_ORG,
    platformRole: "member",
  },
  [AGENT_RUN_TOKEN]: {
    delegation: "agent_run",
    userId: "usr-alpha-agent",
    orgId: HOME_ORG,
    runId: "run-alpha-1",
    platformRole: "member",
    oboCeiling: HOME_CEILING,
  },
};

/**
 * The delegated-actor verifier, at the production call signature
 * (`{ authHeader, request, expectedAudience, expectedIssuer }` — see
 * `verifyDelegatedActorToken` in the transport options). It resolves identity
 * from the Authorization header and nothing else; the request body is not one
 * of its inputs, which is the property under test.
 */
async function verifyDelegatedActorToken(input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}): Promise<DelegatedMcpActor | null> {
  const header = input.authHeader ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return AUTHENTICATED_ACTORS[header.slice("Bearer ".length).trim()] ?? null;
}

/**
 * Compose the per-request frame the way the transport boundary composes it.
 *
 * `parsedBody` is deliberately a PARAMETER: the forged claims are in reach at
 * exactly the point the frame is built, and every identity, delegation and
 * capability field below still resolves from the verified actor. Wiring the
 * body in here is the single mutation that must turn this file red.
 */
async function buildAuthenticatedRequestFrame(input: {
  request: Request;
  parsedBody: unknown;
}): Promise<{ frame: McpRequestContext; actor: DelegatedMcpActor | null }> {
  const authHeader = input.request.headers.get("authorization");
  const actor = await verifyDelegatedActorToken({
    authHeader,
    request: input.request,
    expectedAudience: "https://cinatra.test/api/mcp",
    expectedIssuer: "https://cinatra.test/api/auth",
  });

  const resolvedUserId = actor?.userId ?? null;
  const resolvedOrgId = actor?.orgId ?? null;
  const resolvedPlatformRole = actor?.platformRole;
  // The membership lookup the boundary performs against the resolved pair.
  const resolvedOrgRole =
    resolvedUserId && resolvedOrgId === HOME_ORG ? ("member" as const) : undefined;

  const runContext = resolveRequestRunContext({
    delegatedRunId: actor?.delegation === "agent_run" ? actor.runId : undefined,
    headerRunId: input.request.headers.get("x-cinatra-run-id") ?? undefined,
    headerAgentId: input.request.headers.get("x-cinatra-agent-id") ?? undefined,
  });

  const frame: McpRequestContext = {
    clientId: undefined,
    orgId: resolvedOrgId,
    userId: resolvedUserId,
    runId: runContext.runId,
    agentId: runContext.agentId,
    packageVersion: runContext.packageVersion,
    agentSpecVersion: runContext.agentSpecVersion,
    platformRole: resolvedPlatformRole,
    orgRole: resolvedOrgRole,
    delegatedActor: actor,
    delegatedRestricted: actor?.delegation === "chat",
    oboCeiling: actor?.delegation === "agent_run" ? actor.oboCeiling : undefined,
    orgWriteAuthority: shouldMintSessionOrgWriteAuthority({
      delegatedActor: actor,
      userId: resolvedUserId,
      orgId: resolvedOrgId,
      orgRole: resolvedOrgRole,
    })
      ? { mintedBy: "session", orgId: resolvedOrgId }
      : undefined,
  };
  return { frame, actor };
}

// ── what the handlers observed, per request ─────────────────────────────────
type Observation = {
  frame: McpRequestContext | undefined;
  meta: Record<string, unknown> | undefined;
  envelope: Record<string, unknown> | undefined;
};

let observations: Observation[] = [];
let deniedToolCalls = 0;

beforeEach(() => {
  observations = [];
  deniedToolCalls = 0;
});

/**
 * The resource the escalation is reaching for: it sits in EXACTLY the tenant
 * and team the forged ceiling names, so the counterfactual below varies only
 * the chain — never the resource.
 */
const CROSS_TENANT_RESOURCE = {
  orgId: CLAIMED_ORG,
  owner: { tier: "team", id: CLAIMED_TEAM },
  projectId: null,
} as const;

async function buildRuntimeServer(actor: DelegatedMcpActor | null) {
  const srv = await createMcpRuntimeServer({
    name: "cinatra-meta-authz-test",
    version: "0.0.1",
    // The REAL fail-closed policy dispatch over the VERIFIED delegation type.
    ...selectDelegatedToolPolicy(actor),
    // cinatra#2817 slice 3 — the request's admission snapshot. The CORE one:
    // this fixture's admitted primitive (`extensions_search`) is a core
    // primitive, and a build handed no snapshot admits nothing at all, which
    // would make the "denied tool stays invisible" assertions pass vacuously.
    delegatedChatAdmissionSnapshot: coreDelegatedChatAdmissionSnapshot(),
    registerCapabilities: (toolServer) => {
      // A real write primitive, registered through the POLICED path. Under a
      // chat delegation the registration filter drops it, so it can be neither
      // listed nor resolved — the denial the forged claims are trying to lift.
      toolServer.registerTool(
        "objects_save",
        {
          title: "Save object",
          description: "fixture stand-in for the real write primitive",
          inputSchema: z.object({ orgId: z.string().optional() }),
        },
        async () => {
          deniedToolCalls += 1;
          return { content: [{ type: "text", text: "write executed" }] };
        },
      );
      // Positive control: on the chat allowlist, so `tools/list` is not empty
      // for the wrong reason.
      toolServer.registerTool(
        "extensions_search",
        {
          title: "Extension search",
          description: "fixture stand-in for an allowlisted read primitive",
          inputSchema: z.object({ q: z.string().optional() }),
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    },
  });

  // The frame probes are registered on the RAW server, deliberately outside the
  // policed wrapper: the wrapper's call-time leg lazily imports the app authz
  // kernel, which resolves under the root vitest config and not under this
  // package's, so a policed call would assert different things in the two runs.
  // The AsyncLocalStorage frame under test is established by the transport, not
  // by that wrapper, so observing it here observes the real thing.
  const raw = srv as InstanceType<typeof McpServer>;
  raw.registerTool(
    "frame_probe",
    {
      title: "Frame probe",
      description: "records the request frame and the _meta the request delivered",
      inputSchema: z.object({}),
    },
    async (_args: unknown, ctx: unknown) => {
      const mcpReq = (ctx as { mcpReq?: { _meta?: unknown; envelope?: unknown } })?.mcpReq;
      observations.push({
        frame: mcpRequestContextStorage.getStore(),
        meta: mcpReq?._meta as Record<string, unknown> | undefined,
        envelope: mcpReq?.envelope as Record<string, unknown> | undefined,
      });
      return { content: [{ type: "text", text: "observed" }] };
    },
  );
  raw.registerTool(
    "cross_tenant_read_probe",
    {
      title: "Cross-tenant read probe",
      description: "reads a resource in another tenant, gated by the frame's ceiling",
      inputSchema: z.object({}),
    },
    async () => {
      const frame = mcpRequestContextStorage.getStore();
      observations.push({ frame, meta: undefined, envelope: undefined });
      // The gate reads the frame's ceiling — never the request's claims.
      if (!resourceWithinCeiling(CROSS_TENANT_RESOURCE, frame?.oboCeiling)) {
        return {
          content: [
            { type: "text", text: `Authorization denied for cross_tenant_read_probe: obo_ceiling` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: "cross-tenant read served" }] };
    },
  );
  return raw;
}

/**
 * Drive one request through the SAME two legs the transport wires, inside the
 * SAME single AsyncLocalStorage frame.
 */
async function serve(request: Request) {
  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
  const { frame, actor } = await buildAuthenticatedRequestFrame({ request, parsedBody });

  const srv = await buildRuntimeServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await srv.connect(transport);
  const modernHandler = createModernEraHandler(srv);

  const era = await resolveInboundEra(request, parsedBody);
  const response = (await mcpRequestContextStorage.run(frame, () =>
    era === "modern"
      ? modernHandler.fetch(request, { parsedBody })
      : serveLegacyEra(transport, request, parsedBody),
  )) as Response;

  const text = await response.clone().text();
  await modernHandler.close().catch(() => undefined);
  return {
    era,
    frame,
    status: response.status,
    text,
    json: (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })(),
  };
}

function post(body: unknown, headers: Record<string, string>) {
  return new Request("https://cinatra.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** A modern (2026-07-28) request: valid envelope PLUS the forged claims. */
function modernRequest(
  token: string,
  method: string,
  params: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return post(
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: { ...MODERN_ENVELOPE, ...FORGED_CLAIMS } },
    },
    {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      // The revision requires `Mcp-Name` on tools/call and refuses (-32020)
      // without it — so a forged-claims request has to be well-formed here or
      // it would be rejected for the wrong reason.
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...extraHeaders,
    },
  );
}

/** A legacy (2025-era) request carrying the same forged claims in `params._meta`. */
function legacyRequest(token: string, method: string, params: Record<string, unknown>) {
  return post(
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { ...FORGED_CLAIMS } } },
    {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-11-25",
    },
  );
}

/** Every string reachable in a value — the frame-wide contamination scan. */
function reachableStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) reachableStrings(entry, out);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      reachableStrings(entry, out);
    }
  }
  return out;
}

function expectFrameUncontaminated(frame: McpRequestContext | undefined) {
  expect(frame).toBeDefined();
  const contaminated = reachableStrings(frame).filter((s) => s.includes(MARK));
  expect(contaminated).toEqual([]);
}

const LEGS = [
  { leg: "modern (2026-07-28)", era: "modern", build: modernRequest },
  { leg: "legacy (2025-era)", era: "legacy", build: legacyRequest },
] as const;

describe("_meta identity claims cannot replace the authenticated actor", () => {
  it.each(LEGS)(
    "$leg — the request frame keeps the AUTHENTICATED chat actor, not the forged one",
    async ({ era, build }) => {
      const res = await serve(
        build(CHAT_TOKEN, "tools/call", { name: "frame_probe", arguments: {} }),
      );

      expect(res.era).toBe(era);
      expect(res.status).toBe(200);
      expect(observations).toHaveLength(1);
      const [observed] = observations;

      // The frame the handler ran in IS the frame the boundary composed.
      expect(observed.frame).toBe(res.frame);

      // Identity is the bearer's, field by field.
      expect(observed.frame?.userId).toBe("usr-alpha-chat");
      expect(observed.frame?.orgId).toBe(HOME_ORG);
      expect(observed.frame?.platformRole).toBe("member");
      expect(observed.frame?.orgRole).toBe("member");
      expect(observed.frame?.delegatedActor?.delegation).toBe("chat");
      // The claim that would have lifted the chat allowlist.
      expect(observed.frame?.delegatedRestricted).toBe(true);
      // Capability witnesses the claims tried to mint.
      expect(observed.frame?.oboCeiling).toBeUndefined();
      expect(observed.frame?.a2aActorContext).toBeUndefined();
      expect(observed.frame?.verifiedRunScopeId).toBeUndefined();
      expect(observed.frame?.verifiedSubmissionId).toBeUndefined();
      expect(observed.frame?.projectContext).toBeUndefined();
      expect(observed.frame?.runId).toBeUndefined();
      expect(observed.frame?.agentId).toBeUndefined();
      expect(observed.frame?.clientId).toBeUndefined();

      // …and nothing client-supplied reached ANY field, named or not.
      expectFrameUncontaminated(observed.frame);
    },
  );

  it.each(LEGS)(
    "$leg — the forged claims DID arrive at the handler (the assertion above is not vacuous)",
    async ({ era, build }) => {
      await serve(build(CHAT_TOKEN, "tools/call", { name: "frame_probe", arguments: {} }));
      const [observed] = observations;

      // Every unreserved claim is delivered verbatim to the handler's `_meta` …
      for (const key of UNRESERVED_CLAIM_KEYS) {
        expect(observed.meta?.[key], key).toEqual(FORGED_CLAIMS[key]);
      }
      // … and the reserved-namespace claim is delivered too (the SDK may lift
      // it into the envelope; either way it reached the request, and not the
      // frame).
      for (const key of RESERVED_CLAIM_KEYS) {
        const delivered = observed.meta?.[key] ?? observed.envelope?.[key];
        expect(delivered, key).toEqual(FORGED_CLAIMS[key]);
      }
      // The modern request really was served AS a modern request — the forged
      // claims rode a valid 2026-07-28 envelope, not a downgraded one. The
      // legacy leg has no envelope at all.
      if (era === "modern") {
        expect(observed.envelope?.[PROTOCOL_VERSION_META_KEY]).toBe("2026-07-28");
      } else {
        expect(observed.envelope).toBeUndefined();
      }
    },
  );

  it("the two eras resolve the SAME authorization frame for the same bearer", async () => {
    // The parameterized cases prove each leg observes its own frame. This adds
    // the cross-leg claim: era classification does not move any authorization
    // field, so the forged claims cannot buy anything by picking an era.
    const modern = await serve(
      modernRequest(CHAT_TOKEN, "tools/call", { name: "frame_probe", arguments: {} }),
    );
    const legacy = await serve(
      legacyRequest(CHAT_TOKEN, "tools/call", { name: "frame_probe", arguments: {} }),
    );

    // The two requests really were classified into different eras …
    expect(modern.era).toBe("modern");
    expect(legacy.era).toBe("legacy");
    // … and each handler observed the frame its own request composed …
    expect(observations[0].frame).toBe(modern.frame);
    expect(observations[1].frame).toBe(legacy.frame);
    // … which are identical in every authorization-bearing field.
    for (const field of ["userId", "orgId", "platformRole", "orgRole", "delegatedRestricted"] as const) {
      expect(observations[0].frame?.[field]).toEqual(observations[1].frame?.[field]);
    }
  });
});

describe("_meta capability claims cannot lift the delegated-chat tool policy", () => {
  // Ground the fixture in the REAL policy: `objects_save` is denied to a chat
  // delegation and `extensions_search` is allowed. If that ever changes, this
  // suite must be re-grounded rather than silently pass.
  it("grounds the fixture tools against the real chat allowlist", () => {
    expect(isCoreDelegatedChatAdmitted("objects_save")).toBe(false);
    expect(isCoreDelegatedChatAdmitted("extensions_search")).toBe(true);
  });

  it.each(LEGS)(
    "$leg — a denied tool stays invisible to tools/list despite forged allowlist claims",
    async ({ build }) => {
      const res = await serve(build(CHAT_TOKEN, "tools/list", {}));

      expect(res.status).toBe(200);
      expect(res.text).toContain("extensions_search");
      expect(res.text).not.toContain("objects_save");
    },
  );

  it.each(LEGS)(
    "$leg — a denied tool stays unresolvable by tools/call, with the real not-found refusal",
    async ({ build }) => {
      const res = await serve(
        build(CHAT_TOKEN, "tools/call", { name: "objects_save", arguments: { orgId: CLAIMED_ORG } }),
      );

      const error = res.json?.error as { code?: number; message?: string } | undefined;
      expect(error?.code).toBe(-32602);
      expect(error?.message).toContain("objects_save");
      // The write never executed — the refusal is structural, not cosmetic.
      expect(deniedToolCalls).toBe(0);
    },
  );

  it("the forged claims WOULD have lifted the policy had they been trusted", () => {
    // Counterfactual, stated explicitly so the assertions above cannot pass by
    // being trivially true: the claims name an unrestricted policy mode and an
    // allowlist containing the denied tool.
    expect(FORGED_CLAIMS.toolPolicyMode).toBe("unrestricted");
    expect(FORGED_CLAIMS.allowedTools).toContain("objects_save");
    expect(FORGED_CLAIMS.delegatedRestricted).toBe(false);
    // Under an UNRESTRICTED policy the same registration does list it — so the
    // denial above is produced by the policy, not by the fixture.
    expect(selectDelegatedToolPolicy(null).toolPolicyMode).toBe("unrestricted");
    expect(selectDelegatedToolPolicy(AUTHENTICATED_ACTORS[CHAT_TOKEN]).toolPolicyMode).toBe(
      "delegated-chat",
    );
  });
});

describe("_meta claims cannot widen an on-behalf-of ceiling", () => {
  it.each(LEGS)(
    "$leg — a cross-tenant read stays denied under the run's real anchored ceiling",
    async ({ build }) => {
      const res = await serve(
        build(AGENT_RUN_TOKEN, "tools/call", { name: "cross_tenant_read_probe", arguments: {} }),
      );

      expect(res.status).toBe(200);
      const result = res.json?.result as
        | { isError?: boolean; content?: Array<{ text?: string }> }
        | undefined;
      expect(result?.isError).toBe(true);
      expect(result?.content?.[0]?.text).toContain("Authorization denied for");
      expect(result?.content?.[0]?.text).toContain("obo_ceiling");

      // The frame carried the run's REAL ceiling, not the forged one.
      expect(observations[0].frame?.oboCeiling).toEqual(HOME_CEILING);
      expectFrameUncontaminated(observations[0].frame);
    },
  );

  it("the forged ceiling WOULD have admitted that exact resource", () => {
    // Same predicate, same resource object — only the chain differs. This is
    // precisely what the claims were trying to buy.
    expect(resourceWithinCeiling(CROSS_TENANT_RESOURCE, HOME_CEILING)).toBe(false);
    expect(resourceWithinCeiling(CROSS_TENANT_RESOURCE, FORGED_CEILING)).toBe(true);
  });

  it.each(LEGS)(
    "$leg — a forged org role cannot mint the org-write authority for an agent-run delegation",
    async ({ build }) => {
      await serve(build(AGENT_RUN_TOKEN, "tools/call", { name: "frame_probe", arguments: {} }));
      // Read the authority off the frame the HANDLER observed, not the one the
      // harness returned.
      expect(observations[0].frame?.orgWriteAuthority).toBeUndefined();
      // The real mint predicate refuses the delegation type regardless of role.
      expect(
        shouldMintSessionOrgWriteAuthority({
          delegatedActor: AUTHENTICATED_ACTORS[AGENT_RUN_TOKEN],
          userId: "usr-alpha-agent",
          orgId: HOME_ORG,
          orgRole: "org_owner",
        }),
      ).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Structural tripwire.
//
// The harness above proves the CONTRACT behaviourally, but it composes the
// frame itself, so on its own it cannot see a regression in the real boundary.
// These assertions bind the two: they read `index.tsx` and fail if the frame
// literal ever grows a body-derived source, or if the single-frame property the
// behavioural tests rely on is broken. Narrow by construction — a structural
// tripwire, not a taint analysis.
// ---------------------------------------------------------------------------
describe("the real transport boundary still composes the frame from verified input only", () => {
  const source = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");

  /** The frame literal, delimited by brace matching rather than indentation. */
  function frameLiteral(): string {
    const start = source.indexOf("const requestStore: McpRequestContext = {");
    expect(start, "the request-frame literal moved or was renamed").toBeGreaterThan(-1);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error("the request-frame literal is not brace-balanced");
  }

  /** One whole statement, from `head` to the first `terminator` after it. */
  function statement(head: string, terminator: string): string {
    const start = source.indexOf(head);
    expect(start, `anchor not found: ${head}`).toBeGreaterThan(-1);
    const end = source.indexOf(terminator, start);
    expect(end, `terminator not found after: ${head}`).toBeGreaterThan(start);
    return source.slice(start, end + terminator.length);
  }

  it("the request-frame literal never reads the request body", () => {
    const literal = frameLiteral();
    expect(literal).not.toContain("parsedBody");
    expect(literal).not.toContain("_meta");
    // No spread: every field is named, so a reviewer can see every source.
    expect(literal).not.toContain("...");
  });

  it("the frame is established once and encloses BOTH serving legs", () => {
    const runs = source.split("mcpRequestContextStorage.run(").length - 1;
    expect(runs, "more than one frame is established per request").toBe(1);
    const enclosed = statement("mcpRequestContextStorage.run(", ") as Response;");
    expect(enclosed).toContain("requestStore");
    expect(enclosed).toContain("modernHandler.fetch");
    expect(enclosed).toContain("serveLegacyEra");
  });

  it("the delegated actor is resolved by the token verifier, before any body read", () => {
    const verifyAt = source.indexOf("verifyDelegatedActorToken?.({");
    const parseAt = source.indexOf("await request.clone().json()");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(parseAt);
    // The tool policy is dispatched over the VERIFIED actor.
    expect(source).toContain("selectDelegatedToolPolicy(delegatedActor)");
  });
});
