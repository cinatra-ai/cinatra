// WordPress freshness adapter test.
//
// Mock-based: stubs fetch + readWordPressInstanceById so we can exercise
// the freshness adapter's 5-state contract without a real WordPress.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/wordpress-api", () => ({
  readWordPressInstanceById: vi.fn(),
}));

import { readWordPressInstanceById } from "@/lib/wordpress-api";
import { wordpressFreshnessAdapter } from "../freshness/wordpress-adapter";

const FAKE_INSTANCE = {
  id: "wp_instance_1",
  siteUrl: "http://localhost:8080",
  username: "admin",
  appPassword: "test-password",
};

describe("wordpressFreshnessAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(readWordPressInstanceById).mockResolvedValue(FAKE_INSTANCE as never);
  });

  it("returns 'unsupported' when no remoteRevisionRef is supplied", async () => {
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: null,
    });
    expect(r.state).toBe("unsupported");
  });

  it("returns 'unsupported' for refs not from WordPress connector", async () => {
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: {
        connector: "drupal",
        kind: "drupal-node",
        remoteId: "42",
      },
    });
    expect(r.state).toBe("unsupported");
  });

  it("returns 'unknown' when remoteRevisionRef lacks extra.instanceId", async () => {
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: {
        connector: "wordpress",
        kind: "wordpress-post",
        remoteId: "42",
      },
    });
    expect(r.state).toBe("unknown");
    if (r.state === "unknown") {
      expect(r.reason).toContain("instanceId");
    }
  });

  it("returns 'missing' when WordPress returns 404", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      json: async () => ({ code: "rest_post_invalid_id" }),
    }) as never;
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: {
        connector: "wordpress",
        kind: "wordpress-post",
        remoteId: "42",
        modifiedAt: "2026-05-23T10:00:00Z",
        extra: { instanceId: "wp_instance_1" },
      } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"],
    });
    expect(r.state).toBe("missing");
  });

  it("returns 'changed' when modified_gmt differs", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        id: 42,
        modified_gmt: "2026-05-23T11:00:00",
        content: { raw: "updated content" },
      }),
    }) as never;
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: {
        connector: "wordpress",
        kind: "wordpress-post",
        remoteId: "42",
        modifiedAt: "2026-05-23T10:00:00",
        extra: { instanceId: "wp_instance_1", contentHash: "old_hash" },
      } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"],
    });
    expect(r.state).toBe("changed");
  });

  it("returns 'fresh' when modified_gmt matches", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        id: 42,
        modified_gmt: "2026-05-23T10:00:00",
        content: { raw: "matching content" },
      }),
    }) as never;
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: {
        connector: "wordpress",
        kind: "wordpress-post",
        remoteId: "42",
        modifiedAt: "2026-05-23T10:00:00",
        extra: { instanceId: "wp_instance_1" },
      } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"],
    });
    expect(r.state).toBe("fresh");
  });

  it("returns 'unknown' when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as never;
    const r = await wordpressFreshnessAdapter.check({
      objectId: "obj_1",
      orgId: "org_1",
      remoteRevisionRef: {
        connector: "wordpress",
        kind: "wordpress-post",
        remoteId: "42",
        modifiedAt: "2026-05-23T10:00:00",
        extra: { instanceId: "wp_instance_1" },
      } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"],
    });
    expect(r.state).toBe("unknown");
  });
});
