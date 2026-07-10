// cinatra#1058 — the FIVE connector failure states × {required, optional}.
//
// The five distinguishable states span two layers:
//   • S1 not-installed / S3 policy-denied (no_actor) are detectable at the
//     RUN-START enqueue preflight (an access-policy decision). The optional
//     behavior is WIRED here: required ⇒ fail-closed with actionable copy;
//     optional ⇒ skip-step-audit (collected, not thrown).
//   • S2 no-usable-connection / S4 stale-record / S5 ambiguous-shared are
//     STEP-TIME credential-resolution errors thrown by resolveConnectionForUse.
//     They fail closed by a distinct, actionably-worded error identity. (The
//     optional-vs-required routing for these is owned by the enqueue pre-skip:
//     an optional connector denied at run-start is skip-step-audited, so its
//     dependent step never reaches the resolver. Threading requirement PAST the
//     SDK host-connector boundary into the resolver is a separate follow-up.)
//
// This matrix pins each state's error identity and the enqueue-layer routing.
import { describe, expect, it, vi, beforeEach } from "vitest";

// --- enqueue-layer deps (S1 / S3 routing) -----------------------------------
const requireConnectorAuthority = vi.fn();
vi.mock("@/lib/connector-authority", () => ({
  requireConnectorAuthority: (...a: unknown[]) => requireConnectorAuthority(...(a as [])),
}));
const enforceConnectorPolicy = vi.fn();
vi.mock("@/lib/connector-policy", () => ({
  enforceConnectorPolicy: (...a: unknown[]) => enforceConnectorPolicy(...(a as [])),
}));
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "AGENT_BUILDER_EXECUTION" },
  enqueueBackgroundJob: vi.fn(async () => "job-1"),
}));

// --- resolver import-safety mocks (S2 / S4 / S5 identity pinning) ------------
// @/lib/authz is intentionally NOT mocked — the real AuthzError base is needed
// for the instanceof identity assertions below.
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsByConnector: vi.fn(async () => []),
}));
vi.mock("@/lib/connection-use-gate", () => ({
  decideConnectionUse: vi.fn(),
  enforceConnectionUse: vi.fn(),
  resolveConnectionAccessDeclaration: vi.fn(),
  connectionSubjectUserId: vi.fn(),
}));
vi.mock("@/lib/nango-system", () => ({
  listSavedNangoConnections: vi.fn(() => []),
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: {},
}));
vi.mock("@/lib/authz/audit", () => ({
  logDeniedAuditEventStrictWithCooldown: vi.fn(async () => ({ id: "a" })),
}));

import {
  runConnectorPreflight,
  ConnectorNotConfiguredError,
} from "@/lib/agent-run-enqueue";
import { AuthzError } from "@/lib/authz";
import {
  NoUsableConnectionError,
  AmbiguousSharedConnectionError,
  ConnectionRecordMissingError,
} from "@/lib/connection-credential-resolver";

const ACTOR = { principalId: "u1", organizationId: "org1" } as never;
const PKG = "@cinatra-ai/apollo-connector";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// S1 & S3 — enqueue-layer states. Full required-vs-optional routing.
// ---------------------------------------------------------------------------
describe.each([
  { state: "S1", label: "connector not installed / not configured", reason: "unknown_connector" },
  { state: "S3", label: "policy-denied (no_actor)", reason: "no_actor" },
])("$state ($label) — enqueue-layer routing", ({ reason }) => {
  it("REQUIRED ⇒ fail-closed at enqueue with actionable copy (settingsHref)", async () => {
    requireConnectorAuthority.mockResolvedValue({ allowed: false, reason, skipped: false });
    await expect(
      runConnectorPreflight({ [PKG]: { range: "*", requirement: "required" } }, ACTOR, "use"),
    ).rejects.toMatchObject({
      code: "CONNECTOR_NOT_CONFIGURED",
      settingsHref: "/connectors/cinatra-ai/apollo-connector/setup",
      reason,
    });
  });

  it("OPTIONAL ⇒ skip-step-audit (collected, never thrown)", async () => {
    requireConnectorAuthority.mockResolvedValue({ allowed: false, reason, skipped: true });
    const res = await runConnectorPreflight(
      { [PKG]: { range: "*", requirement: "optional" } },
      ACTOR,
      "use",
    );
    expect(res.skippedOptional).toEqual([{ packageId: PKG, reason }]);
  });
});

// ---------------------------------------------------------------------------
// S2, S4, S5 — step-time credential-resolution states. Pin the error identity
// (distinct, exported class + actionable message).
// ---------------------------------------------------------------------------
describe("S2 (installed, no usable connection) — error identity", () => {
  it("NoUsableConnectionError is a named AuthzError carrying actionable connect-your-account copy", () => {
    const err = new NoUsableConnectionError({
      statusCode: 403,
      reason: "forbidden",
      message: `No ${PKG} connection is available to you — connect your own account, or ask an owner to share theirs.`,
    });
    expect(err).toBeInstanceOf(AuthzError);
    expect(err.constructor.name).toBe("NoUsableConnectionError");
    expect(err.message).toMatch(/connect your own account|ask an owner/i);
  });
});

describe("S4 (stale connection — identity row without a blob record) — error identity", () => {
  it("ConnectionRecordMissingError is a named Error carrying actionable reconnect/remove copy", () => {
    const err = new ConnectionRecordMissingError(
      `The ${PKG} connection is registered but its saved-connection record is missing — reconnect the connector or remove the stale connection.`,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.constructor.name).toBe("ConnectionRecordMissingError");
    expect(err.message).toMatch(/reconnect the connector|remove the stale connection/i);
  });
});

describe("S5 (ambiguous shared connection) — error identity", () => {
  it("AmbiguousSharedConnectionError is a named AuthzError carrying actionable narrow-the-grants copy", () => {
    const err = new AmbiguousSharedConnectionError({
      statusCode: 403,
      reason: "forbidden",
      message: `2 shared ${PKG} connections are granted to you — ambiguous. Ask the owners to narrow the grants so exactly one applies.`,
    });
    expect(err).toBeInstanceOf(AuthzError);
    expect(err.constructor.name).toBe("AmbiguousSharedConnectionError");
    expect(err.message).toMatch(/ambiguous|narrow the grants/i);
  });
});

// The three step-time identities are DISTINCT (no accidental collapse).
it("the five states resolve to three distinct step-time identities + the enqueue ConnectorNotConfiguredError", () => {
  const names = new Set([
    NoUsableConnectionError.name,
    AmbiguousSharedConnectionError.name,
    ConnectionRecordMissingError.name,
    ConnectorNotConfiguredError.name,
  ]);
  expect(names.size).toBe(4);
});
