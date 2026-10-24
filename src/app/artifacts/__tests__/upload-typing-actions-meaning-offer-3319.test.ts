/**
 * cinatra#3319 — the picker's candidate list carries the row's DERIVED MEANING
 * (spec `specs/app-artifacts.html` §VI.1 "Derived meaning & suggestion chips").
 *
 * `listInstalledTypesForArtifact` answers, beside the offered types, the
 * extension the picker opens pre-selected on (a matcher draft at or above its
 * pack's threshold) and the suggestion chips. They come from the detail read the
 * action already makes (`readArtifactForDetail` with `withMeaningOffer`, whose
 * ONE presentation reading is deferred to `readPresentation()`;
 * artifact-detail-meaning-offer-3319.test.ts) and are narrowed to the offered
 * types. The action itself never reads the presentation host (A4). Every
 * collaborator is mocked, as in upload-typing-actions.test.ts; the real pure
 * narrowing step and the real registries run.
 *
 * Revision 4 (Codex spec review 3):
 *   A5    — a presented meaning whose pack no longer accepts the file's MIME is
 *           NOT offered, pre-selected or confirmable (the drawing's MIME
 *           admission; finding 1).
 *   A7    — (rewritten in revision 5, below)
 *   A6/A8/A9 — ONE registry warm per request, after the row's gates and before
 *           the deferred reading, so the offer and the list are decided over the
 *           same registry even when the warm fails (finding 3).
 *   A10/A11 — a registered, actor-refused meaning the row presents, both on the
 *           ordinary list and presented-only, is neither listed nor confirmable
 *           (finding 4, KB-276/KB-282). Revision 5 (review 4, gap 2): the listed
 *           pack is refused by the access gate's matcher arm, which is called
 *           for it; the PDF-only pack is refused by MIME admission (it is not
 *           on the Markdown list) and never reaches that gate.
 *
 * Revision 5 (Codex spec review 4, gap 1):
 *   A7    — the row's base-defining extension, auto-surfaced by its matcher
 *           draft, IS offered and pre-selected; confirming it writes ONE fresh
 *           user assertion after the unchanged converging road, and no second
 *           promotion call.
 *   A12   — when the converging road completes an interrupted promotion, the
 *           base's answer stands and no meaning is written (green at base).
 *   A13   — the same pack refused by the access gate's matcher arm: neither
 *           offered nor confirmable, and the gate is called for it.
 *   A14   — the same pack no longer accepting the file's MIME: neither offered
 *           nor confirmable.
 *   A15   — (rewritten in revision 6, below)
 *
 * Revision 6 (Codex spec review 6, gaps 1-3). A promotion-store double models
 * the store's converging rule (NATIVE, NATIVE_BELOW, INTERRUPTED, COMPLETE) and
 * records every append:
 *   A7    — the pre-selected base-defining extension on a natively typed row:
 *           confirming it writes ONE user assertion BEFORE and INSTEAD of the
 *           converging road; nothing reaches the store, nothing is appended.
 *   A12   — an interrupted promotion: the reading is taken first and refuses,
 *           then the converging road completes it; nothing is written.
 *   A13/A14 — on a completed row.
 *   A15   — the base-defining draft below threshold is a chip, confirmable.
 *   A16   — the same as a chip under another classic meaning (tier 1).
 *   A17   — the base-defining extension not presented: refused, the converging
 *           road unchanged after the reading.
 *   A18   — a claim-backed row type presenting its claiming pack: offered,
 *           pre-selected, confirmed once with no promotion step.
 *
 * Pre-review 9:
 *   A21   — the person's assertion read fails once: the stale confirmation is
 *           refused and writes nothing, so a store read that recovers cannot
 *           append a revision.
 *
 * Round 11 (the class fold): EVERY read of the presented-base verification
 * fails closed. On the NATIVE row (where the store WOULD append), each read
 * that fails (F*) and each verification that denies (D*) refuses the
 * confirmation; nothing is written and no revision is appended:
 *   F1/D1 — the definer read; F2/D2 — the MIME list; F3/D3(A13) — the access
 *   gate; F4 — the presentation reading throws; F5 — the reading degraded a
 *   failed read (`complete: false`); D5 — a complete reading that does not
 *   present the pack; F6/D6 — the row's history (the converging road now needs
 *   the retype on record, with or without the person's assertion).
 *   A13 now runs on NATIVE. G3 (green at base): a retype on record still
 *   converges without the person's assertion.
 *   The double's COMPLETE row carries its promotion's retype, as a completed
 *   promotion does.
 *
 * Round 12 (the proven-promotion guard): the store appends a promotion revision
 * only on proof that a promotion retyped the row (its keyed retype is the row's
 * latest type change; typed-promotion-proof-3319.test.ts). The action no longer
 * reads the row's history itself: the converging road asks the store, and when
 * the store wrote nothing the person's standing meaning is the answer. The
 * double appends only when `promotionRecorded` is set, as the store does.
 *   A18/R12-MF1a-c — the pack whose claim wins a claim-backed row type is no
 *           ordinary candidate: it is decided through the presented-base check,
 *           its binding-blocked write answers ok, a crafted confirmation of it is
 *           refused, and a failed claim read refuses (C2a: the list falls back).
 *   A19-A21, C2d, NULL — the repeat answers ok only on `already-promoted` or a
 *           road that does not apply, while the person's own meaning reads true.
 *   G3    — a keyed retype on record converges without the person's assertion.
 *
 *   pnpm exec vitest run src/app/artifacts/__tests__/upload-typing-actions-meaning-offer-3319.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";

const getAuthSession = vi.fn();
const getActorContext = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
  getActorContext: (...a: unknown[]) => getActorContext(...a),
  isPlatformAdmin: vi.fn(),
}));

const listInstalledMeaningTypesAcceptingMime = vi.fn();
vi.mock("@/lib/artifacts/installed-type-picker", () => ({
  listInstalledMeaningTypesAcceptingMime: (...a: unknown[]) =>
    listInstalledMeaningTypesAcceptingMime(...a),
}));

const ensureArtifactTypesRegisteredWithStore = vi.fn(async () => undefined);
vi.mock("@/lib/artifacts/ensure-artifact-registry", () => ({
  ensureArtifactTypesRegisteredWithStore: () => ensureArtifactTypesRegisteredWithStore(),
}));
vi.mock("@/lib/extension-install-resolution", () => ({
  resolveActiveInstallForActor: vi.fn(async () => null),
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
vi.mock("@cinatra-ai/notifications/server", () => ({ resolveRecipientToUserIds: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotificationForRecipient: vi.fn() }));
vi.mock("@/lib/marketplace-browse", () => ({ loadMarketplaceBrowse: vi.fn() }));
vi.mock("@cinatra-ai/extensions/system-extension-inventory", () => ({
  isSystemExtension: () => true,
}));
// The org-scoped write gate for matcher-channel members (the access gate's
// matcher arm). A10/A11 refuse named packs through it.
const isArtifactExtensionWriteAllowed = vi.fn<(extension: string, orgId?: string) => Promise<boolean>>(
  async () => true,
);
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: (extension: string, orgId: string) =>
    isArtifactExtensionWriteAllowed(extension, orgId),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The typed promotion road and its authority, as in upload-typing-actions.test.ts
// (the converging re-confirmation, A7).
const promoteMatchedArtifactType = vi.fn();
/** Every append the promotion-store double records (revision 6). */
const appends: unknown[] = [];
/** The person's own assertion, as the store's reader answers it (A19). */
const readPersonAssertion = vi.fn<(input?: unknown) => boolean>(() => false);
vi.mock("@/lib/artifacts/typed-promotion-store", () => ({
  promoteMatchedArtifactType: (...a: unknown[]) => promoteMatchedArtifactType(...a),
  readPersonAssertion: (input: unknown) => readPersonAssertion(input),
}));
/** The row's change events, newest first, as the history reader answers them. */
const listEventsForObject = vi.fn<(id?: string, o?: unknown) => unknown[]>(() => []);
vi.mock("@/lib/object-history/eligibility", () => ({
  listEventsForObject: (id: string, o: unknown) => listEventsForObject(id, o),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ kind: "org-write" })),
}));
// The claim-backed reader a later change reads in this action; harmless when
// the action does not import it. A NAMED spy (default: no claims) so A18 sets it
// and the list double can tell the tree it runs on.
const readClaimBackedMeaningTypesForOrg = vi.fn<(orgId?: string) => Promise<unknown[]>>(
  async () => [],
);
/** The pack whose claim wins a type in the org (R12-MF1): none by default. */
const readArtifactSafeClaimWinnerForType = vi.fn<(orgId: string, objectTypeId: string) => string | null>(
  () => null,
);
vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  readClaimBackedMeaningTypesForOrg: (orgId: string) => readClaimBackedMeaningTypesForOrg(orgId),
  readArtifactSafeClaimWinnerForType: (orgId: string, objectTypeId: string) =>
    readArtifactSafeClaimWinnerForType(orgId, objectTypeId),
}));

