import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#1890 (epic #1883 A2 / D6) — upload-refusal advisory channel:
// deep-link + occurrence dedupe-key + notification composition, and the
// best-effort emit that reuses the existing notifications primitive.

const createNotificationForRecipient = vi.fn();
vi.mock("@/lib/notifications", () => ({
  createNotificationForRecipient: (...a: unknown[]) =>
    createNotificationForRecipient(...a),
}));

import {
  UPLOAD_REFUSAL_CATEGORY,
  UPLOAD_REFUSAL_DEDUPE_PREFIX,
  buildUploadRefusalMarketplaceHref,
  buildUploadRefusalNotificationInput,
  notifyUploadRefusal,
  uploadRefusalDedupeKey,
} from "../upload-refusal-advisory";

describe("upload-refusal advisory: deep link", () => {
  it("points at the marketplace with the URL-encoded refused MIME", () => {
    expect(buildUploadRefusalMarketplaceHref("application/zip")).toBe(
      "/configuration/marketplace?accepts=application%2Fzip",
    );
  });
  it("bounds a pathological MIME length before encoding", () => {
    const href = buildUploadRefusalMarketplaceHref("x/".repeat(400));
    // 255-char bound on the raw MIME → encoded length stays finite/bounded.
    expect(href.startsWith("/configuration/marketplace?accepts=")).toBe(true);
    expect(href.length).toBeLessThan(600);
  });
});

describe("upload-refusal advisory: occurrence dedupe key", () => {
  it("is stable per MIME (same MIME → same occurrence key)", () => {
    expect(uploadRefusalDedupeKey("application/zip")).toBe(
      uploadRefusalDedupeKey("application/zip"),
    );
    expect(uploadRefusalDedupeKey("application/zip")).toBe(
      `${UPLOAD_REFUSAL_DEDUPE_PREFIX}application/zip`,
    );
  });
  it("differs across MIMEs (a distinct refused format is a distinct occurrence)", () => {
    expect(uploadRefusalDedupeKey("application/zip")).not.toBe(
      uploadRefusalDedupeKey("text/markdown"),
    );
  });
});

describe("upload-refusal advisory: notification input", () => {
  it("is an info notification carrying the deep link + occurrence key + metadata", () => {
    const input = buildUploadRefusalNotificationInput({
      normalizedMime: "application/zip",
      filename: "bundle.zip",
    });
    expect(input.kind).toBe("info");
    expect(input.href).toBe(
      "/configuration/marketplace?accepts=application%2Fzip",
    );
    expect(input.dedupeKey).toBe(`${UPLOAD_REFUSAL_DEDUPE_PREFIX}application/zip`);
    expect(input.metadata).toMatchObject({
      category: UPLOAD_REFUSAL_CATEGORY,
      mime: "application/zip",
      filename: "bundle.zip",
    });
    expect(input.body).toContain("bundle.zip");
    expect(input.body).toContain("application/zip");
  });
  it("names an anonymous file when no filename is given", () => {
    const input = buildUploadRefusalNotificationInput({
      normalizedMime: "application/zip",
    });
    expect(input.body).toContain("an uploaded file");
    expect(input.metadata).not.toHaveProperty("filename");
  });
});

describe("notifyUploadRefusal", () => {
  beforeEach(() => {
    createNotificationForRecipient.mockReset();
    createNotificationForRecipient.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("emits the advisory to the uploading user via the reused primitive", async () => {
    await notifyUploadRefusal({
      userId: "u1",
      normalizedMime: "application/zip",
      filename: "bundle.zip",
    });
    expect(createNotificationForRecipient).toHaveBeenCalledTimes(1);
    const [recipient, input] = createNotificationForRecipient.mock.calls[0] as [
      { kind: string; userId: string },
      { dedupeKey: string; kind: string },
    ];
    expect(recipient).toEqual({ kind: "user", userId: "u1" });
    expect(input.dedupeKey).toBe(`${UPLOAD_REFUSAL_DEDUPE_PREFIX}application/zip`);
    expect(input.kind).toBe("info");
  });

  it("no-ops on a blank MIME (no recourse to point at)", async () => {
    await notifyUploadRefusal({ userId: "u1", normalizedMime: "" });
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("no-ops without a user id", async () => {
    await notifyUploadRefusal({ userId: "", normalizedMime: "application/zip" });
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("swallows a notification-write failure (best-effort — never throws)", async () => {
    createNotificationForRecipient.mockRejectedValue(new Error("bell down"));
    await expect(
      notifyUploadRefusal({ userId: "u1", normalizedMime: "application/zip" }),
    ).resolves.toBeUndefined();
  });
});
