import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_SURFACE_DEFAULTS,
  buildConnectorInstanceDestructiveHook,
  buildPendingConfirmationMessage,
  deriveConfirmationSurface,
  normalizeConfirmationSurface,
  type ConnectorInstanceDestructiveHookDeps,
} from "@/lib/connector-instance-destructive-hook";
import {
  InvokerError,
  PENDING_CONFIRMATION_MESSAGE_PREFIX,
} from "@/lib/connector-instance-mcp-transport";
import type { InvokerTrustedActor } from "@/lib/connector-instance-invoker";
import {
  ARGS_MAX_BYTES,
  computeArgsDigest,
  type PendingCallStoreQuery,
} from "@/lib/connector-instance-pending-call-store";

// cinatra#2020 S5 PR-3 — the destructive-confirmation hook impl: surface
// derivation (D6), the D7 default matrix × org-override evaluation, the park
// leg + §2.1 message contract, the §7.3 hook-owned audits, and the fail-closed
// doctrine (any infra failure on a require path refuses, never executes).

const ACTOR: InvokerTrustedActor = {
  actor: { principalType: "HumanUser", principalId: "u1", organizationId: "org1" } as never,
  userId: "u1",
  orgId: "org1",
  connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
};

function fireInput(overrides: Record<string, unknown> = {}) {
  return {
    connectorKey: "wordpress",
    instanceId: "inst-1",
    serverId: "wps_default",
    toolName: "core/delete-post",
    actor: ACTOR,
    args: { id: 7, force: true },
    derivedClass: "destructive" as const,
    floorHit: true,
    sourceType: "chat",
    endpointUrl: "https://site.example/wp-json/wp/v2/mcp",
    inputSchema: { type: "object" },
    rawAnnotations: { destructiveHint: true },
    primitiveName: "wordpress_site_tool_call",
    catalogRevision: "rev-9",
    causation: "run-42",
    ...overrides,
  };
}

function makeHook(overrides: Partial<ConnectorInstanceDestructiveHookDeps> = {}) {
  const park = vi.fn(async () => ({
    outcome: "parked" as const,
    id: "cipc_abc123",
    expiresAt: "2026-07-28T10:15:00.000Z",
    reused: false,
  }));
  const readPolicy = vi.fn(async () => null);
  const audit = vi.fn(async () => {});
  const hook = buildConnectorInstanceDestructiveHook({
    park: park as never,
    readPolicy: readPolicy as never,
    audit,
    ...overrides,
  });
  return { hook, park, readPolicy, audit };
}

describe("deriveConfirmationSurface (D6) — verified delegation → surface", () => {
  it.each([
    ["chat", "chat"],
    ["agent_run", "agent_run"],
    ["public_site_widget", "public_site_widget"],
  ] as const)("delegation %s → %s", (delegation, expected) => {
    expect(deriveConfirmationSurface(delegation)).toBe(expected);
  });

  it("null / undefined (cookie-session / dev-bearer frames) → session", () => {
    expect(deriveConfirmationSurface(null)).toBe("session");
    expect(deriveConfirmationSurface(undefined)).toBe("session");
  });

  it("an UNKNOWN future delegation kind lands on the fail-safe require row", () => {
    expect(deriveConfirmationSurface("future_kind")).toBe("session");
    expect(CONFIRMATION_SURFACE_DEFAULTS[deriveConfirmationSurface("future_kind")]).toBe("require");
  });
});

describe("normalizeConfirmationSurface — fire-time sourceType normalization", () => {
  it("passes the four surface values through verbatim", () => {
    for (const s of ["chat", "agent_run", "public_site_widget", "session"] as const) {
      expect(normalizeConfirmationSurface(s)).toBe(s);
    }
  });

  it("absent or foreign sourceType → session (fail-safe require)", () => {
    expect(normalizeConfirmationSurface(undefined)).toBe("session");
    expect(normalizeConfirmationSurface("mcp")).toBe("session");
  });
});