// The presentation host: the action must never read it itself — its detail read
// already did (A4 counts the calls).
const host = vi.hoisted(() => ({
  resolveArtifactPresentationIdentity: vi.fn(),
  resolveArtifactPresentationIdentities: vi.fn(),
  resolveArtifactPresentationReading: vi.fn(),
  resolveArtifactMeaningOffer: vi.fn(),
}));
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationIdentity: (...a: unknown[]) =>
    host.resolveArtifactPresentationIdentity(...a),
  resolveArtifactPresentationIdentities: (...a: unknown[]) =>
    host.resolveArtifactPresentationIdentities(...a),
  resolveArtifactPresentationReading: (...a: unknown[]) =>
    host.resolveArtifactPresentationReading(...a),
  resolveArtifactMeaningOffer: (...a: unknown[]) => host.resolveArtifactMeaningOffer(...a),
}));

const IDEA = "@cinatra-ai/blog-idea-artifact";
const POST = "@cinatra-ai/blog-post-artifact";
const MARKDOWN = "@cinatra-ai/markdown-artifact:artifact";
const TYPES = [
  {
    objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
    extension: IDEA,
    displayName: "Blog idea",
    extensionLabel: "Blog Idea",
  },
  {
    objectTypeId: "@cinatra-ai/blog-post-artifact:post",
    extension: POST,
    displayName: "Post",
    extensionLabel: "Blog Post",
  },
];

const ARTIFACT = { mime: "text/markdown", objectType: MARKDOWN };

beforeEach(() => {
  vi.clearAllMocks();
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  getAuthSession.mockResolvedValue({
    user: { id: "u1" },
    session: { activeOrganizationId: "org-1" },
  });
  getActorContext.mockResolvedValue({ principalId: "u1", organizationId: "org-1" });
  offerFromRead(undefined);
  listInstalledMeaningTypesAcceptingMime.mockReturnValue(TYPES);
  ensureArtifactTypesRegisteredWithStore.mockImplementation(async () => undefined);
  isArtifactExtensionWriteAllowed.mockImplementation(async () => true);
  assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
  // The promotion-store double is set per case (`presentedBaseRow`); no case
  // inherits another's store state, reading or claims.
  promoteMatchedArtifactType.mockReset();
  appends.length = 0;
  readPersonAssertion.mockImplementation(() => false);
  listEventsForObject.mockImplementation(() => []);
  readClaimBackedMeaningTypesForOrg.mockImplementation(async () => []);
  readArtifactSafeClaimWinnerForType.mockImplementation(() => null);
  host.resolveArtifactPresentationReading.mockReset();
});

function registerMatcherPack(packageName: string, mimes: string[]): void {
  matcherManifestRegistry.register({
    packageName,
    matcherSkillIds: [`${packageName}:match`],
    matcherConfidenceThreshold: 0.7,
    fileMimeTypes: mimes,
  });
}
function surface(extension: string, displayName: string) {
  return { objectTypeId: null, extension, displayName, extensionLabel: displayName };
}

/** A matcher pack installed at RUNTIME that accepts markdown: only the
 *  runtime-store warm registers it (cinatra#3204). */
const RUNTIME_PACK = "@acme/runtime-voice";
const RUNTIME_TYPE = surface(RUNTIME_PACK, "Runtime Voice");
function warmRegistersRuntimePack(): void {
  ensureArtifactTypesRegisteredWithStore.mockImplementation(async () => {
    registerMatcherPack(RUNTIME_PACK, ["text/markdown"]);
  });
}
/** The ordinary MIME list as the real one reads it: the runtime pack is on it
 *  only when the matcher channel holds it at the moment of the call. */
function listSeesTheRegistry(): void {
  listInstalledMeaningTypesAcceptingMime.mockImplementation(() =>
    matcherManifestRegistry.get(RUNTIME_PACK) !== null ? [...TYPES, RUNTIME_TYPE] : TYPES,
  );
}
/** The deferred reading presents the runtime pack only when the matcher channel
 *  holds it at the moment of the reading (its liveness and its threshold come
 *  from that channel, `src/lib/objects/presentation-identity.ts`). */
