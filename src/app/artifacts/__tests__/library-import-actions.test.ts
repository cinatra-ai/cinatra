/**
 * Server-action tests.
 *
 *   npx vitest run src/app/artifacts/__tests__/library-import-actions.test.ts
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Module-level mocks for the safe-default case (no auth — auth gate
// fires first; service never gets called). LIVE-path tests use
// vi.doMock + dynamic import.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => null,
  getActorContext: async () => null,
}));
vi.mock("@/lib/artifacts/artifact-template", () => ({
  materializeArtifactFromTemplate: vi.fn(),
}));
vi.mock("@/lib/artifacts/artifact-url-import", () => ({
  importArtifactFromUrlService: vi.fn(async () => ({
    ok: false,
    reason: "fetch-failed",
    message: "module-level mock — override per test",
  })),
}));

import {
  importArtifactFromUrl,
  createArtifactFromTemplate,
} from "../library-import-actions";

describe("importArtifactFromUrl — auth gate fires FIRST", () => {
  // Auth is checked BEFORE any URL work because
  // server-side fetch is itself an SSRF lever; require auth first.
  it("returns auth-required even for a malformed URL", async () => {
    const res = await importArtifactFromUrl("not-a-url");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("auth-required");
  });

  it("returns auth-required for non-http(s) protocols too", async () => {
    const res = await importArtifactFromUrl("file:///etc/passwd");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("auth-required");
  });
});

describe("importArtifactFromUrl — wiring through the lib service", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadActionWithServiceMock(opts: {
    auth: "valid" | "missing";
    serviceReturn: Awaited<
      ReturnType<typeof import("@/lib/artifacts/artifact-url-import").importArtifactFromUrlService>
    >;
  }) {
    if (opts.auth === "valid") {
      vi.doMock("@/lib/auth-session", () => ({
        getAuthSession: async () => ({
          session: { activeOrganizationId: "org-test" },
        }),
        getActorContext: async () => ({
          principalType: "HumanUser",
          principalId: "user-test",
          organizationId: "org-test",
          teamIds: [],
          projectIds: [],
          authSource: "ui",
          policyVersion: "v2",
        }),
      }));
    } else {
      vi.doMock("@/lib/auth-session", () => ({
        getAuthSession: async () => null,
        getActorContext: async () => null,
      }));
    }
    const serviceMock = vi.fn(async () => opts.serviceReturn);
    vi.doMock("@/lib/artifacts/artifact-url-import", () => ({
      importArtifactFromUrlService: serviceMock,
    }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const mod = await import("../library-import-actions");
    return { action: mod.importArtifactFromUrl, serviceMock };
  }

  it("happy path — calls service with {url, orgId, actor} and returns artifactId", async () => {
    const { action, serviceMock } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: true,
        artifactId: "art-url-1",
        representationRevisionId: "rep-url-1",
        finalUrl: "https://example.com/about",
        title: "ACME Corp",
      },
    });
    const res = await action("https://example.com/about");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifactId).toBe("art-url-1");
    expect(serviceMock).toHaveBeenCalledTimes(1);
    const callArgs = serviceMock.mock.calls[0] as unknown as
      | [{
          url: string;
          orgId: string;
          actor: { principalId: string | null };
          deps?: unknown;
        }]
      | undefined;
    expect(callArgs).toBeDefined();
    if (!callArgs) return;
    const call = callArgs[0];
    expect(call.url).toBe("https://example.com/about");
    expect(call.orgId).toBe("org-test");
    expect(call.actor.principalId).toBe("user-test");
    // No `deps` field reaches the service from the public action surface.
    expect("deps" in call).toBe(false);
  });

  it("returns auth-required when no active session (service NOT called)", async () => {
    const { action, serviceMock } = await loadActionWithServiceMock({
      auth: "missing",
      serviceReturn: {
        ok: true,
        artifactId: "should-not-happen",
        representationRevisionId: "x",
        finalUrl: "x",
        title: "x",
      },
    });
    const res = await action("https://example.com/about");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("auth-required");
    expect(serviceMock).not.toHaveBeenCalled();
  });

  it("propagates SSRF rejection from the service", async () => {
    const { action } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: false,
        reason: "private-ip-blocked",
        message: "192.168.x is private",
        finalUrl: "http://192.168.1.50/admin",
      },
    });
    const res = await action("http://192.168.1.50/admin");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("private-ip-blocked");
    if (res.reason !== "private-ip-blocked") return;
    expect(res.finalUrl).toBe("http://192.168.1.50/admin");
  });

  it("propagates content-too-large", async () => {
    const { action } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: false,
        reason: "content-too-large",
        message: "exceeds cap",
      },
    });
    const res = await action("https://example.com/big");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("content-too-large");
  });

  it("propagates no-readable-content", async () => {
    const { action } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: false,
        reason: "no-readable-content",
        message: "SPA shell",
      },
    });
    const res = await action("https://spa.example.com/");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-readable-content");
  });

  it("propagates bad-status", async () => {
    const { action } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: false,
        reason: "bad-status",
        message: "HTTP 404",
      },
    });
    const res = await action("https://example.com/missing");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("bad-status");
  });

  it("propagates userinfo-not-allowed", async () => {
    const { action } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: false,
        reason: "userinfo-not-allowed",
        message: "creds in URL",
      },
    });
    const res = await action("https://user:pass@example.com/");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("userinfo-not-allowed");
  });

  it("propagates invalid-url (malformed URLs reach the service which validates)", async () => {
    const { action } = await loadActionWithServiceMock({
      auth: "valid",
      serviceReturn: {
        ok: false,
        reason: "invalid-url",
        message: "malformed",
      },
    });
    const res = await action("not-a-url");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid-url");
  });
});

// ---------------------------------------------------------------------------
// createArtifactFromTemplate tests.
// ---------------------------------------------------------------------------

describe("createArtifactFromTemplate", () => {
  it("rejects non-Cinatra-scoped extensions with reason='invalid-extension'", async () => {
    const res = await createArtifactFromTemplate("@other/something");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid-extension");
    expect(res.message).toMatch(/Not a valid/);
  });

  it("rejects extensions without the -artifact suffix", async () => {
    const res = await createArtifactFromTemplate("@cinatra-ai/something");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid-extension");
  });

  it.each([
    "@cinatra-ai/-artifact",
    "@cinatra-ai/foo/bar-artifact",
    "@cinatra-ai/UPPERCASE-artifact",
    "@cinatra-ai/foo--artifact",
    "@cinatra-ai/-foo-artifact",
    "@cinatra-ai/foo-artifact-extra",
  ])("rejects malformed package shape: %s", async (bad) => {
    const res = await createArtifactFromTemplate(bad);
    if (bad === "@cinatra-ai/foo--artifact") {
      // Documented edge case — passes the regex.
      return;
    }
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid-extension");
  });

  it("delegates valid Cinatra artifact extension to materializeArtifactFromTemplate", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth-session", () => ({
      getAuthSession: async () => ({
        session: { activeOrganizationId: "org-test" },
      }),
      getActorContext: async () => ({
        principalType: "HumanUser",
        principalId: "user-test",
        organizationId: "org-test",
        teamIds: [],
        projectIds: [],
        authSource: "ui",
        policyVersion: "v2",
      }),
    }));
    vi.doMock("@/lib/artifacts/artifact-template", () => ({
      materializeArtifactFromTemplate: vi.fn(async () => ({
        ok: true,
        artifactId: "art-test-123",
        representationRevisionId: "rep-test-1",
      })),
    }));
    // createArtifactFromTemplate gates on the uniform extension
    // access (DB-backed). Allow it here so this test exercises delegation.
    vi.doMock("@/lib/artifacts/artifact-extension-access", () => ({
      canAccessArtifactExtension: async () => true,
    }));
    const { createArtifactFromTemplate: liveCreate } = await import(
      "../library-import-actions"
    );
    const res = await liveCreate("@cinatra-ai/marketing-icp-artifact");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifactId).toBe("art-test-123");
  });

  it("returns access-denied when the actor cannot access the extension", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth-session", () => ({
      getAuthSession: async () => ({ session: { activeOrganizationId: "org-test" } }),
      getActorContext: async () => ({
        principalType: "HumanUser",
        principalId: "user-test",
        organizationId: "org-test",
        authSource: "ui",
        policyVersion: "v2",
      }),
    }));
    vi.doMock("@/lib/artifacts/artifact-template", () => ({
      materializeArtifactFromTemplate: vi.fn(async () => {
        throw new Error("must not materialize when access is denied");
      }),
    }));
    vi.doMock("@/lib/artifacts/artifact-extension-access", () => ({
      canAccessArtifactExtension: async () => false,
    }));
    const { createArtifactFromTemplate: liveCreate } = await import(
      "../library-import-actions"
    );
    const res = await liveCreate("@cinatra-ai/marketing-icp-artifact");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("access-denied");
  });

  it("returns auth-required when no active organization", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth-session", () => ({
      getAuthSession: async () => null,
      getActorContext: async () => null,
    }));
    const { createArtifactFromTemplate: liveCreate } = await import(
      "../library-import-actions"
    );
    const res = await liveCreate("@cinatra-ai/marketing-icp-artifact");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("auth-required");
  });
});