describe("buildPendingConfirmationMessage — the §2.1 model-facing contract", () => {
  it("starts with the STABLE exported prefix and carries the no-retry directive", () => {
    const msg = buildPendingConfirmationMessage({
      toolName: "core/delete-post",
      serverId: "wps_default",
      pendingCallId: "cipc_abc123",
    });
    expect(msg.startsWith(PENDING_CONFIRMATION_MESSAGE_PREFIX)).toBe(true);
    expect(msg).toContain('the destructive tool "core/delete-post" on server "wps_default" was NOT executed');
    expect(msg).toContain("parked as pending call cipc_abc123");
    expect(msg).toContain("expires in 15 minutes");
    expect(msg).toContain("confirmation card is shown to the user in their cinatra chat");
    expect(msg).toContain("Do NOT retry or re-issue this call");
  });

  it("pins the EXACT contract text — deliberate wording drift must break this test (codex r0)", () => {
    expect(
      buildPendingConfirmationMessage({
        toolName: "core/delete-post",
        serverId: "wps_default",
        pendingCallId: "cipc_abc123",
      }),
    ).toBe(
      'pending_confirmation: the destructive tool "core/delete-post" on server "wps_default" ' +
        "was NOT executed. It requires the user's explicit confirmation and has been parked as " +
        "pending call cipc_abc123 (expires in 15 minutes). A confirmation card is shown to the " +
        "user in their cinatra chat. Do NOT retry or re-issue this call — a retry returns this " +
        "same pending call. Tell the user briefly what the call will do and that they can " +
        "confirm or deny it on the card.",
    );
  });
});

describe("default matrix (D7) × org override — the FULL 4-surface × 3-policy-state matrix", () => {
  const policyRow = (mode: "default" | "disabled") => ({
    connectorKey: "wordpress",
    instanceId: "inst-1",
    mode,
    updatedBy: "admin",
    updatedAt: "2026-07-27T00:00:00.000Z",
  });

  it.each([
    // [surface, policy row (null = absent), expected outcome]
    ["chat", null, "park"],
    ["chat", "default", "park"],
    ["chat", "disabled", "org_disabled"],
    ["session", null, "park"],
    ["session", "default", "park"],
    ["session", "disabled", "org_disabled"],
    ["agent_run", null, "surface_default_off"],
    ["agent_run", "default", "surface_default_off"],
    ["agent_run", "disabled", "surface_default_off"],
    ["public_site_widget", null, "surface_default_off"],
    ["public_site_widget", "default", "surface_default_off"],
    ["public_site_widget", "disabled", "surface_default_off"],
  ] as const)("surface %s × policy %s → %s", async (surface, mode, expected) => {
    const readPolicy = vi.fn(async () => (mode ? policyRow(mode) : null));
    const { hook, park, audit } = makeHook({ readPolicy: readPolicy as never });
    const verdict = await hook.fire(fireInput({ sourceType: surface }) as never);
    if (expected === "park") {
      expect(verdict).toMatchObject({ action: "park", pendingCallId: "cipc_abc123" });
      expect(readPolicy).toHaveBeenCalledTimes(1);
      expect(park).toHaveBeenCalledTimes(1);
      expect(park.mock.calls[0][0]).toMatchObject({ surface });
    } else if (expected === "org_disabled") {
      expect(verdict).toEqual({ action: "continue", reason: "org_disabled" });
      expect(park).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledTimes(1); // the ONE bypass row (§7.3)
    } else {
      // OFF surfaces bypass silently BEFORE the org row: no read, no park, no audit.
      expect(verdict).toEqual({ action: "continue", reason: "surface_default_off" });
      expect(readPolicy).not.toHaveBeenCalled();
      expect(park).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it("absent sourceType → session → parks (fail-safe)", async () => {
    const { hook, park } = makeHook();
    const verdict = await hook.fire(fireInput({ sourceType: undefined }) as never);
    expect(verdict).toMatchObject({ action: "park" });
    expect(park.mock.calls[0][0]).toMatchObject({ surface: "session" });
  });

  it("mode 'disabled' → continue(org_disabled) + the ONE bypass audit row (§7.3), no park", async () => {
    const readPolicy = vi.fn(async () => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "disabled" as const,
      updatedBy: "admin",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));
    const { hook, park, audit } = makeHook({ readPolicy: readPolicy as never });
    const verdict = await hook.fire(fireInput() as never);
    expect(verdict).toEqual({ action: "continue", reason: "org_disabled" });
    expect(park).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      operation: "confirmation_bypass_org_disabled",
      decision: "allowed",
      policyVersion: "connector-instance-confirmation",
      resourceId: "inst-1",
      organizationId: "org1",
      metadata: { surface: "chat", derivedClass: "destructive", floorHit: true },
    });
  });
});

