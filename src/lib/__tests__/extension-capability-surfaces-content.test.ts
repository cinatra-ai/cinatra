// Lazy/guarded host-access cutover — the Content cluster's
// capability resolution surfaces (blog-system, social-media-system,
// email-system). The host names no connector package; the blog/email surfaces
// resolve the connector facades through the capability registry at call time
// and DEGRADE per feature when no provider is registered.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { resolveBlogSystem, requireBlogSystem } from "@/lib/blog-system-provider";
import {
  resolveSocialMediaSystem,
  requireSocialMediaSystem,
} from "@/lib/social-media-system-provider";
import {
  resolveEmailSystemFacade,
  requireEmailSystemFacade,
} from "@/lib/email-transport-provider";

const BLOG_IMPL = {
  buildDraftPayload: vi.fn(async () => ({ createPayload: { title: "t" } })),
  materializeBlogImage: vi.fn(async () => ({
    artifactId: "art-1",
    representationRevisionId: "rev-1",
  })),
  getWordPressContentConverter: vi.fn(() => null),
};

beforeEach(() => {
  __resetCapabilityRegistry();
  vi.clearAllMocks();
});

describe("blog-system resolution", () => {
  it("degrades to null with an empty registry; require* throws the descriptive degraded error", () => {
    expect(resolveBlogSystem()).toBeNull();
    expect(() => requireBlogSystem()).toThrow(/Blog system unavailable/);
  });

  it("resolves the structurally-valid registered facade and skips invalid impls", async () => {
    registerCapabilityProvider("blog-system", {
      packageName: "@v/not-a-blog-system",
      impl: { buildDraftPayload: "nope" },
    });
    registerCapabilityProvider("blog-system", {
      packageName: "@v/blog-connector",
      impl: BLOG_IMPL,
    });
    const system = requireBlogSystem();
    const result = await system.materializeBlogImage({
      imageBase64: "aGk=",
      imageMimeType: "image/png",
      title: "t",
    });
    expect(result).toEqual({ artifactId: "art-1", representationRevisionId: "rev-1" });
    expect(BLOG_IMPL.materializeBlogImage).toHaveBeenCalledTimes(1);
  });

  it("converter lookup degrades like 'no converter registered' (the WP convert primitive's passthrough)", () => {
    // Absent provider → optional-chained lookup yields undefined → the
    // handler's existing `if (!converter)` passthrough branch fires.
    const converter = resolveBlogSystem()?.getWordPressContentConverter("wp-1");
    expect(converter).toBeUndefined();
  });
});

describe("social-media-system resolution", () => {
  it("degrades to null with an empty registry; require* throws the descriptive degraded error", () => {
    expect(resolveSocialMediaSystem()).toBeNull();
    expect(() => requireSocialMediaSystem()).toThrow(/Social-media system unavailable/);
  });

  it("publishes through the registered facade", async () => {
    const publishPost = vi.fn(async () => ({
      providerId: "linkedin",
      providerPostId: "p-1",
      publishedAt: "2026-06-11T00:00:00Z",
    }));
    registerCapabilityProvider("social-media-system", {
      packageName: "@v/social-media-connector",
      impl: { publishPost },
    });
    const receipt = await requireSocialMediaSystem().publishPost(
      {
        accountId: "a-1",
        destinationType: "member",
        destinationId: "m-1",
        content: "hello",
      },
      { connectorId: "linkedin", userId: "u-1" },
    );
    expect(receipt.providerPostId).toBe("p-1");
    expect(publishPost).toHaveBeenCalledTimes(1);
  });
});

describe("email-system resolution", () => {
  it("degrades to null with an empty registry; require* throws the descriptive degraded error", () => {
    expect(resolveEmailSystemFacade()).toBeNull();
    expect(() => requireEmailSystemFacade()).toThrow(/Email system unavailable/);
  });

  it("sends through the registered facade (the trigger default-deps path)", async () => {
    const sendEmail = vi.fn(async () => ({ providerId: "gmail", providerMessageId: "m-1" }));
    registerCapabilityProvider("email-system", {
      packageName: "@v/email-connector",
      impl: { sendEmail },
    });
    const facade = requireEmailSystemFacade();
    await facade.sendEmail(
      { to: ["x@example.com"], subject: "s", textBody: "b" },
      { userId: "u-1", orgId: "o-1" },
    );
    expect(sendEmail).toHaveBeenCalledWith(
      { to: ["x@example.com"], subject: "s", textBody: "b" },
      { userId: "u-1", orgId: "o-1" },
    );
  });
});
