// Grant-following resolver contract tests (cinatra#952 W2): own-first
// resolution, the OWNER-RULING ambiguity HARD-FAIL (never pick; no
// pinning/selection), only:"user" never listing shared, null-org narrowing,
// pre-fetch sentinel DENY audits, blob-record hard-fail, and the
// no-cross-request-caching contract.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz";
import type { NangoConnectionIdentity } from "@cinatra-ai/extensions/connection-identity-store";

const listNangoConnectionsByConnector = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsByConnector: (...a: unknown[]) => listNangoConnectionsByConnector(...a),
}));

const decideConnectionUse = vi.fn();
const enforceConnectionUse = vi.fn(async (..._a: unknown[]) => ({ allowed: true }));
const resolveConnectionAccessDeclaration = vi.fn(
  async (
    _identity: Record<string, unknown>,
  ): Promise<{ kind: string; declaration: Record<string, unknown> | null }> => ({
    kind: "declaration",
    declaration: null,
  }),
);
vi.mock("@/lib/connection-use-gate", () => ({
  decideConnectionUse: (...a: unknown[]) => decideConnectionUse(...a),
  enforceConnectionUse: (...a: unknown[]) => enforceConnectionUse(...a),
  resolveConnectionAccessDeclaration: (identity: Record<string, unknown>) =>
    resolveConnectionAccessDeclaration(identity),
  connectionSubjectUserId: (actor: ActorContext) =>
    actor.principalType === "HumanUser" ? actor.principalId : actor.runAsUserId,
}));

const listSavedNangoConnections = vi.fn();
const logDeniedAuditEventStrictWithCooldown = vi.fn(async (_input: Record<string, unknown>) => ({ id: "a" }));
vi.mock("@/lib/nango-system", () => ({
  listSavedNangoConnections: (...a: unknown[]) => listSavedNangoConnections(...a),
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { github: "cinatra-github" },
}));
vi.mock("@/lib/authz/audit", () => ({
  logDeniedAuditEventStrictWithCooldown: (input: Record<string, unknown>) =>
    logDeniedAuditEventStrictWithCooldown(input),
}));

import {
  resolveConnectionForUse,
  AmbiguousSharedConnectionError,
  NoUsableConnectionError,
  ConnectionRecordMissingError,
} from "@/lib/connection-credential-resolver";

const ORG = "org-1";
const ME = "user-me";
const OTHER_A = "user-a";
const OTHER_B = "user-b";

function row(over: Partial<NangoConnectionIdentity>): NangoConnectionIdentity {
  return {
    id: `id-${over.connectionId ?? Math.random()}`,
    organizationId: ORG,
    connectorPackageId: "@cinatra-ai/github-connector",
    connectorKey: "github",
    connectionId: "c-1",
    ownerUserId: OTHER_A,
    createdAt: new Date(),
    deletedAt: null,
    ...over,
  };
}

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: ME,
  organizationId: ORG,
  teamIds: [],
  projectIds: [],
  projectGrants: [],
  authSource: "ui",
  policyVersion: "v2",
} as ActorContext;

beforeEach(() => {
  vi.clearAllMocks();
  decideConnectionUse.mockResolvedValue({ allowed: true });
  enforceConnectionUse.mockResolvedValue({ allowed: true });
  resolveConnectionAccessDeclaration.mockResolvedValue({ kind: "declaration", declaration: null });
  listSavedNangoConnections.mockReturnValue([
    { connectionId: "c-own", providerConfigKey: "cinatra-github" },
    { connectionId: "c-1", providerConfigKey: "cinatra-github" },
    { connectionId: "c-2", providerConfigKey: "cinatra-github" },
  ]);
});

describe("own-first resolution", () => {
  it("resolves the actor's own connection through the audited gate (delegated=false)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-own", ownerUserId: ME }),
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
    ]);
    const resolved = await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(resolved.connectionId).toBe("c-own");
    expect(resolved.delegated).toBe(false);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(1);
    // Own choice bypasses candidate selection entirely — even with another
    // user's row present there is no ambiguity.
    expect(decideConnectionUse).not.toHaveBeenCalled();
  });

  it("a null-org row resolves for its OWNER (own-match)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-own", ownerUserId: ME, organizationId: null }),
    ]);
    const resolved = await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(resolved.connectionId).toBe("c-own");
  });
});

describe("shared resolution + the ambiguity HARD-FAIL (owner ruling)", () => {
  it("exactly one authorized shared candidate resolves through the SAME audited gate (delegated=true)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
      row({ connectionId: "c-2", ownerUserId: OTHER_B }),
    ]);
    decideConnectionUse
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: "not_visible" });
    const resolved = await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(resolved.connectionId).toBe("c-1");
    expect(resolved.delegated).toBe(true);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(1);
  });

  it(">1 authorized shared candidates = typed hard error + sentinel DENY audit; NEVER picks", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
      row({ connectionId: "c-2", ownerUserId: OTHER_B }),
    ]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(AmbiguousSharedConnectionError);
    expect(enforceConnectionUse).not.toHaveBeenCalled(); // never picked one
    expect(logDeniedAuditEventStrictWithCooldown).toHaveBeenCalledTimes(1);
    const deny = logDeniedAuditEventStrictWithCooldown.mock.calls[0][0] as {
      resourceId: string;
      metadata: Record<string, unknown>;
    };
    expect(deny.resourceId).toBe("connector:github");
    expect(deny.metadata).toMatchObject({
      reason: "ambiguous_shared_candidates",
      candidateCount: 2,
    });
  });

  it("zero candidates = NoUsableConnectionError + pre-fetch sentinel DENY", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(NoUsableConnectionError);
    const deny = logDeniedAuditEventStrictWithCooldown.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(deny.metadata).toMatchObject({ reason: "no_candidate" });
  });

  it("null-org rows are NEVER shared candidates (round-2 finding 6)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A, organizationId: null }),
    ]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(NoUsableConnectionError);
    expect(decideConnectionUse).not.toHaveBeenCalled();
  });

  it("only:'user' never lists shared — actionable connect-your-own error", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-1", ownerUserId: OTHER_A }),
    ]);
    resolveConnectionAccessDeclaration.mockResolvedValue({
      kind: "declaration",
      declaration: { formatVersion: 1, mode: "only", scope: "user", source: "declared" },
    });
    await expect(resolveConnectionForUse({ connectorKey: "github", actor })).rejects.toThrow(
      /connect your own/i,
    );
    expect(decideConnectionUse).not.toHaveBeenCalled();
  });
});

describe("blob address + caching contract", () => {
  it("a live identity row with NO blob record hard-fails (never a silent skip)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-ghost", ownerUserId: ME }),
    ]);
    await expect(
      resolveConnectionForUse({ connectorKey: "github", actor }),
    ).rejects.toBeInstanceOf(ConnectionRecordMissingError);
  });

  it("caches nothing across resolutions (revocation-next-use)", async () => {
    listNangoConnectionsByConnector.mockResolvedValue([
      row({ connectionId: "c-own", ownerUserId: ME }),
    ]);
    await resolveConnectionForUse({ connectorKey: "github", actor });
    await resolveConnectionForUse({ connectorKey: "github", actor });
    expect(listNangoConnectionsByConnector).toHaveBeenCalledTimes(2);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(2);
  });
});