describe("park verdict + pending_call_parked audit (§7.3)", () => {
  it("returns park with id/expiresAt/§2.1-message and audits ids/hashes — never raw args or endpointUrl", async () => {
    const { hook, park, audit } = makeHook();
    const input = fireInput();
    const verdict = await hook.fire(input as never);
    const { hash, bytes } = computeArgsDigest(input.args as Record<string, unknown>);

    expect(verdict).toMatchObject({
      action: "park",
      pendingCallId: "cipc_abc123",
      expiresAt: "2026-07-28T10:15:00.000Z",
    });
    const message = (verdict as { message: string }).message;
    expect(message.startsWith(PENDING_CONFIRMATION_MESSAGE_PREFIX)).toBe(true);
    expect(message).toContain("cipc_abc123");

    // Park input: full material for row + fingerprints (store computes them).
    expect(park.mock.calls[0][0]).toMatchObject({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      serverId: "wps_default",
      toolName: "core/delete-post",
      args: { id: 7, force: true },
      endpointUrl: "https://site.example/wp-json/wp/v2/mcp",
      inputSchema: { type: "object" },
      rawAnnotations: { destructiveHint: true },
      derivedClass: "destructive",
      surface: "chat",
      userId: "u1",
      orgId: "org1",
      primitiveName: "wordpress_site_tool_call",
      causation: "run-42",
    });

    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0] as { operation: string; decision: string; metadata: Record<string, unknown> };
    expect(event).toMatchObject({
      operation: "pending_call_parked",
      decision: "denied",
      policyVersion: "connector-instance-confirmation",
    });
    expect(event.metadata).toMatchObject({
      pendingCallId: "cipc_abc123",
      surface: "chat",
      derivedClass: "destructive",
      floorHit: true,
      argsHash: hash,
      argsBytes: bytes,
      expiresAt: "2026-07-28T10:15:00.000Z",
      reused: false,
    });
    // Codex r2 pin: raw hook input never serialized into audit metadata.
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain("https://site.example");
    expect(serialized).not.toContain('"force"');
  });

  it("floor-only trigger (write-class annotations) parks with row derived_class 'floor'", async () => {
    const { hook, park } = makeHook();
    await hook.fire(fireInput({ derivedClass: "write", floorHit: true }) as never);
    expect(park.mock.calls[0][0]).toMatchObject({ derivedClass: "floor" });
  });

  it("dedup collapse (reused) surfaces the SAME pending call id and audits reused:true", async () => {
    const { hook, audit } = makeHook({
      park: vi.fn(async () => ({
        outcome: "parked" as const,
        id: "cipc_existing",
        expiresAt: "2026-07-28T10:09:00.000Z",
        reused: true,
      })) as never,
    });
    const verdict = await hook.fire(fireInput() as never);
    expect(verdict).toMatchObject({ action: "park", pendingCallId: "cipc_existing" });
    expect((audit.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      reused: true,
    });
  });

  it("stashes {runId, clientId} forensics + catalogRevision into the park-row context", async () => {
    const { hook, park } = makeHook({
      getForensicsContext: () => ({ runId: "run-42", clientId: "client-7" }),
    });
    await hook.fire(fireInput() as never);
    expect(park.mock.calls[0][0]).toMatchObject({
      context: { runId: "run-42", clientId: "client-7", catalogRevision: "rev-9" },
    });
  });

  it("no forensics and no catalogRevision → context null", async () => {
    const { hook, park } = makeHook();
    await hook.fire(fireInput({ catalogRevision: undefined }) as never);
    expect(park.mock.calls[0][0]).toMatchObject({ context: null });
  });
});

