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

import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";

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

// The claim-backed meaning-type reader (cinatra#3319), dynamic-imported by both
// actions, and the pack whose claim wins the row's type. The reader defaults to
// [] and the winner to none in the top-level beforeEach, so every case that
// does not name a claim reads exactly the registry channels it read before.
// The packages that win a claim are read only after a failed claim-backed read
// (cinatra#3319 T21 to T23); none by default.
const readClaimBackedMeaningTypesForOrg = vi.fn();
const readArtifactSafeClaimWinnerForType = vi.fn();
const readArtifactSafeClaimWinnerPackagesForOrg = vi.fn();
vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  readClaimBackedMeaningTypesForOrg: (...a: unknown[]) =>
    readClaimBackedMeaningTypesForOrg(...a),
  readArtifactSafeClaimWinnerForType: (...a: unknown[]) =>
    readArtifactSafeClaimWinnerForType(...a),
  readArtifactSafeClaimWinnerPackagesForOrg: (...a: unknown[]) =>
    readArtifactSafeClaimWinnerPackagesForOrg(...a),
}));

// The row's one presentation reading, which the confirmation's presented-base
// check takes once a definer's type accepts the file. Defaults to a complete
// reading that presents nothing.
const resolveArtifactPresentationReading = vi.fn();
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationReading: (...a: unknown[]) =>
    resolveArtifactPresentationReading(...a),
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
// The claim-scoped gate of a claim-backed pack's winning install (cinatra#3319):
// it admits by default (the top-level beforeEach), so a case names a refusal.
const canActorAccessClaimedArtifactExtension = vi.fn();
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: (...a: unknown[]) =>
    isArtifactExtensionWriteAllowed(...a),
  canActorAccessClaimedArtifactExtension: (...a: unknown[]) =>
    canActorAccessClaimedArtifactExtension(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The typed promotion road (cinatra#3028 enabler 0.14), dynamic-imported by the
// action. Mocked here so the ACTION's wiring is what these cases prove — the
// road's own decisions are proved in its two suites.
const promoteMatchedArtifactType = vi.fn();
// The person's own assertion and the row's change events, read by the action's
// row-own check before the converging road (cinatra#3319).
const readPersonAssertion = vi.fn();
vi.mock("@/lib/artifacts/typed-promotion-store", () => ({
  promoteMatchedArtifactType: (...a: unknown[]) => promoteMatchedArtifactType(...a),
  readPersonAssertion: (...a: unknown[]) => readPersonAssertion(...a),
}));
const listEventsForObject = vi.fn();
vi.mock("@/lib/object-history/eligibility", () => ({
  listEventsForObject: (...a: unknown[]) => listEventsForObject(...a),
}));
const verifySessionAuthority = vi.fn();
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
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
  readClaimBackedMeaningTypesForOrg.mockResolvedValue([]);
  readArtifactSafeClaimWinnerForType.mockReturnValue(null);
  readArtifactSafeClaimWinnerPackagesForOrg.mockReturnValue([]);
  canActorAccessClaimedArtifactExtension.mockResolvedValue(true);
  resolveArtifactPresentationReading.mockReturnValue({
    offer: { preselect: null, suggestions: [] },
    complete: true,
  });
});
afterEach(() => vi.resetModules());

