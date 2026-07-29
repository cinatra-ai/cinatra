// WordPress freshness adapter test.
//
// cinatra#2022 S7 freshness re-point: the adapter now probes through the
// governed connector-instance invoker (`ewpa/get-post` / `ewpa/get-page`)
// instead of a bespoke direct-REST call. Mock-based: stubs the lazily-resolved
// invoker stack (invoke + deps-builder + trusted-actor resolution) so the
// 5-state contract and every degrade path are exercised without a host boot.
// The REAL `InvokerError` class is used (not a stub) so the adapter's
// `instanceof` branch is the code under test, not a mock artifact.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import type { InvokeConnectorInstanceToolInput } from "@/lib/connector-instance-invoker";

const mocks = vi.hoisted(() => ({
  invokeConnectorInstanceTool: vi.fn<(input: unknown, deps: unknown) => Promise<unknown>>(),
  buildConnectorInstanceInvokerDeps: vi.fn<(key: string) => Record<string, unknown>>(() => ({
    __deps: "wordpress",
  })),
  resolveTrustedWriteActor: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/connector-instance-invoker", () => ({
  invokeConnectorInstanceTool: mocks.invokeConnectorInstanceTool,
}));
vi.mock("@/lib/register-host-connector-services", () => ({
  buildConnectorInstanceInvokerDeps: mocks.buildConnectorInstanceInvokerDeps,
}));
vi.mock("@/lib/connector-instance-write-authority", () => ({
  resolveTrustedWriteActor: mocks.resolveTrustedWriteActor,
}));

import { wordpressFreshnessAdapter } from "../freshness/wordpress-adapter";

const TRUSTED_ACTOR = {
  actor: { principalType: "HumanUser", principalId: "u1", organizationId: "org_1" },
  userId: "u1",
  orgId: "org_1",
};

function ref(overrides: Record<string, unknown> = {}) {
  return {
    connector: "wordpress",
    kind: "wordpress-post",
    remoteId: "42",
    modifiedAt: "2026-05-23T10:00:00",
    extra: { instanceId: "wp_instance_1" },
    ...overrides,
  } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"];
}

function check(remoteRevisionRef: ReturnType<typeof ref>) {
  return wordpressFreshnessAdapter.check({
    objectId: "obj_1",
    orgId: "org_1",
    remoteRevisionRef,
  });
}

