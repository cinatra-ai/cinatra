/**
 * Execution-plane session minting + sealing (exec-plane S1, cinatra#1706).
 *
 * Security posture is the point: an unidentifiable caller is DENIED a session
 * (fail-closed); a sealed carrier is integrity-protected + expiring so it
 * cannot be forged or replayed; the carrier carries no secret, only identity.
 */
import { describe, it, expect } from "vitest";
import {
  mintExecutionSession,
  sealExecutionSession,
  openSealedSession,
  UnidentifiableExecutionCallerError,
  ExecutionBrokerSecretMissingError,
  EXECUTION_SURFACES,
  DEFAULT_CARRIER_TTL_MS,
  type ExecutionSession,
} from "../session";

const SECRET = "test-broker-secret-value";

describe("mintExecutionSession — fail-closed identity", () => {
  it("mints a normalized session for an attributable caller", () => {
    const s = mintExecutionSession({
      orgId: " org-1 ",
      userId: " user-1 ",
      surface: "chat",
    });
    expect(s).toEqual({ orgId: "org-1", userId: "user-1", surface: "chat" });
  });

  it("binds runId when the surface supplies one (agent run / #1192)", () => {
    const s = mintExecutionSession({
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId: "run-42",
    });
    expect(s.runId).toBe("run-42");
  });

  it("drops an empty runId rather than persist a meaningless binding", () => {
    const s = mintExecutionSession({
      orgId: "org-1",
      userId: "user-1",
      surface: "chat",
      runId: "   ",
    });
    expect(s.runId).toBeUndefined();
  });

  it.each(["", "   "])("REJECTS an empty orgId (%p) — no capability", (orgId) => {
    expect(() =>
      mintExecutionSession({ orgId, userId: "user-1", surface: "chat" }),
    ).toThrow(UnidentifiableExecutionCallerError);
  });

  it.each(["", "   "])("REJECTS an empty userId (%p) — no capability", (userId) => {
    expect(() =>
      mintExecutionSession({ orgId: "org-1", userId, surface: "chat" }),
    ).toThrow(UnidentifiableExecutionCallerError);
  });

  it("REJECTS an unknown surface", () => {
    expect(() =>
      mintExecutionSession({
        orgId: "org-1",
        userId: "user-1",
        // @ts-expect-error — deliberately invalid surface
        surface: "backdoor",
      }),
    ).toThrow(UnidentifiableExecutionCallerError);
  });

  it("accepts every declared surface", () => {
    for (const surface of EXECUTION_SURFACES) {
      const s = mintExecutionSession({ orgId: "o", userId: "u", surface });
      expect(s.surface).toBe(surface);
    }
  });
});

describe("sealExecutionSession / openSealedSession — round trip", () => {
  const session: ExecutionSession = {
    orgId: "org-1",
    userId: "user-1",
    surface: "agent_run",
    runId: "run-9",
  };

  it("round-trips a sealed session back to its identity", () => {
    const carrier = sealExecutionSession(session, { secret: SECRET, nowMs: 1000 });
    const opened = openSealedSession(carrier, { secret: SECRET, nowMs: 2000 });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.session).toEqual(session);
  });

  it("produces an OPAQUE carrier that is not the raw JSON (integrity-signed)", () => {
    const carrier = sealExecutionSession(session, { secret: SECRET, nowMs: 1000 });
    expect(carrier.startsWith("v1.")).toBe(true);
    expect(carrier.split(".")).toHaveLength(3);
  });

  it("carries NO secret material — only identity + timestamps", () => {
    const carrier = sealExecutionSession(session, { secret: SECRET, nowMs: 1000 });
    const body = carrier.split(".")[1];
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    expect(Object.keys(decoded).sort()).toEqual(
      ["exp", "iat", "orgId", "runId", "surface", "userId"].sort(),
    );
  });

  it("rejects a TAMPERED payload (bad_signature)", () => {
    const carrier = sealExecutionSession(
      { ...session, orgId: "org-1" },
      { secret: SECRET, nowMs: 1000 },
    );
    // Forge a different org in the payload, keep the old MAC.
    const [, , mac] = carrier.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...session, orgId: "org-EVIL", iat: 1000, exp: 1000 + DEFAULT_CARRIER_TTL_MS }),
    ).toString("base64url");
    const forged = `v1.${forgedBody}.${mac}`;
    const opened = openSealedSession(forged, { secret: SECRET, nowMs: 2000 });
    expect(opened).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a carrier signed with a DIFFERENT secret", () => {
    const carrier = sealExecutionSession(session, { secret: "secret-A", nowMs: 1000 });
    const opened = openSealedSession(carrier, { secret: "secret-B", nowMs: 2000 });
    expect(opened).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an EXPIRED carrier", () => {
    const carrier = sealExecutionSession(session, {
      secret: SECRET,
      nowMs: 1000,
      ttlMs: 500,
    });
    const opened = openSealedSession(carrier, { secret: SECRET, nowMs: 1000 + 501 });
    expect(opened).toEqual({ ok: false, reason: "expired" });
  });

  it.each(["", "not-a-carrier", "v1.only-two", "v2.body.mac"])(
    "rejects a malformed carrier (%p)",
    (bad) => {
      const opened = openSealedSession(bad, { secret: SECRET, nowMs: 1000 });
      expect(opened.ok).toBe(false);
    },
  );

  it("SEAL whitelists to the four known fields — smuggled host/secret fields never enter the carrier", () => {
    const smuggled = {
      orgId: "org-1",
      userId: "user-1",
      surface: "chat",
      apiKey: "sk-SECRET",
      hostMount: "/var/run/docker.sock",
    } as unknown as ExecutionSession;
    const carrier = sealExecutionSession(smuggled, { secret: SECRET, nowMs: 1000 });
    const decoded = JSON.parse(
      Buffer.from(carrier.split(".")[1], "base64url").toString("utf8"),
    );
    expect(Object.keys(decoded).sort()).toEqual(
      ["exp", "iat", "orgId", "surface", "userId"].sort(),
    );
  });

  it("SEAL fails closed on an empty pre-minted identity (UnidentifiableExecutionCallerError)", () => {
    const empty = { orgId: "", userId: "", surface: "chat" } as unknown as ExecutionSession;
    expect(() => sealExecutionSession(empty, { secret: SECRET })).toThrow(
      UnidentifiableExecutionCallerError,
    );
  });

  it("fails closed with ExecutionBrokerSecretMissingError when the seal secret is absent", () => {
    const prior = process.env.EXECUTION_BROKER_SECRET;
    delete process.env.EXECUTION_BROKER_SECRET;
    try {
      expect(() => sealExecutionSession(session)).toThrow(
        ExecutionBrokerSecretMissingError,
      );
    } finally {
      if (prior !== undefined) process.env.EXECUTION_BROKER_SECRET = prior;
    }
  });

  it("open reports no_secret (not a crash) when the broker secret is absent", () => {
    const prior = process.env.EXECUTION_BROKER_SECRET;
    delete process.env.EXECUTION_BROKER_SECRET;
    try {
      const opened = openSealedSession("v1.x.y");
      expect(opened).toEqual({ ok: false, reason: "no_secret" });
    } finally {
      if (prior !== undefined) process.env.EXECUTION_BROKER_SECRET = prior;
    }
  });
});