describe("assertUploadMeaning — the converging re-confirmation (cinatra#3028, enabler 0.14)", () => {
  // THE STATE AN INTERRUPTED PROMOTION LEAVES: the row already carries the
  // extension's own type, and its promotion revision never landed. The candidate
  // list EXCLUDES every candidate of the extension that defines the row's
  // current type, so this confirmation can never pass the candidate gate — which
  // is why the road's convergence has to be reachable from HERE or from nowhere.
  const PACK = "@acme/voice";
  const OWN_TYPE = "@acme/voice:brief";
  /** The base type the row carried before the promotion retyped it. */
  const BASE_TYPE = "@cinatra-ai/markdown-artifact:artifact";

  beforeEach(() => {
    objectTypeRegistry._clearForTests();
    objectTypeRegistry.register(
      {
        type: OWN_TYPE,
        category: "data",
        isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      } as never,
      PACK,
    );
    matcherManifestRegistry._clearForTests();
    matcherManifestRegistry.register({
      packageName: PACK,
      matcherSkillIds: ["@acme/voice:match"],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown"],
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      // The row ALREADY carries the extension's own type.
      artifact: { mime: "text/markdown", objectType: OWN_TYPE },
    });
    // …so the picker's own exclusion leaves nothing to pick.
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([]);
    verifySessionAuthority.mockResolvedValue({ kind: "org-write" });
    // The confirmation that retyped the row wrote the person's assertion, and
    // the row's history holds that retype (newest first).
    readPersonAssertion.mockReturnValue(true);
    listEventsForObject.mockReturnValue([
      {
        objectType: OWN_TYPE,
        operation: "update",
        beforeSnapshot: { payload: { type: BASE_TYPE } },
        afterSnapshot: { payload: { type: OWN_TYPE } },
      },
      {
        objectType: BASE_TYPE,
        operation: "create",
        beforeSnapshot: null,
        afterSnapshot: { payload: { type: BASE_TYPE } },
      },
    ]);
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });

  it("COMPLETES a promotion an interruption left half-applied, and writes no second meaning", async () => {
    promoteMatchedArtifactType.mockResolvedValue({
      ok: true,
      representationRevisionId: "rep_converged",
      revision: 2,
      toType: OWN_TYPE,
      retyped: false,
    });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });
    expect(res).toEqual({
      ok: true,
      promotion: {
        promoted: true,
        toType: OWN_TYPE,
        representationRevisionId: "rep_converged",
        revision: 2,
      },
    });
    // The call that retyped the row wrote the person's meaning; a second
    // identical assertion would stack a duplicate for a choice already recorded.
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  // THE REPEAT (cinatra#3319, cinatra#4266): the store appends nothing on a row
  // it holds no promotion of, and answers `already-promoted`.
  it("a repeat while the person's own meaning stands answers ok and writes nothing", async () => {
    promoteMatchedArtifactType.mockResolvedValue({ ok: false, reason: "already-promoted" });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });
    expect(res).toEqual({ ok: true });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(readPersonAssertion).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "a1",
      extension: PACK,
      principal: "u1",
    });
  });

  it("still answers invalid-type when the road refuses and no meaning of the person stands — a row that merely CARRIES the type is not converged", async () => {
    promoteMatchedArtifactType.mockResolvedValue({ ok: false, reason: "already-promoted" });
    readPersonAssertion.mockReturnValue(false);
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("refuses when the store fails, although the person's meaning stands", async () => {
    promoteMatchedArtifactType.mockRejectedValue(new Error("history read failed"));
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("never takes the converging road for an extension that does not define the row's type", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: "@acme/unrelated" });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
  });
});

describe("assertUploadMeaning — the fresh promotion whose retype the store cannot prove (cinatra#3319)", () => {
  const PACK = "@acme/voice";
  const OWN_TYPE = "@acme/voice:brief";
  const BASE_TYPE = "@cinatra-ai/markdown-artifact:artifact";

  beforeEach(() => {
    objectTypeRegistry._clearForTests();
    objectTypeRegistry.register(
      {
        type: OWN_TYPE,
        category: "data",
        isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      } as never,
      PACK,
    );
    matcherManifestRegistry._clearForTests();
    matcherManifestRegistry.register({
      packageName: PACK,
      matcherSkillIds: ["@acme/voice:match"],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown"],
    });
    // A natively typed base row, and the pack offered for it: the ordinary road.
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: BASE_TYPE },
    });
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([
      { objectTypeId: OWN_TYPE, extension: PACK, displayName: "Brief", extensionLabel: "Voice" },
    ]);
    isSystemExtension.mockReturnValue(true);
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    verifySessionAuthority.mockResolvedValue({ kind: "org-write" });
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });

  it("C2h: a retype the store committed but could not prove answers ok with the refusal named, after the person's meaning was written", async () => {
    promoteMatchedArtifactType.mockResolvedValue({ ok: false, reason: "promotion-unproven" });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });
    expect(res).toEqual({
      ok: true,
      promotion: { promoted: false, reason: "promotion-unproven" },
    });
    // The person's own meaning stands; the road appended nothing it cannot prove.
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(promoteMatchedArtifactType).toHaveBeenCalledTimes(1);
    expect(promoteMatchedArtifactType.mock.calls[0]![0]).toMatchObject({
      orgId: "org-1",
      artifactId: "a1",
      extension: PACK,
      confirmed: true,
    });
  });
});

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