function readingSeesTheRegistry(): void {
  readPresentation.mockImplementation(() => ({
    artifact: ARTIFACT,
    meaningOffer:
      matcherManifestRegistry.get(RUNTIME_PACK) !== null
        ? { preselect: RUNTIME_PACK, suggestions: [] }
        : { preselect: null, suggestions: [] },
  }));
}

/** The detail read's answer: the deferred reading rides along ONLY when it was
 *  asked for, as the real service does (artifact-detail-meaning-offer-3319.test.ts
 *  S1/S2). `readPresentation` is a spy, so its call order is observable. */
const readPresentation = vi.fn();
function offerFromRead(offer: unknown): void {
  readPresentation.mockImplementation(() => ({ artifact: ARTIFACT, meaningOffer: offer }));
  readArtifactForDetail.mockImplementation((input: { withMeaningOffer?: boolean }) => ({
    kind: "ok",
    artifact: ARTIFACT,
    ...(input.withMeaningOffer === true && offer !== undefined
      ? { readPresentation: () => readPresentation() }
      : {}),
  }));
}
/** The WRITE read's answer for a row that presents `offer`. It carries the
 *  offer in both shapes revisions 3 and 4 know, so a confirmation gate that
 *  widened its population on the presented meanings (revision 3's B3a) would
 *  see them; the base gate ignores both. */
function writeReadPresents(offer: unknown, artifact: unknown = ARTIFACT): void {
  readArtifactForMeaningWrite.mockImplementation(() => ({
    kind: "ok",
    artifact,
    meaningOffer: offer,
    readPresentation: () => ({ artifact, meaningOffer: offer }),
  }));
}

function hostReads(): number {
  return Object.values(host).reduce((n, f) => n + f.mock.calls.length, 0);
}
afterEach(() => vi.resetModules());