describe("typed refusals + fail-closed doctrine (§2.3)", () => {
  it("args_too_large → InvokerError confirmation_args_too_large (reduce-payload guidance)", async () => {
    const { hook } = makeHook({
      park: vi.fn(async () => ({ outcome: "args_too_large" as const, argsBytes: 300_000 })) as never,
    });
    const err = await hook.fire(fireInput() as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("confirmation_args_too_large");
    expect((err as InvokerError).message).toContain(String(ARGS_MAX_BYTES));
    expect((err as InvokerError).message).toContain("NOT executed");
  });

  it("cap_exceeded → InvokerError confirmation_unavailable naming the pending-card recourse", async () => {
    const { hook } = makeHook({
      park: vi.fn(async () => ({ outcome: "cap_exceeded" as const, pendingCount: 3 })) as never,
    });
    const err = await hook.fire(fireInput() as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("confirmation_unavailable");
    expect((err as InvokerError).message).toContain("too many pending confirmations");
  });

  it.each([
    ["policy read fails", { readPolicy: vi.fn(async () => Promise.reject(new Error("db down"))) }],
    ["park transaction fails", { park: vi.fn(async () => Promise.reject(new Error("db down"))) }],
  ] as const)("%s → confirmation_unavailable (refuses, never executes unconfirmed)", async (_label, o) => {
    const { hook } = makeHook(o as never);
    const err = await hook.fire(fireInput() as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("confirmation_unavailable");
  });

  it("a failed park-audit write refuses fail-closed too (blocking is never weakened)", async () => {
    const { hook } = makeHook({ audit: vi.fn(async () => Promise.reject(new Error("sink down"))) });
    const err = await hook.fire(fireInput() as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("confirmation_unavailable");
  });

  it("a failed org-disabled bypass audit refuses — the bypass may not proceed unaudited", async () => {
    const { hook, park } = makeHook({
      readPolicy: vi.fn(async () => ({
        connectorKey: "wordpress",
        instanceId: "inst-1",
        mode: "disabled" as const,
        updatedBy: "admin",
        updatedAt: "2026-07-27T00:00:00.000Z",
      })) as never,
      audit: vi.fn(async () => Promise.reject(new Error("sink down"))),
    });
    const err = await hook.fire(fireInput() as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("confirmation_unavailable");
    expect(park).not.toHaveBeenCalled();
  });
});

describe("enabled() — binding arms the hook", () => {
  it("defaults to enabled (the S7 entry criterion's 'bound + enabled')", () => {
    const { hook } = makeHook();
    expect(hook.enabled()).toBe(true);
  });

  it("honors an injected kill-switch", () => {
    const { hook } = makeHook({ enabled: () => false });
    expect(hook.enabled()).toBe(false);
  });
});

describe("park verdict + ROW via the REAL store (injected query fn — §10 acceptance)", () => {
  it("drives parkPendingCall end-to-end: advisory lock, dedup probe, cap, INSERT row", async () => {
    const statements: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const query: PendingCallStoreQuery = async <T = unknown>(
      text: string,
      values?: readonly unknown[],
    ): Promise<T[]> => {
      statements.push({ text, values });
      if (text.includes("connector_instance_confirmation_policy")) return [] as T[]; // no org override row
      if (text.includes("pg_advisory_xact_lock")) return [] as T[];
      if (text.startsWith("UPDATE")) return [] as T[]; // flip-expired: none
      if (text.startsWith("SELECT id, expires_at")) return [] as T[]; // no live dup
      if (text.includes("count(*)")) return [{ n: 0 }] as T[];
      if (text.startsWith("INSERT INTO")) {
        const values0 = values as unknown[];
        return [{ id: values0[0], expires_at: "2026-07-28T10:15:00.000Z" }] as T[];
      }
      if (text.startsWith("DELETE FROM")) return [] as T[]; // retention sweep
      throw new Error(`unexpected SQL in double: ${text.slice(0, 60)}`);
    };
    const audit = vi.fn(async () => {});
    const hook = buildConnectorInstanceDestructiveHook({ storeDeps: { query }, audit });

    const verdict = await hook.fire(fireInput() as never);
    expect(verdict).toMatchObject({ action: "park", expiresAt: "2026-07-28T10:15:00.000Z" });
    expect((verdict as { pendingCallId: string }).pendingCallId).toMatch(/^cipc_[0-9a-f]{32}$/);

    const insert = statements.find((s) => s.text.startsWith("INSERT INTO"));
    expect(insert).toBeDefined();
    // The row insert names the partial-index predicate (store contract) and
    // carries the hook-supplied surface + derived class + full args.
    expect(insert!.text).toContain("ON CONFLICT");
    expect(insert!.text).toContain("WHERE status = 'pending'");
    const v = insert!.values as unknown[];
    expect(v[1]).toBe("wordpress"); // connector_key
    expect(v[4]).toBe("core/delete-post"); // tool_name
    expect(v[5]).toBe(JSON.stringify({ id: 7, force: true })); // full args jsonb
    expect(v[12]).toBe("chat"); // surface
    expect(audit).toHaveBeenCalledTimes(1); // pending_call_parked
  });
});
