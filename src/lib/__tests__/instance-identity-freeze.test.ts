// Namespace-freeze invariant + freeze-on-publish primitive.
//
// Locks two pieces of behaviour:
//
//   1. writeInstanceIdentity() refuses to mutate `instanceNamespace` once
//      `firstPublishedAt !== null`, unless the caller passes
//      `{ allowNamespaceRename: true }`. Same-namespace writes
//      (display-name edits, registry slot updates, firstPublishedAt flips)
//      remain allowed.
//   2. markFirstPublishedIfCurrentScope() flips `firstPublishedAt` from null
//      to now() only when the published package lives under the operator's
//      current scope. No-op when already frozen or when the publish was for
//      a different scope (e.g. re-publishing a shipped `@cinatra/...` agent
//      on a non-cinatra instance).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeInstanceIdentity,
  markFirstPublishedIfCurrentScope,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn(),
  writeMetadataValueToDatabase: vi.fn(),
}));

vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));

import {
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";

const POST_PUBLISH_IDENTITY: InstanceIdentity = {
  instanceNamespace: "acme",
  instanceDisplayName: "Acme Co",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct",
  passwordIv: "pw-iv",
  registryUrl: "https://registry.cinatra.ai",
  firstPublishedAt: "2026-05-01T00:00:00.000Z",
  createdAt: "2026-04-01T00:00:00.000Z",
};

const PRE_PUBLISH_IDENTITY: InstanceIdentity = {
  ...POST_PUBLISH_IDENTITY,
  firstPublishedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// writeInstanceIdentity invariant
// -----------------------------------------------------------------------------

describe("writeInstanceIdentity — namespace-freeze invariant", () => {
  it("rejects a namespace change when firstPublishedAt is set and no override flag is passed", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(POST_PUBLISH_IDENTITY);
    const next: InstanceIdentity = { ...POST_PUBLISH_IDENTITY, instanceNamespace: "renamed" };
    expect(() => writeInstanceIdentity(next)).toThrow(/frozen/);
    expect(vi.mocked(writeMetadataValueToDatabase)).not.toHaveBeenCalled();
  });

  it("allows a namespace change when firstPublishedAt is set AND allowNamespaceRename is true", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(POST_PUBLISH_IDENTITY);
    const next: InstanceIdentity = {
      ...POST_PUBLISH_IDENTITY,
      instanceNamespace: "renamed",
      firstPublishedAt: null,
    };
    expect(() => writeInstanceIdentity(next, { allowNamespaceRename: true })).not.toThrow();
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledTimes(1);
  });

  it("allows a namespace change pre-freeze even without the override flag", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(PRE_PUBLISH_IDENTITY);
    const next: InstanceIdentity = { ...PRE_PUBLISH_IDENTITY, instanceNamespace: "renamed" };
    expect(() => writeInstanceIdentity(next)).not.toThrow();
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledTimes(1);
  });

  it("allows same-namespace writes (display-name edit) when frozen, no override needed", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(POST_PUBLISH_IDENTITY);
    const next: InstanceIdentity = { ...POST_PUBLISH_IDENTITY, instanceDisplayName: "Acme Renamed" };
    expect(() => writeInstanceIdentity(next)).not.toThrow();
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledTimes(1);
  });

  it("allows a write when there is no prior identity row (greenfield install)", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(null);
    expect(() => writeInstanceIdentity(POST_PUBLISH_IDENTITY)).not.toThrow();
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// markFirstPublishedIfCurrentScope
// -----------------------------------------------------------------------------

describe("markFirstPublishedIfCurrentScope", () => {
  it("flips firstPublishedAt from null to now() when the published package matches the current scope", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(PRE_PUBLISH_IDENTITY);
    markFirstPublishedIfCurrentScope("@acme/webpage-image-count");
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledTimes(1);
    const written = vi.mocked(writeMetadataValueToDatabase).mock.calls[0]![1] as InstanceIdentity;
    expect(written.firstPublishedAt).not.toBeNull();
    expect(typeof written.firstPublishedAt).toBe("string");
    expect(() => new Date(written.firstPublishedAt as string)).not.toThrow();
    expect(written.instanceNamespace).toBe(PRE_PUBLISH_IDENTITY.instanceNamespace);
  });

  it("does NOT freeze when the published package belongs to a different scope", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(PRE_PUBLISH_IDENTITY);
    markFirstPublishedIfCurrentScope("@cinatra-ai/email-outreach-agent");
    expect(vi.mocked(writeMetadataValueToDatabase)).not.toHaveBeenCalled();
  });

  it("is a no-op when firstPublishedAt is already set (one-way semantics)", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(POST_PUBLISH_IDENTITY);
    markFirstPublishedIfCurrentScope("@acme/another-agent");
    expect(vi.mocked(writeMetadataValueToDatabase)).not.toHaveBeenCalled();
  });

  it("is a no-op when no identity row exists yet", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(null);
    markFirstPublishedIfCurrentScope("@acme/foo");
    expect(vi.mocked(writeMetadataValueToDatabase)).not.toHaveBeenCalled();
  });

  it("is a no-op when given an empty / invalid package name (defensive)", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(PRE_PUBLISH_IDENTITY);
    markFirstPublishedIfCurrentScope("");
    expect(vi.mocked(writeMetadataValueToDatabase)).not.toHaveBeenCalled();
  });
});