describe("cinatra#3319 — listInstalledTypesForArtifact answers the derived meaning", () => {
  it("A1: a draft that auto-surfaced is answered as the pre-selection, from ONE detail read asked for it", async () => {
    offerFromRead({ preselect: IDEA, suggestions: [] });
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(readArtifactForDetail).toHaveBeenCalledTimes(1);
    expect(readArtifactForDetail).toHaveBeenCalledWith({
      orgId: "org-1",
      actor: { principalId: "u1", organizationId: "org-1" },
      artifactId: "a-3319",
      withMeaningOffer: true,
    });
    // The deferred reading is taken once, after the warm.
    expect(readPresentation).toHaveBeenCalledTimes(1);
    expect(ensureArtifactTypesRegisteredWithStore.mock.invocationCallOrder[0]).toBeLessThan(
      readPresentation.mock.invocationCallOrder[0],
    );
    expect(res).toMatchObject({ ok: true, meaning: { preselect: IDEA, suggestions: [] } });
  });

  it("A2: a draft below threshold is answered as a labelled chip", async () => {
    offerFromRead({ preselect: null, suggestions: [{ extension: POST, confidence: 0.61 }] });
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: null,
        suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.61 }],
      },
    });
  });

  it("A3: a reading naming an extension the actor is not offered is narrowed away", async () => {
    offerFromRead({
      preselect: "@acme/not-offered-artifact",
      suggestions: [{ extension: "@acme/not-offered-artifact", confidence: 0.4 }],
    });
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(res).toMatchObject({ ok: true, meaning: { preselect: null, suggestions: [] } });
  });

  it("A4: the action never reads the presentation host itself (no second blocking read)", async () => {
    offerFromRead({ preselect: IDEA, suggestions: [{ extension: POST, confidence: 0.55 }] });
    host.resolveArtifactPresentationReading.mockReturnValue({
      presentation: { identity: { kind: "extension", extension: POST }, tier: "matcher", suggestions: [] },
      offer: { preselect: POST, suggestions: [] },
    });
    host.resolveArtifactMeaningOffer.mockReturnValue({ preselect: POST, suggestions: [] });
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(hostReads()).toBe(0);
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: IDEA,
        suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.55 }],
      },
    });
  });

  it("A5: a presented meaning whose pack no longer accepts the file's MIME is not offered, not pre-selected, and not confirmable", async () => {
    // Review 3, finding 1: the pack wrote its 0.8 draft while it accepted
    // markdown; its live manifest accepts PDF only. The drawing admits only the
    // types whose accepts include the detected MIME, so the picker neither lists
    // nor pre-selects it, and the confirmation refuses it, as main does.
    const PDF_PACK = "@acme/pdf-voice";
    registerMatcherPack(PDF_PACK, ["application/pdf"]);
    const offer = {
      preselect: PDF_PACK,
      suggestions: [{ extension: POST, confidence: 0.4 }],
    };
    offerFromRead(offer);
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect((res as { types: Array<{ extension: string }> }).types.map((t) => t.extension)).toEqual([
      IDEA,
      POST,
    ]);
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: null,
        suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.4 }],
      },
    });
    writeReadPresents(offer);
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PDF_PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("A6: in a COLD process ONE warm runs after the row's gates and before the deferred reading, so a runtime-installed pack is listed and pre-selected", async () => {
    // Review 2, finding 2 and review 3, finding 3: nothing registered the
    // runtime pack yet; only the warm does.
    warmRegistersRuntimePack();
    listSeesTheRegistry();
    offerFromRead({ preselect: null, suggestions: [] });
    readingSeesTheRegistry();
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(readArtifactForDetail).toHaveBeenCalledTimes(1);
    expect(ensureArtifactTypesRegisteredWithStore).toHaveBeenCalledTimes(1);
    expect(readPresentation).toHaveBeenCalledTimes(1);
    const gates = readArtifactForDetail.mock.invocationCallOrder[0];
    const warm = ensureArtifactTypesRegisteredWithStore.mock.invocationCallOrder[0];
    const reading = readPresentation.mock.invocationCallOrder[0];
    expect(gates).toBeLessThan(warm);
    expect(warm).toBeLessThan(reading);
    expect((res as { types: unknown[] }).types).toContainEqual(RUNTIME_TYPE);
    expect(res).toMatchObject({ ok: true, meaning: { preselect: RUNTIME_PACK, suggestions: [] } });
  });

  // THE PRESENTED BASE MEANING (review 4, gap 1; review 6, gaps 1-3). The row
  // already carries the pack's own type, so the base exclusion keeps the pack off
  // the ordinary list; its live same-extension matcher draft is the row's
  // auto-surfaced meaning (tier 2) or one of its suggestions. The drawing: the
  // picker opens pre-selected on it or draws its chip, and confirming it writes a
  // user-sourced meaning.
  const PACK = "@acme/voice";
  const OWN_TYPE = "@acme/voice:brief";
  const VOICE = {
    objectTypeId: OWN_TYPE,
    extension: PACK,
    displayName: "Brief",
    extensionLabel: "Voice",
  };
  // A18: a claim-backed row type. No package registers it in the object-type
  // registry; the organisation's claim winner (PACK) owns it.
  const CLAIM_TYPE = "@acme/voice:memo";
  const MEMO = {
    objectTypeId: CLAIM_TYPE,
    extension: PACK,
    displayName: "Memo",
    extensionLabel: "Voice",
  };

  // THE PROMOTION-STORE DOUBLE (revision 6, gap 1; round 12). It models the
  // store's converging decision (`typed-promotion-store.ts`, the
  // `already-promoted` branch) for a row that already carries the pack's own
  // type: it appends a promotion revision when no revision is present, the call
  // is confirmed, EITHER the person's assertion OR the matcher's at its
  // threshold stands, AND the promotion's own keyed retype is the row's latest
  // type change (`promotionRecorded`). Otherwise it refuses `already-promoted`
  // (also when the revision landed: the deterministic id makes the append a
  // no-op). Every append is recorded.
  type PromotionState = {
    revisionPresent: boolean;
    personAsserted: boolean;
    matcherAtThreshold: boolean;
    promotionRecorded: boolean;
  };
  /** Natively of the pack's type, with a threshold draft: no promotion on record. */
  const NATIVE: PromotionState = { revisionPresent: false, personAsserted: false, matcherAtThreshold: true, promotionRecorded: false };
  /** The same row, its draft below threshold: refused. */
  const NATIVE_BELOW: PromotionState = { revisionPresent: false, personAsserted: false, matcherAtThreshold: false, promotionRecorded: false };
  /** Retyped by a confirmation whose promotion revision is missing: completes. */
  const INTERRUPTED: PromotionState = { revisionPresent: false, personAsserted: true, matcherAtThreshold: false, promotionRecorded: true };
  /** The promotion revision landed: refused. */
  const COMPLETE: PromotionState = { revisionPresent: true, personAsserted: false, matcherAtThreshold: false, promotionRecorded: true };
  /** The row's change events: created as the base type, then (for a promotion,
   *  interrupted or completed) the retype into the pack's own type, newest
   *  first. A natively typed row was created in the pack's own type. */
  const created = (type: string) => ({
    objectType: type,
    operation: "create",
    beforeSnapshot: null,
    afterSnapshot: { payload: { type } },
  });
  const RETYPED = {
    objectType: OWN_TYPE,
    operation: "update",
    beforeSnapshot: { payload: { type: MARKDOWN } },
    afterSnapshot: { payload: { type: OWN_TYPE } },
  };
  function promotionStore(state: PromotionState): void {
    readPersonAssertion.mockImplementation(() => state.personAsserted);
    // The history the base tree's action read itself; the head's never reads it.
    listEventsForObject.mockImplementation(() =>
      state.promotionRecorded ? [RETYPED, created(MARKDOWN)] : [created(OWN_TYPE)],
    );
    promoteMatchedArtifactType.mockImplementation(async (input: { confirmed?: boolean }) => {
      if (
        !state.revisionPresent &&
        input.confirmed === true &&
        state.promotionRecorded &&
        (state.personAsserted || state.matcherAtThreshold)
      ) {
        appends.push(input);
        return {
          ok: true,
          representationRevisionId: "rep_converged",
          revision: 2,
          toType: OWN_TYPE,
          retyped: false,
        };
      }
      return { ok: false, reason: "already-promoted" };
    });
  }

  type Reading = {
    tier?: "matcher" | "classic" | "claim-backed";
    identity?: string;
    preselect: string | null;
    suggestions: Array<{ extension: string; confidence: number | null }>;
  };
  const DEFAULT_READING: Reading = {
    tier: "matcher",
    identity: PACK,
    preselect: PACK,
    suggestions: [{ extension: POST, confidence: 0.4 }],
  };
  function presentedBaseRow(
    reading: Reading = DEFAULT_READING,
    opts: { acceptsMarkdown?: boolean; promotion?: PromotionState; claimBacked?: boolean } = {},
  ) {
    const promotion = opts.promotion ?? NATIVE;
    // The fixture and the reading cannot disagree: an interrupted promotion left
    // the person's assertion of the pack, which wins tier 1 and leaves no draft
    // of it (the unique index), so the pack is presented neither as the
    // pre-selection nor as a suggestion; a natively typed row with a draft
    // presents it.
    const presentsPack =
      reading.preselect === PACK || reading.suggestions.some((s) => s.extension === PACK);
    if (promotion === INTERRUPTED && presentsPack) {
      throw new Error("fixture: an interrupted promotion never presents the pack");
    }
    if ((promotion === NATIVE || promotion === NATIVE_BELOW) && !presentsPack) {
      throw new Error("fixture: a natively typed row with a draft presents the pack");
    }
    if (promotion === NATIVE_BELOW && reading.preselect === PACK) {
      throw new Error("fixture: a draft below threshold never auto-surfaces");
    }
    const mimes = opts.acceptsMarkdown === false ? ["application/pdf"] : ["text/markdown"];
    const rowType = opts.claimBacked ? CLAIM_TYPE : OWN_TYPE;
    if (opts.claimBacked) {
      // The pack registers no object type; its claim owns the host type.
      readClaimBackedMeaningTypesForOrg.mockImplementation(async () => [
        { objectTypeId: CLAIM_TYPE, extension: PACK, acceptMimes: ["text/markdown"] },
      ]);
      readArtifactSafeClaimWinnerForType.mockImplementation((_org, type) =>
        type === CLAIM_TYPE ? PACK : null,
      );
    } else {
      objectTypeRegistry.register(
        {
          type: OWN_TYPE,
          category: "data",
          isArtifact: { accepts: { file: { mimeTypes: mimes } } },
        } as never,
        PACK,
      );
    }
    registerMatcherPack(PACK, mimes);
    promotionStore(promotion);
    const row = { mime: "text/markdown", objectType: rowType };
    const offer = { preselect: reading.preselect, suggestions: reading.suggestions };
    readPresentation.mockImplementation(() => ({ artifact: row, meaningOffer: offer }));
    // The real service answers `readPresentation` only when asked for it.
    readArtifactForDetail.mockImplementation((input: { withMeaningOffer?: boolean }) => ({
      kind: "ok",
      artifact: row,
      ...(input.withMeaningOffer === true ? { readPresentation: () => readPresentation() } : {}),
    }));
    if (opts.claimBacked) {
      // The real list per tree. Main's exclusion is registry-only and knows no
      // claims, so the pack stays a candidate. After the claim-backed change
      // (whose action reads the claims), the claim-backed type is listed only
      // through its claim entry, and the exclusion of the row's type removes its
      // claim winner.
      listInstalledMeaningTypesAcceptingMime.mockImplementation(
        (
          _mime: string,
          o?: {
            excludeTypeId?: string;
            claimBacked?: Array<{ objectTypeId: string; extension: string }>;
          },
        ) => {
          if (readClaimBackedMeaningTypesForOrg.mock.calls.length === 0) return [...TYPES, MEMO];
          const claimed = (o?.claimBacked ?? []).some(
            (e) => e.objectTypeId === CLAIM_TYPE && e.extension === PACK,
          );
          if (!claimed || o?.excludeTypeId === CLAIM_TYPE) return TYPES;
          return [...TYPES, MEMO];
        },
      );
    } else {
      // The real list: with the base exclusion it drops every candidate of the
      // pack; read without it, the pack's own type is a Markdown candidate —
      // unless the pack no longer accepts Markdown.
      listInstalledMeaningTypesAcceptingMime.mockImplementation(
        (_mime: string, o?: { excludeTypeId?: string }) =>
          o?.excludeTypeId === OWN_TYPE || opts.acceptsMarkdown === false
            ? TYPES
            : [...TYPES, VOICE],
      );
    }
    // The confirmation's write read, and the one presentation reading the
    // confirmation takes for this extension (the same host function the list's
    // deferred reading uses).
    readArtifactForMeaningWrite.mockImplementation(() => ({ kind: "ok", artifact: row }));
    host.resolveArtifactPresentationReading.mockReturnValue({
      presentation: {
        identity: { kind: "extension", extension: reading.identity ?? reading.preselect ?? PACK },
        tier: reading.tier ?? (reading.preselect ? "matcher" : "claim-backed"),
        suggestions: reading.suggestions.map((x) => x.extension),
      },
      offer,
      complete: true,
    });
    return row;
  }
  const gateCallsFor = (extension: string) =>
    isArtifactExtensionWriteAllowed.mock.calls.filter((c) => c[0] === extension);
  const extensionsOf = (res: unknown) =>
    (res as { types: Array<{ extension: string }> }).types.map((t) => t.extension);
  /** Some list call read the Markdown list WITHOUT the base exclusion (its
   *  options absent on main, `{ claimBacked }` after the claim-backed change). */
  const sawUnexcludedRead = () =>
    listInstalledMeaningTypesAcceptingMime.mock.calls.some(
      (c) =>
        c[0] === "text/markdown" &&
        ((c[1] as { excludeTypeId?: string } | undefined)?.excludeTypeId ?? undefined) ===
          undefined,
    );
  const exactUserWrite = (extension: string) => ({
    orgId: "org-1",
    artifactId: "a-3319",
    extension,
    assertedBy: "user",
    principal: "u1",
  });

  it("A7: the base-defining extension auto-surfaced on a natively typed row is offered and pre-selected; confirming it writes ONE user assertion and never reaches the promotion road", async () => {
    presentedBaseRow();
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    // The ordinary list is unchanged (with the base exclusion); the presented
    // base meaning is read from the same list without it.
    expect(listInstalledMeaningTypesAcceptingMime).toHaveBeenCalledWith(
      "text/markdown",
      expect.objectContaining({ excludeTypeId: OWN_TYPE }),
    );
    expect(sawUnexcludedRead()).toBe(true);
    expect(extensionsOf(res)).toEqual([IDEA, PACK, POST]);
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: PACK,
        suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.4 }],
      },
    });
    // The access gate's matcher arm decided the pack, for this org.
    expect(gateCallsFor(PACK)).toEqual([[PACK, "org-1"]]);
    // The list never reads the presentation host itself.
    expect(hostReads()).toBe(0);

    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).toHaveBeenCalledWith(exactUserWrite(PACK));
    // The store WOULD append on this row (NATIVE): nothing in the request
    // reaches it.
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    // The confirmation took ONE presentation reading, of this row and type,
    // before the write.
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "a-3319",
      baseType: OWN_TYPE,
    });
    expect(host.resolveArtifactPresentationReading.mock.invocationCallOrder[0]).toBeLessThan(
      assertSemanticType.mock.invocationCallOrder[0],
    );
  });

  it("A12: an interrupted promotion (the person's assertion stands, no draft presented) is completed by the converging road after the reading refuses; its answer stands and nothing is written", async () => {
    presentedBaseRow(
      {
        tier: "classic",
        identity: PACK,
        preselect: null,
        suggestions: [{ extension: POST, confidence: 0.4 }],
      },
      { promotion: INTERRUPTED },
    );
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toEqual({
      ok: true,
      promotion: {
        promoted: true,
        toType: OWN_TYPE,
        representationRevisionId: "rep_converged",
        revision: 2,
      },
    });
    expect(appends).toHaveLength(1);
    expect(assertSemanticType).not.toHaveBeenCalled();
    // The presented meaning was verified FIRST: one reading, before the store.
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
    expect(promoteMatchedArtifactType).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading.mock.invocationCallOrder[0]).toBeLessThan(
      promoteMatchedArtifactType.mock.invocationCallOrder[0],
    );
  });

  it("A13: the presented base meaning refused by the access gate's matcher arm is neither offered nor confirmable", async () => {
    // NATIVE: the store WOULD append, so the refusal is the action's own.
    presentedBaseRow(undefined, { promotion: NATIVE });
    isArtifactExtensionWriteAllowed.mockImplementation(async (extension: string) => extension !== PACK);
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(extensionsOf(res)).toEqual([IDEA, POST]);
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: null,
        suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.4 }],
      },
    });
    expect(gateCallsFor(PACK)).toEqual([[PACK, "org-1"]]);
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    // The confirmation asked the same gate for the pack, and refused before any
    // presentation reading.
    expect(gateCallsFor(PACK)).toEqual([
      [PACK, "org-1"],
      [PACK, "org-1"],
    ]);
    expect(hostReads()).toBe(0);
  });

  it("A14: the presented base meaning whose pack no longer accepts the file's MIME is neither offered nor confirmable", async () => {
    presentedBaseRow(undefined, { acceptsMarkdown: false, promotion: COMPLETE });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(extensionsOf(res)).toEqual([IDEA, POST]);
    expect(res).toMatchObject({ ok: true, meaning: { preselect: null } });
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(hostReads()).toBe(0);
  });

  it("A15: the base-defining extension as a draft below threshold (tier 3) is drawn as a chip, and confirming it writes once with no promotion step", async () => {
    presentedBaseRow(
      {
        tier: "claim-backed",
        preselect: null,
        suggestions: [
          { extension: PACK, confidence: 0.5 },
          { extension: POST, confidence: 0.4 },
        ],
      },
      { promotion: NATIVE_BELOW },
    );
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(extensionsOf(res)).toEqual([IDEA, PACK, POST]);
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: null,
        suggestions: [
          { extension: PACK, label: "Brief · Voice", confidence: 0.5 },
          { extension: POST, label: "Post · Blog Post", confidence: 0.4 },
        ],
      },
    });
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).toHaveBeenCalledWith(exactUserWrite(PACK));
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(hostReads()).toBe(1);
  });

  it("A16: another classic meaning stands (tier 1) and the pack's threshold draft stays a suggestion: its chip is drawn and confirmable with no promotion step", async () => {
    presentedBaseRow(
      {
        tier: "classic",
        identity: POST,
        preselect: null,
        suggestions: [{ extension: PACK, confidence: 0.9 }],
      },
      { promotion: NATIVE },
    );
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: null,
        suggestions: [{ extension: PACK, label: "Brief · Voice", confidence: 0.9 }],
      },
    });
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).toHaveBeenCalledWith(exactUserWrite(PACK));
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  });

  it("A17: the base-defining extension not presented at all is not offered; a crafted confirmation takes the unchanged converging road after the reading and is refused", async () => {
    presentedBaseRow(
      {
        tier: "claim-backed",
        preselect: null,
        suggestions: [{ extension: POST, confidence: 0.4 }],
      },
      { promotion: COMPLETE },
    );
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(extensionsOf(res)).toEqual([IDEA, POST]);
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(hostReads()).toBe(1);
    expect(promoteMatchedArtifactType).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading.mock.invocationCallOrder[0]).toBeLessThan(
      promoteMatchedArtifactType.mock.invocationCallOrder[0],
    );
  });

  it("A18/R12-MF1a: the pack whose claim wins a claim-backed row type is no ordinary candidate: presented, it is offered, pre-selected and confirmed through the presented-base check; its binding-blocked write answers ok, with no promotion step", async () => {
    presentedBaseRow(
      { tier: "matcher", identity: PACK, preselect: PACK, suggestions: [] },
      { claimBacked: true },
    );
    // The real store blocks the person's assertion on the pack's own binding.
    assertSemanticType.mockReturnValue({ blockedByPrecedence: true });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(extensionsOf(res)).toContain(PACK);
    expect(res).toMatchObject({ ok: true, meaning: { preselect: PACK } });
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(assertSemanticType).toHaveBeenCalledWith(exactUserWrite(PACK));
    // Verified against the row's presentation first: one reading, before the write.
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
    expect(host.resolveArtifactPresentationReading.mock.invocationCallOrder[0]).toBeLessThan(
      assertSemanticType.mock.invocationCallOrder[0],
    );
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  });

  it("R12-MF1b: a crafted confirmation of the claiming pack that the row does not present is refused and writes nothing", async () => {
    presentedBaseRow(
      { tier: "claim-backed", preselect: null, suggestions: [{ extension: POST, confidence: 0.4 }] },
      { claimBacked: true, promotion: COMPLETE },
    );
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    // The claimant was decided through the presented-base check.
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
  });

  it("R12-MF1c: a failed claim read refuses the confirmation of a listed pack, before any reading or write", async () => {
    presentedBaseRow(
      { tier: "matcher", identity: PACK, preselect: PACK, suggestions: [] },
      { claimBacked: true },
    );
    readArtifactSafeClaimWinnerForType.mockImplementation(() => {
      throw new Error("claim store unavailable");
    });
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
    expect(hostReads()).toBe(0);
  });

  it("C2a: the list reads the claims leniently: a failed claim read keeps the ordinary list, and the confirmation then refuses", async () => {
    presentedBaseRow(
      { tier: "matcher", identity: PACK, preselect: PACK, suggestions: [] },
      { claimBacked: true },
    );
    readArtifactSafeClaimWinnerForType.mockImplementation(() => {
      throw new Error("claim store unavailable");
    });
    const { listInstalledTypesForArtifact, assertUploadMeaning } = await import(
      "../upload-typing-actions"
    );
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(res).toMatchObject({ ok: true, meaning: { preselect: PACK } });
    expect(extensionsOf(res)).toContain(PACK);
    expect(readArtifactSafeClaimWinnerForType).toHaveBeenCalledWith("org-1", CLAIM_TYPE);
    const confirmed = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(confirmed).toMatchObject({ ok: false, reason: "invalid-type" });
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  /** The reading `presentedBaseRow` configured, taken without leaving a call. */
  function presentedReading(reading: typeof host.resolveArtifactPresentationReading): unknown {
    const value = reading({} as never);
    reading.mockClear();
    return value;
  }
  /** A natively typed, below-threshold row whose double TURNS: the first
   *  confirmation's write leaves the person's assertion standing and ends the
   *  presentation (the draft is archived; the person's meaning is tier 1). */
  function turningNativeBelowRow() {
    presentedBaseRow(
      {
        tier: "claim-backed",
        preselect: null,
        suggestions: [
          { extension: PACK, confidence: 0.5 },
          { extension: POST, confidence: 0.4 },
        ],
      },
      { promotion: NATIVE_BELOW },
    );
    const state: PromotionState = { ...NATIVE_BELOW };
    promotionStore(state);
    assertSemanticType.mockImplementation(() => {
      state.personAsserted = true;
      return { blockedByPrecedence: false };
    });
    // Before the write the row presents the pack's draft as a chip; after it,
    // the person's meaning stands and the pack is presented no more.
    const chip = presentedReading(host.resolveArtifactPresentationReading);
    host.resolveArtifactPresentationReading.mockImplementation(() =>
      state.personAsserted
        ? {
            presentation: {
              identity: { kind: "extension", extension: PACK },
              tier: "classic",
              suggestions: [POST],
            },
            offer: { preselect: null, suggestions: [{ extension: POST, confidence: 0.4 }] },
            complete: true,
          }
        : chip,
    );
    return state;
  }

  it("A19: a second, stale confirmation of the same extension on a natively typed row below threshold writes nothing and appends no revision", async () => {
    const state = turningNativeBelowRow();
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const first = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(first).toEqual({ ok: true });
    expect(state.personAsserted).toBe(true);
    expect(assertSemanticType).toHaveBeenCalledTimes(1);

    // The stale picker confirms the same extension again. The store holds no
    // promotion of this row, so it writes nothing; the person's meaning stands.
    const second = await assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
    expect(second).toEqual({ ok: true });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(appends).toEqual([]);
    // The check read THIS person's assertion.
    expect(readPersonAssertion).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "a-3319",
      extension: PACK,
      principal: "u1",
    });
  });

  it("A20: a store error refuses the stale confirmation and appends nothing, although the person's meaning stands", async () => {
    const state = turningNativeBelowRow();
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toEqual({
      ok: true,
    });
    expect(state.personAsserted).toBe(true);
    promoteMatchedArtifactType.mockImplementation(async () => {
      throw new Error("history read failed");
    });
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toMatchObject({
      ok: false,
      reason: "invalid-type",
    });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(appends).toEqual([]);
  });

  it("A21: when the person's assertion cannot be read, the stale confirmation writes nothing and is refused, even if the store's own read recovers", async () => {
    const state = turningNativeBelowRow();
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toEqual({
      ok: true,
    });
    expect(state.personAsserted).toBe(true);

    // The action's read fails ONCE. The store would read the assertion again on
    // its own; that read recovers (the double answers from the row's state), so
    // reaching the store would append a revision for a promotion that never
    // happened.
    readPersonAssertion.mockImplementationOnce(() => {
      throw new Error("assertion read unavailable");
    });
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toEqual({
      ok: false,
      reason: "invalid-type",
      message:
        "That type is not an installed type that accepts this file — refresh and pick again.",
    });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(appends).toEqual([]);

    // Once the read recovers, the confirmation is answered as already recorded.
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toEqual({
      ok: true,
    });
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(appends).toEqual([]);
  });

  // THE CLASS FOLD (round 11). Every case runs on the NATIVE row, where the
  // store double WOULD append a promotion revision: a failed read (F*) or a
  // denied verification (D*) on the presented-base path refuses the
  // confirmation, and nothing is written or appended.
  const REFUSED = {
    ok: false,
    reason: "invalid-type",
    message:
      "That type is not an installed type that accepts this file — refresh and pick again.",
  };
  function expectNothingWritten(): void {
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  }
  /** A verification that ANSWERED (not presented) hands the row to the
   *  converging road, whose store holds no promotion of it: no write. */
  function expectNothingAppended(): void {
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  }
  async function confirmPack(): Promise<unknown> {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    return assertUploadMeaning({ artifactId: "a-3319", extension: PACK });
  }
  /** A COMPLETE reading of the row that does not present the pack: its draft is
   *  not live for this org (the install gate denied it), so it is neither the
   *  pre-selection nor a suggestion. */
  const NOT_PRESENTED = {
    presentation: {
      identity: { kind: "extension", extension: POST },
      tier: "classic",
      suggestions: [POST],
    },
    offer: { preselect: null, suggestions: [{ extension: POST, confidence: 0.4 }] },
    complete: true,
  };

  it("F1: the definer read of the presented-base check fails: refused, even when a later read recovers", async () => {
    presentedBaseRow();
    const spy = vi
      .spyOn(objectTypeRegistry, "getRegisteringPackage")
      .mockImplementationOnce(() => {
        throw new Error("registry read unavailable");
      });
    try {
      expect(await confirmPack()).toEqual(REFUSED);
    } finally {
      spy.mockRestore();
    }
    expectNothingWritten();
  });

  it("D1: the definer check denies the pack and a later read admits it: refused, nothing appended", async () => {
    presentedBaseRow();
    const spy = vi
      .spyOn(objectTypeRegistry, "getRegisteringPackage")
      .mockImplementationOnce(() => "@acme/other-pack");
    try {
      expect(await confirmPack()).toEqual(REFUSED);
    } finally {
      spy.mockRestore();
    }
    expectNothingAppended();
  });

  it("F2: the MIME list read of the presented-base check fails: refused", async () => {
    presentedBaseRow();
    listInstalledMeaningTypesAcceptingMime.mockImplementation(
      (_mime: string, o?: { excludeTypeId?: string }) => {
        if (o?.excludeTypeId === OWN_TYPE) return TYPES;
        throw new Error("type list unavailable");
      },
    );
    expect(await confirmPack()).toEqual(REFUSED);
    expectNothingWritten();
  });

  it("D2: no installed type of the pack accepts the file any more: refused, nothing appended", async () => {
    presentedBaseRow();
    listInstalledMeaningTypesAcceptingMime.mockImplementation(() => TYPES);
    expect(await confirmPack()).toEqual(REFUSED);
    expectNothingAppended();
  });

  it("F3: the access gate's read fails for the pack: refused", async () => {
    presentedBaseRow();
    isArtifactExtensionWriteAllowed.mockImplementation(async (extension: string) => {
      if (extension === PACK) throw new Error("install status unavailable");
      return true;
    });
    expect(await confirmPack()).toEqual(REFUSED);
    expectNothingWritten();
    expect(hostReads()).toBe(0);
  });

  it("F4: the presentation reading throws (schema or module failure): refused", async () => {
    presentedBaseRow();
    host.resolveArtifactPresentationReading.mockImplementation(() => {
      throw new Error("schema init failed");
    });
    expect(await confirmPack()).toEqual(REFUSED);
    expectNothingWritten();
    expect(host.resolveArtifactPresentationReading).toHaveBeenCalledTimes(1);
  });

  it("F5: a reading that degraded a failed assertion or install read to an empty offer is refused, never read as 'not presented'", async () => {
    presentedBaseRow();
    host.resolveArtifactPresentationReading.mockReturnValue({
      presentation: {
        identity: { kind: "base", typeId: OWN_TYPE },
        tier: "claim-backed",
        suggestions: [],
      },
      offer: { preselect: null, suggestions: [] },
      complete: false,
    });
    expect(await confirmPack()).toEqual(REFUSED);
    expectNothingWritten();
  });

  it("D5: a complete reading that does not present the pack (its draft not live here) does not converge on a row never promoted", async () => {
    presentedBaseRow();
    host.resolveArtifactPresentationReading.mockReturnValue(NOT_PRESENTED);
    expect(await confirmPack()).toEqual(REFUSED);
    expectNothingAppended();
  });

  it("C2d: a store refusal other than already-promoted is refused, although the person's meaning stands", async () => {
    turningNativeBelowRow();
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toEqual({
      ok: true,
    });
    promoteMatchedArtifactType.mockImplementation(async () => ({
      ok: false,
      reason: "not-authorized",
    }));
    expect(await assertUploadMeaning({ artifactId: "a-3319", extension: PACK })).toEqual(REFUSED);
    expect(assertSemanticType).toHaveBeenCalledTimes(1);
    expect(appends).toEqual([]);
  });

  it("NULL: on a road that does not apply (the claiming pack registers no type of its own) the person's standing meaning answers ok and nothing is written", async () => {
    presentedBaseRow(
      { tier: "classic", identity: PACK, preselect: null, suggestions: [{ extension: POST, confidence: 0.4 }] },
      { claimBacked: true, promotion: INTERRUPTED },
    );
    expect(await confirmPack()).toEqual({ ok: true });
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).not.toHaveBeenCalled();
    expect(appends).toEqual([]);
  });

  it("G3: a keyed retype on record still converges without the person's own assertion (green at base)", async () => {
    presentedBaseRow();
    host.resolveArtifactPresentationReading.mockReturnValue(NOT_PRESENTED);
    promotionStore({ ...NATIVE, promotionRecorded: true });
    expect(await confirmPack()).toEqual({
      ok: true,
      promotion: {
        promoted: true,
        toType: OWN_TYPE,
        representationRevisionId: "rep_converged",
        revision: 2,
      },
    });
    expect(appends).toHaveLength(1);
    expect(assertSemanticType).not.toHaveBeenCalled();
  });

  it("A8: a FAILED warm is not retried within the request, so the list and the offer agree (green at base)", async () => {
    // Review 3, finding 3: the real warm resolves after a failed rescan and
    // retries on the next call. A second warm in the same request would
    // register the pack for the list after the reading had missed it.
    let warmCalls = 0;
    ensureArtifactTypesRegisteredWithStore.mockImplementation(async () => {
      warmCalls += 1;
      if (warmCalls === 1) return; // the store rescan failed; nothing registered
      registerMatcherPack(RUNTIME_PACK, ["text/markdown"]);
    });
    listSeesTheRegistry();
    offerFromRead({ preselect: null, suggestions: [] });
    readingSeesTheRegistry();
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = (await listInstalledTypesForArtifact("a-3319")) as {
      types: Array<{ extension: string }>;
      meaning?: { preselect: string | null };
    };
    expect(ensureArtifactTypesRegisteredWithStore).toHaveBeenCalledTimes(1);
    const listed = res.types.some((t) => t.extension === RUNTIME_PACK);
    expect(listed).toBe(false);
    expect(listed).toBe(res.meaning?.preselect === RUNTIME_PACK);
  });

  it("A9: a not-found or denied row triggers no store scan (green at base)", async () => {
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    readArtifactForDetail.mockImplementation(() => ({ kind: "not-found" }));
    expect(await listInstalledTypesForArtifact("gone")).toEqual({ ok: false, reason: "not-found" });
    readArtifactForDetail.mockImplementation(() => ({ kind: "denied" }));
    expect(await listInstalledTypesForArtifact("a-3319")).toEqual({ ok: false, reason: "denied" });
    expect(ensureArtifactTypesRegisteredWithStore).not.toHaveBeenCalled();
    expect(readPresentation).not.toHaveBeenCalled();
  });

  // KB-276 / KB-282 (review 3, finding 4; review 4, gap 2): a registered pack the
  // actor may not use is never listed, pre-selected, suggested or written. The
  // LISTED pack accepts Markdown, so it is on the MIME list and the access
  // gate's matcher arm refuses it (A10/A11 assert that call). The PRESENTED-ONLY
  // pack accepts PDF only: MIME admission refuses it (it is not on the Markdown
  // list), so it never reaches the access gate — with B3a withdrawn there is no
  // presented-only access branch left to prove. The access gate's matcher arm
  // for a widened population is proved where the population widens: A13.
  const DENIED_LISTED = "@acme/denied-voice"; // accepts markdown: on the MIME list
  const DENIED_PRESENTED_ONLY = "@acme/denied-pdf-voice"; // PDF only: presented only
  function deniedPacks(): unknown {
    registerMatcherPack(DENIED_LISTED, ["text/markdown"]);
    registerMatcherPack(DENIED_PRESENTED_ONLY, ["application/pdf"]);
    isArtifactExtensionWriteAllowed.mockImplementation(
      async (extension: string) =>
        extension !== DENIED_LISTED && extension !== DENIED_PRESENTED_ONLY,
    );
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([
      ...TYPES,
      surface(DENIED_LISTED, "Denied Voice"),
    ]);
    return {
      preselect: DENIED_LISTED,
      suggestions: [
        { extension: DENIED_PRESENTED_ONLY, confidence: 0.5 },
        { extension: POST, confidence: 0.4 },
      ],
    };
  }

  it("A10: the list never offers, pre-selects or suggests a registered meaning the actor is refused, listed or presented-only", async () => {
    offerFromRead(deniedPacks());
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect((res as { types: Array<{ extension: string }> }).types.map((t) => t.extension)).toEqual([
      IDEA,
      POST,
    ]);
    expect(res).toMatchObject({
      ok: true,
      meaning: {
        preselect: null,
        suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.4 }],
      },
    });
    // The listed pack was refused by the access gate's matcher arm, for this org;
    // the PDF-only pack was refused by MIME admission and never reached the gate.
    expect(isArtifactExtensionWriteAllowed).toHaveBeenCalledWith(DENIED_LISTED, "org-1");
    expect(isArtifactExtensionWriteAllowed.mock.calls.map((c) => c[0])).not.toContain(
      DENIED_PRESENTED_ONLY,
    );
  });

  it("A11: the confirmation refuses both actor-refused meanings the row presents and writes nothing (green at base)", async () => {
    writeReadPresents(deniedPacks());
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    for (const extension of [DENIED_LISTED, DENIED_PRESENTED_ONLY]) {
      const res = await assertUploadMeaning({ artifactId: "a-3319", extension });
      expect(res).toMatchObject({ ok: false, reason: "invalid-type" });
    }
    expect(assertSemanticType).not.toHaveBeenCalled();
    // Both confirmations ran the candidate gate: the listed pack through the
    // access gate's matcher arm (refused), the PDF-only pack refused by MIME
    // admission before any access call.
    expect(isArtifactExtensionWriteAllowed).toHaveBeenCalledWith(DENIED_LISTED, "org-1");
    expect(isArtifactExtensionWriteAllowed.mock.calls.map((c) => c[0])).not.toContain(
      DENIED_PRESENTED_ONLY,
    );
  });

  // GUARDS — green at the base by design.
  it("G1: a detail read that answers no offer (every other caller's road) leaves the list as it was", async () => {
    offerFromRead(undefined);
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(res).toMatchObject({ ok: true, mime: "text/markdown" });
    expect((res as { types: unknown[] }).types).toHaveLength(2);
    expect((res as { meaning?: unknown }).meaning).toBeUndefined();
  });

  it("G2: an empty offer answers no meaning", async () => {
    offerFromRead({ preselect: IDEA, suggestions: [] });
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([]);
    const { listInstalledTypesForArtifact } = await import("../upload-typing-actions");
    const res = await listInstalledTypesForArtifact("a-3319");
    expect(res).toMatchObject({ ok: true, types: [] });
    expect((res as { meaning?: unknown }).meaning).toBeUndefined();
  });
});