describe("wordpressFreshnessAdapter", () => {
  beforeEach(() => {
    mocks.invokeConnectorInstanceTool.mockReset();
    mocks.buildConnectorInstanceInvokerDeps.mockClear();
    mocks.resolveTrustedWriteActor.mockReset();
    mocks.resolveTrustedWriteActor.mockResolvedValue(TRUSTED_ACTOR);
  });

  it("returns 'unsupported' when no remoteRevisionRef is supplied", async () => {
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: null,
    });
    expect(r.state).toBe("unsupported");
    expect(mocks.invokeConnectorInstanceTool).not.toHaveBeenCalled();
  });

  it("returns 'unsupported' for refs not from WordPress connector", async () => {
    const r = await check(ref({ connector: "drupal", kind: "drupal-node" }));
    expect(r.state).toBe("unsupported");
    expect(mocks.invokeConnectorInstanceTool).not.toHaveBeenCalled();
  });

  it("returns 'unknown' when remoteRevisionRef lacks extra.instanceId", async () => {
    const r = await check(ref({ extra: {} }));
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("instanceId");
    expect(mocks.invokeConnectorInstanceTool).not.toHaveBeenCalled();
  });

  it("returns 'unknown' (never probes) when no trusted actor resolves — the re-point's authz posture", async () => {
    mocks.resolveTrustedWriteActor.mockResolvedValue(null);
    const r = await check(ref());
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("trusted actor");
    expect(mocks.invokeConnectorInstanceTool).not.toHaveBeenCalled();
  });

  it("probes via the governed invoker with ewpa/get-post + post_id args + the wordpress deps", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_id: 42, post_modified_gmt: "2026-05-23T10:00:00", post_content: "c" },
    });
    await check(ref());
    expect(mocks.invokeConnectorInstanceTool).toHaveBeenCalledTimes(1);
    const [input, deps] = mocks.invokeConnectorInstanceTool.mock.calls[0]!;
    const call = input as InvokeConnectorInstanceToolInput;
    expect(call.connectorKey).toBe("wordpress");
    expect(call.instanceId).toBe("wp_instance_1");
    expect(call.toolName).toBe("ewpa/get-post");
    expect(call.args).toEqual({ post_id: 42 });
    expect(call.sourceType).toBe("freshness_sweep");
    expect(call.primitiveName).toBe("wordpress_freshness_check");
    expect(call.actor).toMatchObject({ userId: "u1", orgId: "org_1" });
    expect(deps).toEqual({ __deps: "wordpress" });
    expect(mocks.buildConnectorInstanceInvokerDeps).toHaveBeenCalledWith("wordpress");
  });

  it("targets ewpa/get-page for postType 'page'", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_modified_gmt: "2026-05-23T10:00:00", post_content: "c" },
    });
    await check(ref({ extra: { instanceId: "wp_instance_1", postType: "page" } }));
    const call = mocks.invokeConnectorInstanceTool.mock
      .calls[0]![0] as InvokeConnectorInstanceToolInput;
    expect(call.toolName).toBe("ewpa/get-page");
  });

  it("returns 'missing' when the ability reports a not-found-shaped tool_error", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(
      new InvokerError("tool_error", "rest_post_invalid_id: Invalid post ID."),
    );
    const r = await check(ref());
    expect(r.state).toBe("missing");
  });

  it("returns 'unknown' (not missing) for a generic tool_error", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(
      new InvokerError("tool_error", "insufficient capability for this ability"),
    );
    const r = await check(ref());
    expect(r.state).toBe("unknown");
  });

  it("returns 'missing' when the ability envelope reports a not-found failure", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: false,
      error: "Post not found",
    });
    const r = await check(ref());
    expect(r.state).toBe("missing");
  });

  it("returns 'unknown' when the ability envelope reports a generic failure", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: false,
      error: "temporarily unavailable",
    });
    const r = await check(ref());
    expect(r.state).toBe("unknown");
  });

  it("degrades to 'unknown' when the ability is absent from the instance catalog (tool_not_found)", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(
      new InvokerError(
        "tool_not_found",
        'tool "ewpa/get-post" is not present in the instance catalog',
      ),
    );
    const r = await check(ref());
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("ewpa/get-post");
  });

  it("degrades to 'unknown' on a catalog-cache/load failure (catalog_unavailable) — never a crash", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(
      new InvokerError(
        "catalog_unavailable",
        "the server-enrollment read failed; refusing to serve any catalog",
      ),
    );
    const r = await check(ref());
    expect(r.state).toBe("unknown");
  });

  it("degrades to 'unknown' on transport failures (network_error / timeout)", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(
      new InvokerError("timeout", "connector instance MCP call timed out"),
    );
    const r = await check(ref());
    expect(r.state).toBe("unknown");
  });

  it("degrades to 'unknown' when the per-instance tool policy denies the freshness read", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(
      new InvokerError("tool_policy_denied", 'tool "ewpa/get-post" is denied by the instance policy'),
    );
    const r = await check(ref());
    expect(r.state).toBe("unknown");
  });

  it("degrades to 'unknown' when a non-Invoker error escapes the probe", async () => {
    mocks.invokeConnectorInstanceTool.mockRejectedValue(new Error("boom"));
    const r = await check(ref());
    expect(r.state).toBe("unknown");
  });

  it("returns 'changed' when the modified timestamp differs", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: {
        post_id: 42,
        post_modified_gmt: "2026-05-23T11:00:00",
        post_content: "updated content",
      },
    });
    const r = await check(ref({ extra: { instanceId: "wp_instance_1", contentHash: "old_hash" } }));
    expect(r.state).toBe("changed");
  });

  it("returns 'fresh' when the modified timestamp matches", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: {
        post_id: 42,
        post_modified_gmt: "2026-05-23T10:00:00",
        post_content: "matching content",
      },
    });
    const r = await check(ref());
    expect(r.state).toBe("fresh");
  });

  it("returns 'changed' on a content-hash mismatch when no timestamp is comparable", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_id: 42, post_content: "different content" },
    });
    const r = await check(
      ref({
        modifiedAt: undefined,
        extra: { instanceId: "wp_instance_1", contentHash: "hash_of_something_else" },
      }),
    );
    expect(r.state).toBe("changed");
  });

  it("extracts REST-API-style nested content.raw as a defensive fallback shape", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      id: 42,
      modified_gmt: "2026-05-23T10:00:00",
      content: { raw: "matching content" },
    });
    const r = await check(ref());
    expect(r.state).toBe("fresh");
  });

  it("returns 'unknown' (never probes) when the trusted actor's org mismatches the change-set org", async () => {
    mocks.resolveTrustedWriteActor.mockResolvedValue({
      ...TRUSTED_ACTOR,
      orgId: "org_OTHER",
    });
    const r = await check(ref());
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("organization");
    expect(mocks.invokeConnectorInstanceTool).not.toHaveBeenCalled();
  });

  it("returns 'unknown' when a captured contentHash cannot be verified (no recognized content field)", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_id: 42, post_modified_gmt: "2026-05-23T10:00:00", body_html: "<p>c</p>" },
    });
    const r = await check(
      ref({ extra: { instanceId: "wp_instance_1", contentHash: "some_captured_hash" } }),
    );
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("content");
  });

  it("never aliases an unrecognized content shape to the empty document (empty-hash collision -> unknown)", async () => {
    const { createHash } = await import("node:crypto");
    const emptyHash = createHash("sha256").update("").digest("hex");
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_id: 42, body_html: "<p>real content the extractor does not recognize</p>" },
    });
    const r = await check(
      ref({ modifiedAt: undefined, extra: { instanceId: "wp_instance_1", contentHash: emptyHash } }),
    );
    expect(r.state).toBe("unknown");
  });

  it("returns 'unknown' for a fully unrecognized ability response shape", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { some_field: 1, another: "x" },
    });
    const r = await check(ref());
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") expect(r.reason).toContain("unrecognized");
  });

  it("returns 'unknown' (not fresh) when the captured timestamp has no recognized remote counterpart", async () => {
    // Pre-re-point this silently passed as fresh — a latent false-fresh.
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_id: 42, post_content: "content but no modified field" },
    });
    const r = await check(ref()); // captured modifiedAt set, no captured hash
    expect(r.state).toBe("unknown");
  });

  it("returns 'unknown' when nothing captured is comparable", async () => {
    mocks.invokeConnectorInstanceTool.mockResolvedValue({
      success: true,
      data: { post_id: 42, post_modified_gmt: "2026-05-23T10:00:00", post_content: "c" },
    });
    const r = await check(ref({ modifiedAt: undefined, extra: { instanceId: "wp_instance_1" } }));
    expect(r.state).toBe("unknown");
  });
});
