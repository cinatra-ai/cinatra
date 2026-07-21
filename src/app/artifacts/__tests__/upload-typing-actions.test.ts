/**
 * cinatra#1892 (epic #1883 A4) — server-action boundary tests for the
 * /artifacts upload-typing affordances. Every collaborator is mocked (no DB /
 * no auth graph): these prove the ACTION wiring for the three A4 correction-wave
 * findings.
 *
 *   B2 — assertUploadMeaning gates on WRITE authority (readArtifactForMeaningWrite,
 *        i.e. canonical object.update), and the candidate list is filtered by the
 *        per-actor extension-ACCESS gate so a foreign-scope extension cannot be
 *        asserted through a crafted call.
 *   B4 — requestTypeInstall returns honestly: zero admin recipients ⇒ NOT ok:true
 *        (a distinct "no-admins" reason), and coalesced repeat ⇒ alreadyRequested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matcherManifestRegistry } from "@cinatra-ai/objects/registry";

const getAuthSession = vi.fn();
const getActorContext = vi.fn();
const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
  getActorContext: (...a: unknown[]) => getActorContext(...a),
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const listInstalledMeaningTypesAcceptingMime = vi.fn();
vi.mock("@/lib/artifacts/installed-type-picker", () => ({
  listInstalledMeaningTypesAcceptingMime: (...a: unknown[]) =>
    listInstalledMeaningTypesAcceptingMime(...a),
}));

const resolveActiveInstallForActor = vi.fn();
vi.mock("@/lib/extension-install-resolution", () => ({
  resolveActiveInstallForActor: (...a: unknown[]) => resolveActiveInstallForActor(...a),
}));

const assertSemanticType = vi.fn();
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  assertSemanticType: (...a: unknown[]) => assertSemanticType(...a),
}));

const readArtifactForDetail = vi.fn();
const readArtifactForMeaningWrite = vi.fn();
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: (...a: unknown[]) => readArtifactForDetail(...a),
  readArtifactForMeaningWrite: (...a: unknown[]) => readArtifactForMeaningWrite(...a),
}));

const resolveRecipientToUserIds = vi.fn();
vi.mock("@cinatra-ai/notifications/server", () => ({
  resolveRecipientToUserIds: (...a: unknown[]) => resolveRecipientToUserIds(...a),
}));

const createNotificationForRecipient = vi.fn();
vi.mock("@/lib/notifications", () => ({
  createNotificationForRecipient: (...a: unknown[]) => createNotificationForRecipient(...a),
}));

const loadMarketplaceBrowse = vi.fn();
vi.mock("@/lib/marketplace-browse", () => ({
  loadMarketplaceBrowse: (...a: unknown[]) => loadMarketplaceBrowse(...a),
}));

// The dynamic imports inside filterCandidatesByActorAccess.
const isSystemExtension = vi.fn();
vi.mock("@cinatra-ai/extensions/system-extension-inventory", () => ({
  isSystemExtension: (...a: unknown[]) => isSystemExtension(...a),
}));
// The A4-seam org-scoped write gate for matcher-channel members. Dynamic-imported
// (not top-level), so a mock here intercepts it without pulling the server-only
// canonical-store module. `matcherManifestRegistry` uses the REAL singleton
// (registered per-test + cleared) — the channel membership signal the gate reads.
const isArtifactExtensionWriteAllowed = vi.fn();
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: (...a: unknown[]) =>
    isArtifactExtensionWriteAllowed(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// `@/lib/artifacts/type-install-request` is deliberately NOT mocked: the real
// pure notification builder runs (its href-org behavior is asserted in
// type-install-request.test.ts).

const ACTOR = { principalId: "u1", organizationId: "org-1" };
function authedSession(over: Record<string, unknown> = {}) {
  return {
    user: { id: "u1", name: "Dana", email: "dana@x.io" },
    session: { activeOrganizationId: "org-1" },
    ...over,
  };
}

const CANDIDATE = {
  objectTypeId: "@acme/legal:contract",
  extension: "@acme/legal-artifact",
  displayName: "Contract",
  extensionLabel: "Legal",
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue(authedSession());
  getActorContext.mockResolvedValue(ACTOR);
});
afterEach(() => vi.resetModules());

describe("assertUploadMeaning — B2 write authority", () => {
  it("uses the WRITE gate (readArtifactForMeaningWrite) and rejects a read-only actor", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    readArtifactForMeaningWrite.mockReturnValue({ kind: "denied" });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: CANDIDATE.extension });
    expect(res).toEqual({
      ok: false,
      reason: "denied",
      message: expect.stringMatching(/permission/i),
    });
    // The read-only detail gate must NOT be what guards the mutation.
    expect(readArtifactForMeaningWrite).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("not-found is surfaced honestly from the write gate", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    readArtifactForMeaningWrite.mockReturnValue({ kind: "not-found" });
    const res = await assertUploadMeaning({ artifactId: "gone", extension: CANDIDATE.extension });
    expect(res).toMatchObject({ ok: false, reason: "not-found" });
    expect(assertSemanticType).not.toHaveBeenCalled();
  });
});

describe("assertUploadMeaning — B2 extension-access gate", () => {
  beforeEach(() => {
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "application/pdf", objectType: "@cinatra-ai/pdf:object" },
    });
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([CANDIDATE]);
    isSystemExtension.mockReturnValue(false);
  });

  it("REJECTS a foreign-scope extension the actor cannot address (no addressable install)", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    resolveActiveInstallForActor.mockResolvedValue(null); // not addressable for this actor
    const res = await assertUploadMeaning({ artifactId: "a1", extension: CANDIDATE.extension });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("ADMITS an extension addressable for the actor, then writes the user assertion", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    resolveActiveInstallForActor.mockResolvedValue({ id: "inst-1", isDefault: true, version: "1.0.0" });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: CANDIDATE.extension });
    expect(res).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        artifactId: "a1",
        extension: CANDIDATE.extension,
        assertedBy: "user",
      }),
    );
  });

  it("ADMITS a host-declared SYSTEM extension without an install-store row", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    isSystemExtension.mockReturnValue(true);
    resolveActiveInstallForActor.mockResolvedValue(null); // no canonical install row
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: CANDIDATE.extension });
    expect(res).toEqual({ ok: true });
    // A system extension never needs the install-store lookup.
    expect(resolveActiveInstallForActor).not.toHaveBeenCalled();
  });
});

describe("assertUploadMeaning — A4-seam matcher-channel candidate (package target)", () => {
  // A matcher-only pack: no object type, present ONLY in the matcher-manifest
  // channel, keyed by package name — the exact brand-voice shape.
  const MATCHER_PACK = "@cinatra-ai/brand-voice";
  const MATCHER_CANDIDATE = {
    objectTypeId: null,
    extension: MATCHER_PACK,
    displayName: "Brand Voice",
    extensionLabel: "Brand Voice",
  };

  beforeEach(() => {
    matcherManifestRegistry._clearForTests();
    matcherManifestRegistry.register({
      packageName: MATCHER_PACK,
      matcherSkillIds: ["@cinatra-ai/brand-voice:match"],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown", "text/plain", "application/pdf"],
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "application/pdf", objectType: "@cinatra-ai/pdf:object" },
    });
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([MATCHER_CANDIDATE]);
    isSystemExtension.mockReturnValue(false);
    resolveActiveInstallForActor.mockResolvedValue({
      id: "inst-bv",
      isDefault: true,
      version: "0.1.0",
    });
  });
  afterEach(() => matcherManifestRegistry._clearForTests());

  it("REJECTS a matcher-channel pack NOT org-writable (== the A6 resolver's gate) — no dead pick", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    isArtifactExtensionWriteAllowed.mockResolvedValue(false); // cross-org-only / archived for org
    const res = await assertUploadMeaning({ artifactId: "a1", extension: MATCHER_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(isArtifactExtensionWriteAllowed).toHaveBeenCalledWith(MATCHER_PACK, "org-1");
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("ADMITS an org-writable matcher pack and writes the USER assertion against the PACKAGE target", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: MATCHER_PACK });
    expect(res).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        artifactId: "a1",
        extension: MATCHER_PACK, // the package name IS the assertion target
        assertedBy: "user", // classic, rank-3 — the A6 resolver serves it at tier-1
      }),
    );
  });

  it("ADMITS an org-writable matcher pack the actor cannot separately ADDRESS — the org write gate is the SOLE authority (== A6), no phantom under-offer", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    // A6-live (ungoverned / owner-scoped): org write gate says yes, but the
    // actor-scoped install resolver returns null. The matcher pack must STILL be
    // admitted — requiring addressability here would reject a pack the resolver
    // presents (codex final finding 1). System-extension is also false.
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    resolveActiveInstallForActor.mockResolvedValue(null);
    isSystemExtension.mockReturnValue(false);
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: MATCHER_PACK });
    expect(res).toEqual({ ok: true });
    // The matcher-channel gate never consulted the actor-scoped install resolver.
    expect(resolveActiveInstallForActor).not.toHaveBeenCalledWith(MATCHER_PACK, ACTOR);
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({ extension: MATCHER_PACK, assertedBy: "user" }),
    );
  });
});

describe("requestTypeInstall — B4 honest zero-recipient", () => {
  it("zero admins ⇒ NOT ok:true (distinct no-admins reason), notification NOT written", async () => {
    const { requestTypeInstall } = await import("../upload-typing-actions");
    resolveRecipientToUserIds.mockResolvedValue([]); // no platform admins
    const res = await requestTypeInstall({ packageName: "@acme/legal-artifact" });
    expect(res).toMatchObject({ ok: false, reason: "no-admins" });
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
  });

  it("admins present + a fresh row ⇒ ok, alreadyRequested:false; roster threaded (same expansion, no re-resolve)", async () => {
    const { requestTypeInstall } = await import("../upload-typing-actions");
    resolveRecipientToUserIds.mockResolvedValue(["admin-1", "admin-2"]);
    createNotificationForRecipient.mockResolvedValue([{ id: "n1" }, { id: "n2" }]);
    const res = await requestTypeInstall({ packageName: "@acme/legal-artifact" });
    expect(res).toEqual({ ok: true, alreadyRequested: false });
    // TOCTOU close: the resolved roster is passed verbatim so the created count
    // comes from THIS expansion — the roster is resolved exactly once.
    expect(resolveRecipientToUserIds).toHaveBeenCalledTimes(1);
    expect(createNotificationForRecipient).toHaveBeenCalledWith(
      { kind: "admins" },
      expect.any(Object),
      { recipientUserIds: ["admin-1", "admin-2"] },
    );
  });

  it("admins present but occurrence-deduped (empty result over a non-empty roster) ⇒ ok, alreadyRequested:true", async () => {
    const { requestTypeInstall } = await import("../upload-typing-actions");
    resolveRecipientToUserIds.mockResolvedValue(["admin-1"]);
    createNotificationForRecipient.mockResolvedValue([]); // coalesced onto standing request
    const res = await requestTypeInstall({ packageName: "@acme/legal-artifact" });
    expect(res).toEqual({ ok: true, alreadyRequested: true });
  });

  it("unauthenticated ⇒ auth-required, admin roster never resolved", async () => {
    const { requestTypeInstall } = await import("../upload-typing-actions");
    getAuthSession.mockResolvedValue({ user: undefined, session: undefined });
    const res = await requestTypeInstall({ packageName: "@acme/legal-artifact" });
    expect(res).toMatchObject({ ok: false, reason: "auth-required" });
    expect(resolveRecipientToUserIds).not.toHaveBeenCalled();
  });
});