describe("3319 claim-backed meaning types reach the upload picker and its promotion", () => {
  // THE CLAIM-BACKED TYPE (cinatra#3319): the host registers the LinkedIn post
  // draft (no `isArtifact`, no package), and the organisation's artifact-safe
  // claim winner — the linkedin-artifacts pack — admits it with the accepts of
  // that version's manifest. Neither registry channel lists it, so the only
  // road to the picker is the claim-backed reader's entry.
  const POST_DRAFT = "@cinatra-ai/linkedin:post-draft";
  const LINKEDIN_PACK = "@cinatra-ai/linkedin-artifacts";
  const TEXT_TYPE = "@cinatra-ai/text-artifact:text";
  const ENTRY = {
    objectTypeId: POST_DRAFT,
    extension: LINKEDIN_PACK,
    acceptMimes: ["text/markdown", "text/plain"],
    // The winning claim's identity: its version, its install row and its scope.
    extensionVersion: "1.0.0",
    installId: "inst-linkedin-1",
    scope: "org:org-1",
  };
  /** Another version of the pack, installed elsewhere, put a matcher entry under
   *  its package name in the process-global registry. */
  function registerOtherVersionMatcher(): void {
    matcherManifestRegistry.register({
      packageName: LINKEDIN_PACK,
      matcherSkillIds: [`${LINKEDIN_PACK}:match`],
      matcherConfidenceThreshold: 0.5,
      fileMimeTypes: ["text/markdown"],
    });
  }
  /** The list as the real one draws it while the claim-backed read fails: with
   *  no claim-backed entry, every matcher entry is a candidate under its
   *  package name (installed-type-picker T16, "without a claim-backed entry"). */
  function listDrawsTheMatcherChannel(): void {
    listInstalledMeaningTypesAcceptingMime.mockImplementation(
      (_mime: string, opts?: { claimBacked?: readonly (typeof ENTRY)[] }) => {
        const claimed = new Set((opts?.claimBacked ?? []).map((e) => e.extension));
        return matcherManifestRegistry
          .list()
          .filter((e) => !claimed.has(e.packageName))
          .map((e) => ({
            objectTypeId: null,
            extension: e.packageName,
            displayName: e.packageName,
            extensionLabel: e.packageName,
          }));
      },
    );
  }
  const BRAND_PACK = "@acme/brand-voice";

  beforeEach(async () => {
    // The actions warm the registries once per module instance (the extensions
    // tree and the store). Warm THIS test's instance first, then clear, so what
    // a host has installed never reaches these cases, in any order or filter.
    const { ensureArtifactTypesRegisteredWithStore } = await import(
      "@/lib/artifacts/ensure-artifact-registry"
    );
    await ensureArtifactTypesRegisteredWithStore();
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
    readClaimBackedMeaningTypesForOrg.mockResolvedValue([ENTRY]);
    // The same arbitration names the pack as the winner of its claimed type.
    readArtifactSafeClaimWinnerForType.mockImplementation((_orgId: string, objectTypeId: string) =>
      objectTypeId === POST_DRAFT ? LINKEDIN_PACK : null,
    );
    readArtifactSafeClaimWinnerPackagesForOrg.mockReturnValue([LINKEDIN_PACK]);
    // The picker as the cure draws it: a claim-backed entry is a candidate only
    // when the caller hands it in, and the row's own type is never offered.
    listInstalledMeaningTypesAcceptingMime.mockImplementation(
      (
        _mime: string,
        opts?: { excludeTypeId?: string; claimBacked?: readonly (typeof ENTRY)[] },
      ) =>
        (opts?.claimBacked ?? [])
          .filter((e) => e.objectTypeId !== opts?.excludeTypeId)
          .map((e) => ({
            objectTypeId: e.objectTypeId,
            extension: e.extension,
            displayName: "Post Draft",
            extensionLabel: "LinkedIn",
          })),
    );
    isSystemExtension.mockReturnValue(true);
    verifySessionAuthority.mockResolvedValue({ kind: "org-write" });
    promoteMatchedArtifactType.mockResolvedValue({
      ok: true,
      representationRevisionId: "rep_3319",
      revision: 2,
      toType: POST_DRAFT,
      retyped: true,
    });
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
  });

  it("3319 T4: listInstalledTypesForArtifact passes the claim-backed reader's entries as opts.claimBacked", async () => {
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a1");
    expect(readClaimBackedMeaningTypesForOrg).toHaveBeenCalledWith("org-1");
    expect(listInstalledMeaningTypesAcceptingMime).toHaveBeenCalledWith("text/markdown", {
      excludeTypeId: TEXT_TYPE,
      claimBacked: [ENTRY],
    });
    expect(res).toMatchObject({
      ok: true,
      mime: "text/markdown",
      types: [expect.objectContaining({ objectTypeId: POST_DRAFT, extension: LINKEDIN_PACK })],
    });
  });

  it("3319 T5: assertUploadMeaning for linkedin-artifacts on a markdown row promotes into post-draft with threshold null", async () => {
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", extension: LINKEDIN_PACK, assertedBy: "user" }),
    );
    expect(promoteMatchedArtifactType).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        artifactId: "a1",
        extension: LINKEDIN_PACK,
        ownType: { typeId: POST_DRAFT, acceptsMimes: ["text/markdown", "text/plain"] },
        // linkedin-artifacts declares no matcher: the person's own road, no threshold.
        threshold: null,
        confirmed: true,
      }),
    );
  });

  it("3319 T6: a row already typed post-draft, re-confirmed for linkedin-artifacts, converges and answers ok with the promotion", async () => {
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      // The row ALREADY carries the claim-backed type; its promotion revision
      // never landed, and the picker's own exclusion leaves nothing to pick.
      artifact: { mime: "text/markdown", objectType: POST_DRAFT },
    });
    promoteMatchedArtifactType.mockResolvedValue({
      ok: true,
      representationRevisionId: "rep_3319",
      revision: 2,
      toType: POST_DRAFT,
      retyped: false,
    });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(promoteMatchedArtifactType).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: LINKEDIN_PACK,
        ownType: { typeId: POST_DRAFT, acceptsMimes: ["text/markdown", "text/plain"] },
      }),
    );
    expect(res).toEqual({
      ok: true,
      promotion: {
        promoted: true,
        toType: POST_DRAFT,
        representationRevisionId: "rep_3319",
        revision: 2,
      },
    });
    // The call that retyped the row wrote the person's meaning already.
    expect(assertSemanticType).not.toHaveBeenCalled();
    // The presented-base check read the claim-backed type with the claim-backed
    // population, and the row's reading presents no draft of the pack.
    expect(listInstalledMeaningTypesAcceptingMime).toHaveBeenCalledWith("text/markdown", {
      claimBacked: [ENTRY],
    });
    expect(resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
  });

  it("3319 T12: a row already typed post-draft is not converged for a person the access gate refuses the pack: refused, nothing promoted", async () => {
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: POST_DRAFT },
    });
    // The pack is neither a system extension nor installed for this person.
    isSystemExtension.mockReturnValue(false);
    resolveActiveInstallForActor.mockResolvedValue(null);
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(assertSemanticType).not.toHaveBeenCalled();
    // Refused by the access gate, before the row's reading.
    expect(resolveArtifactPresentationReading).not.toHaveBeenCalled();
  });

  it("3319 T13: a failed claim-backed read still answers the list, without the claim-backed types", async () => {
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("claim store unavailable"));
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a1");
    expect(res).toMatchObject({ ok: true, mime: "text/markdown", types: [] });
    expect(listInstalledMeaningTypesAcceptingMime).toHaveBeenCalledWith("text/markdown", {
      excludeTypeId: TEXT_TYPE,
      claimBacked: [],
    });
  });

  it("3319 T14: a failed claim-backed read offers no claim-backed type, so the confirmation of one is refused and writes nothing", async () => {
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("claim store unavailable"));
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
  });

  it("3319 T17: a claim-backed pack is decided by the claim's per-actor gate, never by the org-wide matcher gate an entry under its name would select", async () => {
    registerOtherVersionMatcher();
    // The org-wide matcher gate would admit the pack; the per-actor gate refuses it.
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    isSystemExtension.mockReturnValue(false);
    resolveActiveInstallForActor.mockResolvedValue(null);
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const listed = await listInstalledTypesForArtifact("a1");
    expect(listed).toMatchObject({ ok: true, types: [] });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(isArtifactExtensionWriteAllowed).not.toHaveBeenCalledWith(LINKEDIN_PACK, "org-1");
  });

  it("3319 T18: a claim-backed promotion takes threshold null although the matcher registry holds an entry under the pack's name", async () => {
    registerOtherVersionMatcher();
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: true });
    expect(promoteMatchedArtifactType).toHaveBeenCalledTimes(1);
    expect(promoteMatchedArtifactType).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: LINKEDIN_PACK,
        ownType: { typeId: POST_DRAFT, acceptsMimes: ["text/markdown", "text/plain"] },
        threshold: null,
      }),
    );
  });

  it("3319 T19: the claim-scoped gate of the winning install refuses a person the A4 gate admits: refused, nothing written", async () => {
    isSystemExtension.mockReturnValue(false);
    resolveActiveInstallForActor.mockResolvedValue({ id: "inst-linkedin-1", isDefault: true, version: "1.0.0" });
    canActorAccessClaimedArtifactExtension.mockResolvedValue(false);
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(canActorAccessClaimedArtifactExtension).toHaveBeenCalledWith(
      { extensionPackage: LINKEDIN_PACK, installId: "inst-linkedin-1", scope: "org:org-1" },
      ACTOR,
      "read",
    );
  });

  it("3319 T21: a failed claim-backed read leaves a matcher entry under a claim-winning pack's name neither listed nor confirmable, and the org-wide matcher gate is not asked", async () => {
    registerOtherVersionMatcher();
    listDrawsTheMatcherChannel();
    // The org-wide matcher gate would admit the pack.
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    // The claim-backed read fails (here: a failed install-row read), while the
    // claim store itself reads: the pack wins its claim, the row's claimant is none.
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("install row unreadable"));
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const listed = await listInstalledTypesForArtifact("a1");
    expect(listed).toMatchObject({ ok: true, types: [] });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(isArtifactExtensionWriteAllowed).not.toHaveBeenCalledWith(LINKEDIN_PACK, "org-1");
  });

  it("3319 T22: when the claim store cannot be read at all, the list does not offer the matcher entry of a pack that registers no artifact type, and its confirmation is refused", async () => {
    registerOtherVersionMatcher();
    listDrawsTheMatcherChannel();
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("claim store unavailable"));
    readArtifactSafeClaimWinnerForType.mockImplementation(() => {
      throw new Error("claim store unavailable");
    });
    readArtifactSafeClaimWinnerPackagesForOrg.mockImplementation(() => {
      throw new Error("claim store unavailable");
    });
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    // The list no longer offers what the confirmation then refuses.
    const listed = await listInstalledTypesForArtifact("a1");
    expect(listed).toMatchObject({ ok: true, types: [] });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
  });

  it("3319 T23: during a failed claim-backed read, a matcher pack that wins no claim keeps the org-wide matcher gate and is listed and confirmed (green at the fold's head)", async () => {
    matcherManifestRegistry.register({
      packageName: BRAND_PACK,
      matcherSkillIds: [`${BRAND_PACK}:match`],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown"],
    });
    listDrawsTheMatcherChannel();
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("install row unreadable"));
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const listed = await listInstalledTypesForArtifact("a1");
    expect(listed).toMatchObject({
      ok: true,
      types: [expect.objectContaining({ objectTypeId: null, extension: BRAND_PACK })],
    });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: BRAND_PACK });
    expect(res).toMatchObject({ ok: true });
    expect(isArtifactExtensionWriteAllowed).toHaveBeenCalledWith(BRAND_PACK, "org-1");
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", extension: BRAND_PACK, assertedBy: "user" }),
    );
  });

  it("3319 T28: during a failed claim-backed read, a row typed with the claim-backed type does not get its claim winner's matcher entry as the presented base meaning: not pre-selected, and its confirmation is refused at the presented-base screen", async () => {
    registerOtherVersionMatcher();
    listDrawsTheMatcherChannel();
    // The org-wide matcher gate would admit the pack.
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("install manifest unreadable"));
    // The claim store reads: the pack wins the row's type (so it defines the
    // row's type) and is a claim winner of the organisation.
    const row = { mime: "text/markdown", objectType: POST_DRAFT };
    // The row presents the pack's draft as its auto-surfaced meaning.
    const offer = { preselect: LINKEDIN_PACK, suggestions: [] };
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: row,
      readPresentation: () => ({ artifact: row, meaningOffer: offer }),
    });
    readArtifactForMeaningWrite.mockReturnValue({ kind: "ok", artifact: row });
    resolveArtifactPresentationReading.mockReturnValue({ offer, complete: true });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    // The presented-base screen refuses the entry, so nothing is offered and
    // nothing is pre-selected.
    const listed = await listInstalledTypesForArtifact("a1");
    expect(listed).toEqual({ ok: true, types: [], mime: "text/markdown" });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: LINKEDIN_PACK });
    expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    // Refused by the access gate of the screen, before the row's reading, and
    // the org-wide matcher gate was never asked for the pack.
    expect(resolveArtifactPresentationReading).not.toHaveBeenCalled();
    expect(isArtifactExtensionWriteAllowed).not.toHaveBeenCalledWith(LINKEDIN_PACK, "org-1");
    // The screen read the matcher channel without the base exclusion.
    expect(listInstalledMeaningTypesAcceptingMime).toHaveBeenCalledWith("text/markdown", {
      claimBacked: [],
    });
  });

  it("3319 T29: during a failed claim-backed read, the matcher entry of a claim-winning pack that registers an artifact type of its own keeps the org-wide matcher gate: listed and confirmed", async () => {
    const OWNING_PACK = "@acme/voice-artifacts";
    objectTypeRegistry.register(
      {
        type: `${OWNING_PACK}:brief`,
        category: "data",
        isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      } as never,
      OWNING_PACK,
    );
    matcherManifestRegistry.register({
      packageName: OWNING_PACK,
      matcherSkillIds: [`${OWNING_PACK}:match`],
      matcherConfidenceThreshold: 0.7,
      fileMimeTypes: ["text/markdown"],
    });
    listDrawsTheMatcherChannel();
    isArtifactExtensionWriteAllowed.mockResolvedValue(true);
    readClaimBackedMeaningTypesForOrg.mockRejectedValue(new Error("install manifest unreadable"));
    // The winners read succeeds and names the pack: it wins a claim too.
    readArtifactSafeClaimWinnerPackagesForOrg.mockReturnValue([LINKEDIN_PACK, OWNING_PACK]);
    readArtifactForDetail.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: TEXT_TYPE },
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const listed = await listInstalledTypesForArtifact("a1");
    expect(listed).toMatchObject({
      ok: true,
      types: [expect.objectContaining({ objectTypeId: null, extension: OWNING_PACK })],
    });
    const res = await assertUploadMeaning({ artifactId: "a1", extension: OWNING_PACK });
    expect(res).toMatchObject({ ok: true });
    expect(readArtifactSafeClaimWinnerPackagesForOrg).toHaveBeenCalledWith("org-1");
    expect(isArtifactExtensionWriteAllowed).toHaveBeenCalledWith(OWNING_PACK, "org-1");
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", extension: OWNING_PACK, assertedBy: "user" }),
    );
  });
});
